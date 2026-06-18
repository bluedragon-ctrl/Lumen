"use strict";
// Runtime entity creation — the monotonic id source plus the item/mob instance
// factories and the floor-merge helper. Split out of state.js; the `nextEntityId`
// counter is module-level singleton state, so `entityId`/`ensureIdAbove` and both
// factories must live together to share it.
const { DEFAULT_FACTION } = require("./config");

// Monotonic source of unique runtime ids. Every addressable runtime entity —
// players, mob instances, item instances, placed fixtures — gets one
// (`player.N`, `mob.N`, `item.N`, `fixture.N`). Authored static defs (rooms,
// templates) keep their own unique string ids.
// NOTE: resets on restart; when snapshot-resume lands we must seed this above
// the highest id seen in the snapshot to avoid collisions.
let nextEntityId = 1;
const entityId = (prefix) => `${prefix}.${nextEntityId++}`;
/** Raise the counter past an existing id (e.g. when loading a saved account). */
function ensureIdAbove(id) {
  const n = typeof id === "string" ? parseInt(id.split(".")[1], 10) : NaN;
  if (!isNaN(n) && n >= nextEntityId) nextEntityId = n + 1;
}

/**
 * Create a runtime item instance from an authoring ItemRef (`{template, qty?, fuel?}`).
 * Stackables carry `qty`; fuelled light sources carry `fuel`/`lit`.
 */
function makeItemInstance(ref, world) {
  const tmpl = world.items[ref.template];
  if (!tmpl) throw new Error(`unknown item template: ${ref.template}`);
  const inst = { id: entityId("item"), template: ref.template };
  if (tmpl.stackable) inst.qty = ref.qty != null ? ref.qty : 1;
  if (tmpl.light) {
    inst.fuel = ref.fuel != null ? ref.fuel : tmpl.light.fuelMax;
    inst.lit = ref.lit || false;
  }
  return inst;
}

/**
 * Drop an item instance onto a room floor, merging into an existing stack of the
 * same stackable template (so three dead grubs read as "a dead grub ×3", not three
 * separate piles). Mirrors `addToInventory` on the carry side.
 */
function addToFloor(rt, inst, world) {
  const t = world.items[inst.template];
  if (t.stackable) {
    const ex = rt.items.find((i) => i.template === inst.template);
    if (ex) {
      ex.qty = (ex.qty || 1) + (inst.qty || 1);
      return;
    }
  }
  rt.items.push(inst);
}

/** Create a runtime mob instance from a mob template id. */
function makeMobInstance(mobId, world) {
  const tmpl = world.mobs[mobId];
  if (!tmpl) throw new Error(`unknown mob template: ${mobId}`);
  return {
    id: entityId("mob"),
    template: mobId,
    hp: tmpl.maxHp,
    maxHp: tmpl.maxHp,
    energy: 0, // accumulated action points
    aggro: {}, // combatantId -> threat; key is any combatant (player OR mob) id, see _addThreat()
    // Instance-level faction (the side this creature fights FOR). Defaults to the
    // template's `faction` (else "wild"); a summon overrides it ("player" for a
    // player's, "wild" for a mob's — see _summon). Sides are resolved by
    // `factionRelation`/`_areEnemies`, while `hostile`/provocation still gate active
    // aggression. `ownerId` names the player a "player"-faction mob belongs to
    // (kill credit, future pet upkeep); null for wild creatures.
    faction: tmpl.faction || DEFAULT_FACTION,
    ownerId: null,
    summonerId: null, // who conjured it (player or mob id); null if not summoned
    summonGroup: null, // per-owner recast-cap key (defaults to the source spell id)
    expiresIn: null, // ticks until it winks out; null = permanent
    noSpoils: false, // summoned creatures drop no loot/XP on any death
    posture: tmpl.posture || "standing", // authored dozing/resting NPCs; inert until roused
  };
}

module.exports = { entityId, ensureIdAbove, makeItemInstance, addToFloor, makeMobInstance };
