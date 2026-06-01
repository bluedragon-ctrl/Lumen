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

/** Defensive mitigation from a player's equipped gear: Armour (vs physical)
 *  and Ward (vs magical). Mirrors the {armour, ward} block on armour items. */
function playerDefence(world, player) {
  let armour = 0;
  let ward = 0;
  for (const inst of Object.values(player.equipment || {})) {
    if (!inst) continue;
    const t = world.items[inst.template];
    if (t.armour) {
      armour += t.armour.armour || 0;
      ward += t.armour.ward || 0;
    }
  }
  return { armour, ward };
}

const mightMod = (attrs) => ((attrs && attrs.might != null ? attrs.might : 5) - 5);

/** Weighted random choice from `[{weight}, ...]`; null if the list is empty. */
function pickWeighted(options) {
  const total = options.reduce((s, o) => s + (o.weight || 1), 0);
  if (total <= 0) return null;
  let r = Math.random() * total;
  for (const o of options) {
    r -= o.weight || 1;
    if (r < 0) return o;
  }
  return options[options.length - 1];
}

/** Resolve one swing. Accuracy is gated by how well the attacker sees the target
 *  (clear 100% / glare 50% / can't-see 5%). `sighted` drives miss-message wording. */
function strike(attackerPerception, light, dice, attackerMightMod, defence, damageType = "physical") {
  const hit = Math.random() < hitChance(attackerPerception, light);
  const sighted = canSee(attackerPerception, light);
  if (!hit) return { hit: false, sighted, damage: 0 };
  // Physical damage is soaked by Armour; everything else (magical) by Ward.
  const mitigation = damageType === "physical" ? defence.armour || 0 : defence.ward || 0;
  const damage = Math.max(1, rollDice(dice) + attackerMightMod - mitigation);
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

// --- Economy ---------------------------------------------------------------
// Every (non-currency) item carries a `value` — the price to buy it from a
// trader. A trader pays SELL_RATE of that value when buying an item from a
// player; an item may override its sell price with an explicit `sellValue`.
const SELL_RATE = 0.2;
const buyValueOf = (t) => (t && t.value) || 0;
const sellValueOf = (t) => (t && t.sellValue != null ? t.sellValue : Math.round(buyValueOf(t) * SELL_RATE));

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
    aggro: {}, // playerId -> threat; minimal threat table, see _addThreat()
  };
}

