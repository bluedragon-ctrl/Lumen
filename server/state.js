"use strict";
const { effectiveLight, canSee, hitChance } = require("./light");
const { rollDice } = require("./dice");

/** The attacker's effective weapon: equipped hand weapon, or unarmed. */
function weaponOf(world, player) {
  const hand = player.equipment && player.equipment.hand;
  if (hand) {
    const t = world.items[hand.template];
    if (t.weapon) return { dice: (t.weapon.damage && t.weapon.damage.physical) || "1d2", actionCost: t.weapon.actionCost || 12 };
  }
  return { dice: "1d2", actionCost: 10 }; // unarmed
}

/** Total physical Armour from a player's equipped gear. */
function playerArmour(world, player) {
  let a = 0;
  for (const inst of Object.values(player.equipment || {})) {
    if (!inst) continue;
    const t = world.items[inst.template];
    if (t.armour) a += t.armour.armour || 0;
  }
  return a;
}

const mightMod = (attrs) => ((attrs && attrs.might != null ? attrs.might : 5) - 5);

/** Resolve one swing. Accuracy is gated by how well the attacker sees the target
 *  (clear 100% / glare 50% / can't-see 5%). `sighted` drives miss-message wording. */
function strike(attackerPerception, light, dice, attackerMightMod, targetArmour) {
  const hit = Math.random() < hitChance(attackerPerception, light);
  const sighted = canSee(attackerPerception, light);
  if (!hit) return { hit: false, sighted, damage: 0 };
  const damage = Math.max(1, rollDice(dice) + attackerMightMod - targetArmour);
  return { hit: true, sighted, damage };
}

// Monotonic source of unique runtime ids. Every addressable runtime entity —
// players, mob instances, item instances, placed fixtures — gets one
// (`player.N`, `mob.N`, `item.N`, `fixture.N`). Authored static defs (rooms,
// templates) keep their own unique string ids.
// NOTE: resets on restart; when snapshot-resume lands we must seed this above
// the highest id seen in the snapshot to avoid collisions.
let nextEntityId = 1;
const entityId = (prefix) => `${prefix}.${nextEntityId++}`;
/** Raise the counter past an existing id (e.g. when loading a saved account). */
function ensureIdAbove(id) {
  const n = typeof id === "string" ? parseInt(id.split(".")[1], 10) : NaN;
  if (!isNaN(n) && n >= nextEntityId) nextEntityId = n + 1;
}

/**
 * Create a runtime item instance from an authoring ItemRef (`{template, qty?, fuel?}`).
 * Stackables carry `qty`; fuelled light sources carry `fuel`/`lit`.
 */
function makeItemInstance(ref, world) {
  const tmpl = world.items[ref.template];
  if (!tmpl) throw new Error(`unknown item template: ${ref.template}`);
  const inst = { id: entityId("item"), template: ref.template };
  if (tmpl.stackable) inst.qty = ref.qty != null ? ref.qty : 1;
  if (tmpl.light) {
    inst.fuel = ref.fuel != null ? ref.fuel : tmpl.light.fuelMax;
    inst.lit = ref.lit || false;
  }
  return inst;
}

/** Create a runtime mob instance from a mob template id. */
function makeMobInstance(mobId, world) {
  const tmpl = world.mobs[mobId];
  if (!tmpl) throw new Error(`unknown mob template: ${mobId}`);
  return {
    id: entityId("mob"),
    template: mobId,
    hp: tmpl.maxHp,
    maxHp: tmpl.maxHp,
    energy: 0, // accumulated action points
  };
}

/**
 * Authoritative in-memory world state (DESIGN.md §6.1). Owns all dynamic state:
 * per-room mob/item instances and connected players. Static content lives in `world`.
 */
class GameState {
  constructor(world) {
    this.world = world;
    this.tick = 0;
    this.players = new Map(); // playerId -> player instance
    this.rooms = {}; // roomId -> { mobs:[], items:[], light:int }
    this._initRooms();
  }

