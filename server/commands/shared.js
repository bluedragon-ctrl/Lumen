"use strict";
/**
 * Shared command helpers — the hub every command module imports from.
 *
 * Holds the targeting/keyword resolution, inventory mutation, view-building and
 * narration helpers used across more than one command domain, plus a few small
 * dedup helpers extracted from handlers that did the same thing. Pure-ish: it
 * touches the engine (state/render/light) but never the command modules, so the
 * domain modules can depend on it without import cycles.
 */
const { buildRoomView, buildPlayerView } = require("../render");
const { canSee } = require("../light");
const { mobVisibleTo, fixtureVisibleTo } = require("../state");
const { STOP_WORDS, nameTokens, matchesQuery } = require("../query");
const quests = require("../quests");

const cap = (s) => (s || "").charAt(0).toUpperCase() + (s || "").slice(1);

// Single-message result builders — the standard refusal / plain-line shapes.
const err = (text) => [{ type: "error", text }];
const logMsg = (text) => [{ type: "log", text }];

// Broadcast one line to everyone else in the actor's room.
const roomLog = (ctx, player, text, kind = "log") =>
  ctx.toRoom(player.location, { type: kind, text }, player.id);

// roomLog + refreshRoom — "others hear it and see the room change" in one step.
function announce(ctx, player, text, kind = "log") {
  roomLog(ctx, player, text, kind);
  ctx.refreshRoom(player.location, player.id);
}

// Recompute the actor's room light AND push the updated view to bystanders.
// Always a pair — recomputing without refreshing once left stale dark views
// (the disconnect bug); this helper makes the invariant unforgettable.
function relight(state, ctx, player) {
  state.rooms[player.location].light = state.computeRoomLight(player.location);
  ctx.refreshRoom(player.location, player.id);
}

// Consume one from a carried stack, removing the instance when it's the last.
function consumeOne(player, inst) {
  if (inst.qty != null && inst.qty > 1) inst.qty -= 1;
  else player.inventory.splice(player.inventory.indexOf(inst), 1);
}

// Attributes a player can raise — with banked level-up points (`train`) or by an
// admin (`@attr`). Single source of truth for both.
const TRAINABLE = ["might", "vitality", "intellect", "wits", "perception"];

// Credit quest kill-progress for a kill landed BY this player on the command path
// (a spell or thrown bomb, where the death is returned inline rather than as a
// tick event). Melee/DoT kills are credited in index.js, so a kill never counts
// twice. Returns the player-facing quest messages to append after the views.
function questKill(state, player, death) {
  return death && death.victimTemplate ? quests.noteKill(state, player, death.victimTemplate) : [];
}

// A no-op broadcast context, for callers (tests, internal calls) that don't
// supply one — every ctx method is a stub.
const NOOP_CTX = { toRoom() {}, refreshRoom() {}, emit() {} };

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

// STOP_WORDS / nameTokens / matchesQuery live in ../query (shared with the
// view layer's examine lookup) and are re-exported below for the command modules.

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

// Find a visible fixture in the player's room that `ql` (lower-cased) names by
// id, authored keyword or display name and that satisfies `pred(ft)`. The
// repeated lookup behind `use` (switch/door/restore/harvest/any) and `operateDoor`.
function findFixture(rt, world, player, ql, pred) {
  return rt.fixtures.find((f) => {
    const ft = world.fixtures[f.template];
    return ft && pred(ft) && fixtureVisibleTo(player, f) && matchesQuery(ql, ft.name, ft.keywords, f.id);
  });
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

// Move/attack/cast rouse a resting player first (decision: auto-stand, then act).
// Pure state change — returns true if it actually stood the player up, so callers
// can prepend a brief "you got up" note where it reads naturally.
function autoStand(player) {
  if (!player.posture || player.posture === "standing") return false;
  player.posture = "standing";
  player.restTicks = 0;
  return true;
}

// The "(+N HP, +N MP)" gain clause for a restore, or the no-effect line. Shared
// by `drink` and `drinkFixture` — a quaffed potion and a healing spring read alike.
function restoreGain(r) {
  const parts = [];
  if (r.hp) parts.push(`+${r.hp} HP`);
  if (r.mana) parts.push(`+${r.mana} MP`);
  return parts.length ? ` (${parts.join(", ")})` : " It does nothing for you.";
}

// Mobs in the room a room-wide attack may catch: hostile creatures, or any that
// already bear aggro toward this player. Shared by `throwBomb` and `castBurst`,
// so a stray blast in town won't catch a peaceful shopkeeper.
function roomHostiles(state, player) {
  const w = state.world;
  return state.rooms[player.location].mobs.filter((m) => {
    const mt = w.mobs[m.template];
    return mt.hostile || (m.aggro && m.aggro[player.id] > 0);
  });
}

// After a room-wide attack, commit the player to swinging at any survivor if not
// already engaged (mirrors a single-target hostile cast). Shared by throwBomb/castBurst.
function stickToSurvivor(state, player, results) {
  const survivor = state.rooms[player.location].mobs.find((m) => results.some((r) => !r.killed && r.id === m.id));
  if (!player.pending && player.hp > 0 && survivor)
    player.pending = { type: "attack", targetId: survivor.id };
}

module.exports = {
  cap, NOOP_CTX, TRAINABLE, questKill, selfAndViews, announceLevelUps,
  err, logMsg, roomLog, announce, relight, consumeOne,
  STOP_WORDS, nameTokens, matchesQuery, parseTarget, itemMatches, findItem, findMobInRoom, findFixture,
  addToInventory, countItem, removeItem, joinList, stationLabel, equipItem,
  autoStand, restoreGain, roomHostiles, stickToSurvivor,
};
