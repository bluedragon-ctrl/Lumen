"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { PHASES, DEFAULT_TIDE, resolveTide, tidePhaseAt, tideOffset } = require("../server/world-clock");
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

test("tideOffset: the darkening formula and phase roles are data-driven", () => {
  // A re-storied world with renamed phases and a different depth curve.
  const cfg = { deepCap: -8, edgeOffset: -2, tideBase: -1, tideDepthDivisor: 2, tidePhases: ["dark"], edgePhases: ["warn"] };
  assert.equal(tideOffset("dark", 0, cfg), -1); // tideBase at the rim
  assert.equal(tideOffset("dark", 4, cfg), -3); // -1 - floor(4/2)
  assert.equal(tideOffset("dark", 99, cfg), -8); // deepCap bites
  assert.equal(tideOffset("warn", 5, cfg), -2); // the edge dim
  assert.equal(tideOffset("calm", 5, cfg), 0); // an unlisted phase is neutral
});

// --- Data-driven config (resolveTide) --------------------------------------

test("resolveTide: a world with no tide config gets the built-in defaults", () => {
  const t = resolveTide({});
  assert.deepEqual(t.phaseTicks, DEFAULT_TIDE.phaseTicks);
  assert.equal(t.enabled, true);
  assert.equal(t.predator.mob, "void-shadow");
});

test("resolveTide: authored fields override, untouched siblings keep defaults", () => {
  const t = resolveTide({ tide: {
    phaseTicks: { calm: 10, stirring: 5, tide: 20, receding: 5 },
    darkening: { deepCap: -9 }, // partial — edgeOffset etc. fall back to defaults
    predator: { chance: 0.5 }, // partial predator merge
  } });
  assert.equal(t.phaseTicks.tide, 20);
  assert.equal(t.darkening.deepCap, -9);
  assert.equal(t.darkening.edgeOffset, DEFAULT_TIDE.darkening.edgeOffset); // kept
  assert.equal(t.predator.chance, 0.5);
  assert.equal(t.predator.mob, "void-shadow"); // kept from default
});

test("resolveTide: predator:null yields a toothless Tide", () => {
  assert.equal(resolveTide({ tide: { predator: null } }).predator, null);
});

