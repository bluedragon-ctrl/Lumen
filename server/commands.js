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
const accounts = require("./accounts");

const DIRS = ["north", "south", "east", "west", "up", "down"];
const DIR_ALIAS = { n: "north", s: "south", e: "east", w: "west", u: "up", d: "down" };
const NOOP_CTX = { toRoom() {}, refreshRoom() {} };

const HELP = [
  "Commands:",
  "  look | l [target]     — view the room, or examine something",
  "  north/south/east/west/up/down (or n/s/e/w/u/d) — move",
  "  go <dir> | move <dir> — move",
  "  get | take <target>   — pick up an item",
  "  drop <target>         — drop an item",
  "  inventory | inv | i   — list what you are carrying",
  "  say <text>            — speak to others in the room",
  "  emote | me <text>     — perform an action",
  "  light | douse         — light or douse your carried light source",
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

function move(state, player, dir, ctx) {
  const room = state.world.rooms[player.location];
  const dest = room.exits && room.exits[dir];
  if (!dest) return [{ type: "error", text: `You can't go ${dir} from here.` }];
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

function toggleLight(state, player, on, ctx) {
  const w = state.world;
  let inst = player.equipment.light;
  if (!inst && on) {
    const idx = player.inventory.findIndex((i) => w.items[i.template].light);
    if (idx < 0) return [{ type: "error", text: "You have no light source." }];
    inst = player.inventory.splice(idx, 1)[0];
    player.equipment.light = inst;
  }
  if (!inst) return [{ type: "error", text: "You have no light source ready." }];
  const name = w.items[inst.template].name;
  if (on && inst.fuel <= 0) return [{ type: "error", text: `${name} is spent.` }];
  inst.lit = on;
  state.rooms[player.location].light = state.computeRoomLight(player.location);
  ctx.toRoom(player.location, { type: "log", text: `${player.name} ${on ? "lights" : "douses"} ${name}.` }, player.id);
  ctx.refreshRoom(player.location, player.id);
  return selfAndViews(state, player, on ? `You light ${name}. The dark recedes.` : `You douse ${name}.`);
}

function get(state, player, arg, ctx) {
  if (!arg) return [{ type: "error", text: "Get what?" }];
  const rt = state.rooms[player.location];
  if (!canSee(player.perception, rt.light)) return [{ type: "error", text: "It is too dark to find anything." }];
  const idx = findItem(rt.items, state.world, arg);
  if (idx < 0) return [{ type: "error", text: `There is no "${arg}" here to get.` }];
  const inst = rt.items.splice(idx, 1)[0];
  addToInventory(player, inst, state.world);
  const name = state.world.items[inst.template].name;
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
    case "say":
      return say(state, player, arg, ctx);
    case "emote":
    case "me":
      return emote(state, player, arg, ctx);
    case "light":
    case "ignite":
      return toggleLight(state, player, true, ctx);
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
