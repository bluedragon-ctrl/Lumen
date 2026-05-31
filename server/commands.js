"use strict";
/**
 * Command parsing and execution (PR #3 subset: look, movement, light/douse).
 * Each handler returns an array of messages to send back to the actor.
 * The full gameplay loop (get/drop/say/inventory, combat) arrives in PR #4.
 */
const { buildRoomView, buildPlayerView, buildExamineView } = require("./render");
const accounts = require("./accounts");

const DIRS = ["north", "south", "east", "west", "up", "down"];
const DIR_ALIAS = { n: "north", s: "south", e: "east", w: "west", u: "up", d: "down" };

const HELP = [
  "Commands:",
  "  look | l [target]     — view the room, or examine something",
  "  north/south/east/west/up/down (or n/s/e/w/u/d) — move",
  "  go <dir> | move <dir> — move",
  "  light | douse         — light or douse your carried light source",
  "  help | ?              — this list",
].join("\n");

function move(state, player, dir) {
  const room = state.world.rooms[player.location];
  const dest = room.exits && room.exits[dir];
  if (!dest) return [{ type: "error", text: `You can't go ${dir} from here.` }];
  player.location = dest;
  state.rooms[dest].light = state.computeRoomLight(dest);
  state.rooms[room.id].light = state.computeRoomLight(room.id);
  return [
    { type: "log", text: `You go ${dir}.` },
    buildRoomView(state, player),
    buildPlayerView(state, player),
  ];
}

function toggleLight(state, player, on) {
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
  return [
    { type: "log", text: on ? `You light ${name}. The dark recedes.` : `You douse ${name}.` },
    buildRoomView(state, player),
    buildPlayerView(state, player),
  ];
}

// Examine a target: render its detail in the Inspect window (+ a brief console
// echo). Resolution (by id first, then name) and perception live in render.js.
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
      const ch = state.createCharacter(v.name, {});
      accounts.save(ch);
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

function execute(state, player, input) {
  const parts = (input || "").trim().split(/\s+/);
  let verb = (parts[0] || "").toLowerCase();
  const arg = parts.slice(1).join(" ");
  if (verb.startsWith("@")) return handleAdmin(state, player, verb, arg);
  if (DIR_ALIAS[verb]) verb = DIR_ALIAS[verb];
  if (DIRS.includes(verb)) return move(state, player, verb);

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
      return move(state, player, d);
    }
    case "light":
    case "ignite":
      return toggleLight(state, player, true);
    case "douse":
    case "extinguish":
      return toggleLight(state, player, false);
    case "help":
    case "?":
      return [{ type: "log", text: HELP }];
    default:
      return [{ type: "error", text: `Unknown command: "${verb}". Try "help".` }];
  }
}

module.exports = { execute, DIRS, DIR_ALIAS, HELP };
