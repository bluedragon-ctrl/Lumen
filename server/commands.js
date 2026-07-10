"use strict";
/**
 * Command parsing and execution.
 *
 * Each handler returns an array of messages for the ACTOR. Effects visible to
 * OTHER players in the room (speech, arrivals, picking things up) are sent via
 * `ctx`, a small broadcast context the server supplies:
 *   ctx.toRoom(roomId, msg, exceptId)   — send a raw message to others in a room
 *   ctx.refreshRoom(roomId, exceptId)   — push an updated room view to others
 *
 * This file owns the dispatcher (the command table + `execute`) and the "core"
 * verbs — movement, posture, carried items, social, combat, learn, train. The
 * other domains live in ./commands/*: help, trade, craft, resource, magic,
 * admin, consume (drink/throw/refuel/light sources), fixtures (use/doors),
 * plus the shared helper hub (./commands/shared).
 */
const { buildRoomView, buildPlayerView, buildExamineView } = require("./render");
const { canSee } = require("./light");
const { addToFloor, itemVisibleTo, isDiscovered, discoveryKey, xpForLevel } = require("./state");
const { EXPLORE_XP, DEFAULT_ACTION_COST } = require("./config");
const quests = require("./quests");
const {
  cap, NOOP_CTX, TRAINABLE, selfAndViews, announceLevelUps, autoStand,
  err, logMsg, roomLog, announce, relight, consumeOne,
  parseTarget, itemMatches, findItem, findMobInRoom,
  addToInventory, joinList, equipItem,
} = require("./commands/shared");
const { buildHelp } = require("./commands/help");
const { shopList, buy, sell } = require("./commands/trade");
const { craft, recipes } = require("./commands/craft");
const { mine, gather, fish } = require("./commands/resource");
const { spellList, cast } = require("./commands/magic");
const { handleAdmin } = require("./commands/admin");
const { drink, refuel } = require("./commands/consume");
const { use, operateDoor } = require("./commands/fixtures");

// Searching the room for hidden features costs one action's worth of energy,
// so it competes with attacking and can't be spammed mid-combat.
const SEARCH_COST = DEFAULT_ACTION_COST;

const DIRS = ["north", "south", "east", "west", "up", "down"];
const DIR_ALIAS = { n: "north", s: "south", e: "east", w: "west", u: "up", d: "down" };

// The function keys a player may bind to a command via `alias` (and that the
// client forwards as a bare key token on keypress). F1–F4 only — F5+ are
// reserved by the browser (reload/devtools/fullscreen) and can't be trapped.
const ALIAS_KEYS = ["F1", "F2", "F3", "F4"];

