"use strict";
/**
 * The Tide — a world clock that periodically darkens every room and (later)
 * looses light-fearing predators. Framing: the abyss breathes. Calm is the long
 * quiet; the Tide is the dark drawing in. Pure phase math here; GameState drives
 * the world side (see _tideTick / _applyTidePhase in state.js).
 *
 * The phase is a pure function of the tick — no stored timer to persist or drift,
 * so a server restart simply begins again in Calm.
 */

// Phase order around the cycle. Stirring is the telegraph (lamps gutter); the
// Tide is the danger; Receding is the ebb back to Calm.
const PHASES = ["calm", "stirring", "tide", "receding"];

/**
 * Resolve the tide phase at a given tick from the configured per-phase lengths.
 * Returns { phase, sinceStart, untilNext, cycleTick, cycle }. `lengths` is a map
 * of phase → tick count (see config.TIDE.phaseTicks).
 */
function tidePhaseAt(tick, lengths) {
  const cycle = PHASES.reduce((a, p) => a + (lengths[p] || 0), 0);
  if (cycle <= 0) return { phase: "calm", sinceStart: 0, untilNext: 0, cycleTick: 0, cycle: 0 };
  const t = ((tick % cycle) + cycle) % cycle; // wrap; safe for tick 0 and any growth
  let acc = 0;
  for (const phase of PHASES) {
    const len = lengths[phase] || 0;
    if (t < acc + len) return { phase, sinceStart: t - acc, untilNext: acc + len - t, cycleTick: t, cycle };
    acc += len;
  }
  return { phase: "calm", sinceStart: 0, untilNext: 0, cycleTick: t, cycle }; // unreachable
}

/**
 * The light offset a phase applies to a room at the given depth (always ≤ 0,
 * folded into the room's ambient by computeRoomLight). The Tide darkening scales
 * with depth — the rim barely dips, the deep plunges — floored at `cfg.deepCap`:
 *   tide:               max(deepCap, -2 - floor(depth/3))
 *   stirring/receding:  cfg.edgeOffset (a flat partial dim — the warning / ebb)
 *   calm:               0
 */
function tideOffset(phase, depth, cfg) {
  if (phase === "tide") return Math.max(cfg.deepCap, -2 - Math.floor((depth || 0) / 3));
  if (phase === "stirring" || phase === "receding") return cfg.edgeOffset;
  return 0;
}

module.exports = { PHASES, tidePhaseAt, tideOffset };
