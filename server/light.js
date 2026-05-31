"use strict";
/**
 * Light model — the one calculation that touches everything (DESIGN.md §3.1, §6.3).
 * Light is a single integer per room; bands map from that integer.
 */

const LIGHT_MIN = 0;
const LIGHT_MAX = 20;

/** Map an integer light value to its band name. */
function bandOf(value) {
  if (value <= 0) return "darkness";
  if (value <= 2) return "dim";
  if (value <= 9) return "bright";
  return "searing"; // exceptional — a torch + a few lightbugs stays "bright"
}

function clampLight(value) {
  return Math.max(LIGHT_MIN, Math.min(LIGHT_MAX, value));
}

/**
 * Effective room light = ambient + sum of active source outputs, clamped.
 * @param {number} ambient        room's authored base light
 * @param {number[]} sourceOutputs outputs of every active light source in the room
 */
function effectiveLight(ambient, sourceOutputs = []) {
  const sum = sourceOutputs.reduce((a, b) => a + b, 0);
  return clampLight((ambient || 0) + sum);
}

/** Can an actor with the given perception band see at this light level? */
function canSee(perception, light) {
  return light >= (perception ? perception.blindBelow : 1);
}

/** Is an actor with the given perception band harmed by this light level? */
function isHarmedByLight(perception, light) {
  return perception ? light > perception.harmedAbove : false;
}

/**
 * Can the actor see *clearly* — i.e. light is within its comfortable band
 * (bright enough to see, not so bright it's blinded by glare)? Used for combat
 * accuracy: clear sight → full hit chance, otherwise the actor is flailing.
 */
function perceivesClearly(perception, light) {
  return canSee(perception, light) && !isHarmedByLight(perception, light);
}

module.exports = {
  LIGHT_MIN,
  LIGHT_MAX,
  bandOf,
  clampLight,
  effectiveLight,
  canSee,
  isHarmedByLight,
  perceivesClearly,
};
