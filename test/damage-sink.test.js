"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { GameState, makeMobInstance } = require("../server/state");

// Pins the unified damage-sink invariants (_hurtMob/_hurtPlayer): every damage
// path — a swing, a spell, a bleed — resolves hp, threat and the kill through
// the same two sinks, so the conventions below are structural, not per-path.
// Same deterministic arena as mob-combat.test.js: bright light (hit chance
// clamps to 1), integer damage dice, wits 0 (no ward/evasion).
function makeCombatWorld() {
  const band = { blindBelow: 1, dimBelow: 3, harmedAbove: 9 };
  return {
    rooms: {
      arena: { id: "arena", name: "Arena", description: "", depth: 0, ambientLight: 5, exits: {} },
    },
    items: {},
    mobs: {
      // Weak melee mob (maxHp 5 — a couple of unarmed swings fell it). Hits for 1.
      biter: { id: "biter", name: "a biter", description: "", maxHp: 5, xp: 1, faction: "wild", perception: band, attack: { damage: "1", type: "physical", actionCost: 12 } },
      // Caster (no melee). Tanky, so a test bolt never kills it by accident.
      caster: { id: "caster", name: "a caster", description: "", maxHp: 50, xp: 1, faction: "wild", attributes: { intellect: 0 }, perception: band },
    },
    spells: {
      bolt: { id: "bolt", name: "Shadow Bolt", hostile: true, effect: { type: "damage", damage: "5" } },
    },
    fixtures: {}, recipes: {}, quests: {},
    playerTemplate: {
      level: 1, xp: 0, shards: 0,
      attributes: { might: 5, vitality: 5, intellect: 0, wits: 0, perception: 5 },
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

// --- Threat convention --------------------------------------------------------

test("melee: a landed swing stokes threat equal to the blow, with no hurt event (silent sink)", () => {
  const state = setup();
  const p = addPlayer(state);
  const mob = addMob(state, "biter");
  mob.hp = mob.maxHp = 100; // survives the one swing
  p.pending = { type: "attack", targetId: mob.id };
  p.energy = 10; // exactly one unarmed swing (UNARMED_ACTION_COST)
  const events = [];
  state.resolvePlayerAttacks(events);
  const swings = events.filter((e) => e.type === "attack");
  assert.equal(swings.length, 1, "exactly one swing");
  assert.equal(swings[0].hit, true, "bright light: the swing lands");
  assert.equal(mob.hp, 100 - swings[0].damage, "hp fell by the rolled blow");
  assert.equal(mob.aggro[p.id], swings[0].damage, "threat equals the blow");
  assert.ok(!events.some((e) => e.type === "mob-hurt"), "the attack event narrates; no mob-hurt");
});

test("melee: a whiffed swing still provokes one point of threat and lands nothing", () => {
  const state = setup();
  const p = addPlayer(state);
  const mob = addMob(state, "biter");
  const events = [];
  const defender = state._mobDefender(mob, state.world.mobs.biter, "arena", { id: p.id, kind: "player", actor: p }, events);
  const attacker = { actor: p, kind: "player", id: p.id, name: p.name, emitsLight: false, roomId: "arena", onHit: null, sourceId: p.id, hurt: () => null };
  const r = { hit: false, sighted: true, damage: 0, crit: false };
  const { defenderDeath, attackerDeath } = state.applyHitOutcome({ r, events, attacker, defender });
  assert.equal(defenderDeath, null);
  assert.equal(attackerDeath, null);
  assert.equal(mob.aggro[p.id], 1, "the whiff provoked");
  assert.equal(mob.hp, mob.maxHp, "no damage on a miss");
  assert.ok(!events.some((e) => e.type === "mob-hurt"), "no hurt event on a miss");
});

test("cast: both directions stoke max(1, damage) threat on the struck mob", () => {
  // Player → mob: castSpell routes through the sink.
  const state = setup();
  const p = addPlayer(state);
  const mob = addMob(state, "caster"); // 50 hp — survives the 5-damage bolt
  state.castSpell(p, state.world.spells.bolt, mob, []);
  assert.equal(mob.aggro[p.id], 5, "player cast: threat equals the bolt");

  // Mob → mob: _resolveSpellPayload routes through the same sink.
  const state2 = setup();
  const caster = addMob(state2, "caster");
  const victim = addMob(state2, "caster");
  victim.faction = "player"; // an enemy of the wild caster
  state2._mobCast(caster, state2.world.mobs.caster, "arena", [], [{ id: victim.id, actor: victim, kind: "mob", faction: "player" }], "bolt");
  assert.equal(victim.aggro[caster.id], 5, "mob cast: threat equals the bolt");
});

// --- One death path -----------------------------------------------------------

test("a melee kill and a spell kill resolve through the same death sequence", () => {
  // Melee finisher.
  const state = setup();
  const p = addPlayer(state);
  const mob = addMob(state, "biter"); // 5 hp
  p.pending = { type: "attack", targetId: mob.id };
  p.energy = 100; // enough swings to finish it
  const events = [];
  state.resolvePlayerAttacks(events);
  const meleeDeath = events.find((e) => e.type === "death");
  assert.ok(meleeDeath, "melee kill emitted the death event");
  assert.equal(meleeDeath.killerId, p.id);
  assert.equal(meleeDeath.xp, 1, "kill XP credited");
  assert.ok(!state.rooms.arena.mobs.includes(mob), "mob removed");
  assert.equal(p.pending, null, "quarry slain — pending cleared, no stale combat-stop next tick");

  // Spell finisher: same event, same credit, from the same sink.
  const state2 = setup();
  const p2 = addPlayer(state2);
  const mob2 = addMob(state2, "biter"); // 5 hp — the 5-damage bolt kills
  const events2 = [];
  const res = state2.castSpell(p2, state2.world.spells.bolt, mob2, events2);
  assert.equal(res.killed, true);
  assert.equal(res.death.killerId, p2.id);
  assert.equal(res.death.xp, 1, "kill XP credited");
  assert.ok(!state2.rooms.arena.mobs.includes(mob2), "mob removed");
  const pushed = events2.find((e) => e.type === "death");
  assert.equal(pushed, res.death, "the sink pushed the same death event it returned");
});

// --- Silence and event order ----------------------------------------------------

test("mob-cast: the cast event narrates the blow (no player-hurt) and precedes a death", () => {
  // Survived bolt: hp falls, the mob-cast event carries the post-blow hp, no player-hurt.
  const state = setup();
  const p = addPlayer(state);
  const caster = addMob(state, "caster");
  p.hp = 100;
  const events = [];
  state._mobCast(caster, state.world.mobs.caster, "arena", events, [pdesc(p)], "bolt");
  const castEv = events.find((e) => e.type === "mob-cast");
  assert.equal(p.hp, 95);
  assert.equal(castEv.targetHp, 95, "cast event carries the post-blow hp");
  assert.equal(castEv.killed, false);
  assert.ok(!events.some((e) => e.type === "player-hurt"), "the cast event narrates; no player-hurt");

  // Lethal bolt: cast-then-death, in that order.
  const state2 = setup();
  const p2 = addPlayer(state2);
  const caster2 = addMob(state2, "caster");
  p2.hp = 5;
  const events2 = [];
  state2._mobCast(caster2, state2.world.mobs.caster, "arena", events2, [pdesc(p2)], "bolt");
  const castIdx = events2.findIndex((e) => e.type === "mob-cast");
  const deathIdx = events2.findIndex((e) => e.type === "death-begin");
  assert.ok(castIdx >= 0 && deathIdx >= 0, "both events fired");
  assert.ok(castIdx < deathIdx, "the cast narrates before the fall");
  assert.equal(events2[castIdx].killed, true);
  assert.equal(events2[castIdx].targetHp, 0);
});

test("a bleed tick still narrates its own mob-hurt, and its kill credits the source", () => {
  const state = setup();
  const p = addPlayer(state);
  const mob = addMob(state, "biter"); // 5 hp — the 10-damage bleed kills
  state.applyEffect(mob, { type: "damage-over-time", name: "bleed", damage: "10", duration: 3, sourceId: p.id, good: false });
  const events = [];
  state._tickEffects(events);
  const hurt = events.find((e) => e.type === "mob-hurt");
  assert.ok(hurt, "an unnarrated source keeps its mob-hurt event");
  assert.equal(hurt.cause, "bleed");
  const death = events.find((e) => e.type === "death");
  assert.ok(death, "the bleed finished it");
  assert.equal(death.killerId, p.id, "the DoT's source is credited");
});
