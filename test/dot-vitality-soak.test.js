"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { GameState, makeMobInstance } = require("../server/state");
const { physicalDotSoak } = require("../server/combat-math");

// A *physical* DoT pulse is soaked flat by the defender's Vitality — floor(vit/8)
// per tick, the lingering-wound counterpart to Armour soaking a physical blow
// (Armour shrugs the strike, Vitality shrugs the bleed). Player-only: mobs never
// get it, so bleed offence stays predictable. Non-physical DoT is the ward
// fizzle's job (no Vitality cut, no double-dip), and the pulse's floor-of-1 still
// lets a soaked bleed sting. These drive _tickEffects with the Vitality set
// directly; physical DoTs never fizzle, so no RNG pinning is needed.
function makeWorld() {
  const band = { blindBelow: 1, dimBelow: 3, harmedAbove: 9 };
  return {
    rooms: { arena: { id: "arena", name: "Arena", description: "", depth: 0, ambientLight: 5, exits: {} } },
    items: {},
    mobs: {
      // A tough mob with real Vitality — used to prove the soak is players-only.
      brute: { id: "brute", name: "a brute", description: "", maxHp: 100, xp: 1, faction: "wild", perception: band, attributes: { might: 5, vitality: 40, intellect: 0, wits: 0, perception: 5 } },
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
function addPlayer(state, vitality) {
  const p = state.createCharacter("Tester");
  state.admit(p);
  state.setPlayerLocation(p, "arena");
  p.attributes.vitality = vitality;
  return p;
}
function tickLoss(state, actor) {
  const before = actor.hp;
  state._tickEffects([]);
  return before - actor.hp;
}

// --- the pure soak curve -----------------------------------------------------

test("physicalDotSoak: floor(vitality / 8), zero at baseline", () => {
  assert.equal(physicalDotSoak(3), 0); // ATTR_BASELINE → no soak; you must invest
  assert.equal(physicalDotSoak(7), 0);
  assert.equal(physicalDotSoak(8), 1);
  assert.equal(physicalDotSoak(16), 2);
  assert.equal(physicalDotSoak(24), 3);
  assert.equal(physicalDotSoak(40), 5);
  assert.equal(physicalDotSoak(undefined), 0); // missing attribute → no soak
});

// --- player defender ---------------------------------------------------------

test("player: a physical DoT pulse is reduced by floor(Vitality/8)", () => {
  const state = new GameState(makeWorld());
  const p = addPlayer(state, 24); // soak 3
  state.applyEffect(p, { type: "damage-over-time", name: "gash", damageType: "physical", damage: "5", duration: 99 });
  assert.equal(tickLoss(state, p), 2, "5 rolled − 3 soak = 2");
});

test("player: a soaked physical pulse still stings (floor of 1)", () => {
  const state = new GameState(makeWorld());
  const p = addPlayer(state, 40); // soak 5, ≥ the pulse
  state.applyEffect(p, { type: "damage-over-time", name: "gash", damageType: "physical", damage: "5", duration: 99 });
  assert.equal(tickLoss(state, p), 1, "5 − 5 floors to 1, never 0");
});

test("player: baseline Vitality gives no soak — the pulse lands in full", () => {
  const state = new GameState(makeWorld());
  const p = addPlayer(state, 5); // floor(5/8) = 0
  state.applyEffect(p, { type: "damage-over-time", name: "gash", damageType: "physical", damage: "5", duration: 99 });
  assert.equal(tickLoss(state, p), 5, "no investment → no reduction");
});

test("player: Vitality does not soak a NON-physical DoT (ward's job, no double-dip)", () => {
  const state = new GameState(makeWorld());
  const p = addPlayer(state, 40); // huge soak, but irrelevant to void
  // No Voidward on the player → the void pulse never fizzles, so it lands; Vitality
  // must not also trim it.
  state.applyEffect(p, { type: "damage-over-time", name: "gloom-rot", damageType: "void", damage: "5", duration: 99 });
  assert.equal(tickLoss(state, p), 5, "void lands in full — Vitality is a physical-only soak");
});

// --- mob defender: players-only --------------------------------------------

test("mob: a physical DoT is NOT soaked by the mob's Vitality (players-only rule)", () => {
  const state = new GameState(makeWorld());
  const m = makeMobInstance("brute", state.world); // vitality 40
  state.rooms.arena.mobs.push(m);
  state.applyEffect(m, { type: "damage-over-time", name: "bleed", damageType: "physical", damage: "5", duration: 99 });
  assert.equal(tickLoss(state, m), 5, "a player's bleed lands in full on even a high-Vitality mob");
});
