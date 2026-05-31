"use strict";
const fs = require("fs");
const path = require("path");
const { RUNTIME_DIR } = require("./config");
const { effectiveLight } = require("./light");

let nextEntityId = 1;
const entityId = (prefix) => `${prefix}.${nextEntityId++}`;

/**
 * Create a runtime item instance from an authoring ItemRef (`{template, qty?, fuel?}`).
 * Stackables carry `qty`; fuelled light sources carry `fuel`/`lit`.
 */
function makeItemInstance(ref, world) {
  const tmpl = world.items[ref.template];
  if (!tmpl) throw new Error(`unknown item template: ${ref.template}`);
  const inst = { template: ref.template };
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
      const rt = { mobs: [], items: [], light: room.ambientLight || 0 };
      for (const g of room.groundItems || []) rt.items.push(makeItemInstance(g, this.world));
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

  /** Instantiate a fresh player from the static template. */
  createPlayer(name) {
    const t = this.world.playerTemplate;
    const player = {
      id: entityId("player"),
      name,
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
    this.players.set(player.id, player);
    return player;
  }

  removePlayer(playerId) {
    this.players.delete(playerId);
  }

  /** Advance the world one tick. Recomputes room light; combat/AI arrive later. */
  advance() {
    this.tick++;
    for (const id of Object.keys(this.rooms)) {
      this.rooms[id].light = this.computeRoomLight(id);
    }
  }

  /** Persist a snapshot of dynamic state to disk (runtime dir, gitignored). */
  snapshot() {
    fs.mkdirSync(RUNTIME_DIR, { recursive: true });
    const data = {
      tick: this.tick,
      players: [...this.players.values()],
    };
    fs.writeFileSync(path.join(RUNTIME_DIR, "snapshot.json"), JSON.stringify(data, null, 2));
  }
}

module.exports = { GameState, makeItemInstance, makeMobInstance };