// Every command word the dispatcher understands, in PRIORITY order. A typed verb
// that isn't an exact match resolves to the FIRST entry it is a prefix of
// (DikuMUD-style abbreviation) — so common verbs precede rarer ones that share a
// prefix (e.g. `look` before `list`, `drop` before `drink`, `get`/`g` since there
// is no `go`). Exact matches (incl. single-letter aliases like l/i/k/c
// and directions, handled earlier) always win over prefixes. This list is the
// abbreviation set only; the full verb→handler mapping is COMMANDS (below), and a
// load-time check keeps the two from drifting apart.
const VERBS = [
  "look", "examine", "exam", "search", "get", "take", "pickup", "drop",
  "inventory", "inv", "attack", "kill", "stop", "sit", "sleep", "stand",
  "wake", "wakeup", "cast", "craft", "make", "learn", "study", "spells", "train",
  "list", "shop", "wares", "buy", "sell",
  "drink", "quaff", "eat", "refuel", "fill", "use", "switch", "toggle", "flip",
  "mine", "dig", "gather", "forage", "harvest", "pick", "fish", "angle", "recipes", "say", "emote", "me", "equip", "wield", "wear",
  "talk", "give", "deliver", "quest", "quests", "journal",
  // `rest` (an alias of `sit`) sits late so `re`/`r` favour refuel/remove/recipes.
  "unequip", "remove", "rest", "help", "alias",
  // `quit`/`logout` sit after `quaff` so `q`/`qu` still mean quaff; quitting needs `qui`+.
  "quit", "logout", "logoff",
];
const VERB_SET = new Set([...VERBS, "l", "x", "i", "k", "c", "?"]); // + single-letter aliases

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
  if (!dest) return err(`You can't go ${dir} from here.`);
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
    const Name = cap(f.mobName);
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
  const followTail = followed.length ? ` Your ${followed.map((f) => f.mobName.replace(/^an? /i, "")).join(", ")} follow${followed.length === 1 ? "s" : ""}.` : "";
  // Room effects that fire on entering (a waterfall douses your flame, a ward
  // mends or saps you). Mutate before building the view so it reflects the result
  // (e.g. a doused room reads dark). Mechanical events go out via ctx.emit; the
  // flavour line is folded into the arrival message; bystanders see roomMessage
  // and any dimming.
  let effectTail = "";
  let enterDied = false;
  for (const eff of state.world.rooms[dest].effects || []) {
    if (eff.trigger !== "enter") continue;
    const evs = [];
    const r = state.applyRoomEffect(player, dest, eff, evs);
    evs.forEach((e) => ctx.emit(e));
    if (!r.fired) continue;
    if (eff.message && !r.silent) effectTail += ` ${eff.message}`;
    else if (r.doused) effectTail += " Your light is snuffed out."; // parity with the tick-path default
    if (eff.roomMessage) ctx.toRoom(dest, { type: "log", text: eff.roomMessage }, player.id);
    if (r.doused) ctx.refreshRoom(dest, player.id); // others see the room dim
    if (r.died) { enterDied = true; break; } // _respawn already moved + re-rendered them
  }
  if (enterDied) return []; // death views were emitted; suppress the normal arrival output
  // A room may give a specific exit its own departure line (a chute you slide down,
  // a rope you haul yourself up) in place of the plain "You go <dir>." — flavour only,
  // shown to the mover; the exit still works like any other.
  const goLine = (room.exitMessages && room.exitMessages[dir]) || `You go ${dir}.`;
  const msgs = selfAndViews(state, player, `${goLine}${tail}${followTail}${effectTail}`);
  announceLevelUps(player, ups, ctx, msgs);
  msgs.push(...qmsgs);
  return msgs;
}

function equip(state, player, arg, ctx) {
  const w = state.world;
  if (!arg) return err("Equip what?");
  const idx = findItem(player.inventory, w, arg);
  if (idx < 0) return err(`You aren't carrying "${arg}".`);
  const t = w.items[player.inventory[idx].template];
  if (!t.slot) return err(`You can't equip ${t.name}.`);
  const prevHp = player.maxHp;
  const prevMana = player.maxMana;
  const prev = equipItem(player, player.inventory.splice(idx, 1)[0], w);
  state.deriveStats(player); // gear may carry an armour.maxHp / armour.maxMana bonus
  if (player.maxHp > prevHp) player.hp += player.maxHp - prevHp; // grant the new capacity (like training)
  if (player.maxMana > prevMana) player.mana += player.maxMana - prevMana;
  player.hp = Math.min(player.hp, player.maxHp);
  player.mana = Math.min(player.mana, player.maxMana);
  relight(state, ctx, player);
  const stowed = prev ? `, stowing ${w.items[prev.template].name}` : "";
  const kindled = t.slot === "light" && player.equipment.light && player.equipment.light.lit ? " It kindles, and the dark recedes." : "";
  return selfAndViews(state, player, `You equip ${t.name}${stowed}.${kindled}`);
}

function unequip(state, player, arg, ctx) {
  const w = state.world;
  if (!arg) return err("Remove what?");
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
  if (!inst) return err(`You don't have "${arg}" equipped.`);
  if (inst.lit) inst.lit = false;
  player.equipment[slot] = null;
  player.inventory.push(inst);
  state.deriveStats(player); // shedding gear may drop an armour.maxHp / armour.maxMana bonus
  player.hp = Math.min(player.hp, player.maxHp);
  player.mana = Math.min(player.mana, player.maxMana);
  relight(state, ctx, player);
  return selfAndViews(state, player, `You remove ${w.items[inst.template].name}.`);
}

