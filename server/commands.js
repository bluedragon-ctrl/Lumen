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
const { makeItemInstance, buyValueOf, sellValueOf, SELL_RATE, itemVisibleTo, fixtureVisibleTo, mobVisibleTo, isDiscovered, discoveryKey, xpForLevel } = require("./state");
const { EXPLORE_XP } = require("./config");

// Searching the room for hidden features costs roughly one action's worth of
// energy, so it competes with attacking and can't be spammed mid-combat.
const SEARCH_COST = 12;
const accounts = require("./accounts");

const DIRS = ["north", "south", "east", "west", "up", "down"];
const DIR_ALIAS = { n: "north", s: "south", e: "east", w: "west", u: "up", d: "down" };
const NOOP_CTX = { toRoom() {}, refreshRoom() {} };

const HELP = [
  "Commands:",
  "  look | examine | x [target] — view the room, or examine something",
  "  search                — comb the room for hidden things (needs light + Perception)",
  "  north/south/east/west/up/down (or n/s/e/w/u/d) — move",
  "  go <dir> | move <dir> — move",
  "  get | take <target>   — pick up an item",
  "  drop <target>         — drop an item",
  "  inventory | inv | i   — list what you are carrying",
  "  attack | kill <target> — attack a creature (stop to break off)",
  "  sit | rest            — sit to recover HP/MP slowly (1 per 5 ticks)",
  "  sleep                 — sleep to recover faster (1 per 2 ticks), but blind",
  "  stand | wake          — get up; moving or attacking also stands you",
  "  cast | c <spell> <target> — cast a spell you know at a creature",
  "  learn | study <scroll|schematic> — learn a spell or recipe (consumes it)",
  "  spells                — list the spells you know",
  "  train [attribute]     — spend a level-up point on an attribute (no arg: show progress)",
  "  equip | wield | wear <item> — equip from inventory (swaps current)",
  "  unequip | remove <item|slot> — return equipped gear to inventory",
  "  list | shop           — see what a trader here buys and sells",
  "  buy <item>            — buy from a trader here",
  "  sell <item>           — sell to a trader here",
  "  recipes               — list recipes you know",
  "  craft | make <recipe> — craft at the matching station here",
  "  mine | dig [vein]     — work ore loose from a vein in the room",
  "  drink | quaff | eat <item> — consume a potion or food",
  "  use | switch <target> — operate a fixture (e.g. a lamp), or use a carried item (potion, flare)",
  "  say <text>            — speak to others in the room",
  "  emote | me <text>     — perform an action",
  "  light [item] | douse  — light (swaps in a fresh source if spent) or douse",
  "  refuel | fill <item>  — refill a fuelled light (e.g. a lantern with oil)",
  "  help | ?              — this list",
].join("\n");

