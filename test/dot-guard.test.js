"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { GameState, makeMobInstance } = require("../server/state");

// Cleanse's after-sheen: a `dot-guard` state during which applyEffect refuses
// any NEW damage-over-time on the bearer (see state-effects.applyEffect) —
// without it, the very next venomous swing undoes the cleanse and the cast is
// worthless. Existing burns keep ticking (cleanse itself already scoured them),
// other effect types land as usual, and an expired guard stops guarding.
function makeWorld() {
  const band = { blindBelow: 1, dimBelow: 3, harmedAbove: 9 };
  return {
    rooms: { arena: { id: "arena", name: "Arena", description: "", depth: 0, ambientLight: 5, exits: {} } },
    items: {},
    mobs: {
      rotter: { id: "rotter", name: "a rotter", description: "", maxHp: 100, xp: 1, faction: "wild", perception: band },
    },
    spells: {
      cleanse: { id: "cleanse", name: "Cleanse", manaCost: 0, hostile: false, target: "creature", effect: { type: "cleanse", name: "Cleanse", guard: 5, good: true } },
    },
    fixtures: {}, recipes: {}, quests: {},
    playerTemplate: {
      level: 1, xp: 0, shards: 0,
      attributes: { might: 5, vitality: 5, intellect: 5, wits: 0, perception: 5 },
      manaRegen: 0, speed: 12, perception: band,
      startLocation: "arena", startInventory: [], startEquipment: { light: null }, knownRecipes: [], knownSpells: [],
    },
  };
}
function addPlayer(state) {
  const p = state.createCharacter("Tester");
  state.admit(p);
  state.setPlayerLocation(p, "arena");
  return p;
}
function dotCount(actor) { return (actor.states || []).filter((s) => s.type === "damage-over-time").length; }

test("a fresh DoT is turned aside while a dot-guard holds (applyEffect returns false)", () => {
  const state = new GameState(makeWorld());
  const p = addPlayer(state);
  state.applyEffect(p, { type: "dot-guard", name: "Cleanse", duration: 5, good: true });
  const landed = state.applyEffect(p, { type: "damage-over-time", name: "bleed", damage: "5", duration: 99, good: false });
  assert.equal(landed, false, "the guard refuses the new DoT");
  assert.equal(dotCount(p), 0, "no damage-over-time state was added");
});

test("non-DoT effects still land through a dot-guard", () => {
  const state = new GameState(makeWorld());
  const p = addPlayer(state);
  state.applyEffect(p, { type: "dot-guard", name: "Cleanse", duration: 5, good: true });
  const landed = state.applyEffect(p, { type: "slow", name: "snare", magnitude: 3, duration: 9, good: false });
  assert.equal(landed, true, "only damage-over-time is guarded");
  assert.equal(state.slowAmount(p), 3, "the slow took hold as usual");
});

test("a DoT applied BEFORE the guard keeps ticking (the guard blocks new ones only)", () => {
  const state = new GameState(makeWorld());
  const p = addPlayer(state);
  state.applyEffect(p, { type: "damage-over-time", name: "bleed", damage: "5", duration: 99, good: false });
  state.applyEffect(p, { type: "dot-guard", name: "Cleanse", duration: 5, good: true });
  const before = p.hp;
  state._tickEffects([]);
  assert.ok(p.hp < before, "the pre-existing bleed still gnaws");
});

test("once the guard expires, new DoTs land again", () => {
  const state = new GameState(makeWorld());
  const p = addPlayer(state);
  state.applyEffect(p, { type: "dot-guard", name: "Cleanse", duration: 1, good: true });
  state._tickEffects([]); // counts the guard's last tick down; it expires
  const landed = state.applyEffect(p, { type: "damage-over-time", name: "bleed", damage: "5", duration: 99, good: false });
  assert.equal(landed, true, "the sheen has faded — the bleed takes hold");
  assert.equal(dotCount(p), 1);
});

test("cleanse strips existing DoTs AND leaves its guard, so an immediate re-poison fails", () => {
  const state = new GameState(makeWorld());
  const p = addPlayer(state);
  state.applyEffect(p, { type: "damage-over-time", name: "venom", damage: "3", duration: 99, good: false });
  state.applyEffect(p, { type: "damage-over-time", name: "bleed", damage: "2", duration: 99, good: false });
  const spell = state.world.spells.cleanse;
  const target = { kind: "player", actor: p, id: p.id, name: "Tester", isSelf: true };
  const res = state._applyBeneficialSpellEffect(p.attributes, spell, target, []);
  assert.equal(res.removed, 2, "both afflictions burned away");
  assert.equal(res.guard, 5, "the after-sheen's length is reported for narration");
  assert.equal(dotCount(p), 0);
  assert.ok(p.states.some((s) => s.type === "dot-guard"), "the dot-guard state is live");
  const landed = state.applyEffect(p, { type: "damage-over-time", name: "venom", damage: "3", duration: 99, good: false });
  assert.equal(landed, false, "the very next venomous swing no longer undoes the cleanse");
});
