"use strict";
const path = require("path");

/** Central configuration. Ports default to 3737 (live) / 3738 (test). */
module.exports = {
  PORT: Number(process.env.PORT) || 3737,
  TICK_MS: 1000, // world tick interval (see DESIGN.md §3.4)
  SNAPSHOT_EVERY_TICKS: 60, // persist runtime state roughly once a minute
  // Death pacing: a fallen delver lies dying in the death room for this many ticks
  // (≈ seconds, at TICK_MS) before waking at the rim — a beat to register the fall
  // rather than being teleported mid-swing. See _beginDeath / _dyingTick in state.js.
  DEATH_DELAY_TICKS: 3,
  DATA_DIR: path.resolve(__dirname, "..", "data"),
  RUNTIME_DIR: path.resolve(__dirname, "..", "data", "runtime"),
  CLIENT_DIR: path.resolve(__dirname, "..", "client"),
  VERSION: require("../package.json").version,

  // Leveling: `xp` is a lifetime total. The XP increment for level N→N+1 is
  // XP_BASE * XP_GROWTH^(N-1) — so 1→2 costs XP_BASE, and each further level
  // costs XP_GROWTH× the last. Each level gained grants POINTS_PER_LEVEL
  // attribute points to spend with `train`.
  XP_BASE: 100,
  XP_GROWTH: 2,
  POINTS_PER_LEVEL: 2,
  // One-off XP the first time a delver sets foot in a room (rewards descent;
  // each room pays once, tracked per player in `visitedRooms`). Crafting XP is
  // not a constant — it equals the output's sale value (see commands.js craft).
  EXPLORE_XP: 5,

  // The sides a creature can fight FOR (a mob's instance `faction`, default
  // "wild"). The *vocabulary* lives here so the data validator and the game
  // share one whitelist; how the sides regard one another (ally/enemy/neutral)
  // is game logic and lives in state.js `FACTION_RELATIONS`.
  FACTIONS: ["player", "rim", "fauna", "wild", "umbral", "outlaw"],
  DEFAULT_FACTION: "wild", // a mob with no authored faction fights for the wild

  // The Tide — the world clock (see server/world-clock.js). The abyss breathes
  // on a fixed cycle: a long Calm, a brief Stirring (the telegraph), the Tide
  // (every room darkens, depth-scaled, and light-fearing predators stir), then a
  // Receding ebb back to Calm. Lengths are in ticks (≈ seconds at TICK_MS).
  // `deepCap` floors the depth-scaled darkening; `edgeOffset` is the partial dim
  // during Stirring/Receding. Toggle the whole system with `enabled`.
  TIDE: {
    enabled: true,
    phaseTicks: { calm: 600, stirring: 60, tide: 240, receding: 60 },
    deepCap: -5, // floor on the depth-scaled Tide darkening (-2 - floor(depth/3))
    edgeOffset: -1, // the gentle dim during Stirring (warning) and Receding (ebb)
    // The dark grows teeth: during the Tide, each tick every room where a living
    // delver stands in failed light (room light < 0) has `predator.chance` to birth
    // a `predator.mob` right beside them, up to `predator.cap` shadows worldwide. The
    // ebb reclaims them (they are tide-spawned). Lit camps (light ≥ 0) are never
    // touched. One tier for now; depth-scaled rosters come later. Set predator:null
    // to leave the Tide toothless (the darkening cycle only, no hunters).
    predator: { mob: "void-shadow", chance: 0.05, cap: 5, faction: "wild", noSpoils: false },
  },
};