const selfAndViews = (state, player, line) => [
  { type: "log", text: line },
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

// Find an item instance by id (exact) or name (substring) within a list.
function findItem(list, world, q) {
  const ql = q.toLowerCase();
  return list.findIndex((i) => i.id.toLowerCase() === ql || world.items[i.template].name.toLowerCase().includes(ql));
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

// Display name of the fixture that provides a crafting station (for hints).
function stationLabel(world, station) {
  const f = Object.values(world.fixtures).find((x) => x.station === station);
  return f ? f.name : `a ${station} station`;
}

// Equip an instance into its template's slot, stowing whatever was there back to
// inventory (and dousing it if it was a lit light). Returns the displaced item.
function equipItem(player, inst, world) {
  const slot = world.items[inst.template].slot;
  const prev = player.equipment[slot] || null;
  if (prev && prev.lit) prev.lit = false;
  player.equipment[slot] = inst;
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
  if (!dest) return [{ type: "error", text: `You can't go ${dir} from here.` }];
  player.pending = null; // moving breaks off any attack
  state.clearRevealedMobs(player.id); // leaving the room re-hides any lurkers you'd spotted
  const from = player.location;
  ctx.toRoom(from, { type: "log", text: `${player.name} leaves ${dir}.` }, player.id);
  state.setPlayerLocation(player, dest);
  state.rooms[dest].light = state.computeRoomLight(dest);
  state.rooms[from].light = state.computeRoomLight(from);
  ctx.refreshRoom(from, player.id);
  ctx.toRoom(dest, { type: "log", text: `${player.name} arrives.` }, player.id);
  ctx.refreshRoom(dest, player.id);
  // First time here? A one-off exploration reward (rewards pushing into new ground;
  // each room pays once). Award before building views so the player view is current.
  let tail = "";
  let ups = [];
  if (!Array.isArray(player.visitedRooms)) player.visitedRooms = [];
  if (!player.visitedRooms.includes(dest)) {
    player.visitedRooms.push(dest);
    if (EXPLORE_XP) {
      ups = state.awardXp(player, EXPLORE_XP);
      tail = ` You map new ground. (+${EXPLORE_XP} xp)`;
    }
  }
  const msgs = selfAndViews(state, player, `You go ${dir}.${tail}`);
  announceLevelUps(player, ups, ctx, msgs);
  return msgs;
}

const fueledLightIdx = (player, w) =>
  player.inventory.findIndex((i) => w.items[i.template].light && i.fuel > 0);

function toggleLight(state, player, on, ctx, arg) {
  const w = state.world;
  // `light <item>`: equip that specific source first (swapping the current one).
  if (on && arg) {
    const idx = findItem(player.inventory, w, arg);
    if (idx >= 0 && w.items[player.inventory[idx].template].light) {
      equipItem(player, player.inventory.splice(idx, 1)[0], w);
    }
  }
  let inst = player.equipment.light;
  // Auto-equip a light if none held, or swap out a spent one for a fuelled one.
  if (on && (!inst || inst.fuel <= 0)) {
    let idx = fueledLightIdx(player, w);
    if (idx < 0 && !inst) idx = player.inventory.findIndex((i) => w.items[i.template].light);
    if (idx >= 0) {
      equipItem(player, player.inventory.splice(idx, 1)[0], w);
      inst = player.equipment.light;
    }
  }
  if (!inst) return [{ type: "error", text: "You have no light source." }];
  const name = w.items[inst.template].name;
  if (on && inst.fuel <= 0) return [{ type: "error", text: `${name} is spent and you have no fresh light.` }];
  inst.lit = on;
  state.rooms[player.location].light = state.computeRoomLight(player.location);
  ctx.toRoom(player.location, { type: "log", text: `${player.name} ${on ? "lights" : "douses"} ${name}.` }, player.id);
  ctx.refreshRoom(player.location, player.id);
  return selfAndViews(state, player, on ? `You light ${name}. The dark recedes.` : `You douse ${name}.`);
}

function equip(state, player, arg, ctx) {
  const w = state.world;
  if (!arg) return [{ type: "error", text: "Equip what?" }];
  const idx = findItem(player.inventory, w, arg);
  if (idx < 0) return [{ type: "error", text: `You aren't carrying "${arg}".` }];
  const t = w.items[player.inventory[idx].template];
  if (!t.slot) return [{ type: "error", text: `You can't equip ${t.name}.` }];
  const prev = equipItem(player, player.inventory.splice(idx, 1)[0], w);
  state.rooms[player.location].light = state.computeRoomLight(player.location);
  ctx.refreshRoom(player.location, player.id);
  const extra = prev ? `, stowing ${w.items[prev.template].name}` : "";
  return selfAndViews(state, player, `You equip ${t.name}${extra}.`);
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
  state.rooms[player.location].light = state.computeRoomLight(player.location);
  ctx.refreshRoom(player.location, player.id);
  return selfAndViews(state, player, `You remove ${w.items[inst.template].name}.`);
}

function get(state, player, arg, ctx) {
  if (!arg) return [{ type: "error", text: "Get what?" }];
  const rt = state.rooms[player.location];
  if (!canSee(player.perception, rt.light)) return [{ type: "error", text: "It is too dark to find anything." }];
  // Undiscovered hidden items aren't pickable by name — you must `search` first.
  const visible = rt.items.filter((i) => itemVisibleTo(player, i));
  const vIdx = findItem(visible, state.world, arg);
  if (vIdx < 0) return [{ type: "error", text: `There is no "${arg}" here to get.` }];
  const inst = rt.items.splice(rt.items.indexOf(visible[vIdx]), 1)[0];
  const t = state.world.items[inst.template];
  // Currency isn't carried as an item — gathering it tallies to the purse.
  if (t.type === "currency") {
    const amt = inst.qty || 1;
    player.shards = (player.shards || 0) + amt;
    const noun = `${amt} shard${amt === 1 ? "" : "s"}`;
    ctx.toRoom(player.location, { type: "log", text: `${player.name} gathers ${noun}.` }, player.id);
    ctx.refreshRoom(player.location, player.id);
    return selfAndViews(state, player, `You gather ${noun}. (${player.shards} total)`);
  }
  addToInventory(player, inst, state.world);
  const name = t.name;
  ctx.toRoom(player.location, { type: "log", text: `${player.name} picks up ${name}.` }, player.id);
  ctx.refreshRoom(player.location, player.id);
  return selfAndViews(state, player, `You pick up ${name}.`);
}

function drop(state, player, arg, ctx) {
  if (!arg) return [{ type: "error", text: "Drop what?" }];
  const idx = findItem(player.inventory, state.world, arg);
  if (idx < 0) return [{ type: "error", text: `You aren't carrying "${arg}".` }];
  const inst = player.inventory.splice(idx, 1)[0];
  state.rooms[player.location].items.push(inst);
  const name = state.world.items[inst.template].name;
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
  if (sells.length) {
    lines.push("Sells (you buy):");
    for (const o of sells) lines.push(`  ${w.items[o.template].name} — ${buyPrice(o, w.items[o.template])} shards`);
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
  ctx.toRoom(player.location, { type: "log", text: `${player.name} buys ${name} from ${sh.t.name}.` }, player.id);
  return selfAndViews(state, player, `You buy ${name} for ${price} shards. (${player.shards} left)`);
}

function sell(state, player, arg, ctx) {
  if (!arg) return [{ type: "error", text: "Sell what?" }];
  const sh = shopHere(state, player);
  if (!sh) return [{ type: "error", text: "There is no one here to trade with." }];
  const w = state.world;
  const idx = findItem(player.inventory, w, arg);
  if (idx < 0) return [{ type: "error", text: `You aren't carrying "${arg}".` }];
  const inst = player.inventory[idx];
  const t = w.items[inst.template];
  // The trader buys any valued item at its sell value — no per-trader buy list.
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

// `use <target>`: operate a switchable fixture here if it matches, else drink it.
function use(state, player, arg, ctx) {
  const w = state.world;
  const rt = state.rooms[player.location];
  if (arg && canSee(player.perception, rt.light)) {
    const ql = arg.toLowerCase();
    const f = rt.fixtures.find((f) => {
      const ft = w.fixtures[f.template];
      return ft && ft.switch && fixtureVisibleTo(player, f) && (f.id.toLowerCase() === ql || ft.name.toLowerCase().includes(ql));
    });
    if (f) return toggleFixture(state, player, f, ctx);
  }
  return drink(state, player, arg, ctx);
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

function craft(state, player, arg, ctx) {
  const w = state.world;
  if (!arg) return [{ type: "error", text: "Craft what? Try `recipes`." }];
  const ql = arg.toLowerCase();
  const entry = Object.entries(w.recipes).find(
    ([id, r]) => id.toLowerCase() === ql || (r.name && r.name.toLowerCase().includes(ql))
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
  return msgs;
}

function recipes(state, player) {
  const w = state.world;
  const known = player.knownRecipes || [];
  if (!known.length) return [{ type: "log", text: "You know no recipes." }];
  const here = new Set(state.rooms[player.location].fixtures.map((f) => w.fixtures[f.template] && w.fixtures[f.template].station));
  const lines = ["You know how to craft:"];
  for (const rid of known) {
    const r = w.recipes[rid];
    if (!r) continue;
    const ins = (r.inputs || []).map((i) => `${i.qty || 1}× ${w.items[i.template].name}`);
    if (r.shards) ins.push(`${r.shards} shards`);
    const station = here.has(r.station) ? "" : ` — needs ${stationLabel(w, r.station)}`;
    lines.push(`  ${r.name || rid}: ${ins.join(", ")} → ${w.items[r.output.template].name}${station}`);
  }
  return [{ type: "log", text: lines.join("\n") }];
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
  const veins = rt.fixtures.filter((f) => w.fixtures[f.template] && w.fixtures[f.template].mine);
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
  const oreName = w.items[ft.mine.template].name;
  ctx.toRoom(player.location, { type: "log", text: `${player.name} works ${oreName} from ${ft.name}.` }, player.id);
  ctx.refreshRoom(player.location, player.id);
  const thin = f.charges <= 0 ? " The seam runs thin and gives no more." : "";
  return selfAndViews(state, player, `You work ${oreName} loose.${thin}`);
}

function say(state, player, text, ctx) {
  if (!text) return [{ type: "error", text: "Say what?" }];
  ctx.toRoom(player.location, { type: "log", text: `${player.name} says: ${text}` }, player.id);
  return [{ type: "log", text: `You say: ${text}` }];
}

function emote(state, player, text, ctx) {
  if (!text) return [{ type: "error", text: "Emote what?" }];
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
  const rt = state.rooms[player.location];
  const see = canSee(player.perception, rt.light);
  const ql = arg.toLowerCase();
  const mob = rt.mobs.find((m) => {
    const t = state.world.mobs[m.template];
    return mobVisibleTo(state, player, m) && (see || t.emitsLight) && (m.id.toLowerCase() === ql || t.name.toLowerCase().includes(ql));
  });
  if (!mob) return [{ type: "error", text: `You see no "${arg}" here to attack.` }];
  player.pending = { type: "attack", targetId: mob.id };
  const ready = { type: "log", text: `You ready your attack on ${state.world.mobs[mob.template].name}.` };
  return woke ? [{ type: "log", text: "You scramble to your feet." }, ready] : [ready];
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
// recipes (`recipe`). Both follow the same flow.
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
  const lines = ["You know how to cast:"];
  for (const id of known) {
    const s = w.spells[id];
    if (!s) continue;
    let tail = "";
    if (s.effect && s.effect.type === "damage")
      tail = ` — ${s.effect.damage} ${s.effect.damageType || "physical"} damage` +
        (s.effect.scale ? ` (+${s.effect.scale.attr}/${s.effect.scale.per})` : "");
    lines.push(`  ${s.name}: ${s.manaCost || 0} mana${tail}`);
  }
  lines.push(`Mana: ${Math.floor(player.mana || 0)}/${player.maxMana}.`);
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
      return s && (id.toLowerCase() === phrase || s.name.toLowerCase() === phrase);
    });
    if (hit) { spellId = hit; rest = tokens.slice(n); }
  }
  if (!spellId) return [{ type: "error", text: `You don't know any spell called "${tokens[0]}". Try \`spells\`.` }];
  const spell = w.spells[spellId];
  if (rest[0] && rest[0].toLowerCase() === "at") rest = rest.slice(1); // `cast spark at lightbug`
  const targetQ = rest.join(" ");

  if (Math.floor(player.mana || 0) < (spell.manaCost || 0))
    return [{ type: "error", text: `You lack the mana for ${spell.name} (need ${spell.manaCost}, have ${Math.floor(player.mana || 0)}).` }];
  if (!targetQ) return [{ type: "error", text: `Cast ${spell.name} at what?` }];

  autoStand(player); // rouse before casting, so a sleeping caster regains sight to aim
  const rt = state.rooms[player.location];
  const see = canSee(player.perception, rt.light);
  const ql = targetQ.toLowerCase();
  const mob = rt.mobs.find((m) => {
    const t = w.mobs[m.template];
    return (see || t.emitsLight) && (m.id.toLowerCase() === ql || t.name.toLowerCase().includes(ql));
  });
  if (!mob) return [{ type: "error", text: `You see no "${targetQ}" here to target.` }];

  const mt = w.mobs[mob.template];
  const verb = spell.name.toLowerCase();
  const res = state.castSpell(player, spell, mob);

  if (res.resisted) {
    ctx.toRoom(player.location, { type: "log", text: `${player.name}'s ${verb} crackles against ${mt.name} and fizzles.` }, player.id);
    ctx.refreshRoom(player.location, player.id);
    return selfAndViews(state, player, `You cast ${spell.name} at ${mt.name}, but its ward turns the bolt aside.`);
  }

  if (res.killed) {
    const d = res.death;
    const lootTxt = d.loot && d.loot.length ? ` It leaves behind ${d.loot.join(", ")}.` : "";
    ctx.toRoom(player.location, { type: "log", text: `${player.name}'s ${verb} blasts ${mt.name} apart, and it dies.${lootTxt}` }, player.id);
    ctx.refreshRoom(player.location, player.id);
    return selfAndViews(
      state, player,
      `Your ${verb} blasts ${mt.name} apart for ${res.damage}! You slay ${mt.name}.${d.xp ? ` (+${d.xp} xp)` : ""}${lootTxt}`
    );
  }

  ctx.toRoom(player.location, { type: "log", text: `${player.name} hurls a crackling ${verb} at ${mt.name}.` }, player.id);
  ctx.refreshRoom(player.location, player.id);
  return selfAndViews(state, player, `You hurl ${spell.name} at ${mt.name} for ${res.damage} damage.`);
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
    case "@help":
      return [{ type: "log", text: "Admin commands:\n  @create-player <name>\n  @list-players\n  @shards <amount>\n  @xp <amount>\n  @attr <attribute> <value>" }];
    default:
      return [{ type: "error", text: `Unknown admin command: "${verb}". Try "@help".` }];
  }
}

function execute(state, player, input, ctx = NOOP_CTX) {
  const parts = (input || "").trim().split(/\s+/);
  let verb = (parts[0] || "").toLowerCase();
  const arg = parts.slice(1).join(" ");
  if (verb.startsWith("@")) return handleAdmin(state, player, verb, arg, ctx);
  if (DIR_ALIAS[verb]) verb = DIR_ALIAS[verb];
  if (DIRS.includes(verb)) return move(state, player, verb, ctx);

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
    case "go":
    case "move": {
      let d = arg.toLowerCase();
      d = DIR_ALIAS[d] || d;
      if (!DIRS.includes(d)) return [{ type: "error", text: `Go where? (${DIRS.join(", ")})` }];
      return move(state, player, d, ctx);
    }
    case "get":
    case "take":
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
    case "craft":
    case "make":
      return craft(state, player, arg, ctx);
    case "mine":
    case "dig":
      return mine(state, player, arg, ctx);
    case "recipes":
      return recipes(state, player);
    case "say":
      return say(state, player, arg, ctx);
    case "emote":
    case "me":
      return emote(state, player, arg, ctx);
    case "equip":
    case "wield":
    case "wear":
    case "hold":
      return equip(state, player, arg, ctx);
    case "unequip":
    case "remove":
      return unequip(state, player, arg, ctx);
    case "light":
    case "ignite":
      return toggleLight(state, player, true, ctx, arg);
    case "douse":
    case "extinguish":
      return toggleLight(state, player, false, ctx);
    case "help":
    case "?":
      return [{ type: "log", text: HELP }];
    default:
      return [{ type: "error", text: `Unknown command: "${verb}". Try "help".` }];
  }
}

module.exports = { execute, DIRS, DIR_ALIAS, HELP };
