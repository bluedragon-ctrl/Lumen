"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { GameState, makeMobInstance } = require("../server/state");

// A DoT pulse of a classified non-physical type rolls the same all-or-nothing
// Ward fizzle a hostile *cast* faces (see wardNegates / _dotResisted): void pulses
// consult Voidward, other classified pulses consult Spellward, and each due pulse
// rolls fresh. Physical and UNTYPED pulses always land (legacy bleeds keep their
// behaviour). These drive _tickEffects directly with Math.random pinned, so the
// fizzle roll is deterministic: wardNegates = (pool > 0) && random < pool * 0.01.
function makeWorld() {
  const band = { blindBelow: 1, dimBelow: 3, harmedAbove: 9 };
  return {
    rooms: { arena: { id: "arena", name: "Arena", description: "", depth: 0, ambientLight: 5, exits: {} } },
    items: {},
    mobs: {
      // Tanky, ward-less template — each test grants the ward it needs via a
      // "protect" state (mobDefence sums those), so one template covers every case.
      rotter: { id: "rotter", name: "a rotter", description: "", maxHp: 100, xp: 1, faction: "wild", perception: band },
    },
    spells: {}, fixtures: {}, recipes: {}, quests: {},
    playerTemplate: {
      level: 1, xp: 0, shards: 0,
      attributes: { might: 5, vitality: 5, intellect: 5, wits: 0, perception: 5 }, // wits 0 → no baseline Ward
      manaRegen: 0, speed: 12, perception: band,
      startLocation: "arena", startInventory: [], startEquipment: { light: null }, knownRecipes: [], knownSpells: [],
    },
  };
}
function addMob(state) { const m = makeMobInstance("rotter", state.world); state.rooms.arena.mobs.push(m); return m; }

// Run one tick with Math.random pinned, returning the HP the target lost.
function tickLoss(state, actor, random) {
  const orig = Math.random;
  Math.random = () => random;
  try {
    const before = actor.hp;
    state._tickEffects([]);
    return before - actor.hp;
  } finally {
    Math.random = orig;
  }
}

// --- mob defender (mobDefence path) ------------------------------------------

test("void DoT: a fizzle roll under Voidward skips the whole pulse (no damage)", () => {
  const state = new GameState(makeWorld());
  const m = addMob(state);
  state.applyEffect(m, { type: "protect", name: "Shell", voidWard: 50, duration: 99 });
  state.applyEffect(m, { type: "damage-over-time", name: "gloom-rot", damageType: "void", damage: "5", duration: 99 });
  assert.equal(tickLoss(state, m, 0), 0, "random 0 < 50*0.01 → the void pulse fizzles whole");
});

test("void DoT: a fizzle roll that misses Voidward lets the pulse land in full", () => {
  const state = new GameState(makeWorld());
  const m = addMob(state);
  state.applyEffect(m, { type: "protect", name: "Shell", voidWard: 50, duration: 99 });
  state.applyEffect(m, { type: "damage-over-time", name: "gloom-rot", damageType: "void", damage: "5", duration: 99 });
  assert.equal(tickLoss(state, m, 0.99), 5, "random 0.99 ≥ 50*0.01 → the pulse lands for its full 5");
});

test("void DoT: Spellward does not fizzle it — only Voidward guards void", () => {
  const state = new GameState(makeWorld());
  const m = addMob(state);
  state.applyEffect(m, { type: "protect", name: "Shell", ward: 100, voidWard: 0, duration: 99 });
  state.applyEffect(m, { type: "damage-over-time", name: "gloom-rot", damageType: "void", damage: "5", duration: 99 });
  assert.equal(tickLoss(state, m, 0), 5, "voidWard 0 → void lands even under maxed Spellward");
});

test("magical DoT: Voidward does not fizzle it — only Spellward guards magical", () => {
  const state = new GameState(makeWorld());
  const m = addMob(state);
  state.applyEffect(m, { type: "protect", name: "Shell", ward: 0, voidWard: 100, duration: 99 });
  state.applyEffect(m, { type: "damage-over-time", name: "witchfire", damageType: "magical", damage: "5", duration: 99 });
  assert.equal(tickLoss(state, m, 0), 5, "ward 0 → a magical pulse lands even under maxed Voidward");
});

test("magical DoT: a fizzle roll under Spellward skips the pulse", () => {
  const state = new GameState(makeWorld());
  const m = addMob(state);
  state.applyEffect(m, { type: "protect", name: "Shell", ward: 50, duration: 99 });
  state.applyEffect(m, { type: "damage-over-time", name: "witchfire", damageType: "magical", damage: "5", duration: 99 });
  assert.equal(tickLoss(state, m, 0), 0, "random 0 < 50*0.01 → the magical pulse fizzles");
});

test("untyped DoT: never fizzles, even under maxed Ward (legacy bleeds unchanged)", () => {
  const state = new GameState(makeWorld());
  const m = addMob(state);
  state.applyEffect(m, { type: "protect", name: "Shell", ward: 100, voidWard: 100, duration: 99 });
  state.applyEffect(m, { type: "damage-over-time", name: "bleed", damage: "5", duration: 99 }); // no damageType
  assert.equal(tickLoss(state, m, 0), 5, "an untyped pulse always lands");
});

test("physical DoT: never fizzles — Armour soaks, Ward never touches it", () => {
  const state = new GameState(makeWorld());
  const m = addMob(state);
  state.applyEffect(m, { type: "protect", name: "Shell", ward: 100, voidWard: 100, duration: 99 });
  state.applyEffect(m, { type: "damage-over-time", name: "gash", damageType: "physical", damage: "5", duration: 99 });
  assert.equal(tickLoss(state, m, 0), 5, "a physical pulse always lands");
});

// --- player defender (playerDefence path) ------------------------------------

test("player: a void DoT fizzles against a caster-granted Voidward weave", () => {
  const state = new GameState(makeWorld());
  const p = state.createCharacter("Tester");
  state.admit(p);
  state.setPlayerLocation(p, "arena");
  state.applyEffect(p, { type: "protect", name: "Halo", voidWard: 50, duration: 99 });
  state.applyEffect(p, { type: "damage-over-time", name: "gloom-rot", damageType: "void", damage: "5", duration: 99 });
  assert.equal(tickLoss(state, p, 0), 0, "the same fizzle roll guards players via playerDefence");
});
