"use strict";
/**
 * Operating room fixtures: `use` (the catch-all — switches, doors, springs,
 * harvestables, quest scenery, then carried light sources and consumables) and
 * the explicit `open`/`close` door verbs. Door/switch state lives on the room's
 * fixture instances; light recomputes live in state.js.
 */
const { canSee } = require("../light");
const { effectiveAttributes } = require("../state");
const quests = require("../quests");
const { gather } = require("./resource");
const { drink, toggleLightSource, findLightSource } = require("./consume");
const { cap, err, selfAndViews, roomLog, announce, relight, findFixture, restoreGain } = require("./shared");

// Player-facing capitalised name for an attribute ("might" → "Might").
const ATTR_LABEL = { might: "Might", vitality: "Vitality", intellect: "Intellect", wits: "Wits", perception: "Perception" };
const attrLabel = (a) => ATTR_LABEL[a] || cap(a);

// Toggle a switchable fixture (a lamp, lever, …). Switching it may change room light.
function toggleFixture(state, player, f, ctx) {
  const ft = state.world.fixtures[f.template];
  f.on = !f.on;
  roomLog(ctx, player, `${player.name} switches ${f.on ? "on" : "off"} ${ft.name}.`);
  relight(state, ctx, player);
  const tail = ft.switch && ft.switch.emitsLight ? (f.on ? " It casts a steady glow." : " Its glow dies.") : "";
  return selfAndViews(state, player, `You switch ${f.on ? "on" : "off"} ${ft.name}.${tail}`);
}

// Open or shut a door fixture (a trapdoor, gate, …). Open, it provides an exit
// in its `dir`; shut, that way is closed. `want` forces a state (open/close
// verbs); omit it to toggle (`use`).
function toggleDoor(state, player, f, ctx, want) {
  const ft = state.world.fixtures[f.template];
  const next = want === undefined ? !f.open : want;
  if (next === f.open) return err(`It's already ${f.open ? "open" : "shut"}.`);
  // A locked door (`door.key`) only opens for someone carrying its key. The key is
  // kept, not consumed — once you've opened the way it stays open for you. Locking
  // (closing) is always allowed.
  if (next && ft.door.key && !player.inventory.some((i) => i.template === ft.door.key)) {
    const keyName = state.world.items[ft.door.key] ? state.world.items[ft.door.key].name : "the right key";
    return err(`${cap(ft.name)} is locked. You'd need ${keyName} to open it.`);
  }
  // An attribute-gated door (`door.requires`) only yields to a delver whose
  // EFFECTIVE attribute (gear and potion buffs counted) meets the threshold — a
  // rusty gate you must be strong enough to force, a puzzle-lock you must be
  // sharp enough to solve. The needed attribute is named on both the refusal and
  // the success line (and on `examine`), so a player is never left guessing.
  // Closing is always allowed — only forcing it open is gated.
  const req = ft.door.requires;
  if (next && req) {
    const have = effectiveAttributes(state.world, player)[req.attr] || 0;
    if (have < req.value) {
      const fail = req.failText || `${cap(ft.name)} won't give — it takes ${attrLabel(req.attr)} ${req.value} to open.`;
      return err(`${fail} (your ${attrLabel(req.attr)}: ${have})`);
    }
  }
  f.open = next;
  announce(ctx, player, `${player.name} ${f.open ? "opens" : "shuts"} ${ft.name}.`);
  const reqTail = next && req ? ` ${req.successText || `It yields to your ${attrLabel(req.attr)} ${req.value}.`}` : "";
  return selfAndViews(state, player, `You ${f.open ? "open" : "shut"} ${ft.name}.${reqTail}`);
}

// Drink/draw from a `restore` fixture (a seep, a spring). Heals hp/mana like a
// `restore` consumable, but the fixture stays put — it's a place, not an item.
function drinkFixture(state, player, f, ctx) {
  const ft = state.world.fixtures[f.template];
  const r = state.applyRestore(player, ft.restore);
  announce(ctx, player, `${player.name} drinks from ${ft.name}.`);
  return selfAndViews(state, player, `You drink from ${ft.name}.${restoreGain(r)}`);
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
    const anyFix = findFixture(rt, w, player, ql, () => true);
    const qmsgs = anyFix ? quests.noteUse(state, player, anyFix.template) : [];
    const withQuest = (arr) => { arr.push(...qmsgs); return arr; };

    const f = findFixture(rt, w, player, ql, (ft) => ft.switch || ft.door);
    if (f) return withQuest(w.fixtures[f.template].door ? toggleDoor(state, player, f, ctx) : toggleFixture(state, player, f, ctx));
    // A fixture you drink/draw from (a seep, a spring) restores hp/mana on use.
    const rf = findFixture(rt, w, player, ql, (ft) => ft.restore);
    if (rf) return withQuest(drinkFixture(state, player, rf, ctx));
    // A harvestable fixture (a mushroom cluster) — `use` it to pick by hand.
    const hf = findFixture(rt, w, player, ql, (ft) => ft.harvest);
    if (hf) return withQuest(gather(state, player, arg, ctx));
    // A quest-only fixture (scenery with no mechanical function) still counts as
    // "used" — acknowledge it so the verb isn't an "unknown" dead end.
    if (anyFix) return withQuest(selfAndViews(state, player, `You handle ${w.fixtures[anyFix.template].name}.`));
  }
  // A carried/equipped light source toggles lit/doused (works in the dark — that's
  // the point of lighting one). Checked before the drink/eat fallback.
  if (arg) {
    const src = findLightSource(state, player, arg);
    if (src) return toggleLightSource(state, player, src, ctx);
  }
  return drink(state, player, arg, ctx);
}

// `open`/`close <door>`: explicitly set a door fixture's state (sugar over `use`).
function operateDoor(state, player, arg, ctx, want) {
  const w = state.world;
  const rt = state.rooms[player.location];
  if (!arg) return err(`${want ? "Open" : "Close"} what?`);
  if (!canSee(player.perception, rt.light)) return err("It's too dark to make that out.");
  const ql = arg.toLowerCase();
  const f = findFixture(rt, w, player, ql, (ft) => ft.door);
  if (!f) return err(`There's nothing like that to ${want ? "open" : "close"} here.`);
  return toggleDoor(state, player, f, ctx, want);
}

module.exports = { use, operateDoor };
