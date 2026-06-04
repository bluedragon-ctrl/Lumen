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
 * Combat hit chance by visibility tier (low → high light):
 *   can't see (below blindBelow)                → 0.05 (flailing)
 *   partial / dim (blindBelow .. below dimBelow) → 0.5
 *   clear (dimBelow .. harmedAbove)              → 1.0
 *   glare (above harmedAbove)                    → 0.5
 * `dimBelow` defaults to `blindBelow` (no partial tier) when an actor omits it.
 */
function hitChance(perception, light) {
  const blindBelow = perception ? perception.blindBelow : 1;
  const dimBelow = perception && perception.dimBelow != null ? perception.dimBelow : blindBelow;
  if (light < blindBelow) return 0.05;
  if (isHarmedByLight(perception, light)) return 0.5;
  if (light < dimBelow) return 0.5;
  return 1.0;
}

/**
 * Detection sensitivity by visibility tier — the per-action rate at which a mob
 * *notices* an enemy and builds aggro toward it (see GameState._detectAndDecay).
 * Mirrors `hitChance` but with a HARD zero below `blindBelow`: combat flailing
 * still lands the occasional blind blow (0.05), but you are not *noticed* at all
 * in the dark, so an unseen delver can slip past.
 *   can't see (below blindBelow)                → 0   (undetected)
 *   partial / dim, or glare (above harmedAbove)  → 0.5 (builds slowly)
 *   clear (dimBelow .. harmedAbove)              → 1.0 (noticed fast)
 */
function noticeChance(perception, light) {
  const blindBelow = perception ? perception.blindBelow : 1;
  const dimBelow = perception && perception.dimBelow != null ? perception.dimBelow : blindBelow;
  if (light < blindBelow) return 0;
  if (isHarmedByLight(perception, light)) return 0.5;
  if (light < dimBelow) return 0.5;
  return 1.0;
}

module.exports = {
  LIGHT_MIN,
  LIGHT_MAX,
  bandOf,
  clampLight,
  effectiveLight,
  canSee,
  isHarmedByLight,
  hitChance,
  noticeChance,
};
