"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { GameState } = require("../server/state");
const { craft } = require("../server/commands/craft");
const { NOOP_CTX, countItem } = require("../server/commands/shared");

// A minimal lit world for craft target-resolution tests. The regression under
// test: `craft bar` used to resolve against ALL world recipes in definition
// order, so it hit "Barbed Bomb" (defined first, "bar" is a prefix of
// "barbed") and refused with "You don't know how to make Barbed Bomb" — even
// when the player knew Rion Bar, held the ore and stood at the furnace.
function makeCraftWorld(fixtures, oreQty) {
  const band = { blindBelow: 1, dimBelow: 3, harmedAbove: 9 };
  return {
    rooms: {
      forge: { id: "forge", name: "Forge", description: "", depth: 0, ambientLight: 5, exits: {}, fixtures, spawns: [] },
    },
    items: {
      rion_ore: { id: "rion_ore", name: "a lump of rion ore", description: "", type: "material", stackable: true },
      rion_bar: { id: "rion_bar", name: "a rion bar", description: "", type: "material", stackable: true },
      barbed_bomb: { id: "barbed_bomb", name: "a barbed bomb", description: "", type: "consumable", stackable: true },
    },
    mobs: {},
    spells: {},
    fixtures: {
      furnace: { id: "furnace", name: "a squat furnace", description: "", type: "scenery", station: "furnace" },
      bench: { id: "bench", name: "a tinker-bench", description: "", type: "scenery", station: "tinker" },
    },
    recipes: {
      // Barbed Bomb comes FIRST so plain definition-order matching would pick it.
      barbed_bomb: { id: "barbed_bomb", name: "Barbed Bomb", station: "tinker", inputs: [{ template: "rion_ore", qty: 1 }], output: { template: "barbed_bomb" } },
      rion_bar: { id: "rion_bar", name: "Rion Bar", station: "furnace", inputs: [{ template: "rion_ore", qty: 2 }], output: { template: "rion_bar" } },
    },
    quests: {},
    playerTemplate: {
      level: 1, xp: 0, shards: 0,
      attributes: { might: 5, vitality: 5, intellect: 5, wits: 0, perception: 5 },
      manaRegen: 0, speed: 12,
      perception: band,
      startLocation: "forge",
      startInventory: [{ template: "rion_ore", qty: oreQty }],
      startEquipment: { light: null, body: null },
      knownRecipes: ["rion_bar"], knownSpells: [],
    },
  };
}

function setup({ knownRecipes, fixtures = ["furnace", "bench"], oreQty = 2 } = {}) {
  const state = new GameState(makeCraftWorld(fixtures, oreQty));
  const p = state.createCharacter("Smith");
  state.admit(p);
  state.setPlayerLocation(p, "forge");
  if (knownRecipes) p.knownRecipes = knownRecipes;
  return { state, p };
}

test("craft prefers a known recipe over an unknown definition-order match", () => {
  const { state, p } = setup();
  const out = craft(state, p, "bar", NOOP_CTX);
  assert.ok(out.some((m) => m.type !== "error" && /You craft a rion bar/.test(m.text || "")),
    `crafts Rion Bar, got: ${JSON.stringify(out[0])}`);
  assert.equal(countItem(p, "rion_bar"), 1);
  assert.equal(countItem(p, "rion_ore"), 0, "ore consumed");
});

test("craft prefers a whole-word match over a prefix match when both are known and craftable", () => {
  const { state, p } = setup({ knownRecipes: ["barbed_bomb", "rion_bar"] });
  const out = craft(state, p, "bar", NOOP_CTX);
  assert.ok(out.some((m) => m.type !== "error" && /You craft a rion bar/.test(m.text || "")),
    `"bar" is a whole word of Rion Bar but only a prefix of Barbed Bomb, got: ${JSON.stringify(out[0])}`);
});

test("craft prefers the known recipe whose station is here", () => {
  // Only the tinker-bench is present; both recipes are known and affordable, so
  // the here-and-now Barbed Bomb outranks Rion Bar's better name match.
  const { state, p } = setup({ knownRecipes: ["barbed_bomb", "rion_bar"], fixtures: ["bench"] });
  const out = craft(state, p, "bar", NOOP_CTX);
  assert.ok(out.some((m) => m.type !== "error" && /You craft a barbed bomb/.test(m.text || "")),
    `the bomb is craftable at this station, the bar is not, got: ${JSON.stringify(out[0])}`);
});

test("craft prefers the known recipe whose inputs are in pocket", () => {
  // Both stations present, but one ore only affords the bomb (the bar needs 2).
  const { state, p } = setup({ knownRecipes: ["barbed_bomb", "rion_bar"], oreQty: 1 });
  const out = craft(state, p, "bar", NOOP_CTX);
  assert.ok(out.some((m) => m.type !== "error" && /You craft a barbed bomb/.test(m.text || "")),
    `only the bomb's inputs are affordable, got: ${JSON.stringify(out[0])}`);
});

test("craft still names the unknown recipe when nothing known matches", () => {
  const { state, p } = setup();
  const out = craft(state, p, "bomb", NOOP_CTX);
  assert.equal(out[0].type, "error");
  assert.match(out[0].text, /You don't know how to make Barbed Bomb/);
});

test("craft reports no recipe for a query matching nothing", () => {
  const { state, p } = setup();
  const out = craft(state, p, "widget", NOOP_CTX);
  assert.equal(out[0].type, "error");
  assert.match(out[0].text, /You know no recipe for "widget"/);
});
