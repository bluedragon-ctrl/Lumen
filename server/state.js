"use strict";
const { effectiveLight, canSee, hitChance } = require("./light");
const { rollDice } = require("./dice");
const { XP_BASE, XP_GROWTH, POINTS_PER_LEVEL } = require("./config");

/** Cumulative lifetime XP required to *reach* `level` (level 1 = 0). The
 *  increment for each step is XP_BASE * XP_GROWTH^(step-1), so successive levels
 *  cost XP_GROWTH× the last. See config.XP_BASE/XP_GROWTH. */
function xpForLevel(level) {
  let total = 0;
  let step = XP_BASE;
  for (let l = 1; l < level; l++) { total += step; step *= XP_GROWTH; }
  return total;
}

// Default melee scaling when a weapon omits its own `scale`: floor(Might / 4)
// added to physical damage. Mirrors a spell's `effect.scale`.
const MELEE_SCALE = { attr: "might", per: 4 };

// Rest recovery: a resting actor regains 1 HP and 1 MP every N ticks. Sitting is
// the lighter rest; sleeping the deeper (and blinding) one. Standing never regains
// HP (only the slow innate mana trickle). Posture is a shared actor concept —
// players use it for recovery + social; mobs use it to author dozing/resting NPCs.
const SIT_RECOVER_TICKS = 5;
const SLEEP_RECOVER_TICKS = 2;
const RESTING = (actor) => actor.posture === "sitting" || actor.posture === "sleeping";

/** Posture-aware sight: a *sleeping* actor perceives nothing — its room view goes
 *  dark and its own sight-gated rolls flail — regardless of room light. Sitting and
 *  standing use the actor's real perception band. Shared by render and targeting. */
function canPerceive(actor, light) {
  if (actor.posture === "sleeping") return false;
  return canSee(actor.perception, light);
}

/** The attacker's effective weapon: equipped hand weapon, or unarmed. `scale`
 *  is the attribute the weapon's damage grows with (default Might/4). */
function weaponOf(world, player) {
  const hand = player.equipment && player.equipment.hand;
  if (hand) {
    const t = world.items[hand.template];
    if (t.weapon) return {
      dice: (t.weapon.damage && t.weapon.damage.physical) || "1d2",
      actionCost: t.weapon.actionCost || 12,
      scale: t.weapon.scale || MELEE_SCALE,
      onHit: t.weapon.onHit || null, // on-hit effects applied to the struck defender
    };
  }
  return { dice: "1d2", actionCost: 10, scale: MELEE_SCALE, onHit: null }; // unarmed
}

// --- Defender-side triggers (onDamage) -------------------------------------
// `onDamage` is the general "when I'm struck" list, the defender-side mirror of
// the attacker's `onHit`. Each entry is an effect spec plus two extra axes the
// attacker side never needs: `target` ("attacker" — reflect/retaliate — or
// "self" — e.g. draw mana off a blow; default "attacker") and `on` (which damage
// sources fire it; default ["melee"], with "spell" reserved for a later castSpell
// wiring). `spikes: { damage, chance? }` is kept as terse authoring sugar for the
// commonest entry — a flat melee reflect — normalized here into an onDamage entry.
const spikesEntry = (s) => ({ type: "damage", damage: s.damage, chance: s.chance, target: "attacker", cause: "spikes", on: ["melee"] });

/** A mob's resolved onDamage triggers: explicit `onDamage` entries plus its
 *  `spikes` sugar (a reflect entry). */
function mobOnDamage(t) {
  const list = Array.isArray(t.onDamage) ? [...t.onDamage] : [];
  if (t.spikes) list.push(spikesEntry(t.spikes));
  return list;
}

/** A player's resolved onDamage triggers, gathered across equipped armour
 *  (`armour.onDamage` entries plus `armour.spikes` sugar). Lets gear punish or
 *  profit from being hit exactly as a mob does — none seeded yet. */
function playerOnDamage(world, player) {
  const list = [];
  for (const inst of Object.values(player.equipment || {})) {
    if (!inst) continue;
    const t = world.items[inst.template];
    if (!t || !t.armour) continue;
    if (Array.isArray(t.armour.onDamage)) list.push(...t.armour.onDamage);
    if (t.armour.spikes) list.push(spikesEntry(t.armour.spikes));
  }
  return list;
}

// Each point of Wits grants this much innate Ward (magic resist) and this much
// evasion (a flat reduction to an attacker's hit chance). Pure defensive stat.
const WARD_PER_WITS = 2;
const EVASION_PER_WITS = 0.02;
// Each point of Perception grants this much to-hit and this much crit chance.
const HIT_PER_PERCEPTION = 0.02;
const CRIT_PER_PERCEPTION = 0.01;
// Attribute-derived pools and the sight curve (see GameState.deriveStats).
const HP_PER_VITALITY = 5;
const MANA_PER_INTELLECT = 4;
const ATTR_BASELINE = 3; // starting value of every attribute
const SIGHT_PER_PERCEPTION = 5; // every +5 Perception over baseline lowers dimBelow by 1

/** A player's effective attributes: base attributes plus any flat modifiers
 *  from equipped gear (`armour.attrMod`, e.g. heavy iron that dulls Wits).
 *  Each result is floored at 0. The single source for attribute reads at combat
 *  time, so a penalty (or bonus) on gear flows through to-hit, melee damage,
 *  Ward and evasion alike. */
function effectiveAttributes(world, player) {
  const attrs = { ...(player.attributes || {}) };
  for (const inst of Object.values(player.equipment || {})) {
    if (!inst) continue;
    const t = world.items[inst.template];
    const mod = t && t.armour && t.armour.attrMod;
    if (!mod) continue;
    for (const [k, v] of Object.entries(mod)) attrs[k] = Math.max(0, (attrs[k] || 0) + v);
  }
  return attrs;
}

/** Defensive profile of a player: Armour (vs physical) and Ward (vs magical)
 *  from equipped gear plus innate Ward from Wits, and Wits-derived evasion.
 *  Mirrors the {armour, ward} block on armour items. Wits is read effective —
 *  heavy gear that dulls Wits costs both Ward and evasion. */
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
  const wits = effectiveAttributes(world, player).wits || 0;
  ward += wits * WARD_PER_WITS;
  return { armour, ward, evasion: wits * EVASION_PER_WITS };
}

// A flat damage bonus from a scaling attribute, e.g. {attr:"intellect", per:4}
// adds floor(intellect / 4). Used by both spells (effect.scale) and melee
// weapons (weapon.scale). No `scale` block → no attribute bonus.
function spellScaleBonus(attrs, scale) {
  if (!scale || !scale.attr) return 0;
  const v = (attrs && attrs[scale.attr] != null) ? attrs[scale.attr] : 0;
  return Math.floor(v / (scale.per || 1));
}