function get(state, player, arg, ctx) {
  if (!arg) return err("Get what?");
  const w = state.world;
  const rt = state.rooms[player.location];
  if (!canSee(player.perception, rt.light)) return err("It is too dark to find anything.");
  // Undiscovered hidden items aren't pickable by name — you must `search` first.
  const visible = rt.items.filter((i) => itemVisibleTo(state, player, i));
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
    if (!targets.length) return err(keyword ? `There is no "${keyword}" here to get.` : "There is nothing here to get.");
    const qmsgs = [];
    const labels = targets.map((inst) => take(inst, qmsgs));
    announce(ctx, player, `${player.name} gathers up what lies here.`);
    const out = selfAndViews(state, player, `You pick up ${labels.join(", ")}.`);
    out.push(...qmsgs);
    return out;
  }
  const vIdx = findItem(visible, w, arg);
  if (vIdx < 0) return err(`There is no "${arg}" here to get.`);
  const inst = visible[vIdx];
  const isCurrency = w.items[inst.template].type === "currency";
  const qmsgs = [];
  const label = take(inst, qmsgs);
  announce(ctx, player, `${player.name} ${isCurrency ? "gathers" : "picks up"} ${label}.`);
  const tail = isCurrency ? ` (${player.shards} total)` : "";
  const out = selfAndViews(state, player, `You ${isCurrency ? "gather" : "pick up"} ${label}.${tail}`);
  out.push(...qmsgs);
  return out;
}

function drop(state, player, arg, ctx) {
  if (!arg) return err("Drop what?");
  const w = state.world;
  const rt = state.rooms[player.location];
  const { all, keyword } = parseTarget(arg);
  if (all) {
    const targets = itemMatches(player.inventory, w, keyword).map((i) => player.inventory[i]);
    if (!targets.length) return err(keyword ? `You aren't carrying any "${keyword}".` : "You are carrying nothing to drop.");
    const labels = [];
    for (const inst of targets) {
      player.inventory.splice(player.inventory.indexOf(inst), 1);
      addToFloor(rt, inst, w);
      labels.push(w.items[inst.template].name);
    }
    announce(ctx, player, `${player.name} sets down a few things.`);
    return selfAndViews(state, player, `You drop ${labels.join(", ")}.`);
  }
  const idx = findItem(player.inventory, w, arg);
  if (idx < 0) return err(`You aren't carrying "${arg}".`);
  const inst = player.inventory.splice(idx, 1)[0];
  addToFloor(rt, inst, w);
  const name = w.items[inst.template].name;
  announce(ctx, player, `${player.name} drops ${name}.`);
  return selfAndViews(state, player, `You drop ${name}.`);
}

function inventory(state, player) {
  const w = state.world;
  if (!player.inventory.length) return logMsg("You are carrying nothing.");
  const lines = player.inventory.map((i) => {
    const qty = i.qty != null ? ` ×${i.qty}` : "";
    return `  ${w.items[i.template].name}${qty}`;
  });
  return logMsg("You are carrying:\n" + lines.join("\n"));
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
    return logMsg(already[spec.name]);
  }
  if ((key === "sit" || key === "sleep") && player.pending)
    return err("You can't rest in the middle of a fight.");
  const wasSleeping = player.posture === "sleeping";
  player.posture = spec.name;
  player.restTicks = 0;
  announce(ctx, player, spec.room(player.name)); // others see the posture tag change
  const self = key === "stand" && wasSleeping ? "You wake and climb to your feet." : spec.self;
  return selfAndViews(state, player, self);
}

