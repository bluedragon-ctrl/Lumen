"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { GameState } = require("../server/state");
const { findFixture } = require("../server/commands/shared");
const { buildExamineView } = require("../server/render");

// A minimal lit world for target-resolution tests. The fixtures and the mob
// carry authored `keywords` that do NOT appear in their display names — the
// regression under test: keyword targeting must work for fixtures (and for
// `examine` generally), not just for item/mob command targeting.
function makeTargetWorld() {
  const band = { blindBelow: 1, dimBelow: 3, harmedAbove: 9 };
  return {
    rooms: {
      arena: { id: "arena", name: "Arena", description: "", depth: 0, ambientLight: 5, exits: {}, fixtures: ["niche", "hatch"], spawns: [{ mob: "figure", max: 1 }] },
    },
    items: {},
    mobs: {
      // Display name shares no word with the keyword "warlock".
      figure: { id: "figure", name: "a robed figure", description: "", keywords: ["warlock", "figure"], maxHp: 10, xp: 1, faction: "wild", perception: band },
    },
    spells: {},
    fixtures: {
      // Named "a cut lamp-shelf" — the keywords niche/stake/chalk are absent from the name.
      niche: { id: "niche", name: "a cut lamp-shelf", keywords: ["niche", "shelf", "stake", "chalk"], description: "", type: "scenery" },
      // A door whose keyword "south" is absent from the name.
      hatch: { id: "hatch", name: "a heavy plank door", keywords: ["door", "plank", "south"], description: "", type: "door", door: { dir: "south", to: "arena", open: false } },
    },
    recipes: {}, quests: {},
    playerTemplate: {
      level: 1, xp: 0, shards: 0,
      attributes: { might: 5, vitality: 5, intellect: 5, wits: 0, perception: 5 },
      manaRegen: 0, speed: 12,
      perception: band,
      startLocation: "arena",
      startInventory: [],
      startEquipment: { light: null, body: null },
      knownRecipes: [], knownSpells: [],
    },
  };
}

function setup() {
  const state = new GameState(makeTargetWorld());
  const p = state.createCharacter("Tester");
  state.admit(p);
  state.setPlayerLocation(p, "arena");
  return { state, p, rt: state.rooms.arena, w: state.world };
}

// --- findFixture (use/open/close/examine command targeting) -------------------

test("findFixture resolves a fixture by an authored keyword absent from its name", () => {
  const { state, p, rt, w } = setup();
  const f = findFixture(rt, w, p, "niche", () => true);
  assert.ok(f, "keyword 'niche' resolves the lamp-shelf");
  assert.equal(f.template, "niche");
});

test("findFixture resolves a door by its direction keyword", () => {
  const { state, p, rt, w } = setup();
  const f = findFixture(rt, w, p, "south", (ft) => !!ft.door);
  assert.ok(f, "keyword 'south' resolves the plank door");
  assert.equal(f.template, "hatch");
});

test("findFixture still resolves by display-name substring (legacy behaviour)", () => {
  const { state, p, rt, w } = setup();
  const f = findFixture(rt, w, p, "lamp-shelf", () => true);
  assert.ok(f, "name substring still matches");
  assert.equal(f.template, "niche");
});

// --- buildExamineView (the examine command) -----------------------------------

test("examine resolves a fixture by an authored keyword absent from its name", () => {
  const { state, p } = setup();
  const view = buildExamineView(state, p, "stake");
  assert.ok(view, "keyword 'stake' resolves to an examine view");
  assert.equal(view.entity.kind, "fixture");
  assert.equal(view.entity.name, "a cut lamp-shelf");
});

test("examine resolves a mob by an authored keyword absent from its name", () => {
  const { state, p } = setup();
  const view = buildExamineView(state, p, "warlock");
  assert.ok(view, "keyword 'warlock' resolves to an examine view");
  assert.equal(view.entity.kind, "mob");
  assert.equal(view.entity.name, "a robed figure");
});
