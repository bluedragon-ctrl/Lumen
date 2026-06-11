"use strict";
/**
 * Command parsing and execution.
 *
 * Each handler returns an array of messages for the ACTOR. Effects visible to
 * OTHER players in the room (speech, arrivals, picking things up) are sent via
 * `ctx`, a small broadcast context the server supplies:
 *   ctx.toRoom(roomId, msg, exceptId)   — send a raw message to others in a room
 *   ctx.refreshRoom(roomId, exceptId)   — push an updated room view to others
 */
const { buildRoomView, buildPlayerView, buildExamineView } = require("./render");
const { canSee } = require("./light");
const { makeItemInstance, addToFloor, buyValueOf, sellValueOf, SELL_RATE, itemVisibleTo, fixtureVisibleTo, mobVisibleTo, isDiscovered, discoveryKey, xpForLevel, effectiveAttributes, spellScaleBonus, durationScaleBonus } = require("./state");
const { EXPLORE_XP } = require("./config");
const quests = require("./quests");

const cap = (s) => (s || "").charAt(0).toUpperCase() + (s || "").slice(1);

// Credit quest kill-progress for a kill landed BY this player on the command path
// (a spell or thrown bomb, where the death is returned inline rather than as a
// tick event). Melee/DoT kills are credited in index.js, so a kill never counts
// twice. Returns the player-facing quest messages to append after the views.
function questKill(state, player, death) {
  return death && death.victimTemplate ? quests.noteKill(state, player, death.victimTemplate) : [];
}

// Searching the room for hidden features costs roughly one action's worth of
// energy, so it competes with attacking and can't be spammed mid-combat.
const SEARCH_COST = 12;
const accounts = require("./accounts");

const DIRS = ["north", "south", "east", "west", "up", "down"];
const DIR_ALIAS = { n: "north", s: "south", e: "east", w: "west", u: "up", d: "down" };
const NOOP_CTX = { toRoom() {}, refreshRoom() {} };

// Every command word the dispatcher understands, in PRIORITY order. A typed verb
// that isn't an exact match resolves to the FIRST entry it is a prefix of
// (DikuMUD-style abbreviation) — so common verbs precede rarer ones that share a
// prefix (e.g. `look` before `list`, `drop` before `drink`, `get`/`g` since there
// is no `go`). Exact matches (incl. single-letter aliases like l/i/k/c
// and directions, handled earlier) always win over prefixes. KEEP IN SYNC with the
// switch in execute(): every word here must have a matching case there, and vice
// versa, or an abbreviation will resolve to an "Unknown command".
const VERBS = [
  "look", "examine", "exam", "search", "get", "take", "pickup", "drop",
  "inventory", "inv", "attack", "kill", "stop", "sit", "sleep", "stand",
  "wake", "wakeup", "cast", "craft", "make", "learn", "study", "spells", "train",
  "list", "shop", "wares", "buy", "sell",
  "drink", "quaff", "eat", "refuel", "fill", "use", "switch", "toggle", "flip",
  "mine", "dig", "gather", "forage", "harvest", "pick", "fish", "angle", "recipes", "say", "emote", "me", "equip", "wield", "wear",
  "talk", "give", "deliver", "quest", "quests", "journal",
  // `rest` (an alias of `sit`) sits late so `re`/`r` favour refuel/remove/recipes.
  "unequip", "remove", "rest", "help",
];
const VERB_SET = new Set([...VERBS, "l", "x", "i", "k", "c", "?"]); // + single-letter aliases

// Help is authored as titled sections of `signature — description` entries, then
// rendered with inline colour markup (see renderMarkup in the client): section
// titles glow gold, command signatures green, the rest reads in the default ink.
// `<#reset>` returns to default colour mid-line (any non-palette tag does).
const HELP_SECTIONS = [
  ["Exploration", [
    "look | examine | x [target] — view the room, or look closely at one thing",
    "search — comb the room for hidden ways and things (needs light + Perception)",
    "north / south / east / west / up / down (n/s/e/w/u/d) — move between rooms",
  ]],
  ["Items & gear", [
    "get | take [N.]<item> | all — pick something up off the floor",
    "drop <item> | all — set something down",
    "inventory | inv | i — list what you are carrying",
    "equip | wield | wear <item> — put on gear (a light source kindles as you equip it)",
    "unequip | remove <item|slot> — return equipped gear to your pack",
    "use | switch <target> — work a fixture, or use/light a carried item",
    "drink | quaff | eat <item> — consume a potion or food",
    "refuel | fill <item> — refill a fuelled light (a lantern with oil)",
  ]],
  ["Combat & magic", [
    "attack | kill [N.]<target> — set on a creature (stop to break off)",
    "stop — break off your attack",
    "cast | c <spell> [target] — cast a spell you know",
    "spells — list the spells you know",
  ]],
  ["Gathering & crafting", [
    "mine | dig [vein] — work ore loose from a vein",
    "gather | pick | forage [cluster] — pick moss, mushrooms and crops by hand",
    "fish | angle [water] — work a baited line (spends a grub as bait)",
    "craft | make <recipe> — craft at the matching station here",
    "recipes — list the recipes you know",
  ]],
  ["People & trade", [
    "talk <npc> — speak with someone (take quests, hear what they need)",
    "give <item> <npc> — hand something over (deliver quest goods)",
    "list | shop — see what a trader here buys and sells",
    "buy <item> — buy from a trader here",
    "sell <item> | all — sell to a trader here",
    "say <text> — speak to everyone in the room",
    "emote | me <text> — perform an action others can see",
  ]],
  ["Resting", [
    "sit | rest — recover HP/MP slowly (1 per 5 ticks)",
    "sleep — recover faster (1 per 2 ticks), but blind while you do",
    "stand | wake — get up; moving or attacking also stands you",
  ]],
  ["Other", [
    "learn | study <scroll|schematic|book> — learn a spell or recipe (consumes it)",
    "train [attribute] — spend a level-up point (no arg: show progress)",
    "quest | journal — your quest log (in progress / finished)",
    "help | ? — this list",
  ]],
];

const HELP_TIPS = [
  "Commands shorten to any unambiguous prefix (exa→examine, cr→craft).",
  "Target by any word in a name (kill innkeeper, get glimmerstone). When several",
  "match, pick one with a number (kill 2.crawler) or act on all (get all, sell all).",
];

const ADMIN_HELP_SECTION = ["Admin", [
  "@create-player <name> — create a new player account",
  "@list-players — list every account",
  "@shards <amount> — grant yourself shards",
  "@xp <amount> — grant yourself experience",
  "@attr <attribute> <value> — set one of your attributes",
  "@spawn <mobId> [count] [wild|player] — spawn mobs in this room",
  "@give <itemId> [count] — conjure an item into your pack",
]];

// Colour one "signature — description" entry: green signature, default rest.
function helpEntry(entry) {
  const i = entry.indexOf(" — ");
  if (i < 0) return `  <#green>${entry}<#reset>`;
  return `  <#green>${entry.slice(0, i)}<#reset> — ${entry.slice(i + 3)}`;
}

function renderHelpSections(sections, title) {
  const out = [`<#gold>${title}<#reset>`];
  for (const [heading, entries] of sections) {
    out.push("", `<#cyan>${heading}<#reset>`);
    for (const e of entries) out.push(helpEntry(e));
  }
  return out;
}

// The help text for a given player: the standard sections plus footer tips, and
// the admin section appended only when the player can actually use those verbs.
function buildHelp(player) {
  const lines = renderHelpSections(HELP_SECTIONS, "Commands");
  if (player && player.isAdmin) {
    lines.push("", `<#cyan>${ADMIN_HELP_SECTION[0]}<#reset>`);
    for (const e of ADMIN_HELP_SECTION[1]) lines.push(helpEntry(e));
  }
  lines.push("", ...HELP_TIPS.map((t) => `<#gray>${t}<#reset>`));
  return lines.join("\n");
}

// Back-compat export: the non-admin help string.
const HELP = buildHelp(null);

const selfAndViews = (state, player, line, kind = "log") => [
  { type: kind, text: line },
  buildRoomView(state, player),
  buildPlayerView(state, player),
];

// Append gold level-up lines for `ups` to a command's outgoing messages and
// broadcast each to the room — the command-path mirror of the kill handler's
// gold hail (index.js). Call AFTER awarding XP but the player view in `out`
// must already reflect the new level (build views after awardXp).
function announceLevelUps(player, ups, ctx, out) {
  for (const up of ups || []) {
    out.push({ type: "gold", text: `You reach level ${up.level}! (+${up.points} attribute points — spend with "train")` });
    ctx.toRoom(player.location, { type: "gold", text: `${player.name} reaches level ${up.level}!` }, player.id);
  }
}

// Words too generic to single out a target — dropped when deriving keywords
// from a display name (so "a sliver of glimmerstone" yields sliver/glimmerstone).
const STOP_WORDS = new Set(["a", "an", "the", "of", "some", "and", "with", "to"]);

// Significant lowercase tokens from a display name, used as fallback keywords.
function nameTokens(name) {
  return (name || "").toLowerCase().split(/[^a-z0-9]+/).filter((t) => t && !STOP_WORDS.has(t));
}

// Does query `q` name a thing called `name` (with optional authored `keywords`
// and instance/template `id`)? Resolution order:
//   1. exact id match
//   2. every query word is (a prefix of) some keyword — authored `keywords` if
//      present, else words derived from the display name. Multi-word queries use
//      AND semantics, so "glimmer crystal" needs both keywords present.
//   3. legacy fallback: `q` is a substring of the full display name.
function matchesQuery(q, name, keywords, id) {
  const ql = (q || "").trim().toLowerCase();
  if (!ql) return false;
  if (id && String(id).toLowerCase() === ql) return true;
  const kws = keywords && keywords.length ? keywords.map((k) => k.toLowerCase()) : nameTokens(name);
  if (ql.split(/\s+/).every((qw) => kws.some((kw) => kw === qw || kw.startsWith(qw)))) return true;
  return (name || "").toLowerCase().includes(ql);
}

// DikuMUD-style target syntax: split a query into an optional `all` flag, an
// optional 1-based ordinal (`2.crawler` → the second crawler), and the bare
// keyword to match. `all`/`all.keyword` set `all` and zero the ordinal.
//   "all"        -> { all:true,  ordinal:0, keyword:"" }
//   "all.shard"  -> { all:true,  ordinal:0, keyword:"shard" }
//   "2.dagger"   -> { all:false, ordinal:2, keyword:"dagger" }
//   "dagger"     -> { all:false, ordinal:1, keyword:"dagger" }
function parseTarget(arg) {
  let q = (arg || "").trim();
  const lead = q.toLowerCase();
  if (lead === "all" || lead.startsWith("all.")) {
    return { all: true, ordinal: 0, keyword: q.slice(3).replace(/^\./, "").trim() };
  }
  const m = /^(\d+)\.(.+)$/.exec(q);
  if (m) return { all: false, ordinal: parseInt(m[1], 10) || 1, keyword: m[2].trim() };
  return { all: false, ordinal: 1, keyword: q };
}

// Indices in `list` whose item matches `keyword` (an empty keyword matches all),
// preserving list order — the basis for ordinal and `all` selection.
function itemMatches(list, world, keyword) {
  const idxs = [];
  list.forEach((i, idx) => {
    const t = world.items[i.template];
    if (!keyword || matchesQuery(keyword, t.name, t.keywords, i.id)) idxs.push(idx);
  });
  return idxs;
}

// Find a single item instance matching `q`, honouring an `N.` ordinal prefix.
// Returns the list index, or -1. A bare `all` (no keyword) isn't a single
// target, so it finds nothing — bulk commands check `parseTarget().all` first.
function findItem(list, world, q) {
  const { ordinal, keyword } = parseTarget(q);
  if (!keyword) return -1;
  const idxs = itemMatches(list, world, keyword);
  const pick = idxs[(ordinal || 1) - 1];
  return pick === undefined ? -1 : pick;
}

// Resolve a mob in the player's room by query, honouring an `N.` ordinal prefix.
// `requireVisible` gates hidden-mob reveals; `cast` historically skips that
// check, so it passes false. Returns the mob instance or null.
function findMobInRoom(state, player, q, requireVisible = true) {
  const w = state.world;
  const rt = state.rooms[player.location];
  const see = canSee(player.perception, rt.light);
  const { ordinal, keyword } = parseTarget(q);
  if (!keyword) return null;
  const matches = rt.mobs.filter((m) => {
    const t = w.mobs[m.template];
    return (!requireVisible || mobVisibleTo(state, player, m)) && (see || t.emitsLight) && matchesQuery(keyword, t.name, t.keywords, m.id);
  });
  return matches[(ordinal || 1) - 1] || null;
}