// Colour markup (`<#name>…`, see client renderMarkup) is authored-content only.
// Strip it from anything a player types so chat/emotes can't inject colours.
function stripMarkup(s) {
  return String(s).replace(/<#[a-z0-9-]+>/gi, "");
}

function say(state, player, text, ctx) {
  if (!text) return err("Say what?");
  text = stripMarkup(text);
  roomLog(ctx, player, `${player.name} says: ${text}`);
  return logMsg(`You say: ${text}`);
}

function emote(state, player, text, ctx) {
  if (!text) return err("Emote what?");
  text = stripMarkup(text);
  const line = `${player.name} ${text}`;
  roomLog(ctx, player, line);
  return logMsg(line);
}

function lookAt(state, player, arg) {
  const view = buildExamineView(state, player, arg);
  if (!view) return err(`You see no "${arg}" here.`);
  return [{ type: "log", text: `You examine ${view.entity.name}.` }, view];
}

// Set a pending attack on a mob in the room; swings resolve on ticks as energy
// allows (see state.resolvePlayerAttacks). You can only target what you can perceive.
function attack(state, player, arg) {
  if (!arg) return err("Attack what?");
  const woke = autoStand(player); // you spring to your feet before swinging (and regain sight)
  const mob = findMobInRoom(state, player, arg);
  if (!mob) return err(`You see no "${arg}" here to attack.`);
  player.pending = { type: "attack", targetId: mob.id };
  const ready = { type: "combat", text: `You ready your attack on ${state.world.mobs[mob.template].name}.` };
  // Switch the Inspect window to the target the instant you engage, rather than
  // waiting for the first swing to resolve on a later tick — combat then keeps
  // this view refreshed each swing (see the attack event in events.js). Returns
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
    return err("You need a moment to catch your breath before searching again.");
  player.energy -= SEARCH_COST;
  const { found, any, shared } = state.search(player);
  roomLog(ctx, player, any
    ? `${player.name} searches around and turns up ${found.join(", ")}.`
    : `${player.name} searches around.`);
  // A find is shared with everyone present, so refresh their view whenever the
  // search revealed anything new — to the searcher or to a co-located delver.
  if (any || shared) ctx.refreshRoom(player.location, player.id);
  if (!any) return selfAndViews(state, player, "You search the area, but find nothing you didn't already know.");
  return selfAndViews(state, player, `You search the area. You discover ${found.join(", ")}!`);
}

// `learn <scroll|schematic>` (alias `study`): commit a scroll's spell or a
// schematic's recipe to memory, consuming the item — one item, one permanent
// thing learned. A book (`teaches`) can teach several at once. All three item
// shapes normalise to one {kind, id} list and share the consume-on-study flow;
// an item that holds nothing new isn't consumed.
function learn(state, player, arg, ctx) {
  const w = state.world;
  if (!arg) return err("Learn what? Study a scroll or schematic you're carrying.");
  const idx = findItem(player.inventory, w, arg);
  if (idx < 0) return err(`You aren't carrying "${arg}".`);
  const inst = player.inventory[idx];
  const t = w.items[inst.template];
  const entries = t.teaches
    ? [
        ...(t.teaches.recipes || []).map((id) => ({ kind: "recipe", id })),
        ...(t.teaches.spells || []).map((id) => ({ kind: "spell", id })),
      ]
    : t.scroll && t.scroll.spell
      ? [{ kind: "spell", id: t.scroll.spell }]
      : t.recipe
        ? [{ kind: "recipe", id: t.recipe }]
        : [];
  if (!entries.length) return err(`There is nothing to learn from ${t.name}.`);
  if (!player.knownRecipes) player.knownRecipes = [];
  if (!player.knownSpells) player.knownSpells = [];
  const learned = [];
  const knew = [];
  for (const e of entries) {
    const def = e.kind === "spell" ? w.spells[e.id] : w.recipes[e.id];
    if (!def)
      return err(e.kind === "spell"
        ? `${t.name} is inscribed with a spell you can't decipher.`
        : `${t.name} describes a method you can't make sense of.`);
    const known = e.kind === "spell" ? player.knownSpells : player.knownRecipes;
    e.name = def.name || e.id;
    if (known.includes(e.id)) { knew.push(e.name); continue; }
    known.push(e.id);
    learned.push(e.name);
  }
  if (!learned.length) {
    if (t.teaches) return err(`You already know everything ${t.name} has to teach.`);
    return err(entries[0].kind === "spell"
      ? `You already know ${entries[0].name}.`
      : `You already know how to make ${entries[0].name}.`);
  }
  let line;
  if (t.teaches) {
    line = `You study ${t.name} and learn ${joinList(learned)}.`;
    if (knew.length) line += ` (You already knew ${joinList(knew)}.)`;
  } else if (entries[0].kind === "spell") {
    line = `You study ${t.name} and learn ${entries[0].name}. The scroll crumbles to ash. Cast it with \`cast ${entries[0].id} <target>\`.`;
  } else {
    line = `You study ${t.name} and learn to craft ${entries[0].name}. Make it with \`craft ${entries[0].name.toLowerCase()}\` at the right station.`;
  }
  consumeOne(player, inst);
  announce(ctx, player, `${player.name} studies ${t.name}.`);
  return selfAndViews(state, player, line);
}

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
    return logMsg(`Level ${player.level} · ${player.xp}/${next} xp.\n${ptLine}`);
  }
  if (!TRAINABLE.includes(attr)) return err(`You can train: ${TRAINABLE.join(", ")}.`);
  if (pts <= 0) return err("You have no points to spend. Defeat foes to gain levels.");
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
  if (!arg) return err("Talk to whom?");
  const w = state.world;
  const mob = findMobInRoom(state, player, arg);
  if (!mob) return err(`You see no "${arg}" here to talk to.`);
  const t = w.mobs[mob.template];
  roomLog(ctx, player, `${player.name} speaks with ${t.name}.`);
  const msgs = quests.handleTalk(state, player, mob);
  if (!msgs.length) {
    const r = state.reactToPlayer(mob, player);
    if (r) {
      // Reaction lines may end in quoted speech, so only punctuate when needed
      // (mirrors the mob-react renderer in events.js).
      const punct = (s) => (/["!?.]$/.test(s) ? s : `${s}.`);
      msgs.push({ type: "log", text: punct(`${cap(t.name)} ${r.textTarget}`) });
      roomLog(ctx, player, punct(`${cap(t.name)} ${r.textRoom.replace(/\{name\}/g, player.name)}`));
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
  if (!arg) return err("Give what to whom? (give <item> <npc>)");
  // Parse "<item> [to] <npc>": a literal " to " splits item/npc; otherwise the
  // last word names the npc and the rest the item.
  let itemQ, npcQ;
  const idx = arg.toLowerCase().indexOf(" to ");
  if (idx >= 0) { itemQ = arg.slice(0, idx).trim(); npcQ = arg.slice(idx + 4).trim(); }
  else { const toks = arg.trim().split(/\s+/); npcQ = toks[toks.length - 1]; itemQ = toks.slice(0, -1).join(" "); }
  if (!itemQ || !npcQ) return err("Give what to whom? (give <item> <npc>)");

  const mob = findMobInRoom(state, player, npcQ);
  if (!mob) return err(`You see no "${npcQ}" here to give anything to.`);
  const iidx = findItem(player.inventory, w, itemQ);
  if (iidx < 0) return err(`You aren't carrying "${itemQ}".`);
  const inst = player.inventory[iidx];
  const itemName = w.items[inst.template].name;
  const npcName = w.mobs[mob.template].name;
  const res = quests.handleGive(state, player, mob, inst);
  if (!res.accepted) return err(`${cap(npcName)} has no need for ${itemName}.`);
  announce(ctx, player, `${player.name} hands ${itemName} to ${npcName}.`);
  return [...res.msgs, buildRoomView(state, player), buildPlayerView(state, player)];
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

// `quit`/`logout`: leave the game cleanly. There's no danger in disconnecting —
// the account is saved on socket close (and periodically) — so this is purely a
// discoverable way to do what closing the tab already does. The room is told the
// delver has gone (and darkened/refreshed) by the socket-close teardown in
// index.js, which fires for both `quit` and a dropped tab so they read alike; here
// we just hand the actor a `goodbye` the client uses to close without reconnecting.
function quit(state, player, arg, ctx) {
  return [{ type: "goodbye", text: "You slip away into the dark. Your progress is saved — you can safely close this tab. (Closing the tab at any time saves too.)" }];
}

// `alias` — bind a command to a function key (F1–F4), clear one, or list them.
//   alias                  → show all four slots
//   alias F1 cast spark    → bind F1
//   alias F1               → clear F1
// Bindings live on the player (player.aliases) and persist with the account.
function alias(state, player, arg) {
  const parts = (arg || "").trim().split(/\s+/);
  const key = (parts[0] || "").toUpperCase();
  const command = parts.slice(1).join(" ").trim();
  player.aliases = player.aliases || {};

  // No key: list the current bindings.
  if (!key) {
    const lines = ALIAS_KEYS.map((k) => `  ${k} — ${player.aliases[k] || "(unbound)"}`);
    return logMsg(`Your shortcuts:\n${lines.join("\n")}\n\nSet one with "alias F1 cast spark"; clear it with "alias F1".`);
  }
  if (!ALIAS_KEYS.includes(key)) {
    return err(`You can only bind ${joinList(ALIAS_KEYS)}.`);
  }
  // Key but no command: clear that slot.
  if (!command) {
    if (!player.aliases[key]) return logMsg(`${key} is already unbound.`);
    delete player.aliases[key];
    return logMsg(`Cleared ${key}.`);
  }
  player.aliases[key] = command;
  return logMsg(`${key} now runs "${command}".`);
}

// The verb→handler table. Each row lists the verbs/aliases that share a handler;
// `run(state, player, arg, ctx)` returns the actor's messages. This replaces the
// old dispatch `switch` — VERBS (above) stays the curated abbreviation list, and
// the assertion below guarantees every abbreviation/alias has a handler here, so
// the two can't silently drift.
const COMMANDS = [
  { verbs: [""], run: () => [] },
  { verbs: ["look", "l", "examine", "exam", "x"], run: (s, p, a) => (a ? lookAt(s, p, a) : [buildRoomView(s, p)]) },
  { verbs: ["search"], run: (s, p, a, c) => search(s, p, c) },
  { verbs: ["get", "take", "pickup"], run: get },
  { verbs: ["drop"], run: drop },
  { verbs: ["inventory", "inv", "i"], run: inventory },
  { verbs: ["attack", "kill", "k"], run: attack },
  { verbs: ["stop"], run: (s, p) => { p.pending = null; return logMsg("You break off your attack."); } },
  { verbs: ["sit", "rest"], run: (s, p, a, c) => setPosture(s, p, "sit", c) },
  { verbs: ["sleep"], run: (s, p, a, c) => setPosture(s, p, "sleep", c) },
  { verbs: ["stand", "wake", "wakeup"], run: (s, p, a, c) => setPosture(s, p, "stand", c) },
  { verbs: ["cast", "c"], run: cast },
  { verbs: ["learn", "study"], run: learn },
  { verbs: ["spells"], run: spellList },
  { verbs: ["train"], run: train },
  { verbs: ["list", "shop", "wares"], run: shopList },
  { verbs: ["buy"], run: buy },
  { verbs: ["sell"], run: sell },
  { verbs: ["drink", "quaff"], run: (s, p, a, c) => drink(s, p, a, c, "drink") },
  { verbs: ["eat"], run: (s, p, a, c) => drink(s, p, a, c, "eat") },
  { verbs: ["refuel", "fill"], run: refuel },
  { verbs: ["use", "switch", "toggle", "flip"], run: use },
  { verbs: ["throw", "hurl", "lob"], run: (s, p, a, c) => drink(s, p, a, c, "throw") },
  { verbs: ["open"], run: (s, p, a, c) => operateDoor(s, p, a, c, true) },
  { verbs: ["close", "shut"], run: (s, p, a, c) => operateDoor(s, p, a, c, false) },
  { verbs: ["craft", "make"], run: craft },
  { verbs: ["mine", "dig"], run: mine },
  { verbs: ["gather", "forage", "harvest", "pick"], run: gather },
  { verbs: ["fish", "angle"], run: fish },
  { verbs: ["recipes"], run: recipes },
  { verbs: ["talk", "greet", "ask"], run: talk },
  { verbs: ["give", "deliver"], run: give },
  { verbs: ["quest", "quests", "journal"], run: (s, p) => quests.log(s, p) },
  { verbs: ["say"], run: say },
  { verbs: ["emote", "me"], run: emote },
  { verbs: ["equip", "wield", "wear"], run: equip },
  { verbs: ["unequip", "remove"], run: unequip },
  { verbs: ["help", "?"], run: (s, p) => logMsg(buildHelp(p)) },
  { verbs: ["alias"], run: alias },
  { verbs: ["quit", "logout", "logoff"], run: quit },
];

// verb/alias -> handler. Built once from COMMANDS; this is the dispatch table.
const HANDLERS = new Map();
for (const e of COMMANDS) for (const v of e.verbs) HANDLERS.set(v, e.run);

// Drift guard: every abbreviation verb and single-letter alias must have a
// handler. Fails loudly at load rather than silently 404-ing a command.
for (const v of VERB_SET) {
  if (!HANDLERS.has(v)) throw new Error(`commands: "${v}" is in the abbreviation set but has no handler in COMMANDS`);
}

function execute(state, player, input, ctx = NOOP_CTX) {
  // A fallen delver can do nothing but wait out the dark until they wake at the rim.
  if (player && player.dying != null) return err("You have fallen. There is only the dark — wait.");
  // F-key alias: a bare F1–F4 (the client sends the key as the whole command)
  // resolves to its bound command. Resolved once here, so a binding can't point
  // at another F-key and loop.
  const keyToken = (input || "").trim().toUpperCase();
  if (player && ALIAS_KEYS.includes(keyToken)) {
    const bound = player.aliases && player.aliases[keyToken];
    if (!bound) return err(`${keyToken} is not bound. Set it with "alias ${keyToken} <command>".`);
    input = bound;
  }
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
  const run = HANDLERS.get(verb);
  if (run) return run(state, player, arg, ctx);
  const guess = closestVerb(verb);
  const hint = guess ? ` Did you mean "${guess}"?` : ` Try "help".`;
  return err(`Unknown command: "${verb}".${hint}`);
}

module.exports = { execute };