// Ward resists hostile magic as an all-or-nothing fizzle: each point of the
// target's Ward is this much chance to negate the spell entirely (works for
// damage and effect spells alike). 0.01 = 1% per point.
const WARD_RESIST_PER_POINT = 0.01;

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

// A hit can never be rarer than this, even against heavy evasion — there is
// always a sliver of a chance to land a blow (matches the can't-see floor).
const MIN_HIT = 0.05;

/** Resolve one swing.
 *  @param attacker { band, hitBonus, dmgBonus, crit } — light-perception band,
 *         flat to-hit bonus (Perception), flat damage bonus (weapon scale), crit chance.
 *  @param defender { armour, ward, evasion } — mitigation + dodge.
 *  Accuracy is the light tier (clear 100% / glare 50% / can't-see 5%) plus the
 *  attacker's hit bonus minus the defender's evasion, clamped to [MIN_HIT, 1].
 *  `sighted` drives miss-message wording; a crit doubles the damage roll. */
function strike(attacker, defender, light, dice, damageType = "physical") {
  const chance = Math.max(MIN_HIT, Math.min(1, hitChance(attacker.band, light) + (attacker.hitBonus || 0) - (defender.evasion || 0)));
  const sighted = canSee(attacker.band, light);
  if (Math.random() >= chance) return { hit: false, sighted, damage: 0, crit: false };
  // Physical damage is soaked by Armour; everything else (magical) by Ward.
  const mitigation = damageType === "physical" ? defender.armour || 0 : defender.ward || 0;
  let base = rollDice(dice) + (attacker.dmgBonus || 0);
  const crit = Math.random() < (attacker.crit || 0);
  if (crit) base *= 2; // a critical strike doubles the offensive damage, before mitigation
  const damage = Math.max(1, base - mitigation);
  return { hit: true, sighted, damage, crit };
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
    posture: tmpl.posture || "standing", // authored dozing/resting NPCs; inert until roused
  };
}

/** Total light an actor radiates from active `emit-light` status effects. */
function actorEmitLight(actor) {
  let sum = 0;
  for (const s of actor.states || []) if (s.type === "emit-light") sum += s.magnitude || 0;
  return sum;
}

// --- Hidden features (search) ----------------------------------------------
// A room feature (item, fixture, exit, mob) may carry a `hidden: { perception }`
// block; it is omitted from a player's view until they `search` and meet the
// requirement. Permanent finds (items/fixtures/exits) are recorded per-player as
// stable discovery keys on `player.discovered`; mob reveals are ephemeral
// (in-memory, current-visit only — see GameState.revealedMobs).
const discoveryKey = (roomId, kind, ident) => `${roomId}|${kind}|${ident}`;
const isDiscovered = (player, key) => Array.isArray(player.discovered) && player.discovered.includes(key);

/** Effective Perception for searching: the attribute scaled by how well the player
 *  sees the room — the same light tiers combat uses (darkness ×0.05, dim/glare
 *  ×0.5, clear ×1.0). So light is required to find what's hidden. */
function effectivePerception(player, light) {
  const per = (player.attributes && player.attributes.perception) || 0;
  return per * hitChance(player.perception, light);
}

// Visibility predicates — a hidden feature is shown only once discovered/revealed.
// Reused by the room view (render.js) and command resolvers so filtering matches.
const itemVisibleTo = (player, inst) => !inst.hidden || isDiscovered(player, inst.discoveryKey);
const fixtureVisibleTo = (player, inst) => !inst.hidden || isDiscovered(player, inst.discoveryKey);
const mobVisibleTo = (state, player, mob) => {
  if (!mob.hidden) return true;
  const set = state.revealedMobs.get(player.id);
  return !!(set && set.has(mob.id));
};

/**
 * Authoritative in-memory world state (DESIGN.md §6.1). Owns all dynamic state:
 * per-room mob/item instances and connected players. Static content lives in `world`.
 */
class GameState {
  constructor(world) {
    this.world = world;
    this.tick = 0;
    this.players = new Map(); // playerId -> player instance
    this.playersByRoom = new Map(); // roomId -> Set(player instance); kept in sync with player.location
    this.rooms = {}; // roomId -> { mobs:[], items:[], light:int }
    this.revealedMobs = new Map(); // playerId -> Set(mob runtime id); ephemeral hidden-mob reveals
    this.ownedCounts = new Map(); // `${roomId}|${mob}` -> living mobs from that spawner (see _countOwned)
    this._initRooms();
  }

  _initRooms() {
    // Spawners drive repop: each remembers its room, mob, population cap, and a
    // countdown. A rule without `respawn` is static (spawned once, never refills).
    this.spawners = [];
    // Harvesters regrow a picked-up floor item after a delay (mushrooms, seeps,
    // …). A groundItem without `respawn` is static (placed once, gone when taken).
    this.harvesters = [];
    for (const [id, room] of Object.entries(this.world.rooms)) {
      this.rooms[id] = { mobs: [], items: [], fixtures: [], light: room.ambientLight || 0 };
      for (const g of room.groundItems || []) {
        const inst = makeItemInstance(g, this.world);
        if (g.respawn != null) {
          inst.origin = { roomId: id, template: g.template, harvest: true }; // tags it for regrow tracking
          this.harvesters.push({ roomId: id, template: g.template, qty: g.qty != null ? g.qty : 1, respawn: g.respawn, timer: g.respawn });
        }
        if (g.hidden) { inst.hidden = g.hidden; inst.discoveryKey = discoveryKey(id, "item", g.template); }
        this.rooms[id].items.push(inst);
      }
      for (const f of room.fixtures || []) {
        // A fixture entry is a template string, or an object `{ template, hidden }`.
        const tmplId = typeof f === "string" ? f : f.template;
        const inst = { id: entityId("fixture"), template: tmplId };
        const ft = this.world.fixtures[tmplId];
        if (ft && ft.switch) inst.on = !!ft.switch.on; // switchable fixtures carry on/off state
        if (ft && ft.mine) { inst.charges = ft.mine.charges; inst.regrow = ft.mine.respawn; } // resource veins deplete as mined
        if (typeof f === "object" && f.hidden) { inst.hidden = f.hidden; inst.discoveryKey = discoveryKey(id, "fix", tmplId); }
        this.rooms[id].fixtures.push(inst);
      }
      for (const s of room.spawns || []) {
        const max = s.max != null ? s.max : 1;
        for (let i = 0; i < max; i++) this._spawnMob(id, s.mob, s.hidden);
        if (s.respawn != null) this.spawners.push({ roomId: id, mob: s.mob, max, respawn: s.respawn, timer: s.respawn, hidden: s.hidden });
      }
      this.rooms[id].light = this.computeRoomLight(id);
    }
  }