  _initRooms() {
    for (const [id, room] of Object.entries(this.world.rooms)) {
      const rt = { mobs: [], items: [], fixtures: [], light: room.ambientLight || 0 };
      for (const g of room.groundItems || []) rt.items.push(makeItemInstance(g, this.world));
      for (const f of room.fixtures || []) rt.fixtures.push({ id: entityId("fixture"), template: f });
      for (const s of room.spawns || []) {
        const max = s.max != null ? s.max : 1;
        for (let i = 0; i < max; i++) rt.mobs.push(makeMobInstance(s.mob, this.world));
      }
      this.rooms[id] = rt;
      rt.light = this.computeRoomLight(id);
    }
  }

  /** Players currently located in a room. */
  playersIn(roomId) {
    return [...this.players.values()].filter((p) => p.location === roomId);
  }

  /**
   * Effective light for a room: ambient + every active source present
   * (light-emitting mobs, plus players carrying a lit light source).
   */
  computeRoomLight(roomId) {
    const room = this.world.rooms[roomId];
    const rt = this.rooms[roomId];
    if (!room || !rt) return 0;
    const outputs = [];
    for (const m of rt.mobs) {
      const tmpl = this.world.mobs[m.template];
      if (tmpl && tmpl.emitsLight) outputs.push(tmpl.emitsLight);
    }
    for (const p of this.playersIn(roomId)) {
      const lightItem = p.equipment && p.equipment.light;
      if (lightItem && lightItem.lit && lightItem.fuel > 0) {
        const tmpl = this.world.items[lightItem.template];
        if (tmpl && tmpl.light) outputs.push(tmpl.light.output);
      }
    }
    return effectiveLight(room.ambientLight, outputs);
  }

  /**
   * Build a fresh character from the static template. Returns plain player data;
   * it is NOT added to the live world (that's `admit`). Used both for new
   * accounts and the auto-created admin.
   */
  createCharacter(name, opts = {}) {
    const t = this.world.playerTemplate;
    const player = {
      id: entityId("player"),
      name,
      isAdmin: !!opts.isAdmin,
      level: t.level,
      xp: t.xp,
      attributes: { ...t.attributes },
      hp: t.maxHp,
      maxHp: t.maxHp,
      mana: t.maxMana,
      maxMana: t.maxMana,
      speed: t.speed,
      energy: 0,
      perception: { ...t.perception },
      location: t.startLocation,
      equipment: {},
      inventory: (t.startInventory || []).map((ref) => makeItemInstance(ref, this.world)),
      states: [],
    };
    for (const [slot, tmplId] of Object.entries(t.startEquipment || {})) {
      player.equipment[slot] =
        tmplId == null ? null : makeItemInstance({ template: tmplId }, this.world);
    }
    return player;
  }

  /**
   * Admit a character (freshly created or loaded from an account) into the live
   * world. Seeds the id counter past any ids it carries so a post-restart load
   * can't collide with freshly minted ids.
   */
  admit(player) {
    ensureIdAbove(player.id);
    for (const inst of player.inventory || []) if (inst) ensureIdAbove(inst.id);
    for (const inst of Object.values(player.equipment || {})) if (inst) ensureIdAbove(inst.id);
    this.players.set(player.id, player);
    return player;
  }

  removePlayer(playerId) {
    this.players.delete(playerId);
  }

  /**
   * Advance the world one tick:
   *   1. accrue action-point energy (capped) for all actors
   *   2. burn fuel on lit lights (→ light-out events)
   *   3. recompute room light
   *   4. resolve combat (player attacks + hostile mob attacks), light-gated
   * Returns an event list the server turns into messages/view refreshes.
   */
  advance() {
    this.tick++;
    const events = [];

    for (const p of this.players.values()) p.energy = Math.min(p.energy + p.speed, p.speed * 3);
    for (const rt of Object.values(this.rooms)) {
      for (const m of rt.mobs) {
        const speed = this.world.mobs[m.template].speed || 10;
        m.energy = Math.min((m.energy || 0) + speed, speed * 3);
      }
    }

    for (const p of this.players.values()) {
      const li = p.equipment && p.equipment.light;
      if (li && li.lit && li.fuel > 0) {
        const tmpl = this.world.items[li.template];
        li.fuel -= (tmpl.light && tmpl.light.burnPerTick) || 1;
        if (li.fuel <= 0) {
          li.fuel = 0;
          li.lit = false;
          events.push({ type: "light-out", playerId: p.id, item: li.template });
        }
      }
    }

    for (const id of Object.keys(this.rooms)) this.rooms[id].light = this.computeRoomLight(id);

    this.resolveCombat(events);
    return events;
  }