/** Total light an actor radiates from active `emit-light` status effects. */
function actorEmitLight(actor) {
  let sum = 0;
  for (const s of actor.states || []) if (s.type === "emit-light") sum += s.magnitude || 0;
  return sum;
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
    // Spawners drive repop: each remembers its room, mob, population cap, and a
    // countdown. A rule without `respawn` is static (spawned once, never refills).
    this.spawners = [];
    for (const [id, room] of Object.entries(this.world.rooms)) {
      this.rooms[id] = { mobs: [], items: [], fixtures: [], light: room.ambientLight || 0 };
      for (const g of room.groundItems || []) this.rooms[id].items.push(makeItemInstance(g, this.world));
      for (const f of room.fixtures || []) {
        const inst = { id: entityId("fixture"), template: f };
        const ft = this.world.fixtures[f];
        if (ft && ft.switch) inst.on = !!ft.switch.on; // switchable fixtures carry on/off state
        this.rooms[id].fixtures.push(inst);
      }
      for (const s of room.spawns || []) {
        const max = s.max != null ? s.max : 1;
        for (let i = 0; i < max; i++) this._spawnMob(id, s.mob);
        if (s.respawn != null) this.spawners.push({ roomId: id, mob: s.mob, max, respawn: s.respawn, timer: s.respawn });
      }
      this.rooms[id].light = this.computeRoomLight(id);
    }
  }

  /** Create a mob instance, tag it with the spawner that owns it, and place it. */
  _spawnMob(roomId, mobId) {
    const m = makeMobInstance(mobId, this.world);
    m.origin = { roomId, mob: mobId }; // which spawner this counts against (survives wandering)
    this.rooms[roomId].mobs.push(m);
    return m;
  }

  /** Living mobs that belong to a spawner, wherever they have since wandered. */
  _countOwned(roomId, mobId) {
    let n = 0;
    for (const rt of Object.values(this.rooms))
      for (const m of rt.mobs)
        if (m.origin && m.origin.roomId === roomId && m.origin.mob === mobId) n++;
    return n;
  }

  /**
   * Repop: each tick, any spawner below its cap counts down; at zero it spawns one
   * mob back in its home room and rearms. At/above cap the timer stays primed, so
   * the full delay only begins once a kill (or a wandered-off mob) drops the count.
   */
  _respawnTick(events) {
    for (const sp of this.spawners) {
      if (this._countOwned(sp.roomId, sp.mob) >= sp.max) { sp.timer = sp.respawn; continue; }
      if (--sp.timer > 0) continue;
      sp.timer = sp.respawn;
      const m = this._spawnMob(sp.roomId, sp.mob);
      const t = this.world.mobs[sp.mob];
      const light = this.rooms[sp.roomId].light = this.computeRoomLight(sp.roomId);
      events.push({ type: "mob-spawn", roomId: sp.roomId, mobId: m.id, mobName: t.name, emitsLight: !!t.emitsLight, light });
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
      const e = actorEmitLight(m); // a mob could carry a light effect (e.g. a spell)
      if (e) outputs.push(e);
    }
    for (const f of rt.fixtures) {
      const ft = this.world.fixtures[f.template];
      if (ft && ft.switch && f.on) outputs.push(ft.switch.emitsLight || 0); // a lit lamp, etc.
    }
    for (const p of this.playersIn(roomId)) {
      const lightItem = p.equipment && p.equipment.light;
      if (lightItem && lightItem.lit && lightItem.fuel > 0) {
        const tmpl = this.world.items[lightItem.template];
        if (tmpl && tmpl.light) outputs.push(tmpl.light.output);
      }
      const e = actorEmitLight(p); // a held Light effect (potion/spell) glows too
      if (e) outputs.push(e);
    }
    return effectiveLight(room.ambientLight, outputs);
  }

  /**
   * Apply a status-effect primitive to an actor. `spec` is the data-driven
   * descriptor authored on a potion/spell, e.g.
   *   { type: "emit-light", name: "Light", magnitude: 1, duration: 180 }
   * Effects stack as independent instances, each with its own countdown; the
   * engine reads them where relevant (emit-light is summed into room light).
   */
  applyEffect(actor, spec) {
    if (!actor.states) actor.states = [];
    actor.states.push({
      type: spec.type,
      name: spec.name || spec.type,
      magnitude: spec.magnitude || 0,
      remaining: spec.duration != null ? spec.duration : null, // null = permanent
      good: spec.good !== false,
    });
  }

  /** Tick down active effects on all players; emit an event as each expires. */
  _tickEffects(events) {
    for (const p of this.players.values()) {
      if (!p.states || !p.states.length) continue;
      const expired = [];
      p.states = p.states.filter((s) => {
        if (s.remaining == null) return true; // permanent
        s.remaining -= 1;
        if (s.remaining <= 0) {
          expired.push(s);
          return false;
        }
        return true;
      });
      for (const s of expired) events.push({ type: "effect-expired", playerId: p.id, effectType: s.type, name: s.name });
    }
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
      shards: t.shards || 0,
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
      states: [], // active status effects (see applyEffect / _tickEffects)
      knownRecipes: [...(t.knownRecipes || [])],
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
    // A persisted location can name a room that no longer exists (e.g. content was
    // reworked since the save). Strand-proof it: fall back to the start room.
    if (!this.rooms[player.location]) player.location = this.world.playerTemplate.startLocation;
    // Likewise, drop carried/equipped items whose template was removed since the
    // save, so a content rework can't crash rendering on an orphaned instance.
    player.inventory = (player.inventory || []).filter((i) => i && this.world.items[i.template]);
    for (const slot of Object.keys(player.equipment || {}))
      if (player.equipment[slot] && !this.world.items[player.equipment[slot].template]) player.equipment[slot] = null;
    // Backfill fields added after this save was written (e.g. effects, recipes).
    if (!Array.isArray(player.states)) player.states = [];
    if (!Array.isArray(player.knownRecipes)) player.knownRecipes = [...(this.world.playerTemplate.knownRecipes || [])];
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

    this._tickEffects(events);

    for (const id of Object.keys(this.rooms)) this.rooms[id].light = this.computeRoomLight(id);

    this.resolvePlayerAttacks(events);
    this.resolveMobAI(events);
    this._respawnTick(events);
    return events;
  }

  /** Player pending-attacks. Accuracy gated by light; multiple swings if energy allows. */
  resolvePlayerAttacks(events) {
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
      const mt = w.mobs[mob.template];
      const mobDef = { armour: mt.armour || 0, ward: mt.ward || 0 };
      while (p.energy >= weapon.actionCost && mob.hp > 0) {
        p.energy -= weapon.actionCost;
        const r = strike(p.perception, rt.light, weapon.dice, mightMod(p.attributes), mobDef, weapon.damageType || "physical");
        events.push({
          type: "attack", by: "player", attackerId: p.id, attackerName: p.name, roomId: p.location,
          targetId: mob.id, targetName: w.mobs[mob.template].name, hit: r.hit, sighted: r.sighted,
          damage: r.damage, targetHp: Math.max(0, mob.hp - r.damage), targetMaxHp: mob.maxHp,
          light: rt.light, targetEmitsLight: !!w.mobs[mob.template].emitsLight,
        });
        this._addThreat(mob, p.id, Math.max(1, r.damage)); // attacking it earns its ire
        mob.hp -= r.damage;
        if (mob.hp <= 0) {
          events.push(this._killMob(mob, p));
          p.pending = null;
          break;
        }
      }
    }
  }

  /** Each mob takes at most one weighted action per tick (attack/emote/flee/idle). */
  resolveMobAI(events) {
    for (const [roomId, rt] of Object.entries(this.rooms)) {
      for (const m of [...rt.mobs]) {
        const t = this.world.mobs[m.template];
        const cost = (t.attack && t.attack.actionCost) || 12;
        if (m.energy < cost) continue;
        m.energy -= cost;
        this._mobAct(m, t, roomId, events);
      }
    }
  }

  _mobAct(m, t, roomId, events) {
    const rt = this.rooms[roomId];
    const playersHere = this.playersIn(roomId).filter((p) => p.hp > 0);

    // Threat: hostile mobs engage any delver present; drop threat toward those
    // who have left/died. A mob with live threat is "in combat" and won't wander.
    if (t.hostile) for (const p of playersHere) this._addThreat(m, p.id, 0);
    this._pruneAggro(m, playersHere);
    const inCombat = Object.keys(m.aggro || {}).length > 0;

    // Wander destinations: "zone" scope confines a mob to its current zone (the
    // village stays in the village, the abyss below); "any" lets it cross zones.
    const allDirs = Object.keys(this.world.rooms[roomId].exits || {});
    const roamDirs = this._zoneExits(roomId);
    const wanderDirs = (a) => (a.scope === "any" ? allDirs : roamDirs);

    let options;
    if (Array.isArray(t.actions) && t.actions.length) {
      options = t.actions.filter((a) => {
        if (a.type === "attack") return t.hostile && t.attack && playersHere.length > 0;
        if (a.type === "wander") return !inCombat && wanderDirs(a).length > 0;
        if (a.type === "emote") return Array.isArray(a.messages) && a.messages.length > 0;
        return a.type === "idle";
      });
    } else {
      // Default behaviour for mobs without an actions table: attack if able.
      options = t.hostile && t.attack && playersHere.length ? [{ type: "attack" }] : [];
    }

    const choice = pickWeighted(options);
    if (!choice || choice.type === "idle") return;
    if (choice.type === "attack") return this._mobAttack(m, t, roomId, events, playersHere);
    if (choice.type === "emote") {
      const text = choice.messages[Math.floor(Math.random() * choice.messages.length)];
      events.push({ type: "mob-emote", roomId, mobId: m.id, mobName: t.name, emitsLight: !!t.emitsLight, light: rt.light, text });
      return;
    }
    if (choice.type === "wander") return this._mobMove(m, t, roomId, events, choice.verb || "wanders off", wanderDirs(choice));
  }

  /** Exit directions whose destination room shares this room's zone (roamable). */
  _zoneExits(roomId) {
    const room = this.world.rooms[roomId];
    const zone = room.zone;
    return Object.entries(room.exits || {})
      .filter(([, dest]) => this.world.rooms[dest] && this.world.rooms[dest].zone === zone)
      .map(([dir]) => dir);
  }

  // --- Aggro / threat table (minimal; placeholder for a fuller threat system) ---
  // Today: tracks which players a mob is engaged with so it stays to fight rather
  // than wandering off, and picks its target by highest threat. Later: threat
  // weighting per action, decay over time, and cross-room pursuit hook here.

  /** Add `amount` threat toward a player (0 just ensures an entry exists). */
  _addThreat(mob, playerId, amount) {
    if (!mob.aggro) mob.aggro = {};
    mob.aggro[playerId] = (mob.aggro[playerId] || 0) + amount;
  }

  /** Forget players no longer present/alive. (Later: decay instead of hard drop.) */
  _pruneAggro(mob, playersHere) {
    if (!mob.aggro) { mob.aggro = {}; return; }
    const present = new Set(playersHere.map((p) => p.id));
    for (const pid of Object.keys(mob.aggro)) if (!present.has(pid)) delete mob.aggro[pid];
  }

  /** The present player a mob is most angry at, or null. */
  _topThreat(mob, playersHere) {
    if (!mob.aggro) return null;
    let best = null, bestT = -Infinity;
    for (const p of playersHere) {
      const th = mob.aggro[p.id];
      if (th != null && th > bestT) { bestT = th; best = p; }
    }
    return best;
  }

  _mobAttack(m, t, roomId, events, playersHere) {
    const rt = this.rooms[roomId];
    const target = this._topThreat(m, playersHere) || playersHere[Math.floor(Math.random() * playersHere.length)];
    this._addThreat(m, target.id, 1); // attacking sticks the mob to its quarry
    const r = strike(t.perception, rt.light, t.attack.damage, mightMod(t.attributes), playerDefence(this.world, target), t.attack.type || "physical");
    events.push({
      type: "attack", by: "mob", attackerId: m.id, attackerName: t.name, roomId,
      targetId: target.id, targetName: target.name, hit: r.hit, sighted: r.sighted,
      damage: r.damage, targetHp: Math.max(0, target.hp - r.damage), targetMaxHp: target.maxHp,
      light: rt.light, attackerEmitsLight: !!t.emitsLight,
    });
    target.hp -= r.damage;
    if (target.hp <= 0) events.push(this._respawn(target, roomId));
  }

  _mobMove(m, t, roomId, events, verb, exits) {
    const dir = exits[Math.floor(Math.random() * exits.length)];
    const dest = this.world.rooms[roomId].exits[dir];
    const rt = this.rooms[roomId];
    const idx = rt.mobs.indexOf(m);
    if (idx >= 0) rt.mobs.splice(idx, 1);
    this.rooms[dest].mobs.push(m);
    rt.light = this.computeRoomLight(roomId);
    this.rooms[dest].light = this.computeRoomLight(dest);
    events.push({
      type: "mob-move", mobId: m.id, mobName: t.name, from: roomId, to: dest, dir, verb,
      emitsLight: !!t.emitsLight, lightFrom: rt.light, lightTo: this.rooms[dest].light,
    });
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
    // Shards drop on the floor (a shared world — anyone present can gather them),
    // merging into an existing pile rather than littering separate stacks.
    let shards = 0;
    if (t.shards) shards = rollDice(t.shards);
    if (shards > 0) {
      const pile = rt.items.find((i) => i.template === "shards");
      if (pile) pile.qty = (pile.qty || 1) + shards;
      else rt.items.push(makeItemInstance({ template: "shards", qty: shards }, this.world));
      loot.push(`${shards} shards`);
    }
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

module.exports = { GameState, makeItemInstance, makeMobInstance, actorEmitLight, playerDefence, buyValueOf, sellValueOf, SELL_RATE };
