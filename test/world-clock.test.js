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

// --- NPCs lighting lamps as the Tide turns ---------------------------------

function makeLampWorld() {
  return {
    rooms: {
      // a camp: an (off) lamp + a resident NPC
      camp: { id: "camp", name: "Camp", description: "", depth: 4, ambientLight: 0, exits: {}, fixtures: ["lamp"], spawns: [{ mob: "warden", max: 1 }] },
      // a lamp but nobody to work it
      empty: { id: "empty", name: "Empty", description: "", depth: 4, ambientLight: 0, exits: {}, fixtures: ["lamp"] },
      // a lamp tended only by wild fauna — which won't work a switch
      lair: { id: "lair", name: "Lair", description: "", depth: 4, ambientLight: 0, exits: {}, fixtures: ["lamp"], spawns: [{ mob: "rat", max: 1 }] },
    },
    items: {},
    mobs: {
      warden: { id: "warden", name: "a warden", faction: "rim", maxHp: 10, speed: 10, attack: { damage: "1d2" } },
      rat: { id: "rat", name: "a rat", faction: "fauna", maxHp: 5, speed: 10, attack: { damage: "1d2" } },
    },
    fixtures: { lamp: { id: "lamp", name: "a lamp", switch: { on: false, emitsLight: 4 } } },
    recipes: {}, spells: {}, quests: {},
    playerTemplate: {
      level: 1, xp: 0, shards: 0,
      attributes: { might: 5, vitality: 5, intellect: 5, wits: 5, perception: 5 },
      manaRegen: 0, speed: 12,
      perception: { blindBelow: 1, dimBelow: 3, harmedAbove: 9 },
      startLocation: "camp", startInventory: [], startEquipment: {},
      knownRecipes: [], knownSpells: [],
    },
  };
}

test("Stirring: an NPC lights its room's lamp; a lampless-tender room is untouched", () => {
  const s = new GameState(makeLampWorld());
  // Calm: lamp off, camp dark (ambient 0 - 0), and during the Tide it would be 0 - 3 = -3.
  assert.equal(s.rooms.camp.light, 0);

  s.forceTidePhase("stirring");
  const lamp = s.rooms.camp.fixtures[0];
  assert.equal(lamp.on, true); // the NPC threw the lamp on
  assert.equal(lamp.tideLit, true);
  assert.equal(s.rooms.camp.light, 4 - 1); // lamp +4 over the Stirring -1 edge dim
  assert.equal(s.rooms.empty.fixtures[0].on, false); // no NPC → lamp stays dark
  assert.equal(s.rooms.lair.fixtures[0].on, false); // wild fauna won't work a switch

  // Through the Tide the lit camp stays bright while the dark deepens elsewhere.
  s.forceTidePhase("tide");
  assert.equal(s.rooms.camp.light, 4 - 3); // +4 lamp over the depth-4 -3 darkening
});

test("Calm: the Tide-lit lamp is snuffed again, but an author-lit lamp is left alone", () => {
  const s = new GameState(makeLampWorld());
  s.forceTidePhase("stirring");
  s.forceTidePhase("calm");
  assert.equal(s.rooms.camp.fixtures[0].on, false); // snuffed on the recede
  assert.equal(s.rooms.camp.fixtures[0].tideLit, false);

  // A lamp the author left burning is never flagged, so it survives the recede.
  s.rooms.camp.fixtures[0].on = true; // author/player lit
  s.forceTidePhase("stirring"); // already on → not flagged tideLit
  s.forceTidePhase("calm");
  assert.equal(s.rooms.camp.fixtures[0].on, true);
});

// --- The dark grows teeth: void shadows born beside delvers in the void -----

