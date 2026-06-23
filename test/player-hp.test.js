"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { GameState, xpForLevel } = require("../server/state");
const { HP_BASE, HP_PER_LEVEL, HP_PER_VITALITY } = require("../server/combat-math");

// Minimal world: one room and a Vitality-3 player template, so maxHp is exercised
// purely through the level/Vitality formula (no gear bonus in play).
function makeWorld() {
  const band = { blindBelow: 1, dimBelow: 3, harmedAbove: 9 };
  return {
    rooms: { arena: { id: "arena", name: "Arena", description: "", depth: 0, ambientLight: 5, exits: {} } },
    items: {}, mobs: {}, spells: {}, fixtures: {}, recipes: {}, quests: {},
    playerTemplate: {
      level: 1, xp: 0, shards: 0,
      attributes: { might: 3, vitality: 3, intellect: 3, wits: 3, perception: 3 },
      manaRegen: 0, speed: 12, perception: band,
      startLocation: "arena", startInventory: [], startEquipment: {},
      knownRecipes: [], knownSpells: [],
    },
  };
}

const expectedHp = (level, vit) => HP_BASE + (level - 1) * HP_PER_LEVEL + vit * HP_PER_VITALITY;

test("maxHp = base + per-level + per-Vitality; a fresh L1/Vit-3 character starts at 15", () => {
  const state = new GameState(makeWorld());
  const p = state.createCharacter("Tester");
  assert.equal(p.maxHp, expectedHp(1, 3));
  assert.equal(p.maxHp, 15); // the historical starting value is preserved
  assert.equal(p.hp, p.maxHp);
});

test("levelling up lifts maxHp for every build and grants the new capacity immediately", () => {
  const state = new GameState(makeWorld());
  const p = state.createCharacter("Tester");
  state.admit(p);
  p.hp = p.maxHp; // start at full

  const before = p.maxHp;
  const ups = state.awardXp(p, xpForLevel(2)); // cross exactly one level
  assert.equal(p.level, 2);
  assert.equal(ups.length, 1);
  // Vitality untouched, but the level term still raises the cap...
  assert.equal(p.maxHp, expectedHp(2, 3));
  assert.equal(p.maxHp - before, HP_PER_LEVEL);
  // ...and the gained capacity is handed to current hp, not left behind.
  assert.equal(p.hp, p.maxHp);
});

test("a multi-level award grants every level's HP in one go", () => {
  const state = new GameState(makeWorld());
  const p = state.createCharacter("Tester");
  state.admit(p);
  p.hp = p.maxHp;

  state.awardXp(p, xpForLevel(4)); // jump to level 4 in a single award
  assert.equal(p.level, 4);
  assert.equal(p.maxHp, expectedHp(4, 3));
  assert.equal(p.hp, p.maxHp);
});

test("training Vitality adds HP_PER_VITALITY on top of the level term", () => {
  const state = new GameState(makeWorld());
  const p = state.createCharacter("Tester");
  p.attributes.vitality += 1;
  state.deriveStats(p);
  assert.equal(p.maxHp, expectedHp(1, 4));
});
