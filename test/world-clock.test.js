"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { PHASES, tidePhaseAt, tideOffset } = require("../server/world-clock");
const { GameState } = require("../server/state");

const LENGTHS = { calm: 600, stirring: 60, tide: 240, receding: 60 }; // matches config default
const CFG = { deepCap: -5, edgeOffset: -1 };

// --- Pure phase math -------------------------------------------------------

test("tidePhaseAt: the cycle starts Calm and walks the phases in order", () => {
  assert.equal(tidePhaseAt(0, LENGTHS).phase, "calm");
  assert.equal(tidePhaseAt(599, LENGTHS).phase, "calm");
  assert.equal(tidePhaseAt(600, LENGTHS).phase, "stirring");
  assert.equal(tidePhaseAt(659, LENGTHS).phase, "stirring");
  assert.equal(tidePhaseAt(660, LENGTHS).phase, "tide");
  assert.equal(tidePhaseAt(899, LENGTHS).phase, "tide");
  assert.equal(tidePhaseAt(900, LENGTHS).phase, "receding");
  assert.equal(tidePhaseAt(959, LENGTHS).phase, "receding");
});

test("tidePhaseAt: the cycle wraps cleanly", () => {
  const cycle = PHASES.reduce((a, p) => a + LENGTHS[p], 0);
  assert.equal(tidePhaseAt(cycle, LENGTHS).phase, "calm");
  assert.equal(tidePhaseAt(cycle + 600, LENGTHS).phase, "stirring");
});

test("tideOffset: the Tide darkening scales with depth, floored at deepCap", () => {
  assert.equal(tideOffset("tide", 0, CFG), -2); // rim
  assert.equal(tideOffset("tide", 2, CFG), -2);
  assert.equal(tideOffset("tide", 3, CFG), -3);
  assert.equal(tideOffset("tide", 6, CFG), -4);
  assert.equal(tideOffset("tide", 99, CFG), -5); // cap bites in the deep
});

test("tideOffset: Calm is neutral, the edges dim gently", () => {
  assert.equal(tideOffset("calm", 7, CFG), 0);
  assert.equal(tideOffset("stirring", 7, CFG), -1);
  assert.equal(tideOffset("receding", 7, CFG), -1);
});

// --- GameState integration -------------------------------------------------

function makeWorld() {
  return {
    rooms: {
      rim: { id: "rim", name: "Rim", description: "", depth: 0, ambientLight: 2, exits: {} },
      deep: { id: "deep", name: "Deep", description: "", depth: 6, ambientLight: 0, exits: {} },
    },
    items: {}, mobs: {}, fixtures: {}, recipes: {}, spells: {}, quests: {},
    playerTemplate: {
      level: 1, xp: 0, shards: 0,
      attributes: { might: 5, vitality: 5, intellect: 5, wits: 5, perception: 5 },
      manaRegen: 0, speed: 12,
      perception: { blindBelow: 1, dimBelow: 3, harmedAbove: 9 },
      startLocation: "rim", startInventory: [], startEquipment: {},
      knownRecipes: [], knownSpells: [],
    },
  };
}

test("forceTidePhase: the Tide darkens every room by its depth-scaled offset", () => {
  const s = new GameState(makeWorld());
  assert.equal(s.rooms.rim.light, 2); // calm: ambient
  assert.equal(s.rooms.deep.light, 0);

  const evs = s.forceTidePhase("tide");
  assert.ok(evs.some((e) => e.type === "tide-phase" && e.phase === "tide"));
  assert.equal(s.rooms.rim.light, 0); // 2 - 2
  assert.equal(s.rooms.deep.light, -4); // 0 - 4
  assert.equal(s.tideOverride, "tide");

  s.forceTidePhase("calm");
  assert.equal(s.rooms.rim.light, 2); // light restored on the ebb
  assert.equal(s.rooms.deep.light, 0);
});

test("forceTidePhase(null) resumes the automatic clock", () => {
  const s = new GameState(makeWorld());
  s.forceTidePhase("tide");
  s.forceTidePhase(null);
  assert.equal(s.tideOverride, null);
});

test("the clock fires a tide-phase event when it crosses a boundary", () => {
  const s = new GameState(makeWorld());
  s.tick = 599; // next advance() lands on 600 → Stirring
  const evs = s.advance();
  assert.equal(s.tidePhase, "stirring");
  assert.ok(evs.some((e) => e.type === "tide-phase" && e.phase === "stirring"));
});
