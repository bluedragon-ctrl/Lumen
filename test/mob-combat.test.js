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
      // A rim guard: `helper` (joins allies' fights) and armed with an attack action
      // so it can act on that commitment. Hits for 5 → fells the maxHp-5 biter in one
      // blow. `rim` allies the player, so it defends a delver under attack.
      guard: { id: "guard", name: "a guard", description: "", maxHp: 20, xp: 1, faction: "rim", helper: true, hostile: false, perception: band, attack: { damage: "5", type: "physical", actionCost: 12 }, actions: [{ type: "attack", weight: 6 }] },
    },
    spells: {
      bolt: { id: "bolt", name: "Shadow Bolt", hostile: true, effect: { type: "damage", damage: "5" } },
      hex: { id: "hex", name: "Hex", hostile: true, effect: { type: "weaken", name: "Hex", duration: 5 } },
      snuff: { id: "snuff", name: "Snuff", hostile: true, effect: { type: "douse", name: "Snuff" } },
      leech: { id: "leech", name: "Leech", hostile: true, effect: { type: "drain", damage: "6", healFactor: 0.5 } },
      siphon: { id: "siphon", name: "Leech Warmth", hostile: true, effect: { type: "mana-drain", drain: "4" } },
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

test("reflect: a Fire Shield STATUS effect burns a melee attacker, exactly like spiked gear", () => {
  const state = setup();
  const p = addPlayer(state);
  p.hp = 100; p.posture = "standing";
  // A drunk Fire Shield potion: a timed buff carrying its own onDamage reflect
  // (50 back at any melee hit — enough to fell the maxHp-5 biter). The engine must
  // gather this from p.states, not only from worn armour.
  const ok = state.applyEffect(p, { type: "reflect", name: "Fire Shield", duration: 90, refresh: true,
    onDamage: [{ type: "damage", damage: "50", cause: "fire shield", target: "attacker", on: ["melee"] }] });
  assert.ok(ok && (p.states || []).some((s) => s.type === "reflect"), "the buff took hold");
  const mob = addMob(state, "biter");
  state._mobAttack(mob, state.world.mobs.biter, "arena", [], [pdesc(p)]);
  assert.ok(!state.rooms.arena.mobs.includes(mob), "the buff's reflect killed the melee attacker");
});

test("reflect: with the Fire Shield lapsed, the same blow reflects nothing (control)", () => {
  const state = setup();
  const p = addPlayer(state);
  p.hp = 100; p.posture = "standing"; // no buff applied
  const mob = addMob(state, "biter");
  state._mobAttack(mob, state.world.mobs.biter, "arena", [], [pdesc(p)]);
  assert.ok(state.rooms.arena.mobs.includes(mob), "no reflect without the buff — the attacker is unharmed");
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

// --- Faction assist (allies defend their own) -------------------------------

test("assist: a rim helper commits to the fight when a wild mob attacks an allied player", () => {
  const state = setup();
  const p = addPlayer(state);
  const attacker = addMob(state, "biter"); // wild
  const guard = addMob(state, "guard");    // rim, helper — allies the player
  attacker.aggro = { [p.id]: 5 };          // the biter has engaged the player
  const events = [];
  state._assistPass(guard, state.world.mobs.guard, [mdesc(attacker)], state.rooms.arena.light, "arena", events);
  assert.ok(guard.aggro && guard.aggro[attacker.id] > 0, "the guard commits threat to the player's attacker");
  assert.ok(has(events, "mob-assist"), "a mob-assist event announces the guard stepping in");
});

test("assist: the committed helper then swings at the attacker via its attack action", () => {
  const state = setup();
  const p = addPlayer(state);
  const attacker = addMob(state, "biter"); // wild, maxHp 5 → the guard's 5 fells it
  const guard = addMob(state, "guard");
  attacker.aggro = { [p.id]: 5 };
  const events = [];
  // The assist pass commits the guard, then a full action turn resolves into a
  // real swing — proving an armed helper can act on that commitment (the bug the
  // rim watch once had was an attack block with no attack action to roll).
  state._assistPass(guard, state.world.mobs.guard, [mdesc(attacker)], state.rooms.arena.light, "arena", events);
  state._mobAct(guard, state.world.mobs.guard, "arena", events);
  assert.ok(!state.rooms.arena.mobs.includes(attacker), "the guard struck down the player's attacker");
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

// --- Drain (Leech) ------------------------------------------------------------

test("drain: a mob's leech damages the player and heals the caster, capped at maxHp", () => {
  const state = setup();
  const p = addPlayer(state);
  const caster = addMob(state, "caster"); // maxHp 50
  caster.hp = 40;
  p.hp = 100;
  const events = [];
  state._mobCast(caster, state.world.mobs.caster, "arena", events, [pdesc(p)], "leech");
  assert.equal(p.hp, 94, "player lost the rolled 6");
  assert.equal(caster.hp, 43, "caster healed floor(6 * 0.5) = 3");
  const ev = events.find((e) => e.type === "mob-cast");
  assert.equal(ev.drained, 3, "mob-cast event carries the drained amount");
});

test("drain: the heal never overfills the caster", () => {
  const state = setup();
  const p = addPlayer(state);
  const caster = addMob(state, "caster");
  caster.hp = 49; // room for only 1 of the 3
  const events = [];
  state._mobCast(caster, state.world.mobs.caster, "arena", events, [pdesc(p)], "leech");
  assert.equal(caster.hp, 50, "capped at maxHp");
});

test("drain: a player-cast drain heals the player (engine path for a future scroll)", () => {
  const state = setup();
  const p = addPlayer(state);
  const mob = addMob(state, "biter"); // 5 hp — the 6 kills it
  p.hp = p.maxHp - 10;
  const events = [];
  const result = state.castSpell(p, state.world.spells.leech, mob, events);
  assert.equal(result.damage, 6);
  assert.ok(result.killed, "the drain still kills");
  assert.equal(p.hp, p.maxHp - 10 + 3, "player healed floor(6 * 0.5) = 3");
  assert.equal(result.drained, 3, "result reports the heal for narration");
});

// --- Mana drain (void leech's Leech Warmth) ----------------------------------

test("mana-drain: a leech drinks the player's mana and deals no HP damage", () => {
  const state = setup();
  const p = addPlayer(state);
  const caster = addMob(state, "caster");
  p.hp = 100; p.maxMana = 10; p.mana = 10;
  const events = [];
  state._mobCast(caster, state.world.mobs.caster, "arena", events, [pdesc(p)], "siphon");
  assert.equal(p.mana, 6, "player lost the rolled 4 mana");
  assert.equal(p.hp, 100, "no HP damage — a leech only drinks will");
  const ev = events.find((e) => e.type === "mob-cast");
  assert.equal(ev.manaDrain, true);
  assert.equal(ev.manaDrained, 4, "mob-cast event carries the mana drained");
  assert.ok(ev.damage === 0 && !ev.killed, "the cast deals and threatens no HP");
  assert.ok(has(events, "vitals"), "the drained delver's mana bar is refreshed");
});

test("mana-drain: a wrung-dry delver loses nothing more (no vitals refresh)", () => {
  const state = setup();
  const p = addPlayer(state);
  const caster = addMob(state, "caster");
  p.hp = 100; p.maxMana = 10; p.mana = 0; // already spent dry
  const events = [];
  state._mobCast(caster, state.world.mobs.caster, "arena", events, [pdesc(p)], "siphon");
  assert.equal(p.mana, 0);
  const ev = events.find((e) => e.type === "mob-cast");
  assert.equal(ev.manaDrain, true);
  assert.equal(ev.manaDrained, 0, "found nothing to drink");
  assert.ok(!has(events, "vitals"), "no bar refresh when nothing was drained");
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

// --- Ambush engagement (rooted/lurking predators) ---------------------------

// AGGRO_ENGAGE is 2 (state-mobai.js): a detect meter must reach it before an
// ambusher will consider a target at all. `_isEngaged` is a pure predicate, so we
// exercise it directly with Math.random pinned for deterministic linger rolls.
function withRandom(v, fn) {
  const real = Math.random;
  Math.random = () => v;
  try { return fn(); } finally { Math.random = real; }
}

test("ambush: sleeping prey is taken outright; an awake lingerer is snapped at only by chance", () => {
  const state = setup();
  const t = { ambush: true };
  const noticed = (over = {}) => ({ detect: { P: 2 }, ...over }); // fully noticed the player
  const sleeper = { id: "P", kind: "player", actor: { posture: "sleeping" } };
  const awake = { id: "P", kind: "player", actor: { posture: "standing" } };

  // Sleeping delver → engaged outright, no roll (pin random high to prove it).
  assert.equal(withRandom(0.99, () => state._isEngaged(noticed(), t, sleeper)), true, "sleeper taken");
  // Awake lingerer, roll below the linger chance → the snap.
  assert.equal(withRandom(0.0, () => state._isEngaged(noticed(), t, awake)), true, "awake lingerer snapped");
  // Awake lingerer, roll above the chance → it keeps waiting.
  assert.equal(withRandom(0.5, () => state._isEngaged(noticed(), t, awake)), false, "awake lingerer left alone");
  // Not yet fully noticed → never engaged, even a sleeper.
  assert.equal(withRandom(0.0, () => state._isEngaged(noticed({ detect: { P: 1 } }), t, sleeper)), false, "must notice first");
  // Once blows are traded (aggro > 0) it commits regardless of posture or roll.
  assert.equal(withRandom(0.99, () => state._isEngaged(noticed({ aggro: { P: 1 } }), t, awake)), true, "combat carries on");
});

// --- Immobilize (a snapper's grip) ------------------------------------------

test("immobilize: an onHit hold lands a timed state that expires and frees the player", () => {
  const state = setup();
  const p = addPlayer(state);
  p.hp = 100;
  // Land the hold exactly as an attacker's onHit immobilize does (shared trigger path).
  const applied = [];
  state._applyTriggerEffect(applied, { type: "immobilize", name: "Held", duration: 3 }, pdesc(p), null, null);
  const held = (p.states || []).find((s) => s.type === "immobilize");
  assert.ok(held, "a Held state is applied");
  assert.equal(held.remaining, 3, "carries its duration");
  assert.ok(applied.some((e) => e.type === "effect-applied" && e.effectType === "immobilize"),
    "apply is narrated with the effect type so the renderer can word the grip");
  // Count it down: it lapses on the 3rd tick and announces its type so the release reads right.
  const ticks = [];
  for (let i = 0; i < 3; i++) state._tickEffects(ticks);
  assert.ok(!(p.states || []).some((s) => s.type === "immobilize"), "the hold has lapsed");
  assert.ok(ticks.some((e) => e.type === "effect-expired" && e.effectType === "immobilize"),
    "expiry narrated with the effect type");
});
