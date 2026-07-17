"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { GameState } = require("../server/state");
const { execute } = require("../server/commands");

// A minimal lit world with three grip-competing items: a one-handed weapon, a
// two-handed weapon, and a shield. Exercises the rule that a two-handed weapon
// and a shield can never be worn together (either auto-frees the other), while a
// one-handed weapon and a shield coexist.
function makeGripWorld() {
  const band = { blindBelow: 1, dimBelow: 3, harmedAbove: 9 };
  return {
    rooms: {
      arena: { id: "arena", name: "Arena", description: "", depth: 0, ambientLight: 5, exits: {}, fixtures: [], spawns: [] },
    },
    items: {
      dagger: { id: "dagger", name: "a dagger", description: "", type: "weapon", slot: "hand", weight: 1, value: 5, weapon: { damage: { physical: "1d4" }, actionCost: 10 } },
      maul: { id: "maul", name: "a maul", description: "", type: "weapon", slot: "hand", weight: 5, value: 20, weapon: { damage: { physical: "1d12" }, actionCost: 16, twoHanded: true } },
      shield: { id: "shield", name: "a shield", description: "", type: "armour", slot: "shield", weight: 4, value: 10, armour: { armour: 1, ward: 0, speedPenalty: 1 } },
    },
    mobs: {}, spells: {}, fixtures: {}, recipes: {}, quests: {},
    playerTemplate: {
      level: 1, xp: 0, shards: 0,
      attributes: { might: 5, vitality: 5, intellect: 5, wits: 5, perception: 5 },
      manaRegen: 0, speed: 12,
      perception: band,
      startLocation: "arena",
      startInventory: [{ template: "dagger" }, { template: "maul" }, { template: "shield" }],
      startEquipment: { hand: null, shield: null, light: null },
      knownRecipes: [], knownSpells: [],
    },
  };
}

function setup() {
  const state = new GameState(makeGripWorld());
  const p = state.createCharacter("Tester");
  state.admit(p);
  state.setPlayerLocation(p, "arena");
  return { state, p };
}

const tmplAt = (p, slot) => (p.equipment[slot] ? p.equipment[slot].template : null);
const carries = (p, tmpl) => p.inventory.some((i) => i.template === tmpl);

test("a one-handed weapon and a shield coexist in their own slots", () => {
  const { state, p } = setup();
  execute(state, p, "equip dagger");
  execute(state, p, "equip shield");
  assert.equal(tmplAt(p, "hand"), "dagger");
  assert.equal(tmplAt(p, "shield"), "shield");
});

test("wielding a two-handed weapon auto-frees an equipped shield", () => {
  const { state, p } = setup();
  execute(state, p, "equip shield");
  assert.equal(tmplAt(p, "shield"), "shield");
  execute(state, p, "equip maul");
  assert.equal(tmplAt(p, "hand"), "maul");
  assert.equal(tmplAt(p, "shield"), null, "shield slot emptied");
  assert.ok(carries(p, "shield"), "shield returned to the pack");
});

test("equipping a shield auto-frees an equipped two-handed weapon", () => {
  const { state, p } = setup();
  execute(state, p, "equip maul");
  assert.equal(tmplAt(p, "hand"), "maul");
  execute(state, p, "equip shield");
  assert.equal(tmplAt(p, "shield"), "shield");
  assert.equal(tmplAt(p, "hand"), null, "two-handed weapon released from hand");
  assert.ok(carries(p, "maul"), "maul returned to the pack");
});

test("equipping a shield leaves a one-handed weapon in hand untouched", () => {
  const { state, p } = setup();
  execute(state, p, "equip dagger");
  execute(state, p, "equip shield");
  assert.equal(tmplAt(p, "hand"), "dagger", "one-handed weapon not displaced");
  assert.equal(tmplAt(p, "shield"), "shield");
});
