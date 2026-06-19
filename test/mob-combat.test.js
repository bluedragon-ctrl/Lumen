"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { GameState, makeItemInstance, makeMobInstance } = require("../server/state");

// A small, mutable combat world. One lit arena (ambient 5 → "bright", clear sight
// for the standard perception band, so a mob's strike lands with chance clamped to
// 1 — `Math.random() >= 1` is always false, giving deterministic, non-flaky hits).
// Damage is authored as plain integers (rollDice("N") === N, no RNG). The test
// player has wits 0 (→ 0 evasion, 0 ward), so casts are never ward-negated and
// melee is never dodged. Combat outcomes are therefore fully deterministic.
function makeCombatWorld() {
  const band = { blindBelow: 1, dimBelow: 3, harmedAbove: 9 };
  return {
    rooms: {
      arena: { id: "arena", name: "Arena", description: "", depth: 0, ambientLight: 5, exits: {} },
    },
    items: {
      torch: { id: "torch", name: "a torch", description: "", type: "light", slot: "light", weight: 1, value: 1, light: { output: 3, fuelMax: 200, burnPerTick: 1 } },
      // Body armour whose spikes reflect a lethal blow back at any melee attacker.
      spikemail: { id: "spikemail", name: "spiked mail", description: "", type: "armour", slot: "body", weight: 1, value: 1, armour: { armour: 0, ward: 0, spikes: { damage: "50" } } },
    },
    mobs: {
      // Weak melee mob (maxHp 5 — dies to the spikemail reflect). Hits for 1.
      biter: { id: "biter", name: "a biter", description: "", maxHp: 5, xp: 1, faction: "wild", perception: band, attack: { damage: "1", type: "physical", actionCost: 12 } },
      // Caster (no melee). Tanky so a reflect can't matter; casts don't reflect anyway.
      caster: { id: "caster", name: "a caster", description: "", maxHp: 50, xp: 1, faction: "wild", attributes: { intellect: 5 }, perception: band },
    },
    spells: {
      bolt: { id: "bolt", name: "Shadow Bolt", hostile: true, effect: { type: "damage", damage: "5" } },
      hex: { id: "hex", name: "Hex", hostile: true, effect: { type: "weaken", name: "Hex", duration: 5 } },
      snuff: { id: "snuff", name: "Snuff", hostile: true, effect: { type: "douse", name: "Snuff" } },
    },
    fixtures: {}, recipes: {}, quests: {},
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

function setup() { return new GameState(makeCombatWorld()); }
function addMob(state, mobId, roomId = "arena") {
  const mob = makeMobInstance(mobId, state.world);
  state.rooms[roomId].mobs.push(mob);
  return mob;
}
function addPlayer(state, name = "Tester", roomId = "arena") {
  const p = state.createCharacter(name);
  state.admit(p);
  state.setPlayerLocation(p, roomId);
  return p;
}
const pdesc = (p) => ({ id: p.id, actor: p, kind: "player", faction: "player" });
const mdesc = (m) => ({ id: m.id, actor: m, kind: "mob", faction: m.faction || "wild" });
const has = (events, type) => events.some((e) => e.type === type);

// --- Melee ------------------------------------------------------------------

test("melee: a blow that KILLS the player fires no auto-retaliate (target-death fix)", () => {
  const state = setup();
  const p = addPlayer(state);
  const mob = addMob(state, "biter");
  p.hp = 1; p.posture = "standing"; // 1 dmg is lethal
  const events = [];
  state._mobAttack(mob, state.world.mobs.biter, "arena", events, [pdesc(p)]);
  // Death is paced (#121): the lethal blow fells the player into a dying state and
  // emits death-begin; the death/respawn comes later via the tick loop.
  assert.ok(events.some((e) => e.type === "death-begin" && e.victimId === p.id), "player death-begin event fired");
  assert.ok(!has(events, "combat-auto-start"), "no auto-retaliate against the killer after they fall");
});

test("melee: a survived blow rouses a resting player and auto-retaliates once", () => {
  const state = setup();
  const p = addPlayer(state);
  const mob = addMob(state, "biter");
  p.hp = 100; p.posture = "sitting"; // resting → should wake
  const events = [];
  state._mobAttack(mob, state.world.mobs.biter, "arena", events, [pdesc(p)]);
  assert.ok(events.some((e) => e.type === "player-woke" && e.playerId === p.id), "roused");
  const starts = events.filter((e) => e.type === "combat-auto-start");
  assert.equal(starts.length, 1, "exactly one auto-start");
  assert.equal(starts[0].targetId, mob.id);
  assert.deepEqual(p.pending, { type: "attack", targetId: mob.id });
});

test("melee: a reflect that KILLS the attacker wakes the player but does not retaliate (attacker-death fix)", () => {
  const state = setup();
  const p = addPlayer(state);
  p.equipment.body = makeItemInstance({ template: "spikemail" }, state.world); // reflects 50
  const mob = addMob(state, "biter"); // maxHp 5 → dies to the reflect
  p.hp = 100; p.posture = "sitting";
  const events = [];
  state._mobAttack(mob, state.world.mobs.biter, "arena", events, [pdesc(p)]);
  assert.ok(!state.rooms.arena.mobs.includes(mob), "mob died from the reflect");
  assert.ok(events.some((e) => e.type === "player-woke"), "player still wakes from the blow");
  assert.ok(!has(events, "combat-auto-start"), "no retaliate against a dead mob");
  assert.equal(p.pending, null, "no pending set against the corpse");
});

test("melee: mob-vs-mob neither rouses nor auto-starts a player", () => {
  const state = setup();
  const attacker = addMob(state, "biter");
  const victim = addMob(state, "biter");
  victim.faction = "player"; // opposing faction → a valid enemy of the wild attacker
  const events = [];
  state._mobAttack(attacker, state.world.mobs.biter, "arena", events, [mdesc(victim)]);
  assert.ok(events.some((e) => e.type === "attack" && e.targetKind === "mob"), "a mob-vs-mob attack happened");
  assert.ok(!has(events, "player-woke"));
  assert.ok(!has(events, "combat-auto-start"));
});

// --- Cast -------------------------------------------------------------------

test("cast: a killing damage spell fires no auto-retaliate", () => {
  const state = setup();
  const p = addPlayer(state);
  const caster = addMob(state, "caster");
  p.hp = 1; p.posture = "standing"; // bolt deals 5
  const events = [];
  state._mobCast(caster, state.world.mobs.caster, "arena", events, [pdesc(p)], "bolt");
  // Paced death (#121): a lethal spell emits death-begin and fells the player.
  assert.ok(events.some((e) => e.type === "death-begin" && e.victimId === p.id));
  assert.ok(!has(events, "combat-auto-start"));
});

test("cast: a survived damage spell rouses and auto-retaliates once", () => {
  const state = setup();
  const p = addPlayer(state);
  const caster = addMob(state, "caster");
  p.hp = 100; p.posture = "sitting";
  const events = [];
  state._mobCast(caster, state.world.mobs.caster, "arena", events, [pdesc(p)], "bolt");
  assert.ok(events.some((e) => e.type === "player-woke"));
  assert.equal(events.filter((e) => e.type === "combat-auto-start").length, 1);
  assert.deepEqual(p.pending, { type: "attack", targetId: caster.id });
});

test("cast: a status spell applies the effect and auto-retaliates once", () => {
  const state = setup();
  const p = addPlayer(state);
  const caster = addMob(state, "caster");
  p.hp = 100; p.posture = "standing";
  const events = [];
  state._mobCast(caster, state.world.mobs.caster, "arena", events, [pdesc(p)], "hex");
  assert.ok((p.states || []).some((s) => s.name === "Hex"), "hex applied");
  assert.equal(events.filter((e) => e.type === "combat-auto-start").length, 1);
});

test("cast: a douse spell snuffs the player's light and auto-retaliates", () => {
  const state = setup();
  const p = addPlayer(state);
  const caster = addMob(state, "caster");
  p.equipment.light = makeItemInstance({ template: "torch" }, state.world);
  p.equipment.light.lit = true;
  p.hp = 100; p.posture = "standing";
  const events = [];
  state._mobCast(caster, state.world.mobs.caster, "arena", events, [pdesc(p)], "snuff");
  assert.equal(p.equipment.light.lit, false, "light doused");
  assert.ok(events.some((e) => e.type === "mob-cast" && e.doused === true));
  assert.equal(events.filter((e) => e.type === "combat-auto-start").length, 1);
});

test("cast: mob-vs-mob neither rouses nor auto-starts a player", () => {
  const state = setup();
  const caster = addMob(state, "caster");
  const victim = addMob(state, "caster");
  victim.faction = "player";
  victim.hp = 100; victim.maxHp = 100; // survive the bolt
  const events = [];
  state._mobCast(caster, state.world.mobs.caster, "arena", events, [mdesc(victim)], "bolt");
  assert.ok(events.some((e) => e.type === "mob-cast" && e.targetKind === "mob"));
  assert.ok(!has(events, "player-woke"));
  assert.ok(!has(events, "combat-auto-start"));
});

// --- Shared target selection ------------------------------------------------

test("target selection: both melee and cast pick the highest-threat enemy", () => {
  for (const kind of ["melee", "cast"]) {
    const state = setup();
    const p1 = addPlayer(state, "One");
    const p2 = addPlayer(state, "Two");
    p1.hp = 100; p2.hp = 100;
    const mob = addMob(state, kind === "melee" ? "biter" : "caster");
    mob.aggro = { [p2.id]: 5 }; // p2 holds more combat threat
    const events = [];
    if (kind === "melee") state._mobAttack(mob, state.world.mobs.biter, "arena", events, [pdesc(p1), pdesc(p2)]);
    else state._mobCast(mob, state.world.mobs.caster, "arena", events, [pdesc(p1), pdesc(p2)], "bolt");
    const ev = events.find((e) => e.type === (kind === "melee" ? "attack" : "mob-cast"));
    assert.equal(ev.targetId, p2.id, `${kind} targeted the higher-threat enemy`);
  }
});
