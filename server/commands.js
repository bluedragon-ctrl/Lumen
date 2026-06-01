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
const { makeItemInstance, buyValueOf, sellValueOf, SELL_RATE } = require("./state");
const accounts = require("./accounts");

const DIRS = ["north", "south", "east", "west", "up", "down"];
const DIR_ALIAS = { n: "north", s: "south", e: "east", w: "west", u: "up", d: "down" };
const NOOP_CTX = { toRoom() {}, refreshRoom() {} };

const HELP = [
  "Commands:",
  "  look | examine | x [target] — view the room, or examine something",
  "  north/south/east/west/up/down (or n/s/e/w/u/d) — move",
  "  go <dir> | move <dir> — move",
  "  get | take <target>   — pick up an item",
  "  drop <target>         — drop an item",
  "  inventory | inv | i   — list what you are carrying",
  "  attack | kill <target> — attack a creature (stop to break off)",
  "  equip | wield | wear <item> — equip from inventory (swaps current)",
  "  unequip | remove <item|slot> — return equipped gear to inventory",
  "  list | shop           — see what a trader here buys and sells",
  "  buy <item>            — buy from a trader here",
  "  sell <item>           — sell to a trader here",
  "  recipes               — list recipes you know",
  "  craft | make <recipe> — craft at the matching station here",
  "  drink | quaff <item>  — consume a potion",
  "  use | switch <target> — operate a fixture (e.g. a lamp), or drink a potion",
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

function move(state, player, dir, ctx) {
  const room = state.world.rooms[player.location];
  const dest = room.exits && room.exits[dir];
  if (!dest) return [{ type: "error", text: `You can't go ${dir} from here.` }];
  player.pending = null; // moving breaks off any attack
  const from = player.location;
  ctx.toRoom(from, { type: "log", text: `${player.name} leaves ${dir}.` }, player.id);
  player.location = dest;
  state.rooms[dest].light = state.computeRoomLight(dest);
  state.rooms[from].light = state.computeRoomLight(from);
  ctx.refreshRoom(from, player.id);
  ctx.toRoom(dest, { type: "log", text: `${player.name} arrives.` }, player.id);
  ctx.refreshRoom(dest, player.id);
  return selfAndViews(state, player, `You go ${dir}.`);
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
  const idx = findItem(rt.items, state.world, arg);
  if (idx < 0) return [{ type: "error", text: `There is no "${arg}" here to get.` }];
  const inst = rt.items.splice(idx, 1)[0];
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
      return ft && ft.switch && (f.id.toLowerCase() === ql || ft.name.toLowerCase().includes(ql));
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

function drink(state, player, arg, ctx) {
  const w = state.world;
  if (!arg) return [{ type: "error", text: "Drink what?" }];
  const idx = findItem(player.inventory, w, arg);
  if (idx < 0) return [{ type: "error", text: `You aren't carrying "${arg}".` }];
  const inst = player.inventory[idx];
  const t = w.items[inst.template];
  if (t.type !== "consumable" || !t.consumable) return [{ type: "error", text: `You can't drink ${t.name}.` }];
  const spec = t.consumable.effect;
  if (!spec || typeof spec !== "object" || !spec.type)
    return [{ type: "error", text: `${t.name} fizzles uselessly — nothing happens.` }];
  // Consume one, then apply the effect primitive.
  if (inst.qty != null && inst.qty > 1) inst.qty -= 1;
  else player.inventory.splice(idx, 1);
  state.applyEffect(player, spec);
  state.rooms[player.location].light = state.computeRoomLight(player.location);
  ctx.toRoom(player.location, { type: "log", text: `${player.name} drinks ${t.name}.` }, player.id);
  ctx.refreshRoom(player.location, player.id);
  const flavour = EFFECT_FLAVOUR[spec.type] ? ` ${EFFECT_FLAVOUR[spec.type]}` : "";
  return selfAndViews(state, player, `You drink ${t.name}.${flavour}`);
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
  return selfAndViews(state, player, `You craft ${outName}.${cost ? ` (−${cost} shards)` : ""}`);
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
  const rt = state.rooms[player.location];
  const see = canSee(player.perception, rt.light);
  const ql = arg.toLowerCase();
  const mob = rt.mobs.find((m) => {
    const t = state.world.mobs[m.template];
    return (see || t.emitsLight) && (m.id.toLowerCase() === ql || t.name.toLowerCase().includes(ql));
  });
  if (!mob) return [{ type: "error", text: `You see no "${arg}" here to attack.` }];
  player.pending = { type: "attack", targetId: mob.id };
  return [{ type: "log", text: `You ready your attack on ${state.world.mobs[mob.template].name}.` }];
}

/** Admin-only commands, prefixed with '@'. */
function handleAdmin(state, player, verb, arg) {
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
    case "@help":
      return [{ type: "log", text: "Admin commands:\n  @create-player <name>\n  @list-players" }];
    default:
      return [{ type: "error", text: `Unknown admin command: "${verb}". Try "@help".` }];
  }
}

function execute(state, player, input, ctx = NOOP_CTX) {
  const parts = (input || "").trim().split(/\s+/);
  let verb = (parts[0] || "").toLowerCase();
  const arg = parts.slice(1).join(" ");
  if (verb.startsWith("@")) return handleAdmin(state, player, verb, arg);
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
      return drink(state, player, arg, ctx);
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