function makeCreepWorld() {
  return {
    rooms: {
      // a deep room that drops into the void band during the Tide
      deep: { id: "deep", name: "Deep", description: "", depth: 6, ambientLight: 0, exits: {} },
      // same depth, but a fixed torch keeps it lit through the Tide
      lit: { id: "lit", name: "Lit", description: "", depth: 6, ambientLight: 0, exits: {}, fixtures: ["torch"] },
    },
    items: {},
    mobs: {
      // mirrors the real void-shadow (the predator config points here by id)
      "void-shadow": {
        id: "void-shadow", name: "a void shadow", faction: "wild", maxHp: 34, speed: 12,
        hostile: true, pursues: true, emitsLight: -1, xp: 12,
        perception: { blindBelow: -20, dimBelow: -20, harmedAbove: 0 },
        lightBane: { above: 0, damage: "1d4" }, attack: { damage: "1d6" },
      },
    },
    fixtures: { torch: { id: "torch", name: "a torch", emitsLight: 6 } },
    recipes: {}, spells: {}, quests: {},
    playerTemplate: {
      level: 1, xp: 0, shards: 0,
      attributes: { might: 5, vitality: 5, intellect: 5, wits: 5, perception: 5 },
      manaRegen: 0, speed: 12,
      perception: { blindBelow: 1, dimBelow: 3, harmedAbove: 9 },
      startLocation: "deep", startInventory: [], startEquipment: {},
      knownRecipes: [], knownSpells: [],
    },
  };
}

// Run fn with Math.random pinned to `v` (deterministic spawn rolls), then restore.
function withRandom(v, fn) {
  const real = Math.random;
  Math.random = () => v;
  try { fn(); } finally { Math.random = real; }
}

function admitAt(s, name, roomId) {
  const p = s.createCharacter(name);
  s.admit(p);
  s.setPlayerLocation(p, roomId);
  return p;
}

test("Tide creep: a void shadow is born beside a delver standing in the void", () => {
  const s = new GameState(makeCreepWorld());
  s.forceTidePhase("tide");
  admitAt(s, "Delver", "deep");
  assert.ok(s.rooms.deep.light < 0, "the deep is in the void during the Tide");

  const events = [];
  withRandom(0, () => s._tideCreepTick(events)); // 0 < chance → always spawns
  const shadows = s.rooms.deep.mobs.filter((m) => m.template === "void-shadow");
  assert.equal(shadows.length, 1);
  assert.equal(shadows[0].tideSpawn, true); // the ebb will reclaim it
  assert.equal(shadows[0].faction, "wild");
  assert.equal(shadows[0].noSpoils, false); // it drops the rare shard when slain
  assert.ok(!shadows[0].origin, "tide spawns carry no origin (never repop, unleashed pursuit)");
  assert.ok(events.some((e) => e.type === "mob-spawn" && e.tideCreep === true));
});

test("Tide creep: a lit room is never a birthplace; nor is an empty one", () => {
  const s = new GameState(makeCreepWorld());
  s.forceTidePhase("tide");
  admitAt(s, "Delver", "lit"); // a torch keeps this room out of the void
  assert.ok(s.rooms.lit.light >= 0, "the torch holds the void off");

  withRandom(0, () => s._tideCreepTick([]));
  assert.equal(s.rooms.lit.mobs.length, 0, "a lit camp births nothing");
  assert.equal(s.rooms.deep.mobs.length, 0, "a dark room with no delver births nothing");
});

test("Tide creep: the worldwide cap holds", () => {
  const s = new GameState(makeCreepWorld());
  s.forceTidePhase("tide");
  admitAt(s, "Delver", "deep");
  // Pin five shadows abroad already (the default cap), then a forced roll spawns none.
  for (let i = 0; i < 5; i++) {
    const inst = require("../server/instances").makeMobInstance("void-shadow", s.world);
    inst.tideSpawn = true;
    s.rooms.deep.mobs.push(inst);
  }
  withRandom(0, () => s._tideCreepTick([]));
  assert.equal(s.rooms.deep.mobs.filter((m) => m.template === "void-shadow").length, 5);
});

test("Tide creep: the ebb sweeps every shadow back into the dark", () => {
  const s = new GameState(makeCreepWorld());
  s.forceTidePhase("tide");
  admitAt(s, "Delver", "deep");
  withRandom(0, () => s._tideCreepTick([]));
  assert.equal(s.rooms.deep.mobs.filter((m) => m.template === "void-shadow").length, 1);

  s.forceTidePhase("calm"); // the recede reclaims the tide-spawned
  assert.equal(s.rooms.deep.mobs.filter((m) => m.template === "void-shadow").length, 0);
});
