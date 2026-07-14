"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { GameState } = require("../server/state");
const { effectiveAttributes } = require("../server/combat-math");

// Minimal world: one room and a baseline-3 player template. A "fortify" buff is
// an `attr-buff` carrying a flat, timed `maxHp` — the durability a Vitality
// attrMod can't grant (pools derive from BASE attributes). These tests drive the
// effect primitive directly (applyEffect to arm, _tickEffects to age it out).
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

// Age a player's states by `n` ticks, expiring any that run out.
function tick(state, n = 1) {
  for (let i = 0; i < n; i++) state._tickEffects([]);
}

test("a fortify buff raises maxHp and grants the added capacity as current HP at once", () => {
  const state = new GameState(makeWorld());
  const p = state.createCharacter("Tester");
  state.admit(p);
  p.hp = p.maxHp; // full at 15
  const base = p.maxHp;

  state.applyEffect(p, { type: "attr-buff", name: "Bravado", attrMod: { might: 3 }, maxHp: 10, duration: 3, good: true });

  assert.equal(p.maxHp, base + 10, "maxHp lifts by the fortify amount");
  assert.equal(p.hp, base + 10, "current HP is handed the new capacity, like a level-up");
  assert.equal(effectiveAttributes(state.world, p).might, 6, "the attrMod half of the buff still applies");
});

test("when the fortify lapses, maxHp drops and current HP clamps down", () => {
  const state = new GameState(makeWorld());
  const p = state.createCharacter("Tester");
  state.admit(p);
  p.hp = p.maxHp;
  const base = p.maxHp;

  state.applyEffect(p, { type: "attr-buff", name: "Bravado", maxHp: 10, duration: 2, good: true });
  assert.equal(p.hp, base + 10);

  tick(state, 2); // buff expires on the 2nd tick
  assert.equal(p.states.length, 0, "the buff is gone");
  assert.equal(p.maxHp, base, "maxHp returns to its unbuffed value");
  assert.equal(p.hp, base, "the borrowed HP is clamped away, not kept");
});

test("a fortify buffer above normal max is only trimmed to the (now lower) cap on expiry", () => {
  const state = new GameState(makeWorld());
  const p = state.createCharacter("Tester");
  state.admit(p);
  const base = p.maxHp;
  p.hp = 8; // wounded, below base max

  state.applyEffect(p, { type: "attr-buff", name: "Bravado", maxHp: 10, duration: 1, good: true });
  assert.equal(p.hp, 18, "the +10 buffer stacks on current HP (8 -> 18), above base max");

  tick(state, 1); // expire
  assert.equal(p.maxHp, base, "cap back to base");
  assert.equal(p.hp, base, "18 clamps down to the 15 base cap");
});

test("a Vitality attr-buff is inert for maxHp (why fortify exists) but fortify is not", () => {
  const state = new GameState(makeWorld());
  const p = state.createCharacter("Tester");
  state.admit(p);
  const base = p.maxHp;

  // A +vitality buff changes effective Vitality but NOT the pool (pools read base).
  state.applyEffect(p, { type: "attr-buff", name: "Vim", attrMod: { vitality: 3 }, duration: 5, good: true });
  assert.equal(effectiveAttributes(state.world, p).vitality, 6);
  assert.equal(p.maxHp, base, "a Vitality attrMod does nothing to maxHp");

  // A fortify buff, by contrast, does lift it.
  state.applyEffect(p, { type: "attr-buff", name: "Bravado", maxHp: 10, duration: 5, good: true });
  assert.equal(p.maxHp, base + 10);
});