  /** Create a mob instance, tag it with the spawner that owns it, and place it. */
  _spawnMob(roomId, mobId, hidden) {
    const m = makeMobInstance(mobId, this.world);
    m.origin = { roomId, mob: mobId }; // which spawner this counts against (survives wandering)
    if (hidden) m.hidden = hidden; // a lurker — unseen/inert until a delver searches it out
    this.rooms[roomId].mobs.push(m);
    this._adjustOwned(m, +1);
    return m;
  }

  // --- Spawner population accounting -----------------------------------------
  // A spawner is identified by its (home room, mob) pair; mobs tag themselves
  // with that pair via `origin` at spawn and keep it as they wander. Rather than
  // rescan the whole world each tick, we keep a running per-spawner live count,
  // bumped at spawn (_spawnMob) and at death (every mob-removal path).
  _ownerKey(origin) {
    return origin ? `${origin.roomId}|${origin.mob}` : null;
  }
  /** Bump a mob's spawner count by `delta` (+1 spawned, −1 removed). */
  _adjustOwned(mob, delta) {
    const k = this._ownerKey(mob.origin);
    if (!k) return;
    const n = (this.ownedCounts.get(k) || 0) + delta;
    if (n > 0) this.ownedCounts.set(k, n);
    else this.ownedCounts.delete(k);
  }

