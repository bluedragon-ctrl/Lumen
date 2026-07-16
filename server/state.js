"use strict";
const { effectiveLight } = require("./light");
const { rollDice } = require("./dice");
const { POINTS_PER_LEVEL, DEATH_DELAY_TICKS, DEFAULT_HIDDEN_ITEM_RESPAWN, DEFAULT_MOB_SPEED, ENERGY_BANK_ACTIONS } = require("./config");
const { tidePhaseAt, resolveTide } = require("./world-clock");
// Pure helpers split out of this file (see PR refactor/split-state-helpers).
// Imported here and re-exported below so the public surface stays unchanged.
const {
  xpForLevel, MELEE_SCALE, weaponOf,
  HP_BASE, HP_PER_LEVEL, HP_PER_VITALITY, MANA_PER_INTELLECT, ATTR_BASELINE, SIGHT_PER_PERCEPTION,
  HIT_PER_PERCEPTION, CRIT_PER_PERCEPTION,
  effectiveAttributes, playerDefence, effectiveSpeed, mobDefence,
  spellScaleBonus, durationScaleBonus,
  roomEffectFires, strike,
} = require("./combat-math");
const { SELL_RATE, buyValueOf, sellValueOf } = require("./economy");
const { entityId, ensureIdAbove, makeItemInstance, addToFloor, makeMobInstance } = require("./instances");
const {
  canPerceive, actorEmitLight, discoveryKey, isDiscovered, effectivePerception,
  itemVisibleTo, fixtureVisibleTo, mobVisibleTo,
} = require("./perception");

