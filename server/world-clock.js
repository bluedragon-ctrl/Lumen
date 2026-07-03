"use strict";
/**
 * The Tide — a world clock that periodically darkens every room and looses
 * light-fearing predators. Framing: the abyss breathes. Calm is the long quiet;
 * the Tide is the dark drawing in. Pure phase math here; GameState drives the
 * world side (see _tideTick / _applyTidePhase in state.js).
 *
 * The phase is a pure function of the tick — no stored timer to persist or drift,
 * so a server restart simply begins again in the first phase.
 *
 * The Tide is data-driven: the whole configuration below (timing, darkening,
 * generation, messages, emotes) is authored in `data/world/tide.json` so the same
 * engine can carry a different story. DEFAULT_TIDE is the built-in fallback that
 * the JSON overrides (see resolveTide); it mirrors the shipped world.
 */

// Default phase order around the cycle. Stirring is the telegraph (lamps gutter);
// the Tide is the danger; Receding is the ebb back to Calm. A world may reorder or
// rename these via tide.json `phases` (paired with matching `phaseTicks` keys).
const PHASES = ["calm", "stirring", "tide", "receding"];

// Built-in Tide configuration — the fallback merged under `data/world/tide.json`
// by resolveTide. Keeping the defaults here (rather than in config.js) keeps all
// the tide knobs in one place and lets test worlds that omit `tide` behave exactly
// like the shipped world.
const DEFAULT_TIDE = {
  enabled: true,
  phases: ["calm", "stirring", "tide", "receding"],
  // Per-phase length in ticks (≈ seconds at TICK_MS).
  phaseTicks: { calm: 600, stirring: 60, tide: 240, receding: 60 },
  // The depth-scaled darkening (see tideOffset). `deepCap` floors it; `edgeOffset`
  // is the flat partial dim during the edge phases. `tidePhases` are the phases
  // that plunge the world into the dark (and loose predators); `edgePhases` are the
  // gentle warning/ebb dims.
  darkening: {
    deepCap: -5,
    edgeOffset: -1,
    tideBase: -2,
    tideDepthDivisor: 3,
    tidePhases: ["tide"],
    edgePhases: ["stirring", "receding"],
  },
  // NPCs work the lamps as the Tide turns: thrown on entering `onPhases`, snuffed
  // again entering `offPhases`. A phase in neither leaves the lamps as they are.
  lamp: {
    onPhases: ["stirring", "tide"],
    offPhases: ["calm"],
    onMessage: "Lamps flare to life around you, beating back the gathering dark.",
    offMessage: "The lamps are snuffed out as the dark recedes.",
  },
  // One world-wide line per phase change (see state._applyTidePhase). A phase with
  // no entry announces nothing.
  phaseMessages: {
    stirring: "<#gold>The lamps gutter and dim. Far below, something vast draws breath — the dark is stirring.<#reset>",
    tide: "<#red>The Tide comes in. The dark floods every passage. Seek the light, or be taken by it.<#reset>",
    receding: "<#cyan>The Tide turns. The dark loosens its grip and begins to ebb.<#reset>",
    calm: "<#cyan>The abyss settles. The dark has receded — for now.<#reset>",
  },
  // The dark grows teeth: during a tidePhase, each tick every room where a living
  // delver stands in failed light (room light < 0) has `chance` to birth one `mob`
  // right beside them, up to `cap` worldwide. The ebb reclaims them (tide-spawned).
  // Set predator:null to leave the Tide toothless (the darkening cycle only).
  predator: { mob: "void-shadow", chance: 0.05, cap: 5, faction: "wild", noSpoils: false },
  // Optional onset roster: mobs the Tide looses across whole depth bands the instant
  // it comes in (as opposed to the per-tick creep above). Each rule:
  // { mob, minDepth, maxDepth, count, maxLight, faction, noSpoils }. Empty by default.
  spawns: [],
  // Ambient atmospheric lines the Tide itself performs during a phase — flavour
  // with no other home (a mob's own arrival/exit flavour lives on the mob). Keyed
  // by phase: { everyTicks, chance, requireDark, lines: [...] }.
  emotes: {},
};

/**
 * Resolve the effective Tide config for a world: `world.tide` (from
 * data/world/tide.json) merged over DEFAULT_TIDE. Top-level keys override; the
 * known object-valued sections (darkening, lamp, phaseMessages, predator, emotes)
 * are merged one level deep so a partial override keeps the untouched defaults.
 * A world with no `tide` gets DEFAULT_TIDE verbatim (used by the test worlds).
 */
function resolveTide(world) {
  const authored = (world && world.tide) || {};
  const merged = { ...DEFAULT_TIDE, ...authored };
  for (const key of ["darkening", "lamp", "phaseMessages", "emotes"]) {
    if (authored[key]) merged[key] = { ...DEFAULT_TIDE[key], ...authored[key] };
  }
  // predator is either an object (merged) or explicitly null (toothless).
  if (Object.prototype.hasOwnProperty.call(authored, "predator")) {
    merged.predator = authored.predator ? { ...DEFAULT_TIDE.predator, ...authored.predator } : null;
  }
  return merged;
}

/**
 * Resolve the tide phase at a given tick from the configured per-phase lengths.
 * Returns { phase, sinceStart, untilNext, cycleTick, cycle }. `lengths` is a map
 * of phase → tick count; `phases` is the order to walk (defaults to PHASES).
 */
function tidePhaseAt(tick, lengths, phases = PHASES) {
  const cycle = phases.reduce((a, p) => a + (lengths[p] || 0), 0);
  if (cycle <= 0) return { phase: phases[0] || "calm", sinceStart: 0, untilNext: 0, cycleTick: 0, cycle: 0 };
  const t = ((tick % cycle) + cycle) % cycle; // wrap; safe for tick 0 and any growth
  let acc = 0;
  for (const phase of phases) {
    const len = lengths[phase] || 0;
    if (t < acc + len) return { phase, sinceStart: t - acc, untilNext: acc + len - t, cycleTick: t, cycle };
    acc += len;
  }
  return { phase: phases[0] || "calm", sinceStart: 0, untilNext: 0, cycleTick: t, cycle }; // unreachable
}

/**
 * The light offset a phase applies to a room at the given depth (always ≤ 0,
 * folded into the room's ambient by computeRoomLight). The Tide darkening scales
 * with depth — the rim barely dips, the deep plunges — floored at `cfg.deepCap`.
 * `cfg` is the resolved `darkening` config:
 *   tidePhases:  max(deepCap, tideBase - floor(depth/tideDepthDivisor))
 *   edgePhases:  cfg.edgeOffset (a flat partial dim — the warning / ebb)
 *   otherwise:   0
 */
function tideOffset(phase, depth, cfg) {
  const tidePhases = cfg.tidePhases || DEFAULT_TIDE.darkening.tidePhases;
  const edgePhases = cfg.edgePhases || DEFAULT_TIDE.darkening.edgePhases;
  if (tidePhases.includes(phase)) {
    const base = cfg.tideBase != null ? cfg.tideBase : DEFAULT_TIDE.darkening.tideBase;
    const div = cfg.tideDepthDivisor || DEFAULT_TIDE.darkening.tideDepthDivisor;
    return Math.max(cfg.deepCap, base - Math.floor((depth || 0) / div));
  }
  if (edgePhases.includes(phase)) return cfg.edgeOffset;
  return 0;
}

module.exports = { PHASES, DEFAULT_TIDE, resolveTide, tidePhaseAt, tideOffset };
