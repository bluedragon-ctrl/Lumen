"use strict";
// Sight, light-emission, and hidden-feature (search) visibility. Posture-aware
// perception plus the discovery-key bookkeeping and visibility predicates reused
// by the room view (render.js) and command resolvers so filtering matches.
const { canSee, hitChance } = require("./light");
const { effectiveAttributes } = require("./combat-math");

/** Posture-aware sight: a *sleeping* actor perceives nothing — its room view goes
 *  dark and its own sight-gated rolls flail — regardless of room light. Sitting and
 *  standing use the actor's real perception band. Shared by render and targeting. */
function canPerceive(actor, light) {
  if (actor.posture === "sleeping") return false;
  return canSee(actor.perception, light);
}

/** Total light an actor radiates from active `emit-light` status effects. */
function actorEmitLight(actor) {
  let sum = 0;
  for (const s of actor.states || []) if (s.type === "emit-light") sum += s.magnitude || 0;
  return sum;
}

// --- Hidden features (search) ----------------------------------------------
// A room feature (item, fixture, exit, mob) may carry a `hidden: { perception }`
// block; it is omitted from a player's view until they `search` and meet the
// requirement. Permanent finds (items/fixtures/exits) are recorded per-player as
// stable discovery keys on `player.discovered`; mob reveals are ephemeral
// (in-memory, current-visit only — see GameState.revealedMobs).
const discoveryKey = (roomId, kind, ident) => `${roomId}|${kind}|${ident}`;
const isDiscovered = (player, key) => Array.isArray(player.discovered) && player.discovered.includes(key);

/** Effective Perception for searching: the attribute scaled by how well the player
 *  sees the room — the same light tiers combat uses (darkness ×0.05, dim/glare
 *  ×0.5, clear ×1.0). So light is required to find what's hidden. */
function effectivePerception(world, player, light) {
  const per = effectiveAttributes(world, player).perception || 0; // includes gear (e.g. a ring of sight)
  return per * hitChance(player.perception, light);
}

// Visibility predicates — a hidden feature is shown only once discovered/revealed.
// Reused by the room view (render.js) and command resolvers so filtering matches.
const itemVisibleTo = (player, inst) => !inst.hidden || isDiscovered(player, inst.discoveryKey);
const fixtureVisibleTo = (player, inst) => !inst.hidden || isDiscovered(player, inst.discoveryKey);
const mobVisibleTo = (state, player, mob) => {
  if (!mob.hidden) return true;
  const set = state.revealedMobs.get(player.id);
  return !!(set && set.has(mob.id));
};

module.exports = {
  canPerceive,
  actorEmitLight,
  discoveryKey,
  isDiscovered,
  effectivePerception,
  itemVisibleTo,
  fixtureVisibleTo,
  mobVisibleTo,
};