  /** Player pending-attacks, then hostile mob attacks. Accuracy gated by light. */
  resolveCombat(events) {
    const w = this.world;

    for (const p of this.players.values()) {
      if (p.hp <= 0 || !p.pending || p.pending.type !== "attack") continue;
      const rt = this.rooms[p.location];
      const mob = rt.mobs.find((m) => m.id === p.pending.targetId);
      if (!mob) {
        p.pending = null;
        events.push({ type: "combat-stop", playerId: p.id, reason: "Your quarry is gone." });
        continue;
      }
      const weapon = weaponOf(w, p);
      while (p.energy >= weapon.actionCost && mob.hp > 0) {
        p.energy -= weapon.actionCost;
        const r = strike(p.perception, rt.light, weapon.dice, mightMod(p.attributes), 0);
        events.push({
          type: "attack", by: "player", attackerId: p.id, attackerName: p.name, roomId: p.location,
          targetId: mob.id, targetName: w.mobs[mob.template].name, hit: r.hit, sighted: r.sighted,
          damage: r.damage, targetHp: Math.max(0, mob.hp - r.damage), targetMaxHp: mob.maxHp,
          light: rt.light, targetEmitsLight: !!w.mobs[mob.template].emitsLight,
        });
        mob.hp -= r.damage;
        if (mob.hp <= 0) {
          events.push(this._killMob(mob, p));
          p.pending = null;
          break;
        }
      }
    }

    for (const [roomId, rt] of Object.entries(this.rooms)) {
      for (const m of rt.mobs) {
        const t = w.mobs[m.template];
        if (!t.hostile || !t.attack) continue;
        const victims = this.playersIn(roomId).filter((p) => p.hp > 0);
        if (!victims.length) continue;
        const target = victims[Math.floor(Math.random() * victims.length)];
        while (m.energy >= t.attack.actionCost && target.hp > 0) {
          m.energy -= t.attack.actionCost;
          const r = strike(t.perception, rt.light, t.attack.damage, mightMod(t.attributes), playerArmour(w, target));
          events.push({
            type: "attack", by: "mob", attackerId: m.id, attackerName: t.name, roomId,
            targetId: target.id, targetName: target.name, hit: r.hit, sighted: r.sighted,
            damage: r.damage, targetHp: Math.max(0, target.hp - r.damage), targetMaxHp: target.maxHp,
            light: rt.light, attackerEmitsLight: !!t.emitsLight,
          });
          target.hp -= r.damage;
          if (target.hp <= 0) {
            events.push(this._respawn(target, roomId));
            break;
          }
        }
      }
    }
  }

  _killMob(mob, killer) {
    const t = this.world.mobs[mob.template];
    const rt = this.rooms[killer.location];
    const idx = rt.mobs.indexOf(mob);
    if (idx >= 0) rt.mobs.splice(idx, 1);
    const loot = [];
    for (const l of t.loot || []) {
      if (Math.random() < l.chance) {
        rt.items.push(makeItemInstance({ template: l.template }, this.world));
        loot.push(this.world.items[l.template].name);
      }
    }
    const xp = t.xp || 0;
    killer.xp = (killer.xp || 0) + xp;
    return { type: "death", victimKind: "mob", victimId: mob.id, victimName: t.name, roomId: killer.location, killerId: killer.id, loot, xp };
  }

  /** Player death (v1): respawn at the rim, full HP, no penalty beyond progress. */
  _respawn(player, deathRoom) {
    const start = this.world.playerTemplate.startLocation;
    player.hp = player.maxHp;
    player.location = start;
    player.pending = null;
    player.energy = 0;
    this.rooms[start].light = this.computeRoomLight(start);
    this.rooms[deathRoom].light = this.computeRoomLight(deathRoom);
    return { type: "death", victimKind: "player", victimId: player.id, victimName: player.name, roomId: deathRoom, respawnRoom: start };
  }
}

module.exports = { GameState, makeItemInstance, makeMobInstance };