// Rest recovery: a resting actor regains 1 HP and 1 MP every N ticks. Sitting is
// the lighter rest; sleeping the deeper (and blinding) one. Standing never regains
// HP (only the slow innate mana trickle). Posture is a shared actor concept —
// players use it for recovery + social; mobs use it to author dozing/resting NPCs.
const SIT_RECOVER_TICKS = 5;
const SLEEP_RECOVER_TICKS = 2;
const RESTING = (actor) => actor.posture === "sitting" || actor.posture === "sleeping";
// Ambient-emote, aggro-detection, grudge, and cross-room-pursuit tuning constants
// moved to state-mobai.js, alongside the methods that read them.

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
    this.revealedItems = new Map(); // playerId -> Set(item runtime id); ephemeral hidden-item reveals (forgotten on leave)
    this.ownedCounts = new Map(); // `${roomId}|${mob}` -> living mobs from that spawner (see _countOwned)
    // The Tide (world-clock.js): the resolved config (data/world/tide.json merged
    // over DEFAULT_TIDE), and the world's current phase, derived from `tick` each
    // tick. `tideOverride` pins it for admin testing (@tide), bypassing the clock.
    // Both set before _initRooms so the first light computation sees the phase.
    this.tide = resolveTide(world);
    this.tidePhase = this.tide.enabled
      ? tidePhaseAt(this.tick, this.tide.phaseTicks, this.tide.phases).phase
      : this.tide.phases[0] || "calm";
    this.tideOverride = null;
    this._initRooms();
    this._initSchedule(); // timed events (visiting trader, …) — see state-scheduler.js
  }

  _initRooms() {
    // Spawners drive repop: each remembers its room, mob, population cap, and a
    // countdown. A rule without `respawn` is static (spawned once, never refills).
    this.spawners = [];
    // Harvesters regrow a picked-up floor item after a delay (mushrooms, seeps,
    // …). A groundItem without `respawn` is static (placed once, gone when
    // taken) — UNLESS it's `hidden` (a searched-out find), which falls back to
    // DEFAULT_HIDDEN_ITEM_RESPAWN so searchable items always regrow eventually;
    // a room's own `respawn` still overrides that default either way.
    this.harvesters = [];
    for (const [id, room] of Object.entries(this.world.rooms)) {
      this.rooms[id] = { mobs: [], items: [], fixtures: [], light: room.ambientLight || 0 };
      for (const g of room.groundItems || []) {
        const inst = makeItemInstance(g, this.world);
        const respawn = g.respawn != null ? g.respawn : (g.hidden ? DEFAULT_HIDDEN_ITEM_RESPAWN : null);
        if (respawn != null) {
          inst.origin = { roomId: id, template: g.template, harvest: true }; // tags it for regrow tracking
          this.harvesters.push({ roomId: id, template: g.template, qty: g.qty != null ? g.qty : 1, respawn, timer: respawn, hidden: g.hidden });
        }
        if (g.hidden) inst.hidden = g.hidden; // a stashed item — unseen until searched out, and re-hidden on leave
        this.rooms[id].items.push(inst);
      }
      for (const f of room.fixtures || []) {
        // A fixture entry is a template string, or an object `{ template, hidden }`.
        const tmplId = typeof f === "string" ? f : f.template;
        const inst = { id: entityId("fixture"), template: tmplId };
        const ft = this.world.fixtures[tmplId];
        if (ft && ft.switch) inst.on = !!ft.switch.on; // switchable fixtures carry on/off state
        if (ft && ft.door) inst.open = !!ft.door.open; // door fixtures carry open/shut state
        if (ft && (ft.mine || ft.fish || ft.harvest)) { const res = ft.mine || ft.fish || ft.harvest; inst.charges = res.charges; inst.regrow = res.respawn; } // resource veins/pools/beds deplete as worked
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

  /** A skittish prey mob slips out of the world — no corpse, loot, or XP, just a
   *  `mob-flee` tell. Unlike a summon's dismissal this frees its spawner slot
   *  (`_adjustOwned(-1)`) so the bed repops on the normal timer. Called from the
   *  skittish branch in `_mobAct`. */
  _bolt(m, t, roomId, events, verb) {
    const rt = this.rooms[roomId];
    const idx = rt.mobs.indexOf(m);
    if (idx < 0) return;
    rt.mobs.splice(idx, 1);
    m.hp = 0; // mark gone for any lingering reference
    this._adjustOwned(m, -1); // free the spawn slot — it repops on the room's timer
    rt.light = this.computeRoomLight(roomId);
    events.push({ type: "mob-flee", roomId, mobName: t.name, emitsLight: t.emitsLight > 0, light: rt.light, verb: verb || "slips out of sight" });
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
      events.push({ type: "mob-spawn", roomId: sp.roomId, mobId: m.id, mobTemplate: sp.mob, mobName: t.name, emitsLight: t.emitsLight > 0, light });
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
      if (hv.hidden) inst.hidden = hv.hidden; // regrow into hiding, same as its authored state — still requires a search
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
        const res = ft && (ft.mine || ft.fish || ft.harvest);
        if (!res) continue;
        if (f.charges >= res.charges) { f.regrow = res.respawn; continue; }
        if (--f.regrow > 0) continue;
        f.charges = res.charges;
        f.regrow = res.respawn;
        events.push({ type: "vein-recover", roomId, fixtureName: ft.name, kind: ft.fish ? "fish" : ft.harvest ? "growth" : "ore" });
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

  /** The strength of the light a player carries: the greater of their equipped
   *  light-slot source's output (whether or not it is currently lit — they can
   *  strike it) and any active carried Light effect (Candlelight, Halo, a potion).
   *  0 if they carry nothing. Used by NPC react conditions (`carriedLightBelow`) to
   *  judge whether a delver is fit to face the Tide's dark. */
  _carriedLightOutput(player) {
    let out = 0;
    const li = player.equipment && player.equipment.light;
    if (li) {
      const t = this.world.items[li.template];
      out = (t && t.light && t.light.output) || 0;
    }
    const e = actorEmitLight(player); // a spell/potion Light effect glows even with no lamp
    return e > out ? e : out;
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
    return effectiveLight(room.ambientLight + this.tideOffsetFor(roomId), outputs);
  }

  /** Bonus max HP from equipped gear (`armour.maxHp`) — lets heavy armour add
   *  raw durability on top of Vitality. Summed across every equipped slot, so it
   *  is folded into `deriveStats` and refreshed whenever gear changes. */
  _equipHpBonus(player) {
    let bonus = 0;
    for (const inst of Object.values(player.equipment || {})) {
      if (!inst) continue;
      const t = this.world.items[inst.template];
      if (t && t.armour && t.armour.maxHp) bonus += t.armour.maxHp;
    }
    return bonus;
  }

  /** Bonus max HP from active *fortify* buffs — a timed `maxHp` carried on a
   *  status (e.g. a stiff drink that toughens as it emboldens). Unlike a
   *  Vitality attr-buff this actually lifts the pool, because pools derive from
   *  BASE attributes; folded into `deriveStats`, granted on apply and clamped on
   *  expiry (see applyEffect / _refreshMaxHp). Player-only. */
  _stateHpBonus(player) {
    let bonus = 0;
    for (const s of player.states || []) if (s.maxHp) bonus += s.maxHp;
    return bonus;
  }

  /** Bonus max Mana from equipped gear (`armour.maxMana`) — e.g. an Umbral
   *  glimmer-ring that deepens a caster's well. Summed across every equipped
   *  slot and folded into `deriveStats`, refreshed whenever gear changes. */
  _equipManaBonus(player) {
    let bonus = 0;
    for (const inst of Object.values(player.equipment || {})) {
      if (!inst) continue;
      const t = this.world.items[inst.template];
      if (t && t.armour && t.armour.maxMana) bonus += t.armour.maxMana;
    }
    return bonus;
  }

  /** The standing mana-regen rate for a player: the template's global trickle plus
   *  any bonus from equipped gear (`armour.manaRegen`, e.g. a glimmersteel coil).
   *  Summed across every slot and folded into `deriveStats`, refreshed whenever
   *  gear changes — so the base stays a tuning constant while gear can deepen it. */
  manaRegenFor(player) {
    let bonus = 0;
    for (const inst of Object.values(player.equipment || {})) {
      if (!inst) continue;
      const t = this.world.items[inst.template];
      if (t && t.armour && t.armour.manaRegen) bonus += t.armour.manaRegen;
    }
    return (this.world.playerTemplate.manaRegen || 0) + bonus;
  }

  /**
   * Recompute a player's derived stats from their attributes (DESIGN.md §3.2):
   * max HP (flat base + per-level grant + Vitality + gear), max Mana (Intellect),
   * the standing mana-regen rate (global trickle + gear), and the low-light sight
   * band (Perception). Idempotent — always derived from `level`/`attributes`/gear
   * plus the template's perception band as the baseline-at-3 anchor, so it is safe
   * to re-run on every admit and whenever level/gear change. Innate Ward/evasion
   * (Wits), to-hit/crit (Perception), and melee damage (Might) are applied live at
   * combat time, not stored here. Does NOT touch current hp/mana — callers clamp.
   */
  deriveStats(player) {
    const a = player.attributes || {};
    player.maxHp = HP_BASE + ((player.level || 1) - 1) * HP_PER_LEVEL + (a.vitality || 0) * HP_PER_VITALITY + this._equipHpBonus(player) + this._stateHpBonus(player);
    player.maxMana = (a.intellect || 0) * MANA_PER_INTELLECT + this._equipManaBonus(player);
    player.manaRegen = this.manaRegenFor(player);
    const band = this.world.playerTemplate.perception || { blindBelow: 1, dimBelow: 3, harmedAbove: 9 };
    const sight = Math.floor(((a.perception || 0) - ATTR_BASELINE) / SIGHT_PER_PERCEPTION);
    const dimBelow = Math.max(band.blindBelow, band.dimBelow - sight);
    player.perception = { blindBelow: band.blindBelow, dimBelow, harmedAbove: band.harmedAbove };
  }

  /** Turn a fortify buff's max-HP change into a health change. On a rise (the
   *  buff applies) grant the new capacity as current HP, like a level-up; on a
   *  fall (the buff lapses) clamp current HP back down. deriveStats itself never
   *  touches hp — this is the one caller that does, for the fortify path.
   *  Player-only; mobs read a static template maxHp. */
  _refreshMaxHp(player) {
    const prev = player.maxHp;
    this.deriveStats(player);
    if (player.maxHp > prev) player.hp += player.maxHp - prev;
    else if (player.hp > player.maxHp) player.hp = player.maxHp;
  }

  /** Credit `amount` lifetime XP to a player and resolve any level-ups it
   *  crosses. Mutates `xp`, `level` and `unspentPoints`; returns one
   *  `{ level, points }` per level gained (a big award can cross several). The
   *  caller narrates/broadcasts these (see events.js `level-up` handling). */
  awardXp(player, amount) {
    player.xp = (player.xp || 0) + (amount || 0);
    const ups = [];
    while (player.xp >= xpForLevel((player.level || 1) + 1)) {
      player.level = (player.level || 1) + 1;
      player.unspentPoints = (player.unspentPoints || 0) + POINTS_PER_LEVEL;
      const prevHp = player.maxHp;
      this.deriveStats(player); // each level lifts maxHp (HP_PER_LEVEL) for every build
      if (player.maxHp > prevHp) player.hp += player.maxHp - prevHp; // grant the new capacity, like training
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
      quests: { active: {}, done: [] }, // quest log: in-progress cursors + finished ids (see quests.js)
      aliases: {}, // F-key shortcuts: { "F1": "cast spark", … } — set via the `alias` command
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
    // Quest log added later: backfill the container so older saves can take quests.
    if (!player.quests || typeof player.quests !== "object") player.quests = { active: {}, done: [] };
    if (!player.quests.active || typeof player.quests.active !== "object") player.quests.active = {};
    if (!Array.isArray(player.quests.done)) player.quests.done = [];
    if (player.unspentPoints == null) player.unspentPoints = 0; // banked attribute points (leveling added later)
    // Explore XP added later: seed with the current room so a pre-existing delver
    // isn't paid for re-treading ground, then earns from the next new room on.
    if (!Array.isArray(player.visitedRooms)) player.visitedRooms = [player.location];
    // F-key alias map added later: backfill so older saves can take bindings.
    if (!player.aliases || typeof player.aliases !== "object") player.aliases = {};
    // Posture always resets to standing on login — a delver wakes up when they
    // reconnect, so a save can't strand them blind and asleep.
    player.posture = "standing";
    player.restTicks = 0;
    // A delver who disconnected mid-fall finishes dying on login: they wake whole at
    // the rim rather than loading back into the dark, frozen at zero HP.
    if (player.dying != null || player.hp <= 0) {
      player.dying = null;
      player.deathRoom = null;
      player.hp = player.maxHp;
      player.location = this.world.playerTemplate.startLocation;
      player.states = (player.states || []).filter((s) => s.source === "item");
      for (const inst of [...Object.values(player.equipment || {}), ...(player.inventory || [])])
        if (inst && inst.lit) inst.lit = false;
    }
    if (player.maxMana == null) player.maxMana = this.world.playerTemplate.maxMana;
    if (player.mana == null) player.mana = player.maxMana;
    player.hp = Math.min(player.hp, player.maxHp);
    player.mana = Math.min(player.mana, player.maxMana);
    // manaRegen's base is a global tuning constant (not per-character progress), so
    // always re-derive it — tuning changes then apply to existing saves too — adding
    // any bonus from gear worn into the session (e.g. a glimmersteel coil).
    player.manaRegen = this.manaRegenFor(player);
    // Admin always knows every recipe — handy for testing. Re-synced on each
    // login, so recipes added to the world after the admin save are picked up.
    if (player.isAdmin) player.knownRecipes = Object.keys(this.world.recipes);
    this.players.set(player.id, player);
    this._indexPlayer(player); // location is final by here — add to the occupancy index
    return player;
  }

  removePlayer(playerId) {
    const player = this.players.get(playerId);
    const events = [];
    if (player) {
      this._dismissOwnedSummons(player.id, "owner-gone", events); // disconnect unravels summons
      this._deindexPlayer(player);
    }
    this.players.delete(playerId);
    this.revealedMobs.delete(playerId); // drop ephemeral hidden-mob reveals on disconnect
    this.revealedItems.delete(playerId); // …and any unpicked hidden-item reveals
    return events;
  }

  /** Forget a player's ephemeral hidden-feature reveals — both lurking mobs and
   *  unpicked stashed items re-hide (e.g. on leaving a room). */
  clearRevealedMobs(playerId) {
    this.revealedMobs.delete(playerId);
    this.revealedItems.delete(playerId);
  }

  /** Reveal an ephemeral hidden item to a player (a search find, or shared with a
   *  co-located delver). Returns true if it was newly revealed. */
  _revealItemTo(player, instId) {
    let set = this.revealedItems.get(player.id);
    if (!set) { set = new Set(); this.revealedItems.set(player.id, set); }
    if (set.has(instId)) return false;
    set.add(instId);
    return true;
  }

  /** Reveal an ephemeral hidden mob (lurker) to a player. Returns true if new. */
  _revealMobTo(player, mobId) {
    let set = this.revealedMobs.get(player.id);
    if (!set) { set = new Set(); this.revealedMobs.set(player.id, set); }
    if (set.has(mobId)) return false;
    set.add(mobId);
    return true;
  }

  /** Record a lasting secret (fixture/exit discovery key) on a player, permanently.
   *  Returns true if it was newly discovered for them. */
  _recordDiscovery(player, key) {
    if (!Array.isArray(player.discovered)) player.discovered = [];
    if (player.discovered.includes(key)) return false;
    player.discovered.push(key);
    return true;
  }

  /**
   * `search` the current room: reveal every hidden feature whose requirement is met
   * by the player's effective Perception (attribute × light tier — so light matters).
   * Lasting secrets (fixtures/exits) are recorded permanently on `player.discovered`;
   * hidden items and mobs are revealed ephemerally (this visit only — a stashed item
   * you leave behind must be searched out anew).
   *
   * A find is *shared*: the searcher points it out, so every co-located delver gets
   * the same reveal too — ignoring their own Perception (they're being shown it).
   * `shared` reports whether that propagation revealed anything new to someone else,
   * so the caller can refresh their room view even when the searcher turned up
   * nothing new. Returns { found, any, shared }.
   */
  search(player) {
    const roomId = player.location;
    const room = this.world.rooms[roomId];
    const rt = this.rooms[roomId];
    const eff = effectivePerception(this.world, player, rt.light);
    if (!Array.isArray(player.discovered)) player.discovered = [];
    const found = [];
    const others = this.playersIn(roomId).filter((p) => p.id !== player.id);
    let shared = false;
    const shareItem = (id) => { for (const o of others) if (this._revealItemTo(o, id)) shared = true; };
    const shareMob = (id) => { for (const o of others) if (this._revealMobTo(o, id)) shared = true; };
    const shareKey = (key) => { for (const o of others) if (this._recordDiscovery(o, key)) shared = true; };

    for (const inst of rt.items) {
      if (!inst.hidden || inst.hidden.perception > eff) continue;
      if (this._revealItemTo(player, inst.id)) found.push(this.world.items[inst.template].name);
      shareItem(inst.id);
    }
    for (const inst of rt.fixtures) {
      if (!inst.hidden || inst.hidden.perception > eff) continue;
      if (this._recordDiscovery(player, inst.discoveryKey)) found.push(this.world.fixtures[inst.template].name);
      shareKey(inst.discoveryKey);
    }
    for (const [dir, h] of Object.entries(room.hiddenExits || {})) {
      if ((h.perception || 0) > eff) continue;
      const key = discoveryKey(roomId, "exit", dir);
      if (this._recordDiscovery(player, key)) found.push(h.name || `a passage ${dir}`);
      shareKey(key);
    }
    for (const m of rt.mobs) {
      if (!m.hidden || m.hidden.perception > eff) continue;
      if (this._revealMobTo(player, m.id)) found.push(this.world.mobs[m.template].name);
      shareMob(m.id);
    }
    return { found, any: found.length > 0, shared };
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

  /** Rouse a resting mob and announce the waking (`mob-woke`), if it was in fact
   *  resting. The one place every hostile contact — a swing, a spell, a blast —
   *  jolts a sleeper awake from. */
  _rouseMob(mob, roomId, events) {
    if (!this._rouse(mob)) return;
    const t = this.world.mobs[mob.template];
    events.push({ type: "mob-woke", roomId, mobId: mob.id, mobName: t.name, emitsLight: t.emitsLight > 0, light: this.rooms[roomId].light });
  }

  /** Commit a player to swinging at `mob` unless they're already engaged, with the
   *  `combat-auto-start` tell. The shared auto-retaliate: a hostile cast sticks the
   *  caster to the target, a mob's blow turns its victim on it (_rouseAndRetaliate). */
  _autoEngage(player, mob, events) {
    if (player.pending) return;
    player.pending = { type: "attack", targetId: mob.id };
    events.push({ type: "combat-auto-start", playerId: player.id, targetId: mob.id, targetName: this.world.mobs[mob.template].name });
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

    this._tideTick(events); // the world clock: darken/brighten the world on phase changes
    if (this._isDarkPhase(this.tidePhase)) this._tideCreepTick(events); // the dark grows teeth: shadows born beside delvers in failed light
    if (this.tide.enabled) this._tideEmoteTick(events); // ambient Tide flavour for the current phase
    this._dyingTick(events); // fallen delvers count down to waking at the rim (death pacing)

    for (const p of this.players.values()) {
      // heavy gear (speedPenalty) and any active `slow` debuff both drag the rate a
      // delver banks action-energy; floored at 1 so movement never fully stalls.
      const sp = Math.max(1, effectiveSpeed(this.world, p) - this.slowAmount(p));
      p.energy = Math.min(p.energy + sp, sp * ENERGY_BANK_ACTIONS);
      this._recoverTick(p, events);
    }
    for (const rt of Object.values(this.rooms)) {
      for (const m of rt.mobs) {
        const base = this.world.mobs[m.template].speed || DEFAULT_MOB_SPEED;
        // A slowed mob (a vine-whip's lash) accrues energy — and so acts — slower.
        const speed = Math.max(1, base - this.slowAmount(m));
        m.energy = Math.min((m.energy || 0) + speed, speed * ENERGY_BANK_ACTIONS);
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
          // A non-refuellable light (a torch) is spent for good when it burns out —
          // there's nothing to refill, so the husk just clutters the slot. Consume it.
          const consumed = !(tmpl.light && tmpl.light.fuelItem);
          if (consumed) p.equipment.light = null;
          events.push({ type: "light-out", playerId: p.id, item: li.template, consumed });
        } else if (this.tick % 10 === 0) {
          // Fuel ticks down every tick, but the gauge only refreshes when the player
          // view is re-sent (on move, vitals, etc.). Nudge it periodically so an idle
          // player still watches their light burn down rather than jumping at the end.
          events.push({ type: "vitals", playerId: p.id });
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
    this._roomEffectsTick(events); // per-tick room effects (regen, darkness drain), same fresh light
    this.resolvePlayerAttacks(events);
    this.resolveMobAI(events);
    this._recoverMobsTick(events); // wounded, disengaged mobs knit their wounds (post-AI: aggro is freshly pruned)
    this._respawnTick(events);
    this._scheduleTick(events); // timed events: visiting NPCs arrive/leave, etc.
    this._harvestTick(events);
    this._summonTick(events);
    this._mineTick(events);
    return events;
  }

  /** Narrate a status effect taking hold on an actor (player or mob). `effectType`
   *  lets the renderer word a non-standard status (e.g. an `immobilize` grip) that
   *  the generic "the X takes hold" line doesn't fit. */
  _narrateEffectApplied(events, who, name, effectType) {
    if (who.kind === "mob")
      events.push({ type: "mob-effect-applied", roomId: who.roomId, mobId: who.id, mobName: who.name, name, effectType, emitsLight: who.emitsLight, light: this.rooms[who.roomId].light });
    else
      events.push({ type: "effect-applied", playerId: who.id, name, effectType });
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
    this._narrateEffectApplied(events, target, s.name || s.type, s.type);
    return null;
  }

  /**
   * Process the outcome of one resolved **melee** swing, for either direction
   * (player→mob or mob→player), from a single place so both get the uniform
   * `attack` event and the data-driven contact triggers identically. Builds the
   * event from the two descriptors (attacker/defender each carry actor, kind,
   * id, name, emitsLight, roomId), then routes the result: a miss calls
   * `defender.provoke` (when the descriptor has one) — a swing provokes its
   * target even when it lands nothing, so flailing in the dark still draws a
   * creature's ire — while a landed hit deals damage via `defender.deal` (the
   * shared damage sink) and fires:
   *   • attacker `onHit` — effect specs applied to the still-living defender (a
   *     venomous bite, a debuff). A player attacker stamps `sourceId` so a poison
   *     kill credits them; a mob's venom credits no one. Each hit stacks an
   *     independent instance, by design.
   *   • defender `onDamage` — the general "when struck" list (reflect, retaliate,
   *     draw mana off the blow). Each entry targets the `attacker` (default) or
   *     `self`, and fires only for a matching damage `source` (default melee).
   *     `spikes` is normalized into this list (see mobOnDamage/playerOnDamage).
   *     A reflected DoT credits the *defender* if it's a player (mirror of onHit).
   * A trigger only ever lands on a side still standing: a defender's reflect
   * fires even on the blow that kills it, but once either side is down no
   * further trigger strikes that corpse (a second "kill" would double-run the
   * death path). `source` is the damage origin ("melee"); spells/ranged don't
   * call this yet — the `castSpell` path is where `on: ["spell"]` entries would
   * later hook. Returns { defenderDeath, attackerDeath } (each a death event or
   * null) so the caller can stop its swing loop and skip double-processing a death.
   */
  applyHitOutcome({ r, events, source = "melee", attacker, defender }) {
    events.push({
      type: "attack", by: attacker.kind, attackerId: attacker.id, attackerName: attacker.name,
      roomId: defender.roomId, targetId: defender.id, targetName: defender.name, targetKind: defender.kind,
      hit: r.hit, sighted: r.sighted, damage: r.damage, crit: r.crit, damageType: r.damageType,
      targetHp: Math.max(0, defender.actor.hp - r.damage),
      light: this.rooms[defender.roomId].light,
      attackerEmitsLight: attacker.emitsLight, targetEmitsLight: defender.emitsLight,
    });
    let attackerDeath = null;
    if (!r.hit) {
      if (defender.provoke) defender.provoke(); // a whiffed swing still draws the target's ire
      return { defenderDeath: null, attackerDeath };
    }
    let defenderDeath = defender.deal(r.damage); // damage + threat + kill via the shared sink; pushes its own death event

    // Attacker onHit → the defender by default (venom, a debuff), but an entry marked
    // `target: "self"` (or "attacker") lands on the attacker instead — life-steal: a
    // blade that heals its wielder on a landed hit (the mirror of onDamage's target
    // axis). Self-target fires even on a killing blow (you drink life as you cut) —
    // but a blood-price effect can also kill the wielder, so its death is captured.
    if (attacker.onHit) {
      for (const spec of attacker.onHit) {
        if (!this._rollChance(spec)) continue;
        if (spec.target === "self" || spec.target === "attacker") {
          if (attackerDeath) continue; // already down — nothing left to pay or drink
          attackerDeath = this._applyTriggerEffect(events, spec, attacker, attacker.hurt, null);
        } else if (!defenderDeath) {
          this._applyTriggerEffect(events, spec, defender, defender.hurt, attacker.sourceId);
        }
      }
    }

    // Defender onDamage → the attacker (reflect/retaliate) or self (mana-on-hit).
    // Reflect fires on contact regardless of whether the defender has an attack of
    // its own, and even on the blow that kills it — only a target already down is
    // skipped (see the corpse rule in the doc above).
    for (const entry of defender.onDamage || []) {
      if (!(entry.on || ["melee"]).includes(source)) continue;
      const toAttacker = (entry.target || "attacker") === "attacker";
      if (toAttacker ? attackerDeath : defenderDeath) continue;
      if (!this._rollChance(entry)) continue;
      const target = toAttacker ? attacker : defender;
      // A defender-applied DoT on the attacker credits the defender if it's a player.
      const credit = toAttacker ? defender.sourceId : null;
      const death = this._applyTriggerEffect(events, entry, target, target.hurt, credit);
      if (death) { if (toAttacker) attackerDeath = death; else defenderDeath = death; }
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
      const attrs = effectiveAttributes(w, p);
      const per = attrs.perception || 0;
      const swing = {
        band: p.perception,
        hitBonus: per * HIT_PER_PERCEPTION,
        dmgBonus: spellScaleBonus(attrs, weapon.scale),
        crit: per * CRIT_PER_PERCEPTION + (weapon.crit || 0),
      };
      // A dozing/resting mob is jolted awake the instant a delver strikes it —
      // the authored ambush payoff: free opening blows, then it fights back.
      this._rouseMob(mob, p.location, events);
      const attacker = {
        actor: p, kind: "player", id: p.id, name: p.name, emitsLight: false, roomId: p.location,
        onHit: weapon.onHit,
        sourceId: p.id, // a player-applied DoT credits them on the kill
        hurt: (dmg, cause) => this._hurtPlayer(p, dmg, events, { cause }), // reflect lands here
      };
      const defender = this._mobDefender(mob, mt, p.location, { id: p.id, kind: "player", actor: p }, events);
      // Stop swinging if the mob dies OR a spike reflect kills the player mid-loop.
      while (p.energy >= weapon.actionCost && mob.hp > 0 && p.hp > 0) {
        p.energy -= weapon.actionCost;
        // Defence is read fresh each swing, so a contact trigger from an earlier
        // swing this tick (an armour-shredding onHit, a spike buff) counts at once.
        const r = strike(swing, mobDefence(mt, mob), rt.light, weapon.dice, weapon.damageType || "physical");
        const { defenderDeath, attackerDeath } = this.applyHitOutcome({ r, events, attacker, defender });
        if (defenderDeath) p.pending = null; // quarry slain — stop swinging
        if (attackerDeath) break; // a reflect killed the player — they've respawned away
      }
    }
  }

  /**
   * THE mob damage sink: every point of damage a mob takes — a melee swing (the
   * defender descriptor's `deal`), a spell, a bleed tick, light-bane, a thrown
   * bomb — lands through here, so hp, threat and the kill can never drift apart
   * between paths. A kill resolves through the shared `_killMobAt` (removal,
   * spoils, XP, light, the `death` event — see state-mobai.js), with `killer`
   * credited as the finisher when a player is named. Options carry the two
   * things that genuinely vary by source:
   *   • `threatTo` — a combatant id to stoke `max(1, amount)` threat toward
   *     (the damage→threat convention, kept here so the minimum can't drift).
   *   • `silent` — skip the `mob-hurt` event when the caller's own swing/cast
   *     event or outcome line already narrates the blow.
   * Returns the death event (already pushed), or null if the mob survives.
   */
  _hurtMob(mob, roomId, amount, events, opts = {}) {
    const { cause = "hit", killer = null, threatTo = null, silent = false, damageType = null } = opts;
    if (threatTo != null) this._addThreat(mob, threatTo, Math.max(1, amount));
    mob.hp -= amount;
    if (!silent) {
      const t = this.world.mobs[mob.template];
      events.push({ type: "mob-hurt", roomId, mobId: mob.id, mobName: t.name, cause, damage: amount, damageType, mobHp: Math.max(0, mob.hp), emitsLight: t.emitsLight > 0, light: this.rooms[roomId].light });
    }
    if (mob.hp > 0) return null;
    const death = this._killMobAt(mob, roomId, killer, cause);
    events.push(death);
    return death;
  }

  /** The player damage sink: every point of damage a player takes — a mob's swing
   *  (the defender descriptor's `deal`), a spell, a bleed tick, the room — lands
   *  through here; death routes through the usual rim respawn (`_beginDeath`).
   *  Pushes a `player-hurt` event tagged with `cause`, unless `silent` (the
   *  caller's own swing/cast event already narrates the blow). Returns the death
   *  event (already pushed), or null if the player survives. */
  _hurtPlayer(player, amount, events, opts = {}) {
    const { cause = "hit", silent = false, damageType = null } = opts;
    player.hp -= amount;
    if (!silent) events.push({ type: "player-hurt", playerId: player.id, cause, damage: amount, damageType, hp: Math.max(0, player.hp), maxHp: player.maxHp });
    if (player.hp <= 0) {
      const death = this._beginDeath(player, player.location, events);
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

  /** Per-tick room effects: for every room that authors `trigger:"tick"` effects,
   *  run each due effect against every living player present. `interval` gates the
   *  cadence via the global tick counter (no per-player state). Runs AFTER
   *  _environmentTick so it reads freshly recomputed light (a dark-room drain bites
   *  the same tick lightBane would). Pushes a `room-effect`/`room-effect-room`
   *  flavour event when the effect authored a message or dimmed the room. */
  _roomEffectsTick(events) {
    for (const [roomId, room] of Object.entries(this.world.rooms)) {
      const effects = room.effects;
      if (!effects || !effects.length) continue;
      const tickEffects = effects.filter((e) => e.trigger === "tick");
      if (!tickEffects.length) continue;
      const players = this.playersIn(roomId).filter((p) => p.hp > 0);
      if (!players.length) continue;
      const died = new Set(); // players a fatal effect respawned away this tick — skip in later effects
      for (const eff of tickEffects) {
        if (eff.interval && eff.interval > 1 && this.tick % eff.interval !== 0) continue;
        for (const p of players) {
          if (died.has(p)) continue; // already killed + respawned by an earlier effect this tick
          const r = this.applyRoomEffect(p, roomId, eff, events);
          if (!r.fired) continue;
          if (r.died) { died.add(p); continue; } // respawned at the rim — don't act on the stale snapshot
          if (eff.message && !r.silent) events.push({ type: "room-effect", playerId: p.id, text: eff.message, dimsRoom: r.doused > 0 });
          else if (r.doused) events.push({ type: "room-effect", playerId: p.id, text: "Your light is snuffed out.", dimsRoom: true });
          if (eff.roomMessage || r.doused) events.push({ type: "room-effect-room", roomId, exceptId: p.id, text: eff.roomMessage || "", dimsRoom: r.doused > 0 });
        }
      }
    }
  }

  /**
   * Player death (v1), phase 1 — the fall. The delver drops where they died and
   * lies dying (`player.dying` ticks) instead of teleporting away instantly: a
   * beat so the death registers rather than reading as a confusing room-swap.
   * `_dyingTick` counts the timer down each tick and runs `_wakeAtRim` at zero.
   * The hp is left at/below zero — combat and recovery already skip the dead, so a
   * dying delver lies inert and untargeted. Returns a `death-begin` event; callers
   * use its truthiness as the "this combatant is down, stop swinging" sentinel.
   */
  _beginDeath(player, deathRoom, events = []) {
    player.dying = DEATH_DELAY_TICKS;
    player.deathRoom = deathRoom;
    player.pending = null;
    player.energy = 0;
    this._dismissOwnedSummons(player.id, "owner-gone", events); // a falling delver's summons unravel
    return { type: "death-begin", victimKind: "player", victimId: player.id, victimName: player.name, roomId: deathRoom };
  }

  /** Tick fallen delvers' dying timers; wake each at the rim when its dark runs out. */
  _dyingTick(events) {
    for (const player of this.players.values()) {
      if (player.dying == null) continue;
      player.dying -= 1;
      if (player.dying <= 0) events.push(this._wakeAtRim(player, events));
      else events.push({ type: "dying", victimId: player.id, victimName: player.name, remaining: player.dying });
    }
  }

  /**
   * Player death phase 2 — the wake. Respawn at the rim, full HP, no penalty beyond
   * progress. Snuffs carried lights (you wake in the dark), ends transient effects,
   * and relocates. Returns the `death` event the server turns into the wake message
   * and view refreshes.
   */
  _wakeAtRim(player, events = []) {
    const start = this.world.playerTemplate.startLocation;
    const deathRoom = player.deathRoom;
    player.dying = null;
    player.deathRoom = null;
    player.hp = player.maxHp;
    // Death snuffs every carried light source — you wake at the rim in the dark.
    for (const inst of [...Object.values(player.equipment || {}), ...(player.inventory || [])])
      if (inst && inst.lit) inst.lit = false;
    // Transient effects (potions, venom, bleeds, glows) end on death. Effects
    // sustained by worn/carried gear (source "item") persist — the gear is still
    // on you when you respawn.
    player.states = (player.states || []).filter((s) => s.source === "item");
    this.setPlayerLocation(player, start);
    player.pending = null;
    player.energy = 0;
    this.rooms[start].light = this.computeRoomLight(start);
    if (this.rooms[deathRoom]) this.rooms[deathRoom].light = this.computeRoomLight(deathRoom);
    return { type: "death", victimKind: "player", victimId: player.id, victimName: player.name, roomId: deathRoom, respawnRoom: start };
  }
}

// Copy a mixin class's prototype methods onto GameState.prototype. Class methods
// are non-enumerable, so Object.assign won't see them — copy property descriptors
// instead, which also keeps them non-enumerable (matching real class methods).
// This is how large method clusters live in their own files (see state-mobai.js)
// while remaining ordinary GameState methods at runtime.
function mixin(target, SourceClass) {
  for (const name of Object.getOwnPropertyNames(SourceClass.prototype)) {
    if (name === "constructor") continue;
    Object.defineProperty(target.prototype, name, Object.getOwnPropertyDescriptor(SourceClass.prototype, name));
  }
}
mixin(GameState, require("./state-mobai")); // mob AI, threat/grudge, pursuit, mob combat
mixin(GameState, require("./state-tide")); // the Tide world clock: phases, lamps, tide spawns/sweeps
mixin(GameState, require("./state-spells")); // cast resolution, detonateRoom, summon lifecycle
mixin(GameState, require("./state-effects")); // status effects, restores, OOC mob regen, room effects
mixin(GameState, require("./state-scheduler")); // timed events: the Scheduler (visiting trader, …)

module.exports = { GameState, makeItemInstance, addToFloor, makeMobInstance, actorEmitLight, playerDefence, effectiveSpeed, buyValueOf, sellValueOf, SELL_RATE, itemVisibleTo, fixtureVisibleTo, mobVisibleTo, effectivePerception, canPerceive, isDiscovered, discoveryKey, xpForLevel, effectiveAttributes, spellScaleBonus, durationScaleBonus, MELEE_SCALE, roomEffectFires };
