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
};