  /** Living mobs that belong to a spawner, wherever they have since wandered. */
  _countOwned(roomId, mobId) {
    return this.ownedCounts.get(`${roomId}|${mobId}`) || 0;
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
      const m = this._spawnMob(sp.roomId, sp.mob, sp.hidden);
      const t = this.world.mobs[sp.mob];
      const light = this.rooms[sp.roomId].light = this.computeRoomLight(sp.roomId);
      events.push({ type: "mob-spawn", roomId: sp.roomId, mobId: m.id, mobName: t.name, emitsLight: !!t.emitsLight, light });
    }
  }

  /**
   * Regrow: each tick, any harvester whose home room no longer holds its tagged
   * floor item counts down; at zero it places a fresh one and rearms. Dropping a
   * matching item back on the floor (untagged) does not suppress regrow.
   */
  _harvestTick(events) {
    for (const hv of this.harvesters) {
      const present = this.rooms[hv.roomId].items.some(
        (it) => it.origin && it.origin.harvest && it.origin.template === hv.template
      );
      if (present) { hv.timer = hv.respawn; continue; }
      if (--hv.timer > 0) continue;
      hv.timer = hv.respawn;
      const inst = makeItemInstance({ template: hv.template, qty: hv.qty }, this.world);
      inst.origin = { roomId: hv.roomId, template: hv.template, harvest: true };
      this.rooms[hv.roomId].items.push(inst);
      const t = this.world.items[hv.template];
      events.push({ type: "item-regrow", roomId: hv.roomId, itemName: t.name });
    }
  }

  /**
   * Recover: each tick, any resource vein below its full charge count counts
   * down; at zero it refills to full and rearms. The timer only begins once the
   * seam has been worked below max, mirroring the spawner/harvester rhythm.
   */
  _mineTick(events) {
    for (const [roomId, rt] of Object.entries(this.rooms)) {
      for (const f of rt.fixtures) {
        const ft = this.world.fixtures[f.template];
        if (!ft || !ft.mine) continue;
        if (f.charges >= ft.mine.charges) { f.regrow = ft.mine.respawn; continue; }
        if (--f.regrow > 0) continue;
        f.charges = ft.mine.charges;
        f.regrow = ft.mine.respawn;
        events.push({ type: "vein-recover", roomId, fixtureName: ft.name });
      }
    }
  }

  /** Players currently located in a room. O(occupants) via the room index. */
  playersIn(roomId) {
    const set = this.playersByRoom.get(roomId);
    return set ? [...set] : [];
  }

  // --- Room occupancy index --------------------------------------------------
  // `playersByRoom` mirrors every player's `location`, so `playersIn` (called
  // for each room every tick, and on every broadcast) stays O(occupants) rather
  // than rescanning all players. Every write to `player.location` MUST go through
  // setPlayerLocation (or admit/removePlayer) to keep the index honest.
  _indexPlayer(player) {
    let set = this.playersByRoom.get(player.location);
    if (!set) { set = new Set(); this.playersByRoom.set(player.location, set); }
    set.add(player);
  }
  _deindexPlayer(player) {
    const set = this.playersByRoom.get(player.location);
    if (set) { set.delete(player); if (set.size === 0) this.playersByRoom.delete(player.location); }
  }
  /** Move a player to a new room, keeping the occupancy index in sync. */
  setPlayerLocation(player, roomId) {
    this._deindexPlayer(player);
    player.location = roomId;
    this._indexPlayer(player);
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
      if (!ft) continue;
      if (ft.switch && f.on) outputs.push(ft.switch.emitsLight || 0); // a lit lamp, etc.
      else if (ft.emitsLight) outputs.push(ft.emitsLight); // an always-glowing fixture (witchglow, sky-fissure)
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
      damage: spec.damage || null, // dice string, for "damage-over-time" (bleed/poison)
      sourceId: spec.sourceId || null, // player to credit if a DoT lands the kill
      remaining: spec.duration != null ? spec.duration : null, // null = permanent
      good: spec.good !== false,
    });
  }

  /**
   * Instantly restore hp and/or mana (a consumable's `restore` effect), clamping
   * to the actor's maxima. Returns the amounts actually applied.
   */
  applyRestore(actor, spec) {
    const out = { hp: 0, mana: 0 };
    if (spec.hp) {
      const before = actor.hp;
      actor.hp = Math.min(actor.maxHp, actor.hp + spec.hp);
      out.hp = actor.hp - before;
    }
    if (spec.mana) {
      const before = actor.mana || 0;
      actor.mana = Math.min(actor.maxMana, before + spec.mana);
      out.mana = actor.mana - before;
    }
    return out;
  }

  /**
   * Tick active status effects on every actor (players and mobs): first apply any
   * `damage-over-time` (bleed/poison) through the shared damage sinks, then count
   * down timed effects and announce expiries. A DoT that kills its host stops that
   * actor's remaining ticks.
   */
  _tickEffects(events) {
    for (const p of this.players.values()) {
      if (!p.states || !p.states.length || p.hp <= 0) continue;
      let dead = false;
      for (const s of p.states) {
        if (s.type !== "damage-over-time" || !s.damage) continue;
        if (this._hurtPlayer(p, Math.max(1, rollDice(s.damage)), events, { cause: s.name || "bleed" })) { dead = true; break; }
      }
      if (!dead) this._expireStates(p, events, (s) => ({ type: "effect-expired", playerId: p.id, effectType: s.type, name: s.name }));
    }
    for (const [roomId, rt] of Object.entries(this.rooms)) {
      for (const m of [...rt.mobs]) {
        if (!m.states || !m.states.length) continue;
        let dead = false;
        for (const s of m.states) {
          if (s.type !== "damage-over-time" || !s.damage) continue;
          const src = s.sourceId ? this.players.get(s.sourceId) : null;
          if (this._hurtMob(m, roomId, Math.max(1, rollDice(s.damage)), events, { cause: s.name || "bleed", killer: src && src.hp > 0 ? src : null })) { dead = true; break; }
        }
        if (!dead) {
          const t = this.world.mobs[m.template];
          this._expireStates(m, events, (s) => ({ type: "mob-effect-expired", roomId, mobId: m.id, mobName: t.name, effectType: s.type, name: s.name, emitsLight: !!t.emitsLight, light: rt.light }));
        }
      }
    }
  }

  /** Count down an actor's timed states, dropping (and announcing via `mkEvent`)
   *  any that reach zero. Permanent states (remaining == null) persist. */
  _expireStates(actor, events, mkEvent) {
    if (!actor.states) return;
    const expired = [];
    actor.states = actor.states.filter((s) => {
      if (s.remaining == null) return true;
      s.remaining -= 1;
      if (s.remaining <= 0) { expired.push(s); return false; }
      return true;
    });
    for (const s of expired) events.push(mkEvent(s));
  }

  /**
   * Recompute a player's derived stats from their attributes (DESIGN.md §3.2):
   * max HP (Vitality), max Mana (Intellect), and the low-light sight band
   * (Perception). Idempotent — always derived from `attributes` plus the
   * template's perception band as the baseline-at-3 anchor, so it is safe to
   * re-run on every admit (like the manaRegen re-sync). Innate Ward/evasion
   * (Wits), to-hit/crit (Perception), and melee damage (Might) are applied live
   * at combat time, not stored here. Does NOT touch current hp/mana — callers clamp.
   */
  deriveStats(player) {
    const a = player.attributes || {};
    player.maxHp = (a.vitality || 0) * HP_PER_VITALITY;
    player.maxMana = (a.intellect || 0) * MANA_PER_INTELLECT;
    const band = this.world.playerTemplate.perception || { blindBelow: 1, dimBelow: 3, harmedAbove: 9 };
    const sight = Math.floor(((a.perception || 0) - ATTR_BASELINE) / SIGHT_PER_PERCEPTION);
    const dimBelow = Math.max(band.blindBelow, band.dimBelow - sight);
    player.perception = { blindBelow: band.blindBelow, dimBelow, harmedAbove: band.harmedAbove };
  }

  /** Credit `amount` lifetime XP to a player and resolve any level-ups it
   *  crosses. Mutates `xp`, `level` and `unspentPoints`; returns one
   *  `{ level, points }` per level gained (a big award can cross several). The
   *  caller narrates/broadcasts these (see index.js `level-up` handling). */
  awardXp(player, amount) {
    player.xp = (player.xp || 0) + (amount || 0);
    const ups = [];
    while (player.xp >= xpForLevel((player.level || 1) + 1)) {
      player.level = (player.level || 1) + 1;
      player.unspentPoints = (player.unspentPoints || 0) + POINTS_PER_LEVEL;
      ups.push({ level: player.level, points: POINTS_PER_LEVEL });
    }
    return ups;
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
      unspentPoints: 0, // attribute points banked from level-ups, spent via `train`
      shards: t.shards || 0,
      attributes: { ...t.attributes },
      manaRegen: t.manaRegen || 0,
      speed: t.speed,
      energy: 0,
      location: t.startLocation,
      equipment: {},
      inventory: (t.startInventory || []).map((ref) => makeItemInstance(ref, this.world)),
      states: [], // active status effects (see applyEffect / _tickEffects)
      posture: "standing", // sit/sleep for rest recovery; resets to standing on login
      restTicks: 0, // counts ticks toward the next rest-recovery point (see _recoverTick)
      knownRecipes: [...(t.knownRecipes || [])],
      knownSpells: [...(t.knownSpells || [])],
      visitedRooms: [t.startLocation], // first-entry explore XP; the spawn room is free
    };
    for (const [slot, tmplId] of Object.entries(t.startEquipment || {})) {
      player.equipment[slot] =
        tmplId == null ? null : makeItemInstance({ template: tmplId }, this.world);
    }
    this.deriveStats(player); // maxHp/maxMana/sight band from attributes
    player.hp = player.maxHp;
    player.mana = player.maxMana;
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
    // Backfill fields added after this save was written (e.g. effects, recipes, spells).
    if (!Array.isArray(player.states)) player.states = [];
    if (!Array.isArray(player.knownRecipes)) player.knownRecipes = [...(this.world.playerTemplate.knownRecipes || [])];
    if (!Array.isArray(player.knownSpells)) player.knownSpells = [...(this.world.playerTemplate.knownSpells || [])];
    if (!Array.isArray(player.discovered)) player.discovered = []; // permanently-found hidden features (keys)
    if (player.unspentPoints == null) player.unspentPoints = 0; // banked attribute points (leveling added later)
    // Explore XP added later: seed with the current room so a pre-existing delver
    // isn't paid for re-treading ground, then earns from the next new room on.
    if (!Array.isArray(player.visitedRooms)) player.visitedRooms = [player.location];
    // Posture always resets to standing on login — a delver wakes up when they
    // reconnect, so a save can't strand them blind and asleep.
    player.posture = "standing";
    player.restTicks = 0;
    if (player.maxMana == null) player.maxMana = this.world.playerTemplate.maxMana;
    if (player.mana == null) player.mana = player.maxMana;
    player.hp = Math.min(player.hp, player.maxHp);
    player.mana = Math.min(player.mana, player.maxMana);
    // manaRegen is a global tuning constant (not per-character progress), so always
    // re-sync it from the template — tuning changes then apply to existing saves too.
    player.manaRegen = this.world.playerTemplate.manaRegen || 0;
    // Admin always knows every recipe — handy for testing. Re-synced on each
    // login, so recipes added to the world after the admin save are picked up.
    if (player.isAdmin) player.knownRecipes = Object.keys(this.world.recipes);
    this.players.set(player.id, player);
    this._indexPlayer(player); // location is final by here — add to the occupancy index
    return player;
  }

  removePlayer(playerId) {
    const player = this.players.get(playerId);
    if (player) this._deindexPlayer(player);
    this.players.delete(playerId);
    this.revealedMobs.delete(playerId); // drop ephemeral hidden-mob reveals on disconnect
  }

  /** Forget a player's ephemeral hidden-mob reveals (e.g. on leaving a room). */
  clearRevealedMobs(playerId) {
    this.revealedMobs.delete(playerId);
  }

  /**
   * `search` the current room: reveal every hidden feature whose requirement is met
   * by the player's effective Perception (attribute × light tier — so light matters).
   * Permanent finds (items/fixtures/exits) are recorded on `player.discovered`;
   * hidden mobs are revealed ephemerally (this visit only). Returns { found, any }.
   */
  search(player) {
    const roomId = player.location;
    const room = this.world.rooms[roomId];
    const rt = this.rooms[roomId];
    const eff = effectivePerception(player, rt.light);
    if (!Array.isArray(player.discovered)) player.discovered = [];
    const found = [];

    for (const inst of rt.items) {
      if (inst.hidden && !isDiscovered(player, inst.discoveryKey) && inst.hidden.perception <= eff) {
        player.discovered.push(inst.discoveryKey);
        found.push(this.world.items[inst.template].name);
      }
    }
    for (const inst of rt.fixtures) {
      if (inst.hidden && !isDiscovered(player, inst.discoveryKey) && inst.hidden.perception <= eff) {
        player.discovered.push(inst.discoveryKey);
        found.push(this.world.fixtures[inst.template].name);
      }
    }
    for (const [dir, h] of Object.entries(room.hiddenExits || {})) {
      const key = discoveryKey(roomId, "exit", dir);
      if (!isDiscovered(player, key) && (h.perception || 0) <= eff) {
        player.discovered.push(key);
        found.push(h.name || `a passage ${dir}`);
      }
    }
    let set = this.revealedMobs.get(player.id);
    for (const m of rt.mobs) {
      if (!m.hidden) continue;
      if (!set) { set = new Set(); this.revealedMobs.set(player.id, set); }
      if (!set.has(m.id) && m.hidden.perception <= eff) {
        set.add(m.id);
        found.push(this.world.mobs[m.template].name);
      }
    }
    return { found, any: found.length > 0 };
  }

  /**
   * Per-tick vitals recovery for a player. Resting (sit/sleep) regains 1 HP and
   * 1 MP on a posture-set cadence and *replaces* the standing mana trickle while
   * it lasts; standing keeps the slow innate mana trickle and never regains HP.
   * Flags a `vitals` refresh whenever a *displayed* value changes, so an idle
   * resting player actually sees the bars climb (views aren't pushed every tick).
   */
  _recoverTick(p, events) {
    if (p.hp <= 0) return; // the dead don't mend; respawn restores them
    const every = p.posture === "sleeping" ? SLEEP_RECOVER_TICKS : p.posture === "sitting" ? SIT_RECOVER_TICKS : 0;
    if (every) {
      if (p.hp >= p.maxHp && p.mana >= p.maxMana) { p.restTicks = 0; return; } // fully mended
      if (++p.restTicks < every) return;
      p.restTicks = 0;
      const hpBefore = p.hp;
      const manaBefore = Math.floor(p.mana || 0);
      p.hp = Math.min(p.maxHp, p.hp + 1);
      p.mana = Math.min(p.maxMana, (p.mana || 0) + 1);
      if (p.hp !== hpBefore || Math.floor(p.mana) !== manaBefore) events.push({ type: "vitals", playerId: p.id });
      return;
    }
    // Standing: only the slow innate mana trickle (fractional, rendered floored).
    p.restTicks = 0;
    if (p.manaRegen && p.mana < p.maxMana) {
      const before = Math.floor(p.mana || 0);
      p.mana = Math.min(p.maxMana, (p.mana || 0) + p.manaRegen);
      if (Math.floor(p.mana) !== before) events.push({ type: "vitals", playerId: p.id });
    }
  }

  /** Rouse a resting actor (player or mob) to standing — they share `posture`.
   *  Returns true if it actually changed, so callers can announce the waking. */
  _rouse(actor) {
    if (RESTING(actor)) { actor.posture = "standing"; actor.restTicks = 0; return true; }
    return false;
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

    for (const p of this.players.values()) {
      p.energy = Math.min(p.energy + p.speed, p.speed * 3);
      this._recoverTick(p, events);
    }
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

    // Per-tick light only changes where a dynamic source lives: a player (burning
    // fuel, an emit-light effect) or a mob (luminous, or an expiring light effect).
    // Rooms with neither hold their last value — ambient and fixtures are static
    // between events, which already recompute the affected room (move/toggle/spawn).
    for (const [id, rt] of Object.entries(this.rooms)) {
      const here = this.playersByRoom.get(id);
      if (rt.mobs.length === 0 && (!here || here.size === 0)) continue;
      rt.light = this.computeRoomLight(id);
    }

    this._environmentTick(events); // light-bane and other room hazards, on fresh light
    this.resolvePlayerAttacks(events);
    this.resolveMobAI(events);
    this._respawnTick(events);
    this._harvestTick(events);
    this._mineTick(events);
    return events;
  }

  /** Narrate a status effect taking hold on an actor (player or mob). */
  _narrateEffectApplied(events, who, name) {
    if (who.kind === "mob")
      events.push({ type: "mob-effect-applied", roomId: who.roomId, mobId: who.id, mobName: who.name, name, emitsLight: who.emitsLight, light: this.rooms[who.roomId].light });
    else
      events.push({ type: "effect-applied", playerId: who.id, name });
  }

  /** Roll an effect spec's `chance` (default 1). True → it fires this hit. */
  _rollChance(spec) {
    return spec.chance == null || Math.random() < spec.chance;
  }

  /**
   * Apply one effect spec to a target actor, dispatching by type: instant
   * `damage` goes through the target's hurt sink (returns its death event, if
   * any); `restore` tops up hp/mana; everything else (`damage-over-time`,
   * `emit-light`, …) is a status via applyEffect. `creditId`, when set, stamps
   * the spec's `sourceId` so a DoT this lands credits that player on a kill.
   * Used for both attacker `onHit` (target = defender) and defender `onDamage`
   * (target = attacker or self).
   */
  _applyTriggerEffect(events, spec, target, hurt, creditId) {
    if (spec.type === "damage")
      return hurt(Math.max(1, rollDice(spec.damage)), spec.cause || "spikes");
    if (spec.type === "restore") {
      const got = this.applyRestore(target.actor, spec);
      if (target.kind === "player" && (got.hp || got.mana)) events.push({ type: "trigger-restore", playerId: target.id, hp: got.hp, mana: got.mana });
      return null;
    }
    const s = creditId ? { ...spec, sourceId: creditId } : spec;
    this.applyEffect(target.actor, s);
    this._narrateEffectApplied(events, target, s.name || s.type);
    return null;
  }

  /**
   * Process the outcome of one resolved **melee** swing, for either direction
   * (player→mob or mob→player), from a single place so both get the data-driven
   * contact triggers identically. Pushes the `attack` event, applies damage via
   * the caller's `defender.deal` sink, then on a *landed* hit fires:
   *   • attacker `onHit` — effect specs applied to the still-living defender (a
   *     venomous bite, a debuff). A player attacker stamps `sourceId` so a poison
   *     kill credits them; a mob's venom credits no one. Each hit stacks an
   *     independent instance, by design.
   *   • defender `onDamage` — the general "when struck" list (reflect, retaliate,
   *     draw mana off the blow). Each entry targets the `attacker` (default) or
   *     `self`, and fires only for a matching damage `source` (default melee).
   *     `spikes` is normalized into this list (see mobOnDamage/playerOnDamage).
   *     A reflected DoT credits the *defender* if it's a player (mirror of onHit).
   * `source` is the damage origin ("melee"); spells/ranged don't call this yet —
   * the `castSpell` path is where `on: ["spell"]` entries would later hook.
   * Returns { defenderDeath, attackerDeath } (each a death event or null) so the
   * caller can stop its swing loop and skip double-processing a death.
   */
  applyHitOutcome({ r, events, attackEvent, source = "melee", attacker, defender }) {
    events.push(attackEvent);
    let defenderDeath = defender.deal(r.damage); // damage + threat/kill (or respawn); pushes its own death event
    let attackerDeath = null;
    if (!r.hit) return { defenderDeath, attackerDeath };

    // Attacker onHit → the defender (only meaningful while it still lives).
    if (attacker.onHit && !defenderDeath) {
      for (const spec of attacker.onHit) {
        if (!this._rollChance(spec)) continue;
        this._applyTriggerEffect(events, spec, defender, defender.hurt, attacker.sourceId);
      }
    }

    // Defender onDamage → the attacker (reflect/retaliate) or self (mana-on-hit).
    // Reflect fires on contact regardless of whether the defender has an attack of
    // its own, and even on the blow that kills it.
    for (const entry of defender.onDamage || []) {
      if (!(entry.on || ["melee"]).includes(source)) continue;
      if (!this._rollChance(entry)) continue;
      const toAttacker = (entry.target || "attacker") === "attacker";
      const target = toAttacker ? attacker : defender;
      // A defender-applied DoT on the attacker credits the defender if it's a player.
      const credit = toAttacker ? defender.sourceId : null;
      const death = this._applyTriggerEffect(events, entry, target, target.hurt, credit);
      if (death) { if (toAttacker) attackerDeath = attackerDeath || death; else defenderDeath = defenderDeath || death; }
    }
    return { defenderDeath, attackerDeath };
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
      const mobDef = { armour: mt.armour || 0, ward: mt.ward || 0, evasion: mt.evasion || 0 };
      const attrs = effectiveAttributes(w, p);
      const per = attrs.perception || 0;
      const attacker = {
        band: p.perception,
        hitBonus: per * HIT_PER_PERCEPTION,
        dmgBonus: spellScaleBonus(attrs, weapon.scale),
        crit: per * CRIT_PER_PERCEPTION,
      };
      const mobName = w.mobs[mob.template].name;
      const mobEmits = !!w.mobs[mob.template].emitsLight;
      // A dozing/resting mob is jolted awake the instant a delver strikes it —
      // the authored ambush payoff: free opening blows, then it fights back.
      if (this._rouse(mob)) events.push({ type: "mob-woke", roomId: p.location, mobId: mob.id, mobName, emitsLight: mobEmits, light: rt.light });
      // Stop swinging if the mob dies OR a spike reflect kills the player mid-loop.
      while (p.energy >= weapon.actionCost && mob.hp > 0 && p.hp > 0) {
        p.energy -= weapon.actionCost;
        const r = strike(attacker, mobDef, rt.light, weapon.dice, weapon.damageType || "physical");
        const attackEvent = {
          type: "attack", by: "player", attackerId: p.id, attackerName: p.name, roomId: p.location,
          targetId: mob.id, targetName: mobName, hit: r.hit, sighted: r.sighted,
          damage: r.damage, crit: r.crit, targetHp: Math.max(0, mob.hp - r.damage), targetMaxHp: mob.maxHp,
          light: rt.light, targetEmitsLight: mobEmits,
        };
        const { attackerDeath } = this.applyHitOutcome({
          r, events, attackEvent,
          attacker: {
            actor: p, kind: "player", id: p.id, name: p.name, emitsLight: false, roomId: p.location,
            onHit: weapon.onHit,
            sourceId: p.id, // a player-applied DoT credits them on the kill
            hurt: (dmg, cause) => this._hurtPlayer(p, dmg, events, { cause }), // reflect lands here
          },
          defender: {
            actor: mob, kind: "mob", id: mob.id, name: mobName, emitsLight: mobEmits,
            roomId: p.location, onDamage: mobOnDamage(mt),
            sourceId: null, // a mob defender's retaliatory DoT credits no one
            deal: (dmg) => {
              this._addThreat(mob, p.id, Math.max(1, dmg)); // attacking it earns its ire
              mob.hp -= dmg;
              if (mob.hp <= 0) { const d = this._killMob(mob, p); events.push(d); p.pending = null; return d; }
              return null;
            },
            hurt: (dmg, cause) => this._hurtMob(mob, p.location, dmg, events, { cause }), // self-damage onDamage (rare)
          },
        });
        if (attackerDeath) break; // a reflect killed the player — they've respawned away
      }
    }
  }

  /**
   * Resolve an immediate spell cast by a player at a mob. Spends mana, rolls the
   * target's Ward to (maybe) fizzle the whole spell, then applies the effect
   * primitive — today only `damage` (dice + scaling-attribute bonus). Hostile
   * spells earn the target's threat even when resisted. Returns a result the
   * caller narrates: { resisted } | { damage, killed, death }.
   *
   * Mana and target validation happen in the command handler; by here the cast
   * is committed. `events` is optional and used to push auto-retaliation events.
   */
  castSpell(player, spell, mob, events = []) {
    const w = this.world;
    const eff = spell.effect || {};
    player.mana = Math.max(0, (player.mana || 0) - (spell.manaCost || 0));

    const ward = w.mobs[mob.template].ward || 0;
    if (spell.hostile && ward > 0 && Math.random() < ward * WARD_RESIST_PER_POINT) {
      this._addThreat(mob, player.id, 1); // a fizzled bolt still draws its ire
      return { resisted: true };
    }

    const result = { resisted: false };
    if (eff.type === "damage") {
      const damage = Math.max(1, rollDice(eff.damage) + spellScaleBonus(effectiveAttributes(w, player), eff.scale));
      this._addThreat(mob, player.id, Math.max(1, damage));
      mob.hp -= damage;
      result.damage = damage;
      if (mob.hp <= 0) {
        result.killed = true;
        result.death = this._killMob(mob, player); // removes mob, drops loot/shards, awards xp
      }
    } else if (spell.hostile) {
      this._addThreat(mob, player.id, 1);
    }
    // A kill may remove a luminous mob; refresh the room's light either way.
    this.rooms[player.location].light = this.computeRoomLight(player.location);

    // A hostile spell rouses a resting mob just as a blow does (only if it survived).
    if (spell.hostile && mob.hp > 0 && this._rouse(mob)) {
      const t = w.mobs[mob.template];
      events.push({ type: "mob-woke", roomId: player.location, mobId: mob.id, mobName: t.name, emitsLight: !!t.emitsLight, light: this.rooms[player.location].light });
    }

    // Auto-retaliate on hostile spell: if the player isn't already attacking something, target this mob
    if (spell.hostile && !player.pending && player.hp > 0 && mob.hp > 0) {
      player.pending = { type: "attack", targetId: mob.id };
      const t = w.mobs[mob.template];
      events.push({ type: "combat-auto-start", playerId: player.id, targetId: mob.id, targetName: t.name });
    }

    return result;
  }

  /** Each mob takes at most one weighted action per tick (attack/emote/flee/idle). */
  resolveMobAI(events) {
    for (const [roomId, rt] of Object.entries(this.rooms)) {
      for (const m of [...rt.mobs]) {
        if (RESTING(m)) continue; // a sitting/sleeping mob is inert until struck (see _rouse)
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
    let playersHere = this.playersIn(roomId).filter((p) => p.hp > 0);

    // A hidden lurker is inert toward anyone who hasn't searched it out (reveal-on-
    // find, no ambush): only delvers who have revealed it perceive — and provoke — it.
    if (m.hidden) {
      playersHere = playersHere.filter((p) => mobVisibleTo(this, p, m));
      if (playersHere.length === 0) return;
    }

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

    // Light-driven flight: a mob with a `flee` action bolts for a random exit the
    // instant the room light rises above its tolerance. This overrides its normal
    // action choice, even combat. With nowhere to run, it stands and acts as usual.
    const flee = (t.actions || []).find((a) => a.type === "flee" && rt.light > (a.lightAbove || 0));
    if (flee) {
      const dirs = wanderDirs(flee);
      if (dirs.length) return this._mobMove(m, t, roomId, events, flee.verb || "flees into the dark", dirs);
    }

    // A mob attacks if it's hostile, OR if it's been provoked (a neutral creature
    // that someone struck has live threat → it fights back), OR if the room light
    // has risen past its `lightAggro` tolerance (a calm creature roused by light —
    // the inverse of `flee`). Shopkeepers et al. carry no `attack` block, so they
    // stay passive even if hit. Note: above `flee`'s threshold, flight wins (it
    // returned earlier); lightAggro bites in the band between calm and flight.
    const lightProvoked = t.lightAggro && rt.light > (t.lightAggro.above || 0);
    const aggressive = t.hostile || inCombat || lightProvoked;

    let options;
    if (Array.isArray(t.actions) && t.actions.length) {
      options = t.actions.filter((a) => {
        if (a.type === "attack") return aggressive && t.attack && playersHere.length > 0;
        if (a.type === "wander") return !inCombat && wanderDirs(a).length > 0;
        if (a.type === "emote") return Array.isArray(a.messages) && a.messages.length > 0;
        return a.type === "idle";
      });
    } else {
      // Default behaviour for mobs without an actions table: attack if able.
      options = aggressive && t.attack && playersHere.length ? [{ type: "attack" }] : [];
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

  /** Award `xp` to everyone who earned a mob's death — the finisher (always, even
   *  if a remote DoT landed the blow) plus anyone with a threat entry who is still
   *  present and alive. Model A: each participant gets the FULL value (co-op, no
   *  division — grouping is rewarded, not taxed). Returns [{ playerId, levelUps }]
   *  so the caller can narrate the credit and broadcast any level-ups. */
  _awardKillXp(mob, primaryKiller, xp, roomId) {
    const out = [];
    const credited = new Set();
    if (primaryKiller) {
      out.push({ playerId: primaryKiller.id, levelUps: this.awardXp(primaryKiller, xp) });
      credited.add(primaryKiller.id);
    }
    for (const id of Object.keys(mob.aggro || {})) {
      if (credited.has(id)) continue;
      if (!(mob.aggro[id] > 0)) continue; // a hostile mob seeds 0-threat entries for everyone present (AI targeting); mere presence isn't participation — you must have traded blows
      const pl = this.players.get(id);
      if (!pl || pl.hp <= 0 || pl.location !== roomId) continue; // present and alive
      out.push({ playerId: id, levelUps: this.awardXp(pl, xp) });
      credited.add(id);
    }
    return out;
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
    const attacker = {
      band: t.perception,
      hitBonus: (t.attack.hitBonus) || 0, // a keen-eyed mob (data-driven, default 0)
      dmgBonus: (t.attack.bonus) || 0,
      crit: (t.attack.crit) || 0, // mirrors player crit; default 0 → no live change
    };
    const r = strike(attacker, playerDefence(this.world, target), rt.light, t.attack.damage, t.attack.type || "physical");
    const attackEvent = {
      type: "attack", by: "mob", attackerId: m.id, attackerName: t.name, roomId,
      targetId: target.id, targetName: target.name, hit: r.hit, sighted: r.sighted,
      damage: r.damage, crit: r.crit, targetHp: Math.max(0, target.hp - r.damage), targetMaxHp: target.maxHp,
      light: rt.light, attackerEmitsLight: !!t.emitsLight,
    };
    this.applyHitOutcome({
      r, events, attackEvent,
      attacker: {
        actor: m, kind: "mob", id: m.id, name: t.name, emitsLight: !!t.emitsLight, roomId,
        onHit: t.attack.onHit,
        sourceId: null, // a mob's venom credits no one
        // Reflect/retaliate lands on the mob; the struck player (if up) gets the credit.
        hurt: (dmg, cause) => this._hurtMob(m, roomId, dmg, events, { cause, killer: target.hp > 0 ? target : null }),
      },
      defender: {
        actor: target, kind: "player", id: target.id, name: target.name, emitsLight: false, roomId,
        onDamage: playerOnDamage(this.world, target), // player armour triggers (none seeded yet)
        sourceId: target.id, // a player's reflected DoT credits them
        deal: (dmg) => {
          target.hp -= dmg;
          if (target.hp <= 0) { const d = this._respawn(target, roomId); events.push(d); return d; }
          return null;
        },
        hurt: (dmg, cause) => this._hurtPlayer(target, dmg, events, { cause }), // self-damage onDamage (rare)
      },
    });

    // A blow rouses a resting target — you can't sleep through being hit. (A
    // sleeping delver is blind, so the first they know of a threat is this strike.)
    if (target.hp > 0 && this._rouse(target)) events.push({ type: "player-woke", playerId: target.id });

    // Auto-retaliate: if the player isn't already attacking something, target this mob
    if (!target.pending && target.hp > 0) {
      target.pending = { type: "attack", targetId: m.id };
      events.push({ type: "combat-auto-start", playerId: target.id, targetId: m.id, targetName: t.name });
    }
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

  /**
   * Drop a slain mob's loot roll and shard roll onto `roomId`'s floor; returns
   * the list of names dropped (shards as "N shards"). Shards merge into an
   * existing pile rather than littering separate stacks. Shared by every death
   * path — a direct kill, the room itself, a bleed tick.
   */
  _dropSpoils(mob, roomId) {
    const t = this.world.mobs[mob.template];
    const rt = this.rooms[roomId];
    const dropped = [];
    for (const l of t.loot || []) {
      if (Math.random() < l.chance) {
        rt.items.push(makeItemInstance({ template: l.template }, this.world));
        dropped.push(this.world.items[l.template].name);
      }
    }
    if (t.shards) {
      const shards = rollDice(t.shards);
      if (shards > 0) {
        const pile = rt.items.find((i) => i.template === "shards");
        if (pile) pile.qty = (pile.qty || 1) + shards;
        else rt.items.push(makeItemInstance({ template: "shards", qty: shards }, this.world));
        dropped.push(`${shards} shards`);
      }
    }
    return dropped;
  }

  /** A direct kill by a player (melee/spell): removes the mob, drops spoils, and
   *  awards xp to the killer. Non-combat deaths go through `_hurtMob` instead. */
  _killMob(mob, killer) {
    const t = this.world.mobs[mob.template];
    const roomId = killer.location;
    const idx = this.rooms[roomId].mobs.indexOf(mob);
    if (idx >= 0) this.rooms[roomId].mobs.splice(idx, 1);
    this._adjustOwned(mob, -1);
    const loot = this._dropSpoils(mob, roomId);
    const xp = t.xp || 0;
    const participants = this._awardKillXp(mob, killer, xp, roomId); // shared credit (Model A)
    return { type: "death", victimKind: "mob", victimId: mob.id, victimName: t.name, roomId, killerId: killer.id, loot, xp, cause: "hit", participants };
  }

  /**
   * Apply `amount` damage to a mob from a source that isn't a direct hit — the
   * room itself (light-bane), a bleed tick, etc. Pushes a `mob-hurt` event tagged
   * with `cause`; on death drops spoils where the mob stands and pushes a `death`
   * event. XP is credited only when a `killer` player is named (pure environment
   * rewards no one). This is the shared "killed by something else" path. Returns
   * the death event, or null if the mob survives.
   */
  _hurtMob(mob, roomId, amount, events, opts = {}) {
    const { cause = "hit", killer = null } = opts;
    const t = this.world.mobs[mob.template];
    const rt = this.rooms[roomId];
    mob.hp -= amount;
    events.push({ type: "mob-hurt", roomId, mobId: mob.id, mobName: t.name, cause, damage: amount, mobHp: Math.max(0, mob.hp), emitsLight: !!t.emitsLight, light: rt.light });
    if (mob.hp > 0) return null;
    const idx = rt.mobs.indexOf(mob);
    if (idx >= 0) rt.mobs.splice(idx, 1);
    this._adjustOwned(mob, -1);
    const loot = this._dropSpoils(mob, roomId);
    const xp = t.xp || 0;
    const participants = killer ? this._awardKillXp(mob, killer, xp, roomId) : []; // shared credit (Model A)
    rt.light = this.computeRoomLight(roomId); // a luminous mob dying changes the room
    const death = { type: "death", victimKind: "mob", victimId: mob.id, victimName: t.name, roomId, killerId: killer ? killer.id : null, loot, xp: killer ? xp : 0, cause, participants };
    events.push(death);
    return death;
  }

  /** Apply `amount` non-combat damage to a player (a bleed tick, the room). Pushes
   *  a `player-hurt` event; routes death through the usual rim respawn. Returns the
   *  death event, or null if the player survives. */
  _hurtPlayer(player, amount, events, opts = {}) {
    const { cause = "hit" } = opts;
    player.hp -= amount;
    events.push({ type: "player-hurt", playerId: player.id, cause, damage: amount, hp: Math.max(0, player.hp), maxHp: player.maxHp });
    if (player.hp <= 0) {
      const death = this._respawn(player, player.location);
      events.push(death);
      return death;
    }
    return null;
  }

  /** Environmental damage: any mob whose `lightBane.above` is exceeded by its
   *  room's light is seared this tick. Credits the top-threat player present (a
   *  kill the player engineered with light) — otherwise it is pure environment. */
  _environmentTick(events) {
    for (const [roomId, rt] of Object.entries(this.rooms)) {
      const playersHere = this.playersIn(roomId).filter((p) => p.hp > 0);
      for (const m of [...rt.mobs]) {
        const lb = this.world.mobs[m.template].lightBane;
        if (!lb || rt.light <= (lb.above || 0)) continue;
        const dmg = Math.max(1, rollDice(lb.damage));
        this._hurtMob(m, roomId, dmg, events, { cause: "light", killer: this._topThreat(m, playersHere) });
      }
    }
  }

  /** Player death (v1): respawn at the rim, full HP, no penalty beyond progress. */
  _respawn(player, deathRoom) {
    const start = this.world.playerTemplate.startLocation;
    player.hp = player.maxHp;
    this.setPlayerLocation(player, start);
    player.pending = null;
    player.energy = 0;
    this.rooms[start].light = this.computeRoomLight(start);
    this.rooms[deathRoom].light = this.computeRoomLight(deathRoom);
    return { type: "death", victimKind: "player", victimId: player.id, victimName: player.name, roomId: deathRoom, respawnRoom: start };
  }
}

module.exports = { GameState, makeItemInstance, makeMobInstance, actorEmitLight, playerDefence, buyValueOf, sellValueOf, SELL_RATE, itemVisibleTo, fixtureVisibleTo, mobVisibleTo, effectivePerception, canPerceive, isDiscovered, discoveryKey, xpForLevel };
