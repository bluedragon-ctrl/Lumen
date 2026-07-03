"use strict";
const fs = require("fs");
const path = require("path");
const { DATA_DIR } = require("./config");

/** Read a JSON file relative to the data directory. */
function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, rel), "utf8"));
}

/**
 * Load all static authored content into memory (read-only at runtime).
 * Returns a frozen `world` object: rooms, items, mobs, fixtures, recipes,
 * and the player template.
 */
function loadWorld() {
  const world = {
    rooms: readJson("world/rooms.json"),
    items: readJson("world/items.json"),
    mobs: readJson("world/mobs.json"),
    fixtures: readJson("world/fixtures.json"),
    recipes: readJson("world/recipes.json"),
    spells: readJson("world/spells.json"),
    quests: readJson("world/quests.json"),
    tide: readJson("world/tide.json"), // the world clock's config (see world-clock.js)
    playerTemplate: readJson("templates/player.json"),
  };
  // Static content must not be mutated at runtime; freeze the top level.
  for (const key of Object.keys(world)) Object.freeze(world[key]);
  return Object.freeze(world);
}

module.exports = { loadWorld };
