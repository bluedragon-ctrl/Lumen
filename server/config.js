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

  // The login screen offers a one-click "Log in as Admin" entry (a dev
  // affordance — login is name-only, no passwords). Set SHOW_ADMIN_LOGIN to
  // 0/false/no/off in the environment to hide it: the admin account still
  // exists and boots as normal, but it's dropped from the login screen and any
  // attempt to log in as an admin account is refused. Everything else on the
  // screen (pick / create / delete a delver) stays available.
  SHOW_ADMIN_LOGIN:
    process.env.SHOW_ADMIN_LOGIN == null
      ? true
      : !/^(0|false|no|off)$/i.test(process.env.SHOW_ADMIN_LOGIN.trim()),

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

  // Action economy (DESIGN.md §3.4 / server/README.md): every actor banks
  // `speed` energy per tick, capped at ENERGY_BANK_ACTIONS actions' worth, and an
  // action fires once the bank covers its cost. One "action" is
  // DEFAULT_ACTION_COST — the default for a weapon or mob attack that authors no
  // `actionCost` (searching costs the same, so it competes with attacking); an
  // unarmed swing is a touch quicker. A mob template with no `speed` accrues
  // DEFAULT_MOB_SPEED per tick. These four knobs must move together: the speed
  // defaults set how fast the bank fills, the costs how fast it drains.
  DEFAULT_ACTION_COST: 12,
  UNARMED_ACTION_COST: 10,
  DEFAULT_MOB_SPEED: 10,
  ENERGY_BANK_ACTIONS: 3,

  // A hidden (searched-out) groundItem with no explicit `respawn` regrows after
  // this many ticks instead of being a one-time find — a room can still author
  // its own `respawn` to override. Non-hidden groundItems are unaffected; they
  // stay static without an explicit `respawn`. See state.js `_initRooms`.
  DEFAULT_HIDDEN_ITEM_RESPAWN: 1800,

  // The sides a creature can fight FOR (a mob's instance `faction`, default
  // "wild"). The *vocabulary* lives here so the data validator and the game
  // share one whitelist; how the sides regard one another (ally/enemy/neutral)
  // is game logic and lives in state.js `FACTION_RELATIONS`.
  FACTIONS: ["player", "rim", "fauna", "wild", "umbral", "outlaw"],
  DEFAULT_FACTION: "wild", // a mob with no authored faction fights for the wild

  // The Tide — the world clock — is data-driven: its whole configuration (timing,
  // darkening, generation, messages, emotes) lives in `data/world/tide.json`, with
  // built-in defaults in server/world-clock.js (DEFAULT_TIDE / resolveTide). The
  // engine reads the resolved config off GameState (`state.tide`), so the same
  // engine can carry a different story by swapping that one JSON file.
};
