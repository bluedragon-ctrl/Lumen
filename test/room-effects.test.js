"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { GameState, roomEffectFires } = require("../server/state");

// A small, mutable world so tests can set room.effects directly (loadWorld() is
// frozen). Two rooms, a torch with a light block, a player template that starts
// with a lit-capable torch and a `light` equip slot.
function makeTestWorld() {
  return {
    rooms: {
      "test.bright": { id: "test.bright", name: "Bright Room", description: "", depth: 0, ambientLight: 5, exits: { north: "test.dark" } },
      "test.dark": { id: "test.dark", name: "Dark Room", description: "", depth: 1, ambientLight: 0, exits: { south: "test.bright" } },
    },
    items: {
      torch: { id: "torch", name: "a torch", description: "", type: "light", slot: "light", weight: 1, value: 1, light: { output: 3, fuelMax: 200, burnPerTick: 1 } },
    },
    mobs: {},
    fixtures: {},
    recipes: {},
    spells: {},
    quests: {},
    playerTemplate: {
      level: 1, xp: 0, shards: 0,
      attributes: { might: 5, vitality: 5, intellect: 5, wits: 5, perception: 5 },
      manaRegen: 0, speed: 12,
      perception: { blindBelow: 1, dimBelow: 3, harmedAbove: 9 },
      startLocation: "test.bright",
      startInventory: [{ template: "torch", fuel: 200 }],
      startEquipment: { light: null },
      knownRecipes: [], knownSpells: [],
    },
  };
}

// Build a GameState with one admitted player standing in `roomId`.
function gsWithPlayer(roomId = "test.bright") {
  const state = new GameState(makeTestWorld());
  const player = state.createCharacter("Tester");
  state.admit(player);
  state.setPlayerLocation(player, roomId);
  return { state, player };
}

test("roomEffectFires: no condition always fires", () => {
  assert.equal(roomEffectFires({}, 0), true);
  assert.equal(roomEffectFires({ when: undefined }, 9), true);
});

test("roomEffectFires: lightBelow fires only under the threshold", () => {
  assert.equal(roomEffectFires({ when: { lightBelow: 1 } }, 0), true);
  assert.equal(roomEffectFires({ when: { lightBelow: 1 } }, 1), false);
  assert.equal(roomEffectFires({ when: { lightBelow: 3 } }, 2), true);
});

test("roomEffectFires: lightAbove fires only over the threshold", () => {
  assert.equal(roomEffectFires({ when: { lightAbove: 9 } }, 10), true);
  assert.equal(roomEffectFires({ when: { lightAbove: 9 } }, 9), false);
});

test("_douse extinguishes every lit source the player carries", () => {
  const { state, player } = gsWithPlayer();
  // Equip and light a torch; also carry a second lit torch in the pack.
  const { makeItemInstance } = require("../server/state");
  player.equipment.light = makeItemInstance({ template: "torch", fuel: 200 }, state.world);
  player.equipment.light.lit = true;
  player.inventory[0].lit = true; // the starting torch
  const n = state._douse(player);
  assert.equal(n, 2);
  assert.equal(player.equipment.light.lit, false);
  assert.equal(player.inventory[0].lit, false);
});

test("_douse returns 0 when nothing is lit", () => {
  const { state, player } = gsWithPlayer();
  assert.equal(state._douse(player), 0);
});

test("_drainMana clamps at zero and reports the amount drained", () => {
  const { state, player } = gsWithPlayer();
  player.mana = 3;
  assert.equal(state._drainMana(player, 2), 2);
  assert.equal(player.mana, 1);
  assert.equal(state._drainMana(player, 5), 1); // only 1 left to take
  assert.equal(player.mana, 0);
  assert.equal(state._drainMana(player, 0), 0); // no-op
});

test("applyRoomEffect: restore mends hp/mana and pushes vitals", () => {
  const { state, player } = gsWithPlayer();
  player.hp = 1; player.mana = 0;
  const events = [];
  const r = state.applyRoomEffect(player, "test.bright", { trigger: "tick", action: { restore: { hp: 1, mana: 2 } } }, events);
  assert.deepEqual(r, { fired: true, doused: 0, died: false });
  assert.equal(player.hp, 2);
  assert.equal(player.mana, 2);
  assert.ok(events.some((e) => e.type === "vitals" && e.playerId === player.id));
});

test("applyRoomEffect: damage hurts hp (player-hurt) and drains mana", () => {
  const { state, player } = gsWithPlayer();
  player.hp = 20; player.mana = 10;
  const events = [];
  const r = state.applyRoomEffect(player, "test.bright", { trigger: "tick", action: { damage: { hp: "2", mana: "3" } } }, events);
  assert.equal(r.fired, true);
  assert.equal(r.died, false);
  assert.equal(player.hp, 18);
  assert.equal(player.mana, 7);
  assert.ok(events.some((e) => e.type === "player-hurt" && e.cause === "darkness"));
});

test("applyRoomEffect: a killing hp blow returns died and skips mana drain", () => {
  const { state, player } = gsWithPlayer("test.dark");
  player.hp = 1; player.mana = 10;
  const events = [];
  const r = state.applyRoomEffect(player, "test.dark", { trigger: "tick", action: { damage: { hp: "50", mana: "5" } } }, events);
  assert.equal(r.died, true);
  assert.equal(player.mana, 10); // mana drain skipped once dead
  assert.ok(events.some((e) => e.type === "death"));
});