function addToInventory(player, inst, world) {
  const t = world.items[inst.template];
  if (t.stackable) {
    const ex = player.inventory.find((i) => i.template === inst.template);
    if (ex) {
      ex.qty = (ex.qty || 1) + (inst.qty || 1);
      return;
    }
  }
  player.inventory.push(inst);
}

// Total quantity of a template carried (sums stacks).
function countItem(player, template) {
  return player.inventory.reduce((n, i) => (i.template === template ? n + (i.qty || 1) : n), 0);
}

// Remove `n` of a template from inventory (across stacks). Assumes enough is present.
function removeItem(player, template, n) {
  for (let i = player.inventory.length - 1; i >= 0 && n > 0; i--) {
    const inst = player.inventory[i];
    if (inst.template !== template) continue;
    const have = inst.qty || 1;
    if (have > n) inst.qty = have - n, (n = 0);
    else (n -= have), player.inventory.splice(i, 1);
  }
}

// Join names into prose: "a", "a and b", "a, b, and c" (Oxford comma).
function joinList(names) {
  if (names.length <= 1) return names[0] || "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

// Display name of the fixture that provides a crafting station (for hints).
function stationLabel(world, station) {
  const f = Object.values(world.fixtures).find((x) => x.station === station);
  return f ? f.name : `a ${station} station`;
}

// Equip an instance into its template's slot, stowing whatever was there back to
// inventory (and dousing it if it was a lit light). A fuelled light source kindles
// as it goes into the light slot (DikuMUD-style: holding a torch lights it; douse
// to conserve fuel with `use`). Returns the displaced item.
function equipItem(player, inst, world) {
  const t = world.items[inst.template];
  const prev = player.equipment[t.slot] || null;
  if (prev && prev.lit) prev.lit = false;
  if (t.light && inst.fuel > 0) inst.lit = true;
  player.equipment[t.slot] = inst;
  if (prev) player.inventory.push(prev);
  return prev;
}

// --- Posture (sit / sleep / stand) -----------------------------------------
// Posture drives rest recovery (see state._recoverTick) and is social. Sleeping
// also blinds you (your room view goes dark). Each spec carries the self/room
// lines for entering it.
const POSTURES = {
  sit: { name: "sitting", self: "You settle down and sit, catching your breath.", room: (n) => `${n} sits down to rest.` },
  sleep: { name: "sleeping", self: "You lie down and close your eyes. Sleep takes you, and the dark with it.", room: (n) => `${n} lies down and falls asleep.` },
  stand: { name: "standing", self: "You stand up.", room: (n) => `${n} stands up.` },
};

// Set the player's posture (sit/sleep/stand). Resting is barred mid-fight; the
// change broadcasts to the room and refreshes others' view (the posture tag).
function setPosture(state, player, key, ctx) {
  const spec = POSTURES[key];
  if (player.posture === spec.name) {
    const already = { sitting: "You are already sitting.", sleeping: "You are already asleep.", standing: "You are already on your feet." };
    return [{ type: "log", text: already[spec.name] }];
  }
  if ((key === "sit" || key === "sleep") && player.pending)
    return [{ type: "error", text: "You can't rest in the middle of a fight." }];
  const wasSleeping = player.posture === "sleeping";
  player.posture = spec.name;
  player.restTicks = 0;
  ctx.toRoom(player.location, { type: "log", text: spec.room(player.name) }, player.id);
  ctx.refreshRoom(player.location, player.id); // others see the posture tag change
  const self = key === "stand" && wasSleeping ? "You wake and climb to your feet." : spec.self;
  return selfAndViews(state, player, self);
}

// Move/attack/cast rouse a resting player first (decision: auto-stand, then act).
// Pure state change — returns true if it actually stood the player up, so callers
// can prepend a brief "you got up" note where it reads naturally.
function autoStand(player) {
  if (!player.posture || player.posture === "standing") return false;
  player.posture = "standing";
  player.restTicks = 0;
  return true;
}

function move(state, player, dir, ctx) {
  autoStand(player); // you stand before you walk (sit/sleep don't block movement)
  const room = state.world.rooms[player.location];
  // A normal exit, or a hidden one this player has already discovered (an
  // undiscovered hidden exit reads exactly like no exit — it isn't leaked).
  let dest = room.exits && room.exits[dir];
  if (!dest && room.hiddenExits && room.hiddenExits[dir] && isDiscovered(player, discoveryKey(player.location, "exit", dir)))
    dest = room.hiddenExits[dir].to;
  // An *open* door fixture (a trapdoor, gate) provides an exit in its direction;
  // shut, that way reads as no exit at all.
  if (!dest) {
    for (const f of state.rooms[player.location].fixtures || []) {
      const ft = state.world.fixtures[f.template];
      if (ft && ft.door && ft.door.dir === dir && f.open) { dest = ft.door.to; break; }
    }
  }
  if (!dest) return [{ type: "error", text: `You can't go ${dir} from here.` }];
  player.pending = null; // moving breaks off any attack
  state.clearRevealedMobs(player.id); // leaving the room re-hides any lurkers you'd spotted
  const from = player.location;
  ctx.toRoom(from, { type: "log", text: `${player.name} leaves ${dir}.` }, player.id);
  state.setPlayerLocation(player, dest);
  state.rooms[dest].light = state.computeRoomLight(dest);
  state.rooms[from].light = state.computeRoomLight(from);
  // Owned summons follow their delver between rooms (wild summons stay put).
  const followed = state._moveSummonsWith(player, from, dest);
  for (const f of followed) {
    const Name = f.mobName.charAt(0).toUpperCase() + f.mobName.slice(1);
    ctx.toRoom(from, { type: "log", text: `${Name} slips away after ${player.name}.` }, player.id);
    ctx.toRoom(dest, { type: "log", text: `${Name} drifts in at ${player.name}'s heel.` }, player.id);
  }
  ctx.refreshRoom(from, player.id);
  ctx.toRoom(dest, { type: "log", text: `${player.name} arrives.` }, player.id);
  ctx.refreshRoom(dest, player.id);
  // First time here? A one-off exploration reward (rewards pushing into new ground;
  // each room pays once). Award before building views so the player view is current.
  let tail = "";
  let ups = [];
  let qmsgs = [];
  if (!Array.isArray(player.visitedRooms)) player.visitedRooms = [];
  if (!player.visitedRooms.includes(dest)) {
    player.visitedRooms.push(dest);
    if (EXPLORE_XP) {
      ups = state.awardXp(player, EXPLORE_XP);
      tail = ` You map new ground. (+${EXPLORE_XP} xp)`;
    }
    qmsgs = quests.noteEnter(state, player, dest); // a quest may begin on first arrival
  }
  const followTail = followed.length ? ` Your ${followed.map((f) => f.mobName).join(", ")} follow${followed.length === 1 ? "s" : ""}.` : "";
  const msgs = selfAndViews(state, player, `You go ${dir}.${tail}${followTail}`);
  announceLevelUps(player, ups, ctx, msgs);
  msgs.push(...qmsgs);
  return msgs;
}

// Toggle a carried/equipped light source via `use <source>`. Equipping a source
// already kindles it (see equipItem); this is how you douse one to save fuel and
// relight it later. A source still in the pack is equipped (and thus lit) first.
// Not gated by light — you must be able to light a torch in the dark.
function toggleLightSource(state, player, inst, ctx) {
  const w = state.world;
  const name = w.items[inst.template].name;
  const equipped = player.equipment.light === inst;
  if (equipped && inst.lit) {
    inst.lit = false;
    state.rooms[player.location].light = state.computeRoomLight(player.location);
    ctx.toRoom(player.location, { type: "log", text: `${player.name} douses ${name}.` }, player.id);
    ctx.refreshRoom(player.location, player.id);
    return selfAndViews(state, player, `You douse ${name}.`);
  }
  if (inst.fuel <= 0) return [{ type: "error", text: `${name} is spent — you need a fresh light.` }];
  if (equipped) inst.lit = true; // relight an equipped-but-doused source
  else equipItem(player, player.inventory.splice(player.inventory.indexOf(inst), 1)[0], w); // equipping kindles it
  state.rooms[player.location].light = state.computeRoomLight(player.location);
  ctx.toRoom(player.location, { type: "log", text: `${player.name} lights ${name}.` }, player.id);
  ctx.refreshRoom(player.location, player.id);
  return selfAndViews(state, player, `You light ${name}. The dark recedes.`);
}

function equip(state, player, arg, ctx) {
  const w = state.world;
  if (!arg) return [{ type: "error", text: "Equip what?" }];
  const idx = findItem(player.inventory, w, arg);
  if (idx < 0) return [{ type: "error", text: `You aren't carrying "${arg}".` }];
  const t = w.items[player.inventory[idx].template];
  if (!t.slot) return [{ type: "error", text: `You can't equip ${t.name}.` }];
  const prevHp = player.maxHp;
  const prevMana = player.maxMana;
  const prev = equipItem(player, player.inventory.splice(idx, 1)[0], w);
  state.deriveStats(player); // gear may carry an armour.maxHp / armour.maxMana bonus
  if (player.maxHp > prevHp) player.hp += player.maxHp - prevHp; // grant the new capacity (like training)
  if (player.maxMana > prevMana) player.mana += player.maxMana - prevMana;
  player.hp = Math.min(player.hp, player.maxHp);
  player.mana = Math.min(player.mana, player.maxMana);
  state.rooms[player.location].light = state.computeRoomLight(player.location);
  ctx.refreshRoom(player.location, player.id);
  const stowed = prev ? `, stowing ${w.items[prev.template].name}` : "";
  const kindled = t.slot === "light" && player.equipment.light && player.equipment.light.lit ? " It kindles, and the dark recedes." : "";
  return selfAndViews(state, player, `You equip ${t.name}${stowed}.${kindled}`);
}

function unequip(state, player, arg, ctx) {
  const w = state.world;
  if (!arg) return [{ type: "error", text: "Remove what?" }];
  const ql = arg.toLowerCase();
  let slot = null;
  if (player.equipment[ql] !== undefined) slot = ql; // a slot name (hand/body/light)
  else
    for (const [s, inst] of Object.entries(player.equipment)) {
      if (inst && (inst.id.toLowerCase() === ql || w.items[inst.template].name.toLowerCase().includes(ql))) {
        slot = s;
        break;
      }
    }
  const inst = slot ? player.equipment[slot] : null;
  if (!inst) return [{ type: "error", text: `You don't have "${arg}" equipped.` }];
  if (inst.lit) inst.lit = false;
  player.equipment[slot] = null;
  player.inventory.push(inst);
  state.deriveStats(player); // shedding gear may drop an armour.maxHp / armour.maxMana bonus
  player.hp = Math.min(player.hp, player.maxHp);
  player.mana = Math.min(player.mana, player.maxMana);
  state.rooms[player.location].light = state.computeRoomLight(player.location);
  ctx.refreshRoom(player.location, player.id);
  return selfAndViews(state, player, `You remove ${w.items[inst.template].name}.`);
}

function get(state, player, arg, ctx) {
  if (!arg) return [{ type: "error", text: "Get what?" }];
  const w = state.world;
  const rt = state.rooms[player.location];
  if (!canSee(player.perception, rt.light)) return [{ type: "error", text: "It is too dark to find anything." }];
  // Undiscovered hidden items aren't pickable by name — you must `search` first.
  const visible = rt.items.filter((i) => itemVisibleTo(player, i));
  const { all, keyword } = parseTarget(arg);
  // Take a single floor instance into purse (currency) or pack; returns a label
  // for the picked-up summary, pushing any quest messages onto `qmsgs`.
  const take = (inst, qmsgs) => {
    rt.items.splice(rt.items.indexOf(inst), 1);
    const t = w.items[inst.template];
    if (t.type === "currency") {
      const amt = inst.qty || 1;
      player.shards = (player.shards || 0) + amt;
      return `${amt} shard${amt === 1 ? "" : "s"}`;
    }
    addToInventory(player, inst, w);
    qmsgs.push(...quests.noteAcquire(state, player, inst.template)); // before views so rewards show
    return t.name;
  };
  if (all) {
    const targets = itemMatches(visible, w, keyword).map((i) => visible[i]);
    if (!targets.length) return [{ type: "error", text: keyword ? `There is no "${keyword}" here to get.` : "There is nothing here to get." }];
    const qmsgs = [];
    const labels = targets.map((inst) => take(inst, qmsgs));
    ctx.toRoom(player.location, { type: "log", text: `${player.name} gathers up what lies here.` }, player.id);
    ctx.refreshRoom(player.location, player.id);
    const out = selfAndViews(state, player, `You pick up ${labels.join(", ")}.`);
    out.push(...qmsgs);
    return out;
  }
  const vIdx = findItem(visible, w, arg);
  if (vIdx < 0) return [{ type: "error", text: `There is no "${arg}" here to get.` }];
  const inst = visible[vIdx];
  const isCurrency = w.items[inst.template].type === "currency";
  const qmsgs = [];
  const label = take(inst, qmsgs);
  const verb = isCurrency ? "gathers" : "picks up";
  ctx.toRoom(player.location, { type: "log", text: `${player.name} ${verb} ${label}.` }, player.id);
  ctx.refreshRoom(player.location, player.id);
  const tail = isCurrency ? ` (${player.shards} total)` : "";
  const out = selfAndViews(state, player, `You ${isCurrency ? "gather" : "pick up"} ${label}.${tail}`);
  out.push(...qmsgs);
  return out;
}

function drop(state, player, arg, ctx) {
  if (!arg) return [{ type: "error", text: "Drop what?" }];
  const w = state.world;
  const rt = state.rooms[player.location];
  const { all, keyword } = parseTarget(arg);
  if (all) {
    const targets = itemMatches(player.inventory, w, keyword).map((i) => player.inventory[i]);
    if (!targets.length) return [{ type: "error", text: keyword ? `You aren't carrying any "${keyword}".` : "You are carrying nothing to drop." }];
    const labels = [];
    for (const inst of targets) {
      player.inventory.splice(player.inventory.indexOf(inst), 1);
      addToFloor(rt, inst, w);
      labels.push(w.items[inst.template].name);
    }
    ctx.toRoom(player.location, { type: "log", text: `${player.name} sets down a few things.` }, player.id);
    ctx.refreshRoom(player.location, player.id);
    return selfAndViews(state, player, `You drop ${labels.join(", ")}.`);
  }
  const idx = findItem(player.inventory, w, arg);
  if (idx < 0) return [{ type: "error", text: `You aren't carrying "${arg}".` }];
  const inst = player.inventory.splice(idx, 1)[0];
  addToFloor(rt, inst, w);
  const name = w.items[inst.template].name;
  ctx.toRoom(player.location, { type: "log", text: `${player.name} drops ${name}.` }, player.id);
  ctx.refreshRoom(player.location, player.id);
  return selfAndViews(state, player, `You drop ${name}.`);
}

function inventory(state, player) {
  const w = state.world;
  if (!player.inventory.length) return [{ type: "log", text: "You are carrying nothing." }];
  const lines = player.inventory.map((i) => {
    const qty = i.qty != null ? ` ×${i.qty}` : "";
    return `  ${w.items[i.template].name}${qty}`;
  });
  return [{ type: "log", text: "You are carrying:\n" + lines.join("\n") }];
}

// A trader you can currently deal with: a mob in the room carrying a `shop` block,
// visible in the present light. Returns { mob, t } or null.
function shopHere(state, player) {
  const rt = state.rooms[player.location];
  if (!canSee(player.perception, rt.light)) return null;
  for (const m of rt.mobs) {
    const t = state.world.mobs[m.template];
    if (t.shop) return { mob: m, t };
  }
  return null;
}

// Price a trader sells an item for: its intrinsic value, or a per-shop override.
function buyPrice(offer, t) {
  return offer && offer.price != null ? offer.price : buyValueOf(t);
}

function shopList(state, player) {
  const sh = shopHere(state, player);
  if (!sh) return [{ type: "error", text: "There is no one here to trade with." }];
  const w = state.world;
  const lines = [`${sh.t.name} trades:`];
  const sells = sh.t.shop.sells || [];
  const purse = player.shards || 0;
  if (sells.length) {
    lines.push("Sells (you buy):");
    for (const o of sells) {
      const price = buyPrice(o, w.items[o.template]);
      const line = `  ${w.items[o.template].name} — ${price} shards`;
      lines.push(price > purse ? `<#gray>${line}` : line);
    }
  }
  lines.push(`Buys most goods at ${Math.round(SELL_RATE * 100)}% of value — \`sell <item>\` for an offer.`);
  lines.push(`You have ${player.shards || 0} shards.`);
  return [{ type: "log", text: lines.join("\n") }];
}

function buy(state, player, arg, ctx) {
  if (!arg) return [{ type: "error", text: "Buy what?" }];
  const sh = shopHere(state, player);
  if (!sh) return [{ type: "error", text: "There is no one here to trade with." }];
  const w = state.world;
  const ql = arg.toLowerCase();
  const offer = (sh.t.shop.sells || []).find(
    (s) => s.template.toLowerCase() === ql || w.items[s.template].name.toLowerCase().includes(ql)
  );
  if (!offer) return [{ type: "error", text: `${sh.t.name} doesn't sell "${arg}".` }];
  const name = w.items[offer.template].name;
  const price = buyPrice(offer, w.items[offer.template]);
  if ((player.shards || 0) < price)
    return [{ type: "error", text: `You can't afford ${name} — ${price} shards, you have ${player.shards || 0}.` }];
  player.shards -= price;
  addToInventory(player, makeItemInstance({ template: offer.template }, w), w);
  const qmsgs = quests.noteAcquire(state, player, offer.template);
  ctx.toRoom(player.location, { type: "log", text: `${player.name} buys ${name} from ${sh.t.name}.` }, player.id);
  const out = selfAndViews(state, player, `You buy ${name} for ${price} shards. (${player.shards} left)`);
  out.push(...qmsgs);
  return out;
}

function sell(state, player, arg, ctx) {
  if (!arg) return [{ type: "error", text: "Sell what?" }];
  const sh = shopHere(state, player);
  if (!sh) return [{ type: "error", text: "There is no one here to trade with." }];
  const w = state.world;
  const { all, keyword } = parseTarget(arg);
  // The trader buys any valued item at its sell value — no per-trader buy list.
  if (all) {
    // `sell all` clears out the whole of each matching valued stack at once.
    const targets = itemMatches(player.inventory, w, keyword).map((i) => player.inventory[i]);
    const sold = [];
    let total = 0;
    for (const inst of targets) {
      const t = w.items[inst.template];
      const unit = sellValueOf(t);
      if (!t.value || unit <= 0) continue; // trader won't buy it — leave it in the pack
      const qty = inst.qty != null ? inst.qty : 1;
      player.inventory.splice(player.inventory.indexOf(inst), 1);
      total += unit * qty;
      sold.push(qty > 1 ? `${t.name} ×${qty}` : t.name);
    }
    if (!sold.length) return [{ type: "error", text: keyword ? `${sh.t.name} won't buy any "${keyword}" from you.` : `${sh.t.name} won't buy anything you're carrying.` }];
    player.shards = (player.shards || 0) + total;
    ctx.toRoom(player.location, { type: "log", text: `${player.name} trades with ${sh.t.name}.` }, player.id);
    return selfAndViews(state, player, `You sell ${sold.join(", ")} for ${total} shards. (${player.shards} total)`);
  }
  const idx = findItem(player.inventory, w, arg);
  if (idx < 0) return [{ type: "error", text: `You aren't carrying "${arg}".` }];
  const inst = player.inventory[idx];
  const t = w.items[inst.template];
  const price = sellValueOf(t);
  if (!t.value || price <= 0) return [{ type: "error", text: `${sh.t.name} won't give you anything for ${t.name}.` }];
  if (inst.qty != null && inst.qty > 1) inst.qty -= 1;
  else player.inventory.splice(idx, 1);
  player.shards = (player.shards || 0) + price;
  ctx.toRoom(player.location, { type: "log", text: `${player.name} sells ${t.name} to ${sh.t.name}.` }, player.id);
  return selfAndViews(state, player, `You sell ${t.name} for ${price} shards. (${player.shards} total)`);
}

// Effect primitives this client knows how to flavour. The engine (state.js)
// owns what each one *does*; this only narrates applying it.
const EFFECT_FLAVOUR = {
  "emit-light": "A soft light wells up beneath your skin.",
};

// Toggle a switchable fixture (a lamp, lever, …). Switching it may change room light.
function toggleFixture(state, player, f, ctx) {
  const ft = state.world.fixtures[f.template];
  f.on = !f.on;
  state.rooms[player.location].light = state.computeRoomLight(player.location);
  ctx.toRoom(player.location, { type: "log", text: `${player.name} switches ${f.on ? "on" : "off"} ${ft.name}.` }, player.id);
  ctx.refreshRoom(player.location, player.id);
  const tail = ft.switch && ft.switch.emitsLight ? (f.on ? " It casts a steady glow." : " Its glow dies.") : "";
  return selfAndViews(state, player, `You switch ${f.on ? "on" : "off"} ${ft.name}.${tail}`);
}

// Open or shut a door fixture (a trapdoor, gate, …). Open, it provides an exit
// in its `dir`; shut, that way is closed. `want` forces a state (open/close
// verbs); omit it to toggle (`use`).
function toggleDoor(state, player, f, ctx, want) {
  const ft = state.world.fixtures[f.template];
  const next = want === undefined ? !f.open : want;
  if (next === f.open) return [{ type: "error", text: `It's already ${f.open ? "open" : "shut"}.` }];
  f.open = next;
  ctx.toRoom(player.location, { type: "log", text: `${player.name} ${f.open ? "opens" : "shuts"} ${ft.name}.` }, player.id);
  ctx.refreshRoom(player.location, player.id);
  return selfAndViews(state, player, `You ${f.open ? "open" : "shut"} ${ft.name}.`);
}

// `use <target>`: operate a switchable or door fixture here if it matches, else drink it.
function use(state, player, arg, ctx) {
  const w = state.world;
  const rt = state.rooms[player.location];
  if (arg && canSee(player.perception, rt.light)) {
    const ql = arg.toLowerCase();
    // Any visible fixture matching arg, regardless of kind — `use`-ing it credits
    // quest `use` objectives/triggers even for plain scenery. Quest reward grants
    // happen here, before the mechanical handler builds its views.
    const anyFix = rt.fixtures.find((f) => {
      const ft = w.fixtures[f.template];
      return ft && fixtureVisibleTo(player, f) && (f.id.toLowerCase() === ql || ft.name.toLowerCase().includes(ql));
    });
    const qmsgs = anyFix ? quests.noteUse(state, player, anyFix.template) : [];
    const withQuest = (arr) => { arr.push(...qmsgs); return arr; };

    const f = rt.fixtures.find((f) => {
      const ft = w.fixtures[f.template];
      return ft && (ft.switch || ft.door) && fixtureVisibleTo(player, f) && (f.id.toLowerCase() === ql || ft.name.toLowerCase().includes(ql));
    });
    if (f) return withQuest(w.fixtures[f.template].door ? toggleDoor(state, player, f, ctx) : toggleFixture(state, player, f, ctx));
    // A fixture you drink/draw from (a seep, a spring) restores hp/mana on use.
    const rf = rt.fixtures.find((f) => {
      const ft = w.fixtures[f.template];
      return ft && ft.restore && fixtureVisibleTo(player, f) && (f.id.toLowerCase() === ql || ft.name.toLowerCase().includes(ql));
    });
    if (rf) return withQuest(drinkFixture(state, player, rf, ctx));
    // A harvestable fixture (a mushroom cluster) — `use` it to pick by hand.
    const hf = rt.fixtures.find((f) => {
      const ft = w.fixtures[f.template];
      return ft && ft.harvest && fixtureVisibleTo(player, f) && (f.id.toLowerCase() === ql || ft.name.toLowerCase().includes(ql));
    });
    if (hf) return withQuest(gather(state, player, arg, ctx));
    // A quest-only fixture (scenery with no mechanical function) still counts as
    // "used" — acknowledge it so the verb isn't an "unknown" dead end.
    if (anyFix) return withQuest(selfAndViews(state, player, `You handle ${w.fixtures[anyFix.template].name}.`));
  }
  // A carried/equipped light source toggles lit/doused (works in the dark — that's
  // the point of lighting one). Checked before the drink/eat fallback.
  if (arg) {
    const src = [player.equipment.light, ...player.inventory].filter(Boolean).find(
      (i) => w.items[i.template].light && matchesQuery(arg, w.items[i.template].name, w.items[i.template].keywords, i.id)
    );
    if (src) return toggleLightSource(state, player, src, ctx);
  }
  return drink(state, player, arg, ctx);
}

// `open`/`close <door>`: explicitly set a door fixture's state (sugar over `use`).
function operateDoor(state, player, arg, ctx, want) {
  const w = state.world;
  const rt = state.rooms[player.location];
  if (!arg) return [{ type: "error", text: `${want ? "Open" : "Close"} what?` }];
  if (!canSee(player.perception, rt.light)) return [{ type: "error", text: "It's too dark to make that out." }];
  const ql = arg.toLowerCase();
  const f = rt.fixtures.find((f) => {
    const ft = w.fixtures[f.template];
    return ft && ft.door && fixtureVisibleTo(player, f) && (f.id.toLowerCase() === ql || ft.name.toLowerCase().includes(ql));
  });
  if (!f) return [{ type: "error", text: `There's nothing like that to ${want ? "open" : "close"} here.` }];
  return toggleDoor(state, player, f, ctx, want);
}

// `refuel <item>`: top up a carried/equipped fuelled light from its fuel item
// (e.g. a lantern with a flask of oil). Torches aren't refuellable — replace them.
function refuel(state, player, arg, ctx) {
  const w = state.world;
  if (!arg) return [{ type: "error", text: "Refuel what?" }];
  const ql = arg.toLowerCase();
  // A light source matching arg, equipped or in the pack.
  const candidates = [player.equipment && player.equipment.light, ...player.inventory].filter(Boolean);
  const inst = candidates.find(
    (i) => w.items[i.template].light && (i.id.toLowerCase() === ql || w.items[i.template].name.toLowerCase().includes(ql))
  );
  if (!inst) return [{ type: "error", text: `You have no light source "${arg}" to refuel.` }];
  const t = w.items[inst.template];
  const lt = t.light;
  if (!lt.fuelItem) return [{ type: "error", text: `${t.name} can't be refuelled — you'd just replace it.` }];
  if (inst.fuel >= lt.fuelMax) return [{ type: "error", text: `${t.name} is already full.` }];
  const fidx = player.inventory.findIndex((i) => i.template === lt.fuelItem);
  if (fidx < 0) return [{ type: "error", text: `You need ${w.items[lt.fuelItem].name} to refuel ${t.name}.` }];
  const fuelItem = player.inventory[fidx];
  if (fuelItem.qty != null && fuelItem.qty > 1) fuelItem.qty -= 1;
  else player.inventory.splice(fidx, 1);
  inst.fuel = Math.min(lt.fuelMax, (inst.fuel || 0) + (lt.refuelPerUnit || lt.fuelMax));
  state.rooms[player.location].light = state.computeRoomLight(player.location);
  ctx.refreshRoom(player.location, player.id);
  return selfAndViews(state, player, `You refuel ${t.name} with ${w.items[lt.fuelItem].name}. (fuel ${inst.fuel}/${lt.fuelMax})`);
}

// Consume a carried consumable and apply its effect. `verb` is the word the
// player reached for — `drink`/`eat` (ingestibles) or `use` (the catch-all that
// also activates devices like a flare); it only shapes the flavour text.
function drink(state, player, arg, ctx, verb = "use") {
  const w = state.world;
  if (!arg) return [{ type: "error", text: `What do you want to ${verb}?` }];
  const idx = findItem(player.inventory, w, arg);
  if (idx < 0) return [{ type: "error", text: `You aren't carrying "${arg}".` }];
  const inst = player.inventory[idx];
  const t = w.items[inst.template];
  if (t.type !== "consumable" || !t.consumable) return [{ type: "error", text: `You can't ${verb} ${t.name}.` }];
  const spec = t.consumable.effect;
  if (!spec || typeof spec !== "object" || !spec.type)
    return [{ type: "error", text: `${t.name} fizzles uselessly — nothing happens.` }];
  // A thrown area bomb is its own resolution — it consumes only on a throw that
  // has something to hit, so it can refuse (and keep the bomb) in an empty room.
  if (spec.type === "damage-room") return throwBomb(state, player, idx, inst, t, spec, ctx, verb);
  // Consume one, then apply the effect primitive.
  if (inst.qty != null && inst.qty > 1) inst.qty -= 1;
  else player.inventory.splice(idx, 1);
  // `restore` is instantaneous (heal hp/mana); everything else is a status effect.
  if (spec.type === "restore") {
    const r = state.applyRestore(player, spec);
    ctx.toRoom(player.location, { type: "log", text: `${player.name} ${verb}s ${t.name}.` }, player.id);
    ctx.refreshRoom(player.location, player.id);
    const parts = [];
    if (r.hp) parts.push(`+${r.hp} HP`);
    if (r.mana) parts.push(`+${r.mana} MP`);
    const gain = parts.length ? ` (${parts.join(", ")})` : " It does nothing for you.";
    return selfAndViews(state, player, `You ${verb} ${t.name}.${gain}`);
  }
  state.applyEffect(player, spec);
  state.rooms[player.location].light = state.computeRoomLight(player.location);
  ctx.toRoom(player.location, { type: "log", text: `${player.name} ${verb}s ${t.name}.` }, player.id);
  ctx.refreshRoom(player.location, player.id);
  // An item may carry its own flavour line; otherwise fall back to the effect's.
  const flavourText = t.consumable.flavour || EFFECT_FLAVOUR[spec.type];
  const flavour = flavourText ? ` ${flavourText}` : "";
  return selfAndViews(state, player, `You ${verb} ${t.name}.${flavour}`);
}

// `throw`/`use <bomb>`: detonate a `damage-room` consumable, blasting every
// eligible mob in the room at once. Only hostile (or already-engaged) mobs catch
// the blast, so a stray toss in town won't blow up a peaceful shopkeeper — and
// with nothing to hit the throw is refused and the bomb kept. Per-target damage,
// threat and kills live in state.detonateRoom; this filters, consumes, narrates,
// and sticks the thrower to a survivor so they keep swinging (like a hostile cast).
function throwBomb(state, player, idx, inst, t, spec, ctx, verb) {
  const w = state.world;
  const rt = state.rooms[player.location];
  const targets = rt.mobs.filter((m) => {
    const mt = w.mobs[m.template];
    return mt.hostile || (m.aggro && m.aggro[player.id] > 0);
  });
  if (!targets.length)
    return [{ type: "error", text: `There's nothing here for ${t.name} to catch — best not waste it.` }];

  autoStand(player); // you surge to your feet to make the throw
  if (inst.qty != null && inst.qty > 1) inst.qty -= 1;
  else player.inventory.splice(idx, 1);

  const results = state.detonateRoom(player, spec, targets);
  const killed = results.filter((r) => r.killed);
  const hurt = results.filter((r) => !r.killed && r.damage > 0);
  const poisoned = results.filter((r) => !r.killed && r.dot);
  const xp = killed.reduce((s, r) => s + (r.death.xp || 0), 0);
  const loot = killed.flatMap((r) => r.death.loot || []);

  // Keep swinging at any survivor if not already committed (mirrors a hostile cast).
  const survivor = rt.mobs.find((m) => results.some((r) => !r.killed && r.id === m.id));
  if (!player.pending && player.hp > 0 && survivor)
    player.pending = { type: "attack", targetId: survivor.id };

  let outcome = "";
  if (hurt.length) outcome += ` It tears into ${hurt.map((r) => `${r.name} for ${r.damage}`).join(", ")}.`;
  if (poisoned.length) outcome += ` The ${spec.cause || "cloud"} clings to ${poisoned.map((r) => r.name).join(", ")}.`;
  if (killed.length) outcome += ` It blasts apart ${killed.map((r) => r.name).join(", ")}!${xp ? ` (+${xp} xp)` : ""}`;
  if (loot.length) outcome += ` They leave behind ${loot.join(", ")}.`;

  const qmsgs = killed.flatMap((r) => questKill(state, player, r.death));
  const burst = t.consumable.burst || "a storm of glimmer-fire and shrapnel";
  ctx.toRoom(player.location, { type: "combat", text: `${player.name} hurls ${t.name} and it bursts in ${burst}!` }, player.id);
  ctx.refreshRoom(player.location, player.id);
  const flavour = t.consumable.flavour ? ` ${t.consumable.flavour}` : "";
  const out = selfAndViews(state, player, `You hurl ${t.name}.${flavour}${outcome}`, "combat");
  out.push(...qmsgs);
  return out;
}

// Drink/draw from a `restore` fixture (a seep, a spring). Heals hp/mana like a
// `restore` consumable, but the fixture stays put — it's a place, not an item.
function drinkFixture(state, player, f, ctx) {
  const w = state.world;
  const ft = w.fixtures[f.template];
  const r = state.applyRestore(player, ft.restore);
  ctx.toRoom(player.location, { type: "log", text: `${player.name} drinks from ${ft.name}.` }, player.id);
  ctx.refreshRoom(player.location, player.id);
  const parts = [];
  if (r.hp) parts.push(`+${r.hp} HP`);
  if (r.mana) parts.push(`+${r.mana} MP`);
  const gain = parts.length ? ` (${parts.join(", ")})` : " It does nothing for you.";
  return selfAndViews(state, player, `You drink from ${ft.name}.${gain}`);
}

function craft(state, player, arg, ctx) {
  const w = state.world;
  if (!arg) return [{ type: "error", text: "Craft what? Try `recipes`." }];
  const entry = Object.entries(w.recipes).find(
    ([id, r]) => matchesQuery(arg, r.name || id, r.keywords, id)
  );
  if (!entry) return [{ type: "error", text: `You know no recipe for "${arg}".` }];
  const [rid, r] = entry;
  const label = r.name || rid;
  if (!(player.knownRecipes || []).includes(rid))
    return [{ type: "error", text: `You don't know how to make ${label}.` }];
  // Must be at a fixture providing the recipe's station.
  const rt = state.rooms[player.location];
  const hasStation = rt.fixtures.some((f) => w.fixtures[f.template] && w.fixtures[f.template].station === r.station);
  if (!hasStation) return [{ type: "error", text: `You need ${stationLabel(w, r.station)} to make ${label}.` }];
  // Check material inputs and shard cost before consuming anything.
  for (const inp of r.inputs || []) {
    const need = inp.qty || 1;
    const have = countItem(player, inp.template);
    if (have < need)
      return [{ type: "error", text: `You need ${need}× ${w.items[inp.template].name} (you have ${have}).` }];
  }
  const cost = r.shards || 0;
  if ((player.shards || 0) < cost)
    return [{ type: "error", text: `You need ${cost} shards (you have ${player.shards || 0}).` }];
  // Consume, then produce.
  for (const inp of r.inputs || []) removeItem(player, inp.template, inp.qty || 1);
  if (cost) player.shards -= cost;
  addToInventory(player, makeItemInstance({ template: r.output.template, qty: r.output.qty || 1 }, w), w);
  const qmsgs = quests.noteAcquire(state, player, r.output.template);
  const outName = w.items[r.output.template].name;
  ctx.toRoom(player.location, { type: "log", text: `${player.name} works at ${stationLabel(w, r.station)}.` }, player.id);
  ctx.refreshRoom(player.location, player.id);
  // Crafting XP = the output's sale value × quantity: it scales with the worth of
  // what you made (and thus the rarity/cost of its inputs), so spamming a cheap
  // recipe pays almost nothing. Award before building views so XP shows current.
  const xp = sellValueOf(w.items[r.output.template]) * (r.output.qty || 1);
  const ups = xp ? state.awardXp(player, xp) : [];
  const msgs = selfAndViews(state, player, `You craft ${outName}.${cost ? ` (−${cost} shards)` : ""}${xp ? ` (+${xp} xp)` : ""}`);
  announceLevelUps(player, ups, ctx, msgs);
  msgs.push(...qmsgs);
  return msgs;
}

// Order a recipe list by what it outputs: worn gear first (by slot, weapon →
// armour → trinket → light), then consumables, then raw materials, then the
// rest. Keeps the list reading top-to-bottom from "things you wield" to "things
// you stockpile" rather than in arbitrary definition order.
const CRAFT_SLOT_ORDER = ["hand", "body", "head", "neck", "finger", "light"];
function craftSortKey(item) {
  const s = CRAFT_SLOT_ORDER.indexOf(item.slot);
  if (s >= 0) return s;
  if (item.type === "consumable") return CRAFT_SLOT_ORDER.length;
  if (item.type === "material") return CRAFT_SLOT_ORDER.length + 2;
  return CRAFT_SLOT_ORDER.length + 1;
}

// Can the player pay a recipe's inputs (components + shards) right now? Used
// only to grey the list — `craft` re-checks before consuming anything.
function canAfford(player, r) {
  for (const inp of r.inputs || [])
    if (countItem(player, inp.template) < (inp.qty || 1)) return false;
  return (player.shards || 0) >= (r.shards || 0);
}

function recipes(state, player) {
  const w = state.world;
  const known = player.knownRecipes || [];
  if (!known.length) return [{ type: "log", text: "You know no recipes." }];
  const here = new Set(state.rooms[player.location].fixtures.map((f) => w.fixtures[f.template] && w.fixtures[f.template].station));
  const recs = known.map((rid) => w.recipes[rid]).filter(Boolean);
  // Plain code-unit compare for the name tiebreak — `localeCompare` pulls in the
  // host locale's collation, which on some machines sorts the "ch" digraph after
  // "h" (Czech-style) and scrambles names like Chitin vs Glimmersteel.
  const byName = (a, b) => {
    const na = a.name || a.id, nb = b.name || b.id;
    return na < nb ? -1 : na > nb ? 1 : 0;
  };
  recs.sort((a, b) =>
    craftSortKey(w.items[a.output.template]) - craftSortKey(w.items[b.output.template]) ||
    byName(a, b));
  // One line per recipe; greyed (via `<#gray>` markup) when you lack the
  // components/shards to make it. In the "elsewhere" block the station you'd
  // need is appended, since those recipes span different stations.
  // Affordable recipes lead with a green name; ones you can't make yet read fully
  // grey (the station you'd need is appended in the "Elsewhere" block).
  const fmt = (r, withStation) => {
    const ins = (r.inputs || []).map((i) => `${i.qty || 1}× ${w.items[i.template].name}`);
    if (r.shards) ins.push(`${r.shards} shards`);
    const where = withStation ? ` — at ${stationLabel(w, r.station)}` : "";
    const name = r.name || r.id;
    const rest = `: ${ins.join(", ")} → ${w.items[r.output.template].name}${where}`;
    return canAfford(player, r) ? `  <#green>${name}<#reset>${rest}` : `<#gray>  ${name}${rest}<#reset>`;
  };
  const hereRecs = recs.filter((r) => here.has(r.station));
  const awayRecs = recs.filter((r) => !here.has(r.station));
  const lines = ["<#gold>Recipes<#reset>"];
  if (hereRecs.length) lines.push("", "<#cyan>Here<#reset>", ...hereRecs.map((r) => fmt(r, false)));
  if (awayRecs.length) lines.push("", "<#cyan>Elsewhere<#reset>", ...awayRecs.map((r) => fmt(r, true)));
  return [{ type: "log", text: lines.join("\n") }];
}

// `mine` / `gather` / `fish` all pull a resource from a charged fixture and
// differ only in flavour and which flag the fixture carries (`mine`, `harvest`,
// `fish`). Players don't know the flag — they reach for the verb the *thing*
// suggests (`gather moss`, though moss is a `mine` fixture; `mine` a mushroom
// bed). So when a resource verb has nothing of its own kind to work, it hands
// the room off to the sibling verb that does. The handler table is filled in
// after all three are declared (see resourceHandlers, below `fish`).
const RESOURCE_KINDS = ["mine", "harvest", "fish"];
const resourceHandlers = {}; // { mine, harvest: gather, fish } — wired up below.

// Visible fixtures in the player's room that carry the given resource flag.
function resourceFixtures(state, player, kind) {
  const w = state.world;
  return state.rooms[player.location].fixtures.filter(
    (f) => w.fixtures[f.template] && w.fixtures[f.template][kind] && fixtureVisibleTo(player, f)
  );
}

// Does `arg` (lower-cased) name this fixture, by template id or display name?
function fixtureMatchesArg(state, f, ql) {
  const ft = state.world.fixtures[f.template];
  return f.template.toLowerCase().includes(ql) || ft.name.toLowerCase().includes(ql);
}

// When a resource verb can't satisfy `arg` (or has none of its own kind here),
// pick the sibling handler that should run instead — or null to let the caller
// proceed with its own logic / error. The caller checks its own kind first, so
// this only ever delegates work the player's verb wouldn't otherwise do.
function resourceRedirect(state, player, arg, selfKind) {
  const ql = arg ? arg.toLowerCase() : null;
  const others = RESOURCE_KINDS.filter((k) => k !== selfKind)
    .map((k) => ({ kind: k, fixtures: resourceFixtures(state, player, k) }))
    .filter((o) => o.fixtures.length);
  if (!others.length) return null;
  if (ql) {
    // With an arg, redirect only when it actually names a sibling-kind fixture.
    const hit = others.find((o) => o.fixtures.some((f) => fixtureMatchesArg(state, f, ql)));
    return hit ? resourceHandlers[hit.kind] : null;
  }
  // No arg: redirect only when exactly one sibling kind is present, so e.g.
  // bare `gather` in a room that holds only an ore vein is unambiguous.
  return others.length === 1 ? resourceHandlers[others[0].kind] : null;
}

// `mine` (alias `dig`): work ore loose from a resource vein in the room. Veins
// hold a few charges and refill on a timer (see state._mineTick). Each swing
// spends energy, so a seam can't be stripped in a single tick. Bare-handed for
// now — a pickaxe may speed or improve the yield in a later pass.
function mine(state, player, arg, ctx) {
  const w = state.world;
  const rt = state.rooms[player.location];
  if (!canSee(player.perception, rt.light))
    return [{ type: "error", text: "It is too dark to find anything worth mining." }];
  const veins = resourceFixtures(state, player, "mine");
  // Hand off to gather/fish when the player named something that isn't a vein,
  // or there's nothing to mine here at all, so the wrong-verb instinct lands.
  const ownMatch = arg && veins.some((f) => fixtureMatchesArg(state, f, arg.toLowerCase()));
  if (!ownMatch && (!veins.length || arg)) {
    const redirect = resourceRedirect(state, player, arg, "mine");
    if (redirect) return redirect(state, player, arg, ctx);
  }
  if (!veins.length) return [{ type: "error", text: "There is nothing to mine here." }];
  let f;
  if (arg) {
    const ql = arg.toLowerCase();
    f = veins.find((v) => v.template.toLowerCase().includes(ql) || w.fixtures[v.template].name.toLowerCase().includes(ql));
    if (!f) return [{ type: "error", text: `There is no "${arg}" to mine here.` }];
  } else if (veins.length === 1) {
    f = veins[0];
  } else {
    return [{ type: "error", text: `Mine what? ${veins.map((v) => w.fixtures[v.template].name).join(", ")}.` }];
  }
  const ft = w.fixtures[f.template];
  if (f.charges <= 0)
    return [{ type: "error", text: `The seam is worked out for now — nothing more will come loose until it recovers.` }];
  const cost = ft.mine.energy || player.speed; // ~one tick's worth of effort per swing
  if (player.energy < cost)
    return [{ type: "error", text: "You are too spent to swing again just yet." }];
  player.energy -= cost;
  f.charges -= 1;
  const qty = ft.mine.yield || 1;
  addToInventory(player, makeItemInstance({ template: ft.mine.template, qty }, w), w);
  const qmsgs = quests.noteAcquire(state, player, ft.mine.template);
  const oreName = w.items[ft.mine.template].name;
  ctx.toRoom(player.location, { type: "log", text: `${player.name} works ${oreName} from ${ft.name}.` }, player.id);
  ctx.refreshRoom(player.location, player.id);
  const thin = f.charges <= 0 ? " The seam runs thin and gives no more." : "";
  const out = selfAndViews(state, player, `You work ${oreName} loose.${thin}`);
  out.push(...qmsgs);
  return out;
}

// `gather` (alias `forage`): pick by hand from a harvestable fixture — a glowing
// mushroom cluster, say. Shares the charged-harvest rhythm of `mine`/`fish` (the
// fixture holds a few crops that deplete and regrow on a timer, see
// state._mineTick) but reads as plucking, not digging — no pick required.
function gather(state, player, arg, ctx) {
  const w = state.world;
  const rt = state.rooms[player.location];
  if (!canSee(player.perception, rt.light))
    return [{ type: "error", text: "It is too dark to find anything worth gathering." }];
  const beds = resourceFixtures(state, player, "harvest");
  // Hand off to mine/fish when the named target isn't a bed, or there's nothing
  // to gather here — so `gather` works on an ore vein or fishing water too.
  const ownMatch = arg && beds.some((f) => fixtureMatchesArg(state, f, arg.toLowerCase()));
  if (!ownMatch && (!beds.length || arg)) {
    const redirect = resourceRedirect(state, player, arg, "harvest");
    if (redirect) return redirect(state, player, arg, ctx);
  }
  if (!beds.length) return [{ type: "error", text: "There is nothing here to gather." }];
  let f;
  if (arg) {
    const ql = arg.toLowerCase();
    f = beds.find((v) => v.template.toLowerCase().includes(ql) || w.fixtures[v.template].name.toLowerCase().includes(ql));
    if (!f) return [{ type: "error", text: `There is no "${arg}" to gather here.` }];
  } else if (beds.length === 1) {
    f = beds[0];
  } else {
    return [{ type: "error", text: `Gather what? ${beds.map((v) => w.fixtures[v.template].name).join(", ")}.` }];
  }
  const ft = w.fixtures[f.template];
  const h = ft.harvest;
  if (f.charges <= 0)
    return [{ type: "error", text: `${ft.name} has been picked clean — give it time to grow back.` }];
  const cost = h.energy || player.speed; // ~one tick's worth of effort per pick
  if (player.energy < cost)
    return [{ type: "error", text: "You are too spent to forage just now." }];
  player.energy -= cost;
  f.charges -= 1;
  const qty = h.yield || 1;
  addToInventory(player, makeItemInstance({ template: h.template, qty }, w), w);
  const qmsgs = quests.noteAcquire(state, player, h.template);
  const itemName = w.items[h.template].name;
  const verb = h.verb || "gather";
  ctx.toRoom(player.location, { type: "log", text: `${player.name} ${verb}s ${itemName} from ${ft.name}.` }, player.id);
  ctx.refreshRoom(player.location, player.id);
  const bare = f.charges <= 0 ? " That is the last of them — the cluster is bare." : "";
  const out = selfAndViews(state, player, `You ${verb} ${itemName}.${bare}`);
  out.push(...qmsgs);
  return out;
}

// `fish` (alias `angle`): work a baited line in fishing water. Mirrors `mine` —
// the water holds a stock of catches that depletes and refills on a timer (see
// state._mineTick, which recovers `fish` fixtures too) — but a cast also spends a
// grub as bait, lost to the water whether or not anything takes it.
function fish(state, player, arg, ctx) {
  const w = state.world;
  const rt = state.rooms[player.location];
  if (!canSee(player.perception, rt.light))
    return [{ type: "error", text: "It is too dark to find the water, let alone fish it." }];
  const pools = resourceFixtures(state, player, "fish");
  // Hand off to mine/gather when the named target isn't water, or there's none
  // here — so a misplaced `fish` on a vein or mushroom bed still does the work.
  const ownMatch = arg && pools.some((f) => fixtureMatchesArg(state, f, arg.toLowerCase()));
  if (!ownMatch && (!pools.length || arg)) {
    const redirect = resourceRedirect(state, player, arg, "fish");
    if (redirect) return redirect(state, player, arg, ctx);
  }
  if (!pools.length) return [{ type: "error", text: "There is no water to fish here." }];
  let f;
  if (arg) {
    const ql = arg.toLowerCase();
    f = pools.find((v) => v.template.toLowerCase().includes(ql) || w.fixtures[v.template].name.toLowerCase().includes(ql));
    if (!f) return [{ type: "error", text: `There is no "${arg}" to fish here.` }];
  } else if (pools.length === 1) {
    f = pools[0];
  } else {
    return [{ type: "error", text: `Fish where? ${pools.map((v) => w.fixtures[v.template].name).join(", ")}.` }];
  }
  const ft = w.fixtures[f.template];
  const spec = ft.fish;
  if (f.charges <= 0)
    return [{ type: "error", text: "The water is fished out for now — nothing is biting until it recovers." }];
  const bait = spec.bait || "grub";
  if (countItem(player, bait) < 1)
    return [{ type: "error", text: `You have no bait — you need ${w.items[bait].name} to work the line.` }];
  const cost = spec.energy || player.speed; // ~one tick's worth of effort per cast
  if (player.energy < cost)
    return [{ type: "error", text: "You are too spent to work the line just yet." }];
  player.energy -= cost;
  removeItem(player, bait, 1); // bait is lost to the water, catch or no
  const chance = spec.catchChance != null ? spec.catchChance : 1;
  if (Math.random() >= chance) {
    ctx.refreshRoom(player.location, player.id);
    return selfAndViews(state, player, "Something worries the bait off your line and is gone before you can pull. The line comes up bare.");
  }
  f.charges -= 1;
  const qty = spec.yield || 1;
  addToInventory(player, makeItemInstance({ template: spec.template, qty }, w), w);
  const qmsgs = quests.noteAcquire(state, player, spec.template);
  const catchName = w.items[spec.template].name;
  ctx.toRoom(player.location, { type: "log", text: `${player.name} hauls ${catchName} from ${ft.name}.` }, player.id);
  ctx.refreshRoom(player.location, player.id);
  const fishedOut = f.charges <= 0 ? " The water goes still; nothing more is biting for now." : "";
  const out = selfAndViews(state, player, `You hook ${catchName} and swing it ashore.${fishedOut}`);
  out.push(...qmsgs);
  return out;
}

// Wire the resource verbs to their fixture flags now that all three exist, so
// resourceRedirect can hand off between them (see RESOURCE_KINDS, above `mine`).
resourceHandlers.mine = mine;
resourceHandlers.harvest = gather;
resourceHandlers.fish = fish;

// Colour markup (`<#name>…`, see client renderMarkup) is authored-content only.
// Strip it from anything a player types so chat/emotes can't inject colours.
function stripMarkup(s) {
  return String(s).replace(/<#[a-z0-9-]+>/gi, "");
}

function say(state, player, text, ctx) {
  if (!text) return [{ type: "error", text: "Say what?" }];
  text = stripMarkup(text);
  ctx.toRoom(player.location, { type: "log", text: `${player.name} says: ${text}` }, player.id);
  return [{ type: "log", text: `You say: ${text}` }];
}

function emote(state, player, text, ctx) {
  if (!text) return [{ type: "error", text: "Emote what?" }];
  text = stripMarkup(text);
  const line = `${player.name} ${text}`;
  ctx.toRoom(player.location, { type: "log", text: line }, player.id);
  return [{ type: "log", text: line }];
}

function lookAt(state, player, arg) {
  const view = buildExamineView(state, player, arg);
  if (!view) return [{ type: "error", text: `You see no "${arg}" here.` }];
  return [{ type: "log", text: `You examine ${view.entity.name}.` }, view];
}

// Set a pending attack on a mob in the room; swings resolve on ticks as energy
// allows (see state.resolveCombat). You can only target what you can perceive.
function attack(state, player, arg) {
  if (!arg) return [{ type: "error", text: "Attack what?" }];
  const woke = autoStand(player); // you spring to your feet before swinging (and regain sight)
  const mob = findMobInRoom(state, player, arg);
  if (!mob) return [{ type: "error", text: `You see no "${arg}" here to attack.` }];
  player.pending = { type: "attack", targetId: mob.id };
  const ready = { type: "combat", text: `You ready your attack on ${state.world.mobs[mob.template].name}.` };
  // Switch the Inspect window to the target the instant you engage, rather than
  // waiting for the first swing to resolve on a later tick — combat then keeps
  // this view refreshed each swing (see the attack event in index.js). Returns
  // null in the dark, where there is nothing to pin.
  const view = buildExamineView(state, player, mob.id);
  const out = woke ? [{ type: "log", text: "You scramble to your feet." }, ready] : [ready];
  if (view) out.push(view);
  return out;
}

// `search`: comb the current room for hidden features (exits, stashes, fixtures,
// lurkers). Effective Perception — your attribute scaled by how well you see the
// room (the combat light tiers) — gates what you turn up, so light is required to
// search well. Costs a slice of energy so it competes with acting in combat.
function search(state, player, ctx) {
  if (player.energy < SEARCH_COST)
    return [{ type: "error", text: "You need a moment to catch your breath before searching again." }];
  player.energy -= SEARCH_COST;
  const { found, any } = state.search(player);
  ctx.toRoom(player.location, { type: "log", text: `${player.name} searches around.` }, player.id);
  if (!any) return selfAndViews(state, player, "You search the area, but find nothing you didn't already know.");
  ctx.refreshRoom(player.location, player.id); // a revealed lurker may now be visible to others too
  return selfAndViews(state, player, `You search the area. You discover ${found.join(", ")}!`);
}

// `learn <scroll|schematic>` (alias `study`): commit a scroll's spell or a
// schematic's recipe to memory, consuming the item — one item, one permanent
// thing learned. Scrolls teach spells (`scroll.spell`); recipe items teach
// recipes (`recipe`); a book (`teaches`) can teach several of each at once.
// All follow the same consume-on-study flow.
function learn(state, player, arg, ctx) {
  const w = state.world;
  if (!arg) return [{ type: "error", text: "Learn what? Study a scroll or schematic you're carrying." }];
  const idx = findItem(player.inventory, w, arg);
  if (idx < 0) return [{ type: "error", text: `You aren't carrying "${arg}".` }];
  const inst = player.inventory[idx];
  const t = w.items[inst.template];

  // Consume one of the item and report what was learned.
  const consume = (line) => {
    if (inst.qty != null && inst.qty > 1) inst.qty -= 1;
    else player.inventory.splice(idx, 1);
    ctx.toRoom(player.location, { type: "log", text: `${player.name} studies ${t.name}.` }, player.id);
    ctx.refreshRoom(player.location, player.id);
    return selfAndViews(state, player, line);
  };

  // A book teaches a list of recipes and/or spells. We learn every entry we
  // don't already know, skipping the rest; if the book holds nothing new, it
  // isn't consumed. A short summary names what was learned (and what was old).
  if (t.teaches) {
    const recipeIds = t.teaches.recipes || [];
    const spellIds = t.teaches.spells || [];
    if (!player.knownRecipes) player.knownRecipes = [];
    if (!player.knownSpells) player.knownSpells = [];
    const learned = [];
    const knew = [];
    for (const rid of recipeIds) {
      const r = w.recipes[rid];
      if (!r) return [{ type: "error", text: `${t.name} describes a method you can't make sense of.` }];
      if (player.knownRecipes.includes(rid)) { knew.push(r.name || rid); continue; }
      player.knownRecipes.push(rid);
      learned.push(r.name || rid);
    }
    for (const sid of spellIds) {
      const spell = w.spells[sid];
      if (!spell) return [{ type: "error", text: `${t.name} is inscribed with a spell you can't decipher.` }];
      if (player.knownSpells.includes(sid)) { knew.push(spell.name); continue; }
      player.knownSpells.push(sid);
      learned.push(spell.name);
    }
    if (!learned.length)
      return [{ type: "error", text: `You already know everything ${t.name} has to teach.` }];
    let line = `You study ${t.name} and learn ${joinList(learned)}.`;
    if (knew.length) line += ` (You already knew ${joinList(knew)}.)`;
    return consume(line);
  }

  if (t.scroll && t.scroll.spell) {
    const spell = w.spells[t.scroll.spell];
    if (!spell) return [{ type: "error", text: `${t.name} is inscribed with a spell you can't decipher.` }];
    if (!player.knownSpells) player.knownSpells = [];
    if (player.knownSpells.includes(t.scroll.spell))
      return [{ type: "error", text: `You already know ${spell.name}.` }];
    player.knownSpells.push(t.scroll.spell);
    return consume(`You study ${t.name} and learn ${spell.name}. The scroll crumbles to ash. Cast it with \`cast ${t.scroll.spell} <target>\`.`);
  }

  if (t.recipe) {
    const r = w.recipes[t.recipe];
    if (!r) return [{ type: "error", text: `${t.name} describes a method you can't make sense of.` }];
    if (!player.knownRecipes) player.knownRecipes = [];
    if (player.knownRecipes.includes(t.recipe))
      return [{ type: "error", text: `You already know how to make ${r.name || t.recipe}.` }];
    player.knownRecipes.push(t.recipe);
    return consume(`You study ${t.name} and learn to craft ${r.name || t.recipe}. Make it with \`craft ${(r.name || t.recipe).toLowerCase()}\` at the right station.`);
  }

  return [{ type: "error", text: `There is nothing to learn from ${t.name}.` }];
}

function spellList(state, player) {
  const w = state.world;
  const known = player.knownSpells || [];
  if (!known.length) return [{ type: "log", text: "You know no spells. Study a scroll to learn one." }];
  const lines = ["<#gold>Spells<#reset>", ""];
  for (const id of known) {
    const s = w.spells[id];
    if (!s) continue;
    let tail = "";
    const e = s.effect || {};
    if (e.type === "damage") {
      const bonus = e.scale ? spellScaleBonus(effectiveAttributes(w, player), e.scale) : 0;
      tail = ` — ${e.damage} ${bonus ? `+${bonus} ` : ""}${e.damageType || "physical"} damage` +
        (e.scale ? ` (${e.scale.attr}/${e.scale.per})` : "");
    }
    else if (e.type === "heal-over-time")
      tail = ` — heals ${e.magnitude || 0}${e.scale ? `+${e.scale.attr}/${e.scale.per}` : ""} HP every ${e.interval || 1} tick${(e.interval || 1) === 1 ? "" : "s"} for ${e.duration || 0}`;
    else if (e.type === "protect") {
      const parts = [];
      if (e.armour) parts.push(`armour ${fmtAmount(e.armour)}`);
      if (e.ward) parts.push(`ward ${fmtAmount(e.ward)}`);
      tail = ` — ${parts.join(", ")} for ${fmtTicks(e.duration || 0)}`;
    }
    else if (e.type === "damage-over-time") {
      const dur = (e.duration || 0) + durationScaleBonus(effectiveAttributes(w, player), e.durationScale);
      const ds = e.durationScale ? ` (${e.durationScale.attr})` : "";
      tail = ` — ${e.damage} ${e.damageType || "magical"} burn per tick for ${dur}${ds}${e.emitLight ? `, sheds ${e.emitLight} light` : ""} (resisted by Ward)`;
    }
    else if (e.type === "damage-room") {
      const bonus = e.scale ? spellScaleBonus(effectiveAttributes(w, player), e.scale) : 0;
      tail = ` — ${e.damage} ${bonus ? `+${bonus} ` : ""}${e.damageType || "magical"} to every foe in the room` +
        (e.scale ? ` (${e.scale.attr}/${e.scale.per})` : "");
    }
    else if (e.type === "emit-light")
      tail = ` — sheds ${e.magnitude || 1} light for ${fmtTicks(e.duration || 0)}`;
    else if (e.type === "sleep")
      tail = ` — lulls a foe to sleep (resisted by Ward, broken by any blow)`;
    else if (e.type === "summon") {
      const sm = w.mobs[e.mob];
      const life = (e.duration || 0) + durationScaleBonus(effectiveAttributes(w, player), e.durationScale);
      const span = life ? ` for ${fmtTicks(life)}${e.durationScale ? ` (${e.durationScale.attr})` : ""}` : "";
      tail = ` — conjures ${sm ? sm.name : e.mob}${span}`;
    }
    // Material components (e.g. a chitin plate for Glimmer Husk) are listed after mana/shards as `name (qty)`.
    const comps = (s.itemCost || []).map((c) => `${w.items[c.template] ? w.items[c.template].name : c.template} (${c.qty || 1})`);
    const cost = [`${s.manaCost || 0} mana`, s.shardCost ? `${s.shardCost} shards` : null, ...comps].filter(Boolean).join(" + ");
    lines.push(`  <#green>${s.name}<#reset>: ${cost}${tail}`);
  }
  lines.push("", `<#gray>Mana: ${Math.floor(player.mana || 0)}/${player.maxMana}.<#reset>`);
  return [{ type: "log", text: lines.join("\n") }];
}

// `cast <spell> [at] <target>`: spend mana to hurl a known spell at a creature
// you can perceive. Resolution (Ward resist, Intellect-scaled damage, threat,
// kill) lives in state.castSpell; this handles targeting and narration.
function cast(state, player, arg, ctx) {
  const w = state.world;
  if (!arg) return [{ type: "error", text: "Cast what? Try `spells`." }];
  const tokens = arg.trim().split(/\s+/);
  // Match the longest leading run of tokens that names a known spell (spell
  // names are usually one word); the remainder is the target.
  const known = player.knownSpells || [];
  let spellId = null;
  let rest = tokens.slice();
  for (let n = Math.min(3, tokens.length); n >= 1 && !spellId; n--) {
    const phrase = tokens.slice(0, n).join(" ").toLowerCase();
    const hit = known.find((id) => {
      const s = w.spells[id];
      return s && matchesQuery(phrase, s.name, s.keywords, id);
    });
    if (hit) { spellId = hit; rest = tokens.slice(n); }
  }
  if (!spellId) return [{ type: "error", text: `You don't know any spell called "${tokens[0]}". Try \`spells\`.` }];
  const spell = w.spells[spellId];
  if (rest[0] && rest[0].toLowerCase() === "at") rest = rest.slice(1); // `cast spark at lightbug`
  const targetQ = rest.join(" ");

  // Mana, shards, and any material component are priced in one place (state.costShortfall);
  // refuse here, before anything is spent, if the caster can't pay.
  const short = state.costShortfall(player, spell);
  if (short) return [{ type: "error", text: short }];

  autoStand(player); // rouse before casting, so a sleeping caster regains sight to aim

  // Summon spells are self-centred (no creature target) — conjure at the caster.
  if (spell.effect && spell.effect.type === "summon") return castSummon(state, player, spell, ctx);

  // Beneficial spells (no `hostile` flag) mend rather than harm — they have their
  // own targeting (self by default, an ally delver, or any creature in the room).
  if (!spell.hostile) return castSupport(state, player, spell, targetQ, ctx);

  // Area spells (Arc Flash) blast every eligible foe in the room at once — no single
  // target to name. Eligibility/narration live in castBurst.
  if (spell.effect && spell.effect.type === "damage-room") return castBurst(state, player, spell, ctx);

  if (!targetQ) return [{ type: "error", text: `Cast ${spell.name} at what?` }];
  const mob = findMobInRoom(state, player, targetQ, false);
  if (!mob) return [{ type: "error", text: `You see no "${targetQ}" here to target.` }];

  const mt = w.mobs[mob.template];
  const verb = spell.name.toLowerCase();
  const res = state.castSpell(player, spell, mob);

  if (res.resisted) {
    ctx.toRoom(player.location, { type: "combat", text: `${player.name}'s ${verb} crackles against ${mt.name} and fizzles.` }, player.id);
    ctx.refreshRoom(player.location, player.id);
    return selfAndViews(state, player, `You cast ${spell.name} at ${mt.name}, but its ward turns the bolt aside.`, "combat");
  }

  if (res.slept) {
    // Don't let the caster's own queued swing instantly rouse the sleeper.
    if (player.pending && player.pending.targetId === mob.id) player.pending = null;
    ctx.toRoom(player.location, { type: "combat", text: `${player.name} weaves a drowsy hush over ${mt.name}, and it sinks into slumber.` }, player.id);
    ctx.refreshRoom(player.location, player.id);
    return selfAndViews(state, player, `You weave ${spell.name} over ${mt.name}; its limbs go slack and it sinks into a deep slumber.`, "combat");
  }

  if (res.dot) {
    const span = res.duration ? ` for ${fmtTicks(res.duration)}` : "";
    ctx.toRoom(player.location, { type: "combat", text: `${player.name}'s ${verb} catches on ${mt.name}, and it begins to smoulder.` }, player.id);
    ctx.refreshRoom(player.location, player.id);
    return selfAndViews(state, player, `You set ${spell.name} alight in ${mt.name}; a clinging glimmer-burn takes hold and will gnaw at it${span}.`, "combat");
  }

  if (res.killed) {
    const d = res.death;
    const lootTxt = d.loot && d.loot.length ? ` It leaves behind ${d.loot.join(", ")}.` : "";
    const qmsgs = questKill(state, player, d);
    ctx.toRoom(player.location, { type: "combat", text: `${player.name}'s ${verb} blasts ${mt.name} apart, and it dies.${lootTxt}` }, player.id);
    ctx.refreshRoom(player.location, player.id);
    const out = selfAndViews(
      state, player,
      `Your ${verb} blasts ${mt.name} apart for ${res.damage}! You slay ${mt.name}.${d.xp ? ` (+${d.xp} xp)` : ""}${lootTxt}`,
      "combat"
    );
    out.push(...qmsgs);
    return out;
  }

  ctx.toRoom(player.location, { type: "combat", text: `${player.name} hurls a crackling ${verb} at ${mt.name}.` }, player.id);
  ctx.refreshRoom(player.location, player.id);
  return selfAndViews(state, player, `You hurl ${spell.name} at ${mt.name} for ${res.damage} damage.`, "combat");
}

// Cast a hostile area spell (Arc Flash): sear every eligible foe in the room at once.
// Eligibility mirrors throwBomb — only hostile (or already-engaged) mobs catch the
// burst, so a cast in town won't sear a peaceful shopkeeper, and with nothing to hit
// the cast is refused and the mana kept. Per-target damage, Intellect scaling, threat
// and kills live in state.castRoomSpell; this filters, narrates, and sticks the caster
// to a survivor so they keep swinging (mirrors a single-target hostile cast).
function castBurst(state, player, spell, ctx) {
  const w = state.world;
  const rt = state.rooms[player.location];
  const targets = rt.mobs.filter((m) => {
    const mt = w.mobs[m.template];
    return mt.hostile || (m.aggro && m.aggro[player.id] > 0);
  });
  if (!targets.length)
    return [{ type: "error", text: `There's nothing here for ${spell.name} to catch — best save the mana.` }];

  const verb = spell.name.toLowerCase();
  const results = state.castRoomSpell(player, spell, targets);
  const killed = results.filter((r) => r.killed);
  const hurt = results.filter((r) => !r.killed && r.damage > 0);
  const resisted = results.filter((r) => r.resisted);
  const xp = killed.reduce((s, r) => s + (r.death.xp || 0), 0);
  const loot = killed.flatMap((r) => r.death.loot || []);

  // Keep swinging at any survivor if not already committed (mirrors a hostile cast).
  const survivor = rt.mobs.find((m) => results.some((r) => !r.killed && r.id === m.id));
  if (!player.pending && player.hp > 0 && survivor)
    player.pending = { type: "attack", targetId: survivor.id };

  let outcome = "";
  if (hurt.length) outcome += ` It sears ${hurt.map((r) => `${r.name} for ${r.damage}`).join(", ")}.`;
  if (killed.length) outcome += ` It burns apart ${killed.map((r) => r.name).join(", ")}!${xp ? ` (+${xp} xp)` : ""}`;
  if (resisted.length) outcome += ` ${resisted.map((r) => r.name).join(", ")} ${resisted.length === 1 ? "shrugs" : "shrug"} the burst off, warded.`;
  if (loot.length) outcome += ` They leave behind ${loot.join(", ")}.`;

  const qmsgs = killed.flatMap((r) => questKill(state, player, r.death));
  ctx.toRoom(player.location, { type: "combat", text: `${player.name} looses a blinding ${verb} and the room erupts in white light!` }, player.id);
  ctx.refreshRoom(player.location, player.id);
  const out = selfAndViews(state, player, `You loose ${spell.name}; light floods the chamber.${outcome}`, "combat");
  out.push(...qmsgs);
  return out;
}

// Format a tick count as m:ss for narration (one tick = one second). Mirrors
// render.js's fmtDuration so spoken durations match the status panel countdown.
function fmtTicks(ticks) {
  const s = Math.max(0, ticks | 0);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// Describe a `{ base?, scale? }` amount spec for the `spells` listing, e.g.
// `1+intellect/4` or `intellect`. A bare number renders as itself.
function fmtAmount(spec) {
  if (spec == null) return "0";
  if (typeof spec === "number") return String(spec);
  const sc = spec.scale && spec.scale.attr ? `${spec.scale.attr}${spec.scale.per && spec.scale.per !== 1 ? `/${spec.scale.per}` : ""}` : "";
  if (spec.base && sc) return `${spec.base}+${sc}`;
  return sc || String(spec.base || 0);
}

// Cast a beneficial spell. Resolution (mana, magnitude scaling, applying the
// effect) lives in state.castBeneficial; this resolves the target and narrates.
// Target precedence: an explicit self word (or no target) → the caster; else an
// ally delver in the room; else a creature. Per-pulse effects (Regeneration)
// then surface their healing over the following ticks via `regen-tick` events.
function castSupport(state, player, spell, targetQ, ctx) {
  const w = state.world;
  const rt = state.rooms[player.location];
  const see = canSee(player.perception, rt.light);
  const ql = (targetQ || "").trim().toLowerCase();
  const selfWords = ["", "self", "me", "myself", player.name.toLowerCase()];

  let target = null;
  if (selfWords.includes(ql)) {
    target = { kind: "player", actor: player, id: player.id, name: "yourself", isSelf: true };
  } else {
    const other = [...state.playersIn(player.location)].find(
      (o) => o.id !== player.id && o.hp > 0 && matchesQuery(ql, o.name, null, o.id)
    );
    if (other) {
      if (!see) return [{ type: "error", text: "It is too dark to make out your target." }];
      target = { kind: "player", actor: other, id: other.id, name: other.name };
    } else {
      const mob = rt.mobs.find((m) => {
        const t = w.mobs[m.template];
        return (see || t.emitsLight) && matchesQuery(ql, t.name, t.keywords, m.id);
      });
      if (mob) {
        const mt = w.mobs[mob.template];
        target = { kind: "mob", actor: mob, id: mob.id, name: mt.name, roomId: player.location, emitsLight: !!mt.emitsLight };
      }
    }
  }
  if (!target) return [{ type: "error", text: `You see no "${targetQ}" here to mend.` }];

  const res = state.castBeneficial(player, spell, target);
  const verb = spell.name.toLowerCase();
  const targetName = target.isSelf ? "themselves" : target.name; // for the room's view

  ctx.toRoom(player.location, { type: "log", text: `${player.name} weaves ${verb} over ${targetName}, and a soft light settles in.` }, player.id);
  ctx.refreshRoom(player.location, player.id);

  const onWhom = target.isSelf ? "yourself" : target.name;

  if (res.effect === "restore") {
    const parts = [];
    if (res.restored.hp) parts.push(`${res.restored.hp} health`);
    if (res.restored.mana) parts.push(`${res.restored.mana} mana`);
    const tail = parts.length ? ` restoring ${parts.join(" and ")}` : "";
    return selfAndViews(state, player, `You cast ${spell.name} on ${target.name}${tail}.`);
  }
  if (res.effect === "protect") {
    const parts = [];
    if (res.armour) parts.push(`+${res.armour} armour`);
    if (res.ward) parts.push(`+${res.ward} ward`);
    const grant = parts.length ? parts.join(", ") : "a faint sheen";
    return selfAndViews(state, player, `You cast ${spell.name} on ${onWhom}; a crust of hardened glimmer grants ${grant} for ${fmtTicks(res.duration)}.`);
  }
  if (res.effect === "emit-light") {
    return selfAndViews(state, player, `You cast ${spell.name} on ${onWhom}; a mote of light kindles overhead, shedding ${res.perPulse} light for ${fmtTicks(res.duration)}.`);
  }
  return selfAndViews(state, player, `You cast ${spell.name} on ${onWhom}; ${res.perPulse} HP will knit every ${res.interval} tick${res.interval === 1 ? "" : "s"}.`);
}

// Cast a summon spell. Resolution (mana, recast-replace, conjuring) lives in
// state.castSummon; this narrates. The summon is self-centred — it appears in the
// caster's room and fights autonomously via the faction AI.
function castSummon(state, player, spell, ctx) {
  const w = state.world;
  const res = state.castSummon(player, spell);
  const name = res.mob.name;
  const bare = name.replace(/^an? /i, ""); // "a Wisp" -> "Wisp" for the possessive clause
  // A construct built from a material component (Glimmer Husk) is forged, not conjured.
  const comp = (spell.itemCost || [])[0];
  const compName = comp && w.items[comp.template] ? w.items[comp.template].name.replace(/^an? /i, "") : null;
  if (compName) {
    ctx.toRoom(player.location, { type: "log", text: `${player.name} sets a ${compName} down and works glimmer into it until it shudders and stands: ${name}.` }, player.id);
    ctx.refreshRoom(player.location, player.id);
    const replaced = res.replaced ? ` Your previous ${bare} slumps into dead shell.` : "";
    return selfAndViews(state, player, `You bind raw glimmer into the ${compName}, and ${name} grinds upright to stand watch.${replaced}`);
  }
  ctx.toRoom(player.location, { type: "log", text: `${player.name} traces a binding-glyph, and ${name} coalesces from the gloom.` }, player.id);
  ctx.refreshRoom(player.location, player.id);
  const replaced = res.replaced ? ` Your previous ${bare} unravels into motes.` : "";
  return selfAndViews(state, player, `You weave the glimmer into shape, and ${name} answers your call.${replaced}`);
}

// Attributes a player can raise with banked level-up points.
const TRAINABLE = ["might", "vitality", "intellect", "wits", "perception"];

/** Spend a banked attribute point on `arg`, or — with no arg — report leveling
 *  progress. Raising vitality/intellect lifts the HP/MP cap; the new capacity is
 *  granted immediately (current pools rise by the same delta) so the point is felt
 *  at once, without being a free heal. */
function train(state, player, arg) {
  const pts = player.unspentPoints || 0;
  const attr = (arg || "").trim().toLowerCase();
  if (!attr) {
    const next = xpForLevel((player.level || 1) + 1);
    const ptLine = pts ? `${pts} unspent point${pts === 1 ? "" : "s"} — train: ${TRAINABLE.join(", ")}` : "No unspent points — defeat foes to level up.";
    return [{ type: "log", text: `Level ${player.level} · ${player.xp}/${next} xp.\n${ptLine}` }];
  }
  if (!TRAINABLE.includes(attr)) return [{ type: "error", text: `You can train: ${TRAINABLE.join(", ")}.` }];
  if (pts <= 0) return [{ type: "error", text: "You have no points to spend. Defeat foes to gain levels." }];
  const prevHp = player.maxHp;
  const prevMana = player.maxMana;
  player.attributes[attr] = (player.attributes[attr] || 0) + 1;
  player.unspentPoints = pts - 1;
  state.deriveStats(player); // recompute maxHp/maxMana/sight from the new attribute
  player.hp = Math.min(player.maxHp, player.hp + (player.maxHp - prevHp));
  player.mana = Math.min(player.maxMana, (player.mana || 0) + (player.maxMana - prevMana));
  const left = player.unspentPoints;
  const tail = left ? ` (${left} point${left === 1 ? "" : "s"} left)` : "";
  return selfAndViews(state, player, `You train ${attr} to ${player.attributes[attr]}.${tail}`);
}

// `talk <npc>` (alias `greet`/`ask`): speak with a creature here. Offers any quest
// that NPC has for you and reminds you of deliveries they're owed (see quests.js).
// With no quest business, an NPC with a `react` action answers in character
// (the first reaction matching this player); anyone else just shrugs.
function talk(state, player, arg, ctx) {
  if (!arg) return [{ type: "error", text: "Talk to whom?" }];
  const w = state.world;
  const mob = findMobInRoom(state, player, arg);
  if (!mob) return [{ type: "error", text: `You see no "${arg}" here to talk to.` }];
  const t = w.mobs[mob.template];
  ctx.toRoom(player.location, { type: "log", text: `${player.name} speaks with ${t.name}.` }, player.id);
  const msgs = quests.handleTalk(state, player, mob);
  if (!msgs.length) {
    const r = state.reactToPlayer(mob, player);
    if (r) {
      // Reaction lines may end in quoted speech, so only punctuate when needed
      // (mirrors the mob-react renderer in index.js).
      const punct = (s) => (/["!?.]$/.test(s) ? s : `${s}.`);
      msgs.push({ type: "log", text: punct(`${cap(t.name)} ${r.textTarget}`) });
      ctx.toRoom(player.location, { type: "log", text: punct(`${cap(t.name)} ${r.textRoom.replace(/\{name\}/g, player.name)}`) }, player.id);
    } else {
      msgs.push({ type: "log", text: `${cap(t.name)} has nothing for you right now.` });
    }
  }
  return [...msgs, buildPlayerView(state, player)]; // a taken/auto-advanced quest may change stats
}

// `give <item> [to] <npc>` (alias `deliver`): hand an item to a creature here. If
// it satisfies an active deliver step for that NPC, the items are consumed and the
// quest advances; otherwise the NPC declines and you keep the item.
function give(state, player, arg, ctx) {
  const w = state.world;
  if (!arg) return [{ type: "error", text: "Give what to whom? (give <item> <npc>)" }];
  // Parse "<item> [to] <npc>": a literal " to " splits item/npc; otherwise the
  // last word names the npc and the rest the item.
  let itemQ, npcQ;
  const idx = arg.toLowerCase().indexOf(" to ");
  if (idx >= 0) { itemQ = arg.slice(0, idx).trim(); npcQ = arg.slice(idx + 4).trim(); }
  else { const toks = arg.trim().split(/\s+/); npcQ = toks[toks.length - 1]; itemQ = toks.slice(0, -1).join(" "); }
  if (!itemQ || !npcQ) return [{ type: "error", text: "Give what to whom? (give <item> <npc>)" }];

  const mob = findMobInRoom(state, player, npcQ);
  if (!mob) return [{ type: "error", text: `You see no "${npcQ}" here to give anything to.` }];
  const iidx = findItem(player.inventory, w, itemQ);
  if (iidx < 0) return [{ type: "error", text: `You aren't carrying "${itemQ}".` }];
  const inst = player.inventory[iidx];
  const itemName = w.items[inst.template].name;
  const npcName = w.mobs[mob.template].name;
  const res = quests.handleGive(state, player, mob, inst);
  if (!res.accepted) return [{ type: "error", text: `${cap(npcName)} has no need for ${itemName}.` }];
  ctx.toRoom(player.location, { type: "log", text: `${player.name} hands ${itemName} to ${npcName}.` }, player.id);
  ctx.refreshRoom(player.location, player.id);
  return [...res.msgs, buildRoomView(state, player), buildPlayerView(state, player)];
}

/** Admin-only commands, prefixed with '@'. */
function handleAdmin(state, player, verb, arg, ctx = NOOP_CTX) {
  if (!player.isAdmin) return [{ type: "error", text: "You lack the authority for that." }];
  switch (verb) {
    case "@create-player": {
      const v = accounts.validateName(arg);
      if (!v.ok) return [{ type: "error", text: v.reason }];
      if (accounts.exists(v.name)) return [{ type: "error", text: `A delver named "${v.name}" already exists.` }];
      accounts.save(state.createCharacter(v.name, {}));
      return [{ type: "log", text: `Created delver "${v.name}". They may now log in.` }];
    }
    case "@list-players":
      return [{ type: "log", text: "Delvers: " + (accounts.listNames().join(", ") || "(none)") }];
    case "@shards": {
      const n = parseInt(arg, 10);
      if (!Number.isFinite(n) || n < 0) return [{ type: "error", text: "Usage: @shards <amount>" }];
      player.shards = n;
      return [{ type: "log", text: `Your purse now holds ${n} shards.` }];
    }
    case "@xp": {
      const n = parseInt(arg, 10);
      if (!Number.isFinite(n) || n < 1) return [{ type: "error", text: "Usage: @xp <amount≥1>" }];
      const ups = state.awardXp(player, n); // mirrors a kill's award, level-ups and all
      const out = [{ type: "log", text: `You gain ${n} xp.` }];
      announceLevelUps(player, ups, ctx, out);
      out.push(buildPlayerView(state, player));
      return out;
    }
    case "@attr": {
      const ATTRS = ["might", "vitality", "intellect", "wits", "perception"];
      const [name, raw] = arg.split(/\s+/);
      const attr = (name || "").toLowerCase();
      const n = parseInt(raw, 10);
      if (!ATTRS.includes(attr) || !Number.isFinite(n) || n < 1)
        return [{ type: "error", text: `Usage: @attr <${ATTRS.join("|")}> <value≥1>` }];
      player.attributes[attr] = n;
      state.deriveStats(player); // recompute maxHp/maxMana/sight from the new attributes
      player.hp = Math.min(player.hp, player.maxHp);
      player.mana = Math.min(player.mana || 0, player.maxMana);
      return selfAndViews(state, player, `Your ${attr} is now ${n}.`);
    }
    case "@spawn": {
      // Drop a mob (by template id) into the admin's current room — a testing aid
      // for mobs not yet placed in any room's spawn list. An optional trailing
      // faction (`wild` default, or `player`) marks the spawned instance as a
      // player-allied creature (faction "player" + ownerId = admin) so mob-vs-mob
      // combat can be exercised live; this is a dev affordance, not authored content.
      const [mobId, rawN, rawFaction] = arg.split(/\s+/);
      if (!mobId || !state.world.mobs[mobId])
        return [{ type: "error", text: `Usage: @spawn <mobId> [count] [wild|player]. Unknown mob "${mobId || ""}".` }];
      const faction = (rawFaction || "wild").toLowerCase();
      if (faction !== "wild" && faction !== "player")
        return [{ type: "error", text: `Usage: @spawn <mobId> [count] [wild|player]. Unknown faction "${rawFaction}".` }];
      const n = Math.max(1, Math.min(10, parseInt(rawN, 10) || 1));
      for (let i = 0; i < n; i++) {
        const m = state._spawnMob(player.location, mobId);
        if (faction === "player") { m.faction = "player"; m.ownerId = player.id; }
      }
      state.rooms[player.location].light = state.computeRoomLight(player.location); // a luminous mob lights the room
      const t = state.world.mobs[mobId];
      const Name = t.name.charAt(0).toUpperCase() + t.name.slice(1);
      ctx.toRoom(player.location, { type: "log", text: `${Name} flickers into being.` }, player.id);
      ctx.refreshRoom(player.location, player.id);
      const tag = faction === "player" ? " (player-allied)" : "";
      return selfAndViews(state, player, `Spawned ${n}× ${t.name}${tag} here.`);
    }
    case "@give": {
      // Drop an item (by template id) straight into the admin's pack — a testing
      // aid for gear/consumables/materials you'd otherwise have to craft or grind
      // for. `count` stacks for stackables, else mints that many instances; it is
      // clamped to a sane ceiling.
      const [itemId, rawN] = arg.split(/\s+/);
      if (!itemId || !state.world.items[itemId])
        return [{ type: "error", text: `Usage: @give <itemId> [count]. Unknown item "${itemId || ""}".` }];
      const t = state.world.items[itemId];
      const n = Math.max(1, Math.min(99, parseInt(rawN, 10) || 1));
      if (t.stackable) {
        addToInventory(player, makeItemInstance({ template: itemId, qty: n }, state.world), state.world);
      } else {
        for (let i = 0; i < n; i++) addToInventory(player, makeItemInstance({ template: itemId }, state.world), state.world);
      }
      return selfAndViews(state, player, `Conjured ${n}× ${t.name} into your pack.`);
    }
    case "@help": {
      const lines = ["<#gold>Admin commands<#reset>", ""];
      for (const e of ADMIN_HELP_SECTION[1]) lines.push(helpEntry(e));
      return [{ type: "log", text: lines.join("\n") }];
    }
    default:
      return [{ type: "error", text: `Unknown admin command: "${verb}". Try "@help".` }];
  }
}

// Levenshtein edit distance, bounded use only — VERBS is short. Drives the
// "did you mean?" hint for a mistyped verb that prefix-abbreviation can't catch.
function editDistance(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}

// The known verb closest to a typo, if it's near enough to be worth suggesting.
function closestVerb(verb) {
  let best = null, bestD = Infinity;
  for (const v of VERBS) {
    const d = editDistance(verb, v);
    if (d < bestD) { bestD = d; best = v; }
  }
  return bestD <= 2 ? best : null;
}

function execute(state, player, input, ctx = NOOP_CTX) {
  const parts = (input || "").trim().split(/\s+/);
  let verb = (parts[0] || "").toLowerCase();
  const arg = parts.slice(1).join(" ");
  if (verb.startsWith("@")) return handleAdmin(state, player, verb, arg, ctx);
  if (DIR_ALIAS[verb]) verb = DIR_ALIAS[verb];
  if (DIRS.includes(verb)) return move(state, player, verb, ctx);
  // DikuMUD-style abbreviation: resolve a partial verb to the first command it
  // prefixes (priority order in VERBS). Exact verbs/aliases are left untouched.
  if (verb && !VERB_SET.has(verb)) {
    const hit = VERBS.find((v) => v.startsWith(verb));
    if (hit) verb = hit;
  }

  switch (verb) {
    case "":
      return [];
    case "look":
    case "l":
    case "examine":
    case "exam":
    case "x":
      return arg ? lookAt(state, player, arg) : [buildRoomView(state, player)];
    case "search":
      return search(state, player, ctx);
    case "get":
    case "take":
    case "pickup":
      return get(state, player, arg, ctx);
    case "drop":
      return drop(state, player, arg, ctx);
    case "inventory":
    case "inv":
    case "i":
      return inventory(state, player);
    case "attack":
    case "kill":
    case "k":
      return attack(state, player, arg);
    case "stop":
      player.pending = null;
      return [{ type: "log", text: "You break off your attack." }];
    case "sit":
    case "rest":
      return setPosture(state, player, "sit", ctx);
    case "sleep":
      return setPosture(state, player, "sleep", ctx);
    case "stand":
    case "wake":
    case "wakeup":
      return setPosture(state, player, "stand", ctx);
    case "cast":
    case "c":
      return cast(state, player, arg, ctx);
    case "learn":
    case "study":
      return learn(state, player, arg, ctx);
    case "spells":
      return spellList(state, player);
    case "train":
      return train(state, player, arg);
    case "list":
    case "shop":
    case "wares":
      return shopList(state, player);
    case "buy":
      return buy(state, player, arg, ctx);
    case "sell":
      return sell(state, player, arg, ctx);
    case "drink":
    case "quaff":
      return drink(state, player, arg, ctx, "drink");
    case "eat":
      return drink(state, player, arg, ctx, "eat");
    case "refuel":
    case "fill":
      return refuel(state, player, arg, ctx);
    case "use":
    case "switch":
    case "toggle":
    case "flip":
      return use(state, player, arg, ctx);
    case "throw":
    case "hurl":
    case "lob":
      return drink(state, player, arg, ctx, "throw");
    case "open":
      return operateDoor(state, player, arg, ctx, true);
    case "close":
    case "shut":
      return operateDoor(state, player, arg, ctx, false);
    case "craft":
    case "make":
      return craft(state, player, arg, ctx);
    case "mine":
    case "dig":
      return mine(state, player, arg, ctx);
    case "gather":
    case "forage":
    case "harvest":
    case "pick":
      return gather(state, player, arg, ctx);
    case "fish":
    case "angle":
      return fish(state, player, arg, ctx);
    case "recipes":
      return recipes(state, player);
    case "talk":
    case "greet":
    case "ask":
      return talk(state, player, arg, ctx);
    case "give":
    case "deliver":
      return give(state, player, arg, ctx);
    case "quest":
    case "quests":
    case "journal":
      return quests.log(state, player);
    case "say":
      return say(state, player, arg, ctx);
    case "emote":
    case "me":
      return emote(state, player, arg, ctx);
    case "equip":
    case "wield":
    case "wear":
      return equip(state, player, arg, ctx);
    case "unequip":
    case "remove":
      return unequip(state, player, arg, ctx);
    case "help":
    case "?":
      return [{ type: "log", text: buildHelp(player) }];
    default: {
      const guess = closestVerb(verb);
      const hint = guess ? ` Did you mean "${guess}"?` : ` Try "help".`;
      return [{ type: "error", text: `Unknown command: "${verb}".${hint}` }];
    }
  }
}

module.exports = { execute, DIRS, DIR_ALIAS, HELP };
