"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { GameState, roomEffectFires } = require("../server/state");

// A small, mutable world so tests can set room.effects directly (loadWorld() is
// frozen). Two rooms, a torch with a light block, a player template that starts
// with a lit-capable torch and a `light` equip slot.
function makeTestWorld() {
  return {
    rooms: {
      "test.bright": { id: "test.bright", name: "Bright Room", description: "", depth: 0, ambientLight: 5, exits: { north: "test.dark" } },
      "test.dark": { id: "test.dark", name: "Dark Room", description: "", depth: 1, ambientLight: 0, exits: { south: "test.bright" } },
    },
    items: {
      torch: { id: "torch", name: "a torch", description: "", type: "light", slot: "light", weight: 1, value: 1, light: { output: 3, fuelMax: 200, burnPerTick: 1 } },
    },
    mobs: {},
    fixtures: {},
    recipes: {},
    spells: {},
    quests: {},
    playerTemplate: {
      level: 1, xp: 0, shards: 0,
      attributes: { might: 5, vitality: 5, intellect: 5, wits: 5, perception: 5 },
      manaRegen: 0, speed: 12,
      perception: { blindBelow: 1, dimBelow: 3, harmedAbove: 9 },
      startLocation: "test.bright",
      startInventory: [{ template: "torch", fuel: 200 }],
      startEquipment: { light: null },
      knownRecipes: [], knownSpells: [],
    },
  };
}

// Build a GameState with one admitted player standing in `roomId`.
function gsWithPlayer(roomId = "test.bright") {
  const state = new GameState(makeTestWorld());
  const player = state.createCharacter("Tester");
  state.admit(player);
  state.setPlayerLocation(player, roomId);
  return { state, player };
}

test("roomEffectFires: no condition always fires", () => {
  assert.equal(roomEffectFires({}, 0), true);
  assert.equal(roomEffectFires({ when: undefined }, 9), true);
});

test("roomEffectFires: lightBelow fires only under the threshold", () => {
  assert.equal(roomEffectFires({ when: { lightBelow: 1 } }, 0), true);
  assert.equal(roomEffectFires({ when: { lightBelow: 1 } }, 1), false);
  assert.equal(roomEffectFires({ when: { lightBelow: 3 } }, 2), true);
});

test("roomEffectFires: lightAbove fires only over the threshold", () => {
  assert.equal(roomEffectFires({ when: { lightAbove: 9 } }, 10), true);
  assert.equal(roomEffectFires({ when: { lightAbove: 9 } }, 9), false);
});

module.exports = { makeTestWorld, gsWithPlayer };