test("applyRoomEffect: douse extinguishes and reports the dim, recomputes light", () => {
  const { state, player } = gsWithPlayer("test.dark");
  const { makeItemInstance } = require("../server/state");
  player.equipment.light = makeItemInstance({ template: "torch", fuel: 200 }, state.world);
  player.equipment.light.lit = true;
  state.rooms["test.dark"].light = state.computeRoomLight("test.dark"); // bright from the torch
  assert.ok(state.rooms["test.dark"].light > 0);
  const r = state.applyRoomEffect(player, "test.dark", { trigger: "enter", action: { douse: true } }, []);
  assert.equal(r.doused, 1);
  assert.equal(player.equipment.light.lit, false);
  assert.equal(state.rooms["test.dark"].light, 0); // ambient 0, torch out
});

test("applyRoomEffect: a failed condition fires nothing", () => {
  const { state, player } = gsWithPlayer("test.bright"); // light 5
  player.hp = 1;
  const r = state.applyRoomEffect(player, "test.bright", { trigger: "tick", when: { lightBelow: 1 }, action: { damage: { hp: "5" } } }, []);
  assert.equal(r.fired, false);
  assert.equal(player.hp, 1); // untouched
});

test("_roomEffectsTick: tick restore heals a present player and emits room-effect", () => {
  const { state, player } = gsWithPlayer("test.bright");
  state.world.rooms["test.bright"].effects = [
    { trigger: "tick", action: { restore: { mana: 2 } }, message: "The air hums with power." },
  ];
  player.mana = 0;
  const events = [];
  state._roomEffectsTick(events);
  assert.equal(player.mana, 2);
  assert.ok(events.some((e) => e.type === "room-effect" && e.playerId === player.id && e.text === "The air hums with power."));
});

test("_roomEffectsTick: interval gates how often a tick effect fires", () => {
  const { state, player } = gsWithPlayer("test.bright");
  state.world.rooms["test.bright"].effects = [{ trigger: "tick", interval: 3, action: { restore: { mana: 1 } } }];
  player.mana = 0;
  for (state.tick = 1; state.tick <= 6; state.tick++) state._roomEffectsTick([]);
  // tick % 3 === 0 at ticks 3 and 6 → fires twice.
  assert.equal(player.mana, 2);
});

test("_roomEffectsTick: light-gated damage only fires in the dark", () => {
  const { state, player } = gsWithPlayer("test.dark"); // ambient 0
  state.rooms["test.dark"].light = state.computeRoomLight("test.dark"); // 0
  state.world.rooms["test.dark"].effects = [
    { trigger: "tick", when: { lightBelow: 1 }, action: { damage: { hp: "1" } } },
  ];
  state.world.rooms["test.bright"].effects = [
    { trigger: "tick", when: { lightBelow: 1 }, action: { damage: { hp: "1" } } },
  ];
  player.hp = 10;
  state._roomEffectsTick([]);
  assert.equal(player.hp, 9); // dark room bites
  state.setPlayerLocation(player, "test.bright");
  state._roomEffectsTick([]);
  assert.equal(player.hp, 9); // bright room (light 5) does not
});

test("_roomEffectsTick: enter effects are ignored by the tick driver", () => {
  const { state, player } = gsWithPlayer("test.bright");
  state.world.rooms["test.bright"].effects = [{ trigger: "enter", action: { restore: { mana: 5 } } }];
  player.mana = 0;
  state._roomEffectsTick([]);
  assert.equal(player.mana, 0);
});

const { execute } = require("../server/commands");

// A ctx that records bystander sends and dispatched events (the server's roomCtx
// shape: toRoom / refreshRoom / emit).
function recordingCtx() {
  const emitted = [];
  return { emitted, toRoom() {}, refreshRoom() {}, emit(ev) { emitted.push(ev); } };
}

test("move(): an enter douse snuffs the player's light and folds in the message", () => {
  const { state, player } = gsWithPlayer("test.bright");
  player.equipment.light = require("../server/state").makeItemInstance({ template: "torch", fuel: 200 }, state.world);
  player.equipment.light.lit = true;
  state.world.rooms["test.dark"].effects = [
    { trigger: "enter", action: { douse: true }, message: "Cold spray drowns your flame." },
  ];
  const ctx = recordingCtx();
  const msgs = execute(state, player, "north", ctx);
  assert.equal(player.location, "test.dark");
  assert.equal(player.equipment.light.lit, false); // doused on arrival
  assert.ok(msgs.some((m) => m.text && m.text.includes("Cold spray drowns your flame.")));
});

test("move(): an enter restore mends the arriving player and emits vitals", () => {
  const { state, player } = gsWithPlayer("test.bright");
  state.world.rooms["test.dark"].effects = [{ trigger: "enter", action: { restore: { hp: 3 } } }];
  player.hp = 1;
  const ctx = recordingCtx();
  execute(state, player, "north", ctx);
  assert.equal(player.hp, 4);
  assert.ok(ctx.emitted.some((e) => e.type === "vitals" && e.playerId === player.id));
});

test("move(): a room without enter effects is unaffected", () => {
  const { state, player } = gsWithPlayer("test.bright");
  player.hp = 5;
  const ctx = recordingCtx();
  execute(state, player, "north", ctx);
  assert.equal(player.hp, 5);
});

module.exports = { makeTestWorld, gsWithPlayer };
