"use strict";
const path = require("path");

/** Central configuration. Ports default to 3737 (live) / 3738 (test). */
module.exports = {
  PORT: Number(process.env.PORT) || 3737,
  TICK_MS: 1000, // world tick interval (see DESIGN.md §3.4)
  SNAPSHOT_EVERY_TICKS: 60, // persist runtime state roughly once a minute
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
  FACTIONS: ["player", "rim", "fauna", "wild", "umbral"],
  DEFAULT_FACTION: "wild", // a mob with no authored faction fights for the wild
};
