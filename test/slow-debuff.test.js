"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { GameState, makeMobInstance } = require("../server/state");

// A minimal one-room world with a single inert mob template of known speed. No
// players are admitted, so nothing spends action-energy — each advance() tick just
// banks the mob's per-tick speed accrual, which is exactly what a `slow` debuff
// (a vine-whip's lash) shaves down. Deterministic: no RNG in the accrual path.
function makeWorld() {
  const band = { blindBelow: 1, dimBelow: 3, harmedAbove: 9 };
  return {
    rooms: { arena: { id: "arena", name: "Arena", description: "", depth: 0, ambientLight: 5, exits: {} } },
    items: {},
    mobs: {
      sitter: { id: "sitter", name: "a sitter", description: "", maxHp: 50, xp: 1, faction: "wild", speed: 10, perception: band },
    },
    spells: {}, fixtures: {}, recipes: {}, quests: {},
    playerTemplate: {
      level: 1, xp: 0, shards: 0,
      attributes: { might: 5, vitality: 5, intellect: 5, wits: 0, perception: 5 },
      manaRegen: 0, speed: 12, perception: band,
      startLocation: "arena", startInventory: [], startEquipment: { light: null }, knownRecipes: [], knownSpells: [],
    },
  };
}
function addMob(state) { const m = makeMobInstance("sitter", state.world); state.rooms.arena.mobs.push(m); return m; }

test("slow: a slowed mob banks less action-energy per tick, by exactly its magnitude", () => {
  const state = new GameState(makeWorld());
  const slow = addMob(state);
  const fast = addMob(state);
  state.applyEffect(slow, { type: "slow", name: "Slowed", magnitude: 4, duration: 6 });
  state.advance();
  assert.strictEqual(fast.energy, 10, "unslowed mob banks its full speed");
  assert.strictEqual(slow.energy, 6, "slowed mob banks speed minus the slow magnitude");
});

test("slow: accrual is floored at 1 — a slow hobbles but never fully freezes", () => {
  const state = new GameState(makeWorld());
  const m = addMob(state);
  state.applyEffect(m, { type: "slow", name: "Slowed", magnitude: 99, duration: 6 });
  state.advance();
  assert.strictEqual(m.energy, 1, "a slow that exceeds speed still leaves 1 point of accrual");
});

test("slow: stacks additively across instances", () => {
  const state = new GameState(makeWorld());
  const m = addMob(state);
  state.applyEffect(m, { type: "slow", name: "Slowed", magnitude: 3, duration: 6 });
  state.applyEffect(m, { type: "slow", name: "Slowed", magnitude: 2, duration: 6 });
  assert.strictEqual(state.slowAmount(m), 5, "two live slows sum");
});

test("slow: the debuff lifts after its duration", () => {
  const state = new GameState(makeWorld());
  const m = addMob(state);
  state.applyEffect(m, { type: "slow", name: "Slowed", magnitude: 4, duration: 2 });
  assert.strictEqual(state.slowAmount(m), 4);
  state.advance(); // remaining 2 -> 1
  state.advance(); // remaining 1 -> 0, expires
  assert.strictEqual(state.slowAmount(m), 0, "slow expired after its duration");
  state.advance();
  assert.strictEqual(m.energy, 10, "back to full-speed accrual once the drag lifts");
});
