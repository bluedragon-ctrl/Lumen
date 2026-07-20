"use strict";
/**
 * Light model — the one calculation that touches everything (DESIGN.md §3.1, §6.3).
 * Light is a single integer per room; bands map from that integer.
 */

const LIGHT_MIN = -20;
const LIGHT_MAX = 20;

/** Map an integer light value to its band name. */
function bandOf(value) {
  if (value < 0) return "void";        // sub-zero: deep dark, the mirror of "searing"
  if (value === 0) return "darkness";
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

/**
 * The single light value a *crowd* of players contributes, with diminishing
 * returns so grouping up can't trivially manufacture `searing`. Each entry is
 * one player's own carried light (their lit lamp + their own glow effect — that
 * per-player stack is unchanged). Across players the brightest counts in full,
 * every dimmer light contributes half (floored), and the total extra is capped
 * at the brightest value — so player light can at most *double*, and its ceiling
 * scales with light quality, not head-count. A room full of ordinary torches
 * (output 3) tops out at 6 (bright); only strong dedicated lights combine into
 * searing. A room's non-player sources (ambient, fixtures, mobs) are unaffected
 * and still sum normally — this shapes only stacked delver light.
 * @param {number[]} perPlayerOutputs each present player's own carried-light total
 * @returns {number} the combined player contribution (0 if nobody carries light)
 */
function playerLightContribution(perPlayerOutputs = []) {
  const lit = perPlayerOutputs.filter((o) => o > 0).sort((a, b) => b - a);
  if (lit.length === 0) return 0;
  const brightest = lit[0];
  let extra = 0;
  for (let i = 1; i < lit.length; i++) extra += Math.floor(lit[i] / 2);
  return brightest + Math.min(extra, brightest);
}

/** Can an actor with the given perception band see at this light level? A
 *  dark-adapted creature with `blindAbove` is *dazzled* by light past that band
 *  (the bright-side mirror of `blindBelow`) and sees nothing — players carry no
 *  `blindAbove`, so glare never blinds a delver. */
function canSee(perception, light) {
  if (perception && perception.blindAbove != null && light > perception.blindAbove) return false;
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
 *   dazzled (above blindAbove)                   → 0.05 (flailing, mirror of dark)
 * `dimBelow` defaults to `blindBelow` (no partial tier) when an actor omits it.
 * `blindAbove` is optional (dark-adapted creatures only) — the bright-side cap.
 */
function hitChance(perception, light) {
  const blindBelow = perception ? perception.blindBelow : 1;
  const dimBelow = perception && perception.dimBelow != null ? perception.dimBelow : blindBelow;
  if (light < blindBelow) return 0.05;
  if (perception && perception.blindAbove != null && light > perception.blindAbove) return 0.05;
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
 *   dazzled (above blindAbove)                   → 0   (undetected — stealth in glare)
 * The `blindAbove` cap is the bright-side twin of `blindBelow`'s hard zero: it is
 * what lets a delver hauling strong light slip past a dark-adapted hunter.
 */
function noticeChance(perception, light) {
  const blindBelow = perception ? perception.blindBelow : 1;
  const dimBelow = perception && perception.dimBelow != null ? perception.dimBelow : blindBelow;
  if (light < blindBelow) return 0;
  if (perception && perception.blindAbove != null && light > perception.blindAbove) return 0;
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
  playerLightContribution,
  canSee,
  isHarmedByLight,
  hitChance,
  noticeChance,
};