test("tidePhaseAt: honours a custom phase order and lengths", () => {
  const phases = ["quiet", "surge"];
  const lengths = { quiet: 3, surge: 2 };
  assert.equal(tidePhaseAt(0, lengths, phases).phase, "quiet");
  assert.equal(tidePhaseAt(3, lengths, phases).phase, "surge");
  assert.equal(tidePhaseAt(5, lengths, phases).phase, "quiet"); // wraps at cycle 5
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

test("the clock honours data-driven phaseTicks from the world", () => {
  const world = makeWorld();
  world.tide = { phaseTicks: { calm: 2, stirring: 2, tide: 2, receding: 2 } };
  const s = new GameState(world);
  assert.equal(s.tidePhase, "calm");
  s.tick = 1; // next advance() lands on 2 → Stirring under the short cycle
  s.advance();
  assert.equal(s.tidePhase, "stirring");
});

// --- Ambient Tide emotes (data-driven) -------------------------------------

function makeEmoteWorld() {
  return {
    rooms: { deep: { id: "deep", name: "Deep", description: "", depth: 6, ambientLight: 0, exits: {} } },
    items: {}, mobs: {}, fixtures: {}, recipes: {}, spells: {}, quests: {},
    tide: {
      // everyTicks 0 → no cadence gate; chance 1 → always; requireDark → only in the void.
      emotes: { tide: { everyTicks: 0, chance: 1, requireDark: true, lines: ["The dark leans close."] } },
    },
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

test("Tide emotes: an ambient line fires in a dark, occupied room during the phase", () => {
  const s = new GameState(makeEmoteWorld());
  s.forceTidePhase("tide");
  admitAt(s, "Delver", "deep");
  assert.ok(s.rooms.deep.light < 0, "the deep is in the void during the Tide");
  const events = [];
  s._tideEmoteTick(events);
  const emote = events.find((e) => e.type === "tide-emote");
  assert.ok(emote && emote.roomId === "deep");
  assert.equal(emote.text, "The dark leans close.");
});

test("Tide emotes: none without an occupant, and none in a phase with no config", () => {
  const s = new GameState(makeEmoteWorld());
  s.forceTidePhase("tide");
  const e1 = [];
  s._tideEmoteTick(e1); // nobody in the room
  assert.equal(e1.filter((e) => e.type === "tide-emote").length, 0);

  admitAt(s, "Delver", "deep");
  s.forceTidePhase("calm"); // calm authors no emote
  const e2 = [];
  s._tideEmoteTick(e2);
  assert.equal(e2.filter((e) => e.type === "tide-emote").length, 0);
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

// A creep world with TWO predators: the shallow shadow (maxLight -1, anywhere the
// delver's light has failed) and the deeper leech (maxLight -4, only the drowned
// deep). `shallow` (depth 0) drops to -2 during the Tide; `deep` (depth 6) to -4.
function makeTwoPredatorWorld() {
  const w = makeCreepWorld();
  w.rooms.shallow = { id: "shallow", name: "Shallow", description: "", depth: 0, ambientLight: 0, exits: {} };
  w.mobs["void-leech"] = {
    id: "void-leech", name: "a void leech", faction: "wild", maxHp: 12, speed: 12,
    hostile: true, pursues: true, emitsLight: -1, xp: 8,
    perception: { blindBelow: -20, dimBelow: -20, harmedAbove: 0 },
    lightBane: { above: 0, damage: "1d6" },
  };
  w.tide = {
    predator: [
      { mob: "void-shadow", chance: 0.05, cap: 5, faction: "wild", maxLight: -1 },
      { mob: "void-leech", chance: 0.05, cap: 10, faction: "wild", maxLight: -4 },
    ],
  };
  return w;
}

test("Tide creep: the deeper predator's maxLight gate holds it to the drowned deep", () => {
  const s = new GameState(makeTwoPredatorWorld());
  s.forceTidePhase("tide");
  admitAt(s, "Shallow", "shallow"); // depth 0 → light -2 during the Tide
  admitAt(s, "Deep", "deep"); // depth 6 → light -4 during the Tide
  assert.equal(s.rooms.shallow.light, -2, "the shallow dips only to -2");
  assert.equal(s.rooms.deep.light, -4, "the deep plunges to -4");

  withRandom(0, () => s._tideCreepTick([])); // 0 < chance → always spawns where eligible
  // The shadow (maxLight -1) births in both rooms; the leech (maxLight -4) only in the deep.
  assert.equal(s.rooms.shallow.mobs.filter((m) => m.template === "void-shadow").length, 1);
  assert.equal(s.rooms.shallow.mobs.filter((m) => m.template === "void-leech").length, 0, "-2 is too shallow for a leech");
  assert.equal(s.rooms.deep.mobs.filter((m) => m.template === "void-shadow").length, 1);
  assert.equal(s.rooms.deep.mobs.filter((m) => m.template === "void-leech").length, 1, "the deep is dark enough for the leech");
});

test("Tide creep: each predator swarms to its OWN cap, independently", () => {
  const s = new GameState(makeTwoPredatorWorld());
  s.forceTidePhase("tide");
  admitAt(s, "Deep", "deep");
  // Pin the shadow at its cap of 5; the leech (cap 10) should still be free to birth.
  for (let i = 0; i < 5; i++) {
    const inst = require("../server/instances").makeMobInstance("void-shadow", s.world);
    inst.tideSpawn = true;
    s.rooms.deep.mobs.push(inst);
  }
  withRandom(0, () => s._tideCreepTick([]));
  assert.equal(s.rooms.deep.mobs.filter((m) => m.template === "void-shadow").length, 5, "the shadow cap still holds");
  assert.equal(s.rooms.deep.mobs.filter((m) => m.template === "void-leech").length, 1, "the leech is unaffected by the shadow's cap");
});

// --- NPC Tide reactions: phase + carried-light gating ----------------------

function makeLightWorld() {
  return {
    rooms: { rim: { id: "rim", name: "Rim", description: "", depth: 0, ambientLight: 3, exits: {} } },
    items: {
      lantern: { id: "lantern", name: "a brass lantern", type: "light", slot: "light", light: { output: 3 } },
      glimmersteel: { id: "glimmersteel", name: "a glimmersteel lamp", type: "light", slot: "light", light: { output: 4 } },
    },
    mobs: {}, fixtures: {}, recipes: {}, spells: {}, quests: {},
    playerTemplate: {
      level: 1, xp: 0, shards: 0,
      attributes: { might: 5, vitality: 5, intellect: 5, wits: 5, perception: 5 },
      manaRegen: 0, speed: 12,
      perception: { blindBelow: 1, dimBelow: 3, harmedAbove: 9 },
      startLocation: "rim", startInventory: [], startEquipment: { light: null },
      knownRecipes: [], knownSpells: [],
    },
  };
}

test("_carriedLightOutput reads the equipped light slot (lit or not)", () => {
  const s = new GameState(makeLightWorld());
  const p = s.createCharacter("Delver"); s.admit(p);
  assert.equal(s._carriedLightOutput(p), 0); // empty slot
  p.equipment.light = { template: "lantern" };
  assert.equal(s._carriedLightOutput(p), 3);
  p.equipment.light = { template: "glimmersteel" };
  assert.equal(s._carriedLightOutput(p), 4);
});

test("react if.phase gates a reaction to the matching Tide phase", () => {
  const s = new GameState(makeLightWorld());
  const p = s.createCharacter("Delver"); s.admit(p);
  assert.equal(s._reactMatches(p, { phase: ["stirring", "tide"] }, null), false); // Calm
  s.forceTidePhase("tide");
  assert.equal(s._reactMatches(p, { phase: ["stirring", "tide"] }, null), true);
  assert.equal(s._reactMatches(p, { phase: ["stirring"] }, null), false); // wrong phase
});

test("react if.carriedLightBelow matches an under-lit delver", () => {
  const s = new GameState(makeLightWorld());
  const p = s.createCharacter("Delver"); s.admit(p);
  assert.equal(s._reactMatches(p, { carriedLightBelow: 4 }, null), true); // no light (0 < 4)
  p.equipment.light = { template: "lantern" }; // brass lantern, output 3
  assert.equal(s._reactMatches(p, { carriedLightBelow: 4 }, null), true); // weak (3 < 4)
  p.equipment.light = { template: "glimmersteel" }; // output 4
  assert.equal(s._reactMatches(p, { carriedLightBelow: 4 }, null), false); // adequate (4 not < 4)
});
