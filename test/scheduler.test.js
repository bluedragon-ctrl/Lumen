"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { GameState } = require("../server/state");

// A small world carrying one scheduled `visit`: a trader arrives at test.gate on a
// short cycle (first at tick 2, then every 10), staying 3 ticks. Tiny numbers keep
// the timing assertions readable; the engine is the same at 1200/300.
function makeTestWorld() {
  return {
    rooms: {
      "test.gate": { id: "test.gate", name: "Gate", description: "", depth: 0, ambientLight: 3, exits: {} },
    },
    items: {
      "lamp-oil": { id: "lamp-oil", name: "lamp-oil", description: "", type: "material", weight: 1, value: 2 },
    },
    mobs: {
      "visiting-trader": {
        id: "visiting-trader", faction: "rim", name: "a road-worn trader", description: "",
        maxHp: 20, speed: 12, behavior: "passive", hostile: false,
        perception: { blindBelow: 1, dimBelow: 3, harmedAbove: 9 },
        spawnMessage: "The wicket creaks and {name} slips in.",
        despawnVerb: "slips back out through the wicket",
        actions: [{ type: "idle", weight: 1 }],
        shop: { sells: [{ template: "lamp-oil" }] },
      },
    },
    fixtures: {}, recipes: {}, spells: {}, quests: {},
    schedule: [
      { id: "visiting-trader", everyTicks: 10, firstTicks: 2, action: { type: "visit", mob: "visiting-trader", room: "test.gate", stayTicks: 3 } },
    ],
    playerTemplate: {
      level: 1, xp: 0, shards: 0,
      attributes: { might: 5, vitality: 5, intellect: 5, wits: 5, perception: 5 },
      manaRegen: 0, speed: 12,
      perception: { blindBelow: 1, dimBelow: 3, harmedAbove: 9 },
      startLocation: "test.gate", startInventory: [], startEquipment: {},
      knownRecipes: [], knownSpells: [],
    },
  };
}

// A mob in a room whose template carries a `shop` block — mirrors trade.js `shopHere`.
const traderIn = (state, roomId) =>
  state.rooms[roomId].mobs.find((m) => (state.world.mobs[m.template] || {}).shop);

// Drive the scheduler `n` ticks in isolation, returning every event emitted.
function runTicks(state, n) {
  const events = [];
  for (let i = 0; i < n; i++) state._scheduleTick(events);
  return events;
}

test("scheduler: no visitor at boot", () => {
  const state = new GameState(makeTestWorld());
  assert.equal(traderIn(state, "test.gate"), undefined);
  assert.equal(state.scheduled.length, 1);
  assert.equal(state.scheduled[0].active, false);
});

test("scheduler: visit fires after firstTicks, ends after stayTicks", () => {
  const state = new GameState(makeTestWorld());

  // Ticks 1 → not yet; tick 2 → arrival.
  let events = runTicks(state, 1);
  assert.equal(traderIn(state, "test.gate"), undefined, "still absent before firstTicks");
  events = runTicks(state, 1);
  assert.ok(traderIn(state, "test.gate"), "arrived on the firstTicks-th tick");
  assert.ok(events.some((e) => e.type === "mob-spawn"), "arrival emits a mob-spawn");
  assert.equal(state.scheduled[0].active, true);

  // Present for stayTicks (ticks 3, 4), then swept out on tick 5.
  runTicks(state, 2);
  assert.ok(traderIn(state, "test.gate"), "still present within stayTicks");
  const departEvents = runTicks(state, 1);
  assert.equal(traderIn(state, "test.gate"), undefined, "gone once stayTicks elapse");
  const flee = departEvents.find((e) => e.type === "mob-flee");
  assert.ok(flee, "departure emits a mob-flee");
  assert.match(flee.verb, /wicket/, "flee carries the mob's despawnVerb");
  assert.equal(state.scheduled[0].active, false);
});

test("scheduler: re-arrives on the everyTicks cadence", () => {
  const state = new GameState(makeTestWorld());
  runTicks(state, 5); // first visit done (arrived tick 2, departed tick 5)
  assert.equal(traderIn(state, "test.gate"), undefined);
  // First fire rearmed the timer to everyTicks (10) at tick 2 → next fire at tick 12.
  runTicks(state, 6); // through tick 11
  assert.equal(traderIn(state, "test.gate"), undefined, "not back before the cadence");
  runTicks(state, 1); // tick 12
  assert.ok(traderIn(state, "test.gate"), "re-arrived one everyTicks after the first fire");
});

test("scheduler: a trader killed mid-visit ends cleanly with no stray flee", () => {
  const state = new GameState(makeTestWorld());
  runTicks(state, 2); // arrive
  const mob = traderIn(state, "test.gate");
  assert.ok(mob);
  // Simulate a kill: remove the mob from the room the way a death path would.
  const rt = state.rooms["test.gate"];
  rt.mobs.splice(rt.mobs.indexOf(mob), 1);
  mob.hp = 0;
  // Let the visit's stayTicks run out (ticks 3, 4, 5).
  const events = runTicks(state, 3);
  assert.ok(!events.some((e) => e.type === "mob-flee"), "no departure line for an already-dead trader");
  assert.equal(state.scheduled[0].active, false, "cycle rearms cleanly");
});
