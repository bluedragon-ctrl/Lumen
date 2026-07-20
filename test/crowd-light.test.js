"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { GameState, makeItemInstance } = require("../server/state");
const { bandOf } = require("../server/light");

// A dark room and a lit-torch player template — mirrors room-effects.test.js so
// we exercise the real computeRoomLight wiring (lit-lamp gate, per-player sum,
// crowd diminishing) rather than the pure light.js function in isolation.
function makeTestWorld() {
  return {
    rooms: {
      "test.dark": { id: "test.dark", name: "Dark Room", description: "", depth: 1, ambientLight: 0, exits: {} },
    },
    items: {
      torch: { id: "torch", name: "a torch", description: "", type: "light", slot: "light", weight: 1, value: 1, light: { output: 3, fuelMax: 200, burnPerTick: 1 } },
      blaze: { id: "blaze", name: "a blaze-lantern", description: "", type: "light", slot: "light", weight: 2, value: 75, light: { output: 7, fuelMax: 600, burnPerTick: 5 } },
    },
    mobs: {}, fixtures: {}, recipes: {}, spells: {}, quests: {},
    playerTemplate: {
      level: 1, xp: 0, shards: 0,
      attributes: { might: 5, vitality: 5, intellect: 5, wits: 5, perception: 5 },
      manaRegen: 0, speed: 12,
      perception: { blindBelow: 1, dimBelow: 3, harmedAbove: 9 },
      startLocation: "test.dark",
      startInventory: [], startEquipment: { light: null },
      knownRecipes: [], knownSpells: [],
    },
  };
}

// Admit `count` players into test.dark, each equipped with a lit `template`.
function crowdInDark(count, template = "torch") {
  const state = new GameState(makeTestWorld());
  for (let i = 0; i < count; i++) {
    const p = state.createCharacter("Delver" + i);
    state.admit(p);
    state.setPlayerLocation(p, "test.dark");
    p.equipment.light = makeItemInstance({ template, fuel: 200 }, state.world);
    p.equipment.light.lit = true;
  }
  return state;
}

test("crowd light: one torch lights a dark room to 3 (bright)", () => {
  assert.equal(crowdInDark(1).computeRoomLight("test.dark"), 3);
});

test("crowd light: four torches settle at 6 (bright), not 12 (searing)", () => {
  const light = crowdInDark(4).computeRoomLight("test.dark");
  assert.equal(light, 6);
  assert.equal(bandOf(light), "bright");
});

test("crowd light: an unlit torch contributes nothing", () => {
  const state = crowdInDark(2);
  const [a] = state.playersIn("test.dark");
  a.equipment.light.lit = false; // douse one
  assert.equal(state.computeRoomLight("test.dark"), 3); // the remaining lit torch only
});

test("crowd light: two blaze-lanterns still reach searing", () => {
  const light = crowdInDark(2, "blaze").computeRoomLight("test.dark");
  assert.equal(light, 10);
  assert.equal(bandOf(light), "searing");
});
