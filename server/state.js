"use strict";
const { effectiveLight } = require("./light");
const { rollDice } = require("./dice");
const { POINTS_PER_LEVEL, DEFAULT_FACTION, DEATH_DELAY_TICKS, TIDE } = require("./config");
const { tidePhaseAt, tideOffset } = require("./world-clock");
// Pure helpers split out of this file (see PR refactor/split-state-helpers).
// Imported here and re-exported below so the public surface stays unchanged.
const {
  xpForLevel, MELEE_SCALE, weaponOf, mobOnDamage, playerOnDamage,
  HP_BASE, HP_PER_LEVEL, HP_PER_VITALITY, MANA_PER_INTELLECT, ATTR_BASELINE, SIGHT_PER_PERCEPTION,
  HIT_PER_PERCEPTION, CRIT_PER_PERCEPTION,
  effectiveAttributes, playerDefence, effectiveSpeed, mobDefence,
  spellScaleBonus, durationScaleBonus, scaledAmount, wardNegates,
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
// Out-of-combat recovery (see GameState._recoverMobsTick): a wounded mob that
// nothing is fighting or watching, in a room clear of living foes, knits its
// wounds shut. It must hold OOC_REGEN_DELAY ticks past its last combat first (so
// a brief retreat barely helps), then mends maxHp/OOC_REGEN_TICKS per tick to
// full. The counter to flee-heal-return: a real heal-trip finds the mob whole.
// A per-mob `regen: { delay, perTick }` overrides either knob.
const OOC_REGEN_DELAY = 5; // ticks out of combat before recovery starts
const OOC_REGEN_TICKS = 20; // ticks to mend from empty to full (sets the default rate)
// Factions whose NPCs tend lamps against the Tide: the Rim's human settlers and
// the Umbrals. The wild fauna and beasts won't work a switch (see _setTideLamps).
const LAMP_TENDER_FACTIONS = new Set(["rim", "umbral"]);

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
    // The Tide (world-clock.js): the world's current phase, derived from `tick`
    // each tick. `tideOverride` pins it for admin testing (@tide), bypassing the
    // clock. Set before _initRooms so the first light computation sees the phase.
    this.tidePhase = TIDE.enabled ? tidePhaseAt(this.tick, TIDE.phaseTicks).phase : "calm";
    this.tideOverride = null;
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

  /**
   * The summon primitive. Conjures `count` instances of `mobId` into `roomId`,
   * stamped with faction/ownership/lifetime, and places them WITHOUT a spawner
   * `origin` (so they never respawn or count against a room's spawn cap). Used by
   * both the player Summon spell (faction "player", an ownerId, a lifetime) and a
   * mob `summon` action (faction "wild", a summonerId, permanent). Pushes one
   * `summon` event for narration. Returns the new instances.
   */
  _summon({ roomId, mobId, count = 1, faction = DEFAULT_FACTION, ownerId = null, summonerId = null, group = null, lifetime = null, by = "mob", byName = null, verb = null }, events = []) {
    const t = this.world.mobs[mobId];
    if (!t) throw new Error(`summon: unknown mob template ${mobId}`);
    const made = [];
    for (let i = 0; i < count; i++) {
      const m = makeMobInstance(mobId, this.world);
      m.faction = faction;
      m.ownerId = ownerId;
      m.summonerId = summonerId;
      m.summonGroup = group;
      m.expiresIn = lifetime;
      m.noSpoils = true;
      this.rooms[roomId].mobs.push(m);
      made.push(m);
    }
    this.rooms[roomId].light = this.computeRoomLight(roomId); // a glowing summon lights the room
    events.push({
      type: "summon", roomId, by, byId: by === "player" ? ownerId : summonerId, byName,
      mobTemplate: mobId, mobName: t.name, emitsLight: t.emitsLight > 0,
      count: made.length, light: this.rooms[roomId].light, verb,
    });
    return made;
  }

  /** Remove a summoned mob from the world silently — no corpse, loot, XP, or death
   *  event, just a `summon-end`. Finds the mob's room by scan (few summons exist). */
  _dismissSummon(mob, reason, events = []) {
    for (const [roomId, rt] of Object.entries(this.rooms)) {
      const idx = rt.mobs.indexOf(mob);
      if (idx < 0) continue;
      rt.mobs.splice(idx, 1);
      mob.hp = 0; // mark gone for any lingering reference
      rt.light = this.computeRoomLight(roomId);
      const t = this.world.mobs[mob.template];
      events.push({ type: "summon-end", roomId, mobName: t.name, emitsLight: t.emitsLight > 0, light: rt.light, reason });
      return;
    }
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

  /** Dismiss every summon owned by `ownerId` (owner death/disconnect). */
  _dismissOwnedSummons(ownerId, reason, events = []) {
    const owned = [];
    for (const rt of Object.values(this.rooms)) for (const m of rt.mobs) if (m.ownerId === ownerId) owned.push(m);
    for (const m of owned) this._dismissSummon(m, reason, events);
    return events;
  }

  /** Relocate a player's owned summons from `from` to `dest` (follow on move).
   *  Returns [{ mobName, emitsLight }] for the caller to narrate. Recomputes light
   *  in both rooms if anything moved. Wild (ownerless) summons never follow. */
  _moveSummonsWith(player, from, dest) {
    const rtFrom = this.rooms[from], rtDest = this.rooms[dest];
    const moved = [];
    for (const m of [...rtFrom.mobs]) {
      if (m.ownerId !== player.id) continue;
      const idx = rtFrom.mobs.indexOf(m);
      if (idx >= 0) rtFrom.mobs.splice(idx, 1);
      rtDest.mobs.push(m);
      const t = this.world.mobs[m.template];
      moved.push({ mobName: t.name, emitsLight: t.emitsLight > 0 });
    }
    if (moved.length) {
      rtFrom.light = this.computeRoomLight(from);
      rtDest.light = this.computeRoomLight(dest);
    }
    return moved;
  }

  /** Count living summons sharing a `summonerId` (a mob's living brood). */
  _broodCount(summonerId) {
    let n = 0;
    for (const rt of Object.values(this.rooms)) for (const m of rt.mobs) if (m.summonerId === summonerId && m.hp > 0) n++;
    return n;
  }

  /** Tick summon lifetimes: decrement `expiresIn`, wink out at zero. */
  _summonTick(events) {
    for (const rt of Object.values(this.rooms)) {
      for (const m of [...rt.mobs]) {
        if (m.expiresIn == null) continue;
        m.expiresIn -= 1;
        if (m.expiresIn <= 0) this._dismissSummon(m, "expired", events);
      }
    }
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
      events.push({ type: "mob-spawn", roomId: sp.roomId, mobId: m.id, mobName: t.name, emitsLight: t.emitsLight > 0, light });
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

  // --- The Tide (world clock) ------------------------------------------------
  // Each tick, resolve the current phase (from the clock, or a pinned override)
  // and, when it changes, apply the transition: every room's effective light
  // shifts at once, predators stir on the way in and sink back on the way out.

  /** Resolve the tide phase for this tick and, if it changed, apply it. */
  _tideTick(events) {
    if (!TIDE.enabled) return;
    const phase = this.tideOverride || tidePhaseAt(this.tick, TIDE.phaseTicks).phase;
    if (phase === this.tidePhase) return;
    const prev = this.tidePhase;
    this.tidePhase = phase;
    this._applyTidePhase(prev, phase, events);
  }

  /** Admin/testing hook: pin the tide to `phase` (bypassing the clock) and apply
   *  the transition now. Pass null to resume the automatic clock. Returns the
   *  transition events for the caller to dispatch (see the @tide command). */
  forceTidePhase(phase) {
    this.tideOverride = phase;
    const events = [];
    if (phase && phase !== this.tidePhase) {
      const prev = this.tidePhase;
      this.tidePhase = phase;
      this._applyTidePhase(prev, phase, events);
    }
    return events;
  }

  /** A compact read of the Tide for the client HUD: the current phase and a 0..1
   *  `intensity` (how dark the world is right now — 0 in Calm, rising through
   *  Stirring, full at the Tide, falling through Receding). `enabled` is false when
   *  the world clock is off, so the client can hide the indicator entirely. */
  tideStatus() {
    if (!TIDE.enabled) return { enabled: false, phase: "calm", intensity: 0 };
    const info = tidePhaseAt(this.tick, TIDE.phaseTicks);
    const phase = this.tideOverride || info.phase;
    let intensity;
    if (this.tideOverride) {
      intensity = phase === "tide" ? 1 : phase === "stirring" || phase === "receding" ? 0.5 : 0;
    } else {
      const frac = Math.min(1, info.sinceStart / (TIDE.phaseTicks[phase] || 1));
      intensity = phase === "tide" ? 1 : phase === "stirring" ? frac : phase === "receding" ? 1 - frac : 0;
    }
    return { enabled: true, phase, intensity: Math.round(intensity * 100) / 100 };
  }

  /** A tide phase change. Recompute EVERY room's light first — the darkening
   *  lands worldwide at once, but the per-tick light loop only refreshes occupied
   *  rooms, so a delver who later walks into a distant room would otherwise see
   *  stale light (the light-refresh invariant). Then the Tide looses its
   *  predators (onset) or sweeps the survivors back (any ebb). The `tide-phase`
   *  event tells every connected delver and refreshes their view so an idle
   *  player watches the world darken. */
  _applyTidePhase(prev, phase, events) {
    for (const id of Object.keys(this.rooms)) this.rooms[id].light = this.computeRoomLight(id);
    // NPCs light their lamps against the gathering dark (Stirring through the
    // Tide) and snuff them once it has receded (Calm) — before spawn, so a lit
    // camp's brightness already repels the predators' maxLight check.
    if (phase === "stirring" || phase === "tide") this._setTideLamps(true, events);
    else if (phase === "calm") this._setTideLamps(false, events);
    if (phase === "tide") this._tideSpawn(events);
    else this._tideSweep(events);
    events.push({ type: "tide-phase", phase, prev });
  }

  /** NPCs work the lamps as the Tide turns. With `on`, every room that holds a
   *  living NPC has its switchable light fixtures (a lamp, currently off) thrown
   *  on, tagged `tideLit`. With `on` false (the recede to Calm), only those
   *  Tide-lit lamps are snuffed again — an author- or player-lit lamp is left
   *  burning. Only a living lamp-tending NPC (Rim or Umbral — see
   *  LAMP_TENDER_FACTIONS) works the switch; the wild fauna won't. A room with no
   *  such tender, or no lamp, is simply skipped (the safe-camp content — pairing
   *  lamps with NPCs — is the follow-up pass). */
  _setTideLamps(on, events) {
    for (const [roomId, rt] of Object.entries(this.rooms)) {
      let changed = false;
      if (on) {
        if (!rt.mobs.some((m) => m.hp > 0 && LAMP_TENDER_FACTIONS.has(m.faction))) continue; // no lamp-tending NPC here
        for (const f of rt.fixtures) {
          const ft = this.world.fixtures[f.template];
          if (ft && ft.switch && ft.switch.emitsLight && !f.on) { f.on = true; f.tideLit = true; changed = true; }
        }
      } else {
        for (const f of rt.fixtures) if (f.tideLit) { f.on = false; f.tideLit = false; changed = true; }
      }
      if (changed) {
        rt.light = this.computeRoomLight(roomId);
        events.push({ type: "tide-lamp", roomId, on, light: rt.light });
      }
    }
  }

  /** Loose the Tide's light-fearing predators. Data-driven from an optional
   *  `world.tideSpawns` roster (the followup content task) — until that lands the
   *  dark comes empty-handed. Each rule: { mob, minDepth, maxDepth, count,
   *  maxLight, faction, noSpoils }. A rule skips any room already brighter than
   *  `maxLight`, so a lit camp keeps the hunters out. Spawned mobs are tagged
   *  `tideSpawn` so the ebb can reclaim them; they carry no spawner `origin`
   *  (never repop, never count against a room's cap). */
  _tideSpawn(events) {
    const roster = this.world.tideSpawns;
    if (!Array.isArray(roster) || !roster.length) return;
    for (const [roomId, room] of Object.entries(this.world.rooms)) {
      const depth = room.depth || 0;
      const rt = this.rooms[roomId];
      for (const rule of roster) {
        if (!this.world.mobs[rule.mob]) continue;
        if (depth < (rule.minDepth || 0)) continue;
        if (rule.maxDepth != null && depth > rule.maxDepth) continue;
        if (rule.maxLight != null && rt.light > rule.maxLight) continue; // lamps keep the hunters out
        const count = Math.max(1, rule.count || 1);
        let last = null;
        for (let i = 0; i < count; i++) {
          const m = makeMobInstance(rule.mob, this.world);
          m.tideSpawn = true; // the ebb reclaims it (see _tideSweep)
          m.faction = rule.faction || "umbral";
          m.noSpoils = !!rule.noSpoils;
          rt.mobs.push(m);
          last = m;
        }
        const light = rt.light = this.computeRoomLight(roomId); // a dark-shedding predator deepens the room
        const t = this.world.mobs[rule.mob];
        events.push({ type: "mob-spawn", roomId, mobId: last.id, mobName: t.name, emitsLight: t.emitsLight > 0, light });
      }
    }
  }

  /** The ebb: every Tide-spawned predator still abroad sinks back into the dark —
   *  no corpse, loot, or XP, just a vanish (like a summon's dismissal). */
  _tideSweep(events) {
    for (const [roomId, rt] of Object.entries(this.rooms)) {
      let removed = 0;
      for (const m of [...rt.mobs]) {
        if (!m.tideSpawn) continue;
        const idx = rt.mobs.indexOf(m);
        if (idx < 0) continue;
        rt.mobs.splice(idx, 1);
        m.hp = 0; // mark gone for any lingering reference
        removed++;
        const t = this.world.mobs[m.template];
        events.push({ type: "mob-flee", roomId, mobName: t.name, emitsLight: t.emitsLight > 0, light: rt.light, verb: "sinks back into the dark" });
      }
      if (removed) rt.light = this.computeRoomLight(roomId); // a dark predator leaving lifts the gloom
    }
  }

  /** The Tide's living teeth, per tick (called from advance only while the phase is
   *  `tide`). The dark itself births a predator beside a delver who has let their
   *  light fail: every room holding a living player whose effective light is below 0
   *  (the void band) has `TIDE.predator.chance` to spawn one `predator.mob` right
   *  there. Capped at `predator.cap` shadows worldwide, so a long dark mounts pressure
   *  toward the cap rather than flooding. A lit camp (light ≥ 0) is never a birthplace
   *  — keeping a flame is the whole counterplay — and a shadow that strays into light
   *  is seared by its lightBane as usual. Spawns are tagged `tideSpawn`, so the ebb's
   *  `_tideSweep` reclaims any still abroad; they carry no `origin` (never repop, and
   *  their pursuit is unleashed — the dark does not give up). */
  _tideCreepTick(events) {
    const cfg = TIDE.predator;
    if (!cfg || !cfg.mob || !this.world.mobs[cfg.mob]) return;
    const cap = cfg.cap != null ? cfg.cap : 5;
    let alive = 0; // living tide-spawned shadows already abroad (the global cap)
    for (const rt of Object.values(this.rooms))
      for (const m of rt.mobs) if (m.tideSpawn && m.hp > 0) alive++;
    if (alive >= cap) return;
    const chance = cfg.chance != null ? cfg.chance : 0.05;
    const t = this.world.mobs[cfg.mob];
    for (const [roomId, rt] of Object.entries(this.rooms)) {
      if (alive >= cap) break;
      if (rt.light >= 0) continue; // the dark only births where a delver's light has failed
      if (!this.playersIn(roomId).some((p) => p.hp > 0)) continue; // beside a living delver
      if (Math.random() >= chance) continue;
      const m = makeMobInstance(cfg.mob, this.world);
      m.tideSpawn = true; // the ebb reclaims it (see _tideSweep)
      m.faction = cfg.faction || "wild";
      m.noSpoils = !!cfg.noSpoils;
      rt.mobs.push(m);
      alive++;
      const light = (rt.light = this.computeRoomLight(roomId)); // a dark-shedding predator deepens the room
      events.push({ type: "mob-spawn", roomId, mobId: m.id, mobName: t.name, emitsLight: t.emitsLight > 0, light, tideCreep: true });
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
    return effectiveLight(room.ambientLight + this.tideOffsetFor(roomId), outputs);
  }

  /** The Tide's light offset for a room right now (≤ 0): the current phase's
   *  depth-scaled darkening, folded into ambient by computeRoomLight. 0 when the
   *  system is disabled or the world is Calm. See world-clock.js. */
  tideOffsetFor(roomId) {
    if (!TIDE.enabled) return 0;
    const room = this.world.rooms[roomId];
    return tideOffset(this.tidePhase, room ? room.depth : 0, TIDE);
  }

  /**
   * Apply a status-effect primitive to an actor. `spec` is the data-driven
   * descriptor authored on a potion/spell, e.g.
   *   { type: "emit-light", name: "Light", magnitude: 1, duration: 180 }
   * Effects stack as independent instances, each with its own countdown; the
   * engine reads them where relevant (emit-light is summed into room light).
   * `spec.refresh` opts out of stacking: any existing instance of the same
   * type+name is dropped first, so re-applying just resets the timer (the right
   * behaviour for buffs like Glimmerskin; DoTs leave it unset to keep stacking).
   */
  applyEffect(actor, spec) {
    if (!actor.states) actor.states = [];
    const name = spec.name || spec.type;
    if (spec.refresh) actor.states = actor.states.filter((s) => !(s.type === spec.type && s.name === name));
    actor.states.push({
      type: spec.type,
      name,
      magnitude: spec.magnitude || 0,
      armour: spec.armour || 0, // flat defence buffs (see "protect" / playerDefence)
      ward: spec.ward || 0,
      damage: spec.damage || null, // dice string, for "damage-over-time" (bleed/poison)
      interval: spec.interval || null, // ticks between pulses, for periodic effects (heal-over-time)
      pulse: 0, // counts ticks toward the next pulse (see _tickEffects)
      sourceId: spec.sourceId || null, // player to credit if a DoT lands the kill
      source: spec.source || null, // "item" = sustained by worn/carried gear; survives death
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
      if (dead) continue;
      for (const s of p.states) {
        if (s.type !== "heal-over-time" || !this._pulseReady(s)) continue;
        const healed = this._heal(p, s.magnitude);
        if (healed) events.push({ type: "regen-tick", playerId: p.id, amount: healed, name: s.name });
      }
      this._expireStates(p, events, (s) => ({ type: "effect-expired", playerId: p.id, effectType: s.type, name: s.name }));
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
          for (const s of m.states) {
            if (s.type !== "heal-over-time" || !this._pulseReady(s)) continue;
            const healed = this._heal(m, s.magnitude);
            if (healed) events.push({ type: "mob-regen", roomId, mobId: m.id, mobName: t.name, amount: healed, name: s.name, emitsLight: t.emitsLight > 0, light: rt.light });
          }
          this._expireStates(m, events, (s) => ({ type: "mob-effect-expired", roomId, mobId: m.id, mobName: t.name, effectType: s.type, name: s.name, emitsLight: t.emitsLight > 0, light: rt.light }));
        }
      }
    }
  }

  /** Out-of-combat recovery: a wounded mob that nothing is fighting or watching,
   *  in a room with no living foe, knits its wounds shut. It must stay out of
   *  combat for `delay` ticks first — so darting out and back barely helps — then
   *  mends `perTick` HP toward full each tick, defaulting to maxHp/OOC_REGEN_TICKS
   *  so any mob recovers fully in ~OOC_REGEN_TICKS ticks regardless of size. This
   *  is the counter to flee-heal-return: a genuine heal-trip finds the mob whole
   *  again. `m.lastCombatTick` is stamped every tick the mob is alerted; a per-mob
   *  `regen: { delay, perTick }` overrides either knob (e.g. a slow-mending boss).
   *
   *  ORDERING (load-bearing): must run AFTER `resolveMobAI` in the tick. The
   *  alerted check below reads `mob.aggro`/`mob.detect`, which `_mobAct` freshly
   *  prunes (drops combatants who left) each AI pass — so a mob whose foes have
   *  gone is correctly seen as disengaged here. Run before the AI and a just-
   *  departed enemy would still read as alerted, blocking recovery for a tick. */
  _recoverMobsTick(events) {
    for (const [roomId, rt] of Object.entries(this.rooms)) {
      const foePresent = this.playersIn(roomId).some((p) => p.hp > 0);
      for (const m of rt.mobs) {
        if (m.hp <= 0 || m.hp >= m.maxHp) continue;
        if (this._alerted(m)) { m.lastCombatTick = this.tick; continue; } // still in a fight
        if (foePresent) continue; // never mend in front of a living delver
        const reg = this.world.mobs[m.template].regen || {};
        const delay = reg.delay != null ? reg.delay : OOC_REGEN_DELAY;
        if (this.tick - (m.lastCombatTick != null ? m.lastCombatTick : -Infinity) < delay) continue;
        const perTick = reg.perTick != null ? reg.perTick : Math.max(1, Math.ceil(m.maxHp / OOC_REGEN_TICKS));
        const healed = this._heal(m, perTick);
        if (!healed) continue;
        const t = this.world.mobs[m.template];
        events.push({ type: "mob-regen", roomId, mobId: m.id, mobName: t.name, amount: healed, name: "recovery", emitsLight: t.emitsLight > 0, light: rt.light });
      }
    }
  }

  /** Advance a periodic state's pulse counter; true on the tick its `interval`
   *  comes due (default every tick). Used by heal-over-time (and future pulses). */
  _pulseReady(s) {
    const every = s.interval || 1;
    if (++s.pulse < every) return false;
    s.pulse = 0;
    return true;
  }

  /** Restore up to `amount` HP to an actor (player or mob), clamped to its
   *  maximum. Returns the HP actually gained (0 if already full). */
  _heal(actor, amount) {
    if (!amount || actor.hp >= actor.maxHp) return 0;
    const before = actor.hp;
    actor.hp = Math.min(actor.maxHp, actor.hp + amount);
    return actor.hp - before;
  }

  /** Snuff every lit light source a player carries (equipped or in the pack) —
   *  the waterfall douse. Mirrors the death-snuff loop in _respawn. Returns the
   *  count extinguished; the caller recomputes room light when it's > 0. A spent
   *  husk is left in place (not consumed — unlike burning out). */
  _douse(player) {
    let n = 0;
    for (const inst of [...Object.values(player.equipment || {}), ...(player.inventory || [])])
      if (inst && inst.lit) { inst.lit = false; n++; }
    return n;
  }

  /** Drain up to `amount` mana from an actor, clamped at 0 (the mana mirror of
   *  _heal / the mana side of applyRestore). Returns the mana actually taken. */
  _drainMana(actor, amount) {
    if (!amount) return 0;
    const before = actor.mana || 0;
    actor.mana = Math.max(0, before - amount);
    return before - actor.mana;
  }

  /** Run one room effect against a player standing in `roomId`, if its light
   *  condition is met. Performs the single action and pushes the MECHANICAL
   *  events (`vitals`, and via _hurtPlayer the `player-hurt`/`death-begin` events);
   *  the caller renders the effect's flavour (`message`/`roomMessage`). Returns
   *  `{ fired, doused, died }` — see the plan's contract. Shared by the tick
   *  driver (_roomEffectsTick) and the enter driver (move() in commands.js). */
  applyRoomEffect(player, roomId, effect, events) {
    if (!roomEffectFires(effect, this.rooms[roomId].light)) return { fired: false, doused: 0, died: false };
    const a = effect.action || {};
    let doused = 0;
    let died = false;
    if (a.douse) {
      doused = this._douse(player);
      if (doused) this.rooms[roomId].light = this.computeRoomLight(roomId);
    } else if (a.restore) {
      const got = this.applyRestore(player, a.restore);
      if (got.hp || got.mana) events.push({ type: "vitals", playerId: player.id });
    } else if (a.damage) {
      if (a.damage.hp != null && this._hurtPlayer(player, Math.max(1, rollDice(a.damage.hp)), events, { cause: "darkness" })) died = true;
      if (!died && a.damage.mana != null && this._drainMana(player, Math.max(1, rollDice(a.damage.mana)))) events.push({ type: "vitals", playerId: player.id });
    }
    return { fired: true, doused, died };
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
    player.maxHp = HP_BASE + ((player.level || 1) - 1) * HP_PER_LEVEL + (a.vitality || 0) * HP_PER_VITALITY + this._equipHpBonus(player);
    player.maxMana = (a.intellect || 0) * MANA_PER_INTELLECT + this._equipManaBonus(player);
    player.manaRegen = this.manaRegenFor(player);
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
    return events;
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
    const eff = effectivePerception(this.world, player, rt.light);
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

    this._tideTick(events); // the world clock: darken/brighten the world on phase changes
    if (this.tidePhase === "tide") this._tideCreepTick(events); // the dark grows teeth: shadows born beside delvers in failed light
    this._dyingTick(events); // fallen delvers count down to waking at the rim (death pacing)

    for (const p of this.players.values()) {
      const sp = effectiveSpeed(this.world, p); // heavy gear (speedPenalty) slows action-energy gain
      p.energy = Math.min(p.energy + sp, sp * 3);
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
    this._harvestTick(events);
    this._summonTick(events);
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

    // Attacker onHit → the defender by default (venom, a debuff), but an entry marked
    // `target: "self"` (or "attacker") lands on the attacker instead — life-steal: a
    // blade that heals its wielder on a landed hit (the mirror of onDamage's target
    // axis). Self-target fires even on a killing blow (you drink life as you cut);
    // defender-target only while the defender still lives.
    if (attacker.onHit) {
      for (const spec of attacker.onHit) {
        if (!this._rollChance(spec)) continue;
        if (spec.target === "self" || spec.target === "attacker")
          this._applyTriggerEffect(events, spec, attacker, attacker.hurt, null);
        else if (!defenderDeath)
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
      const mobDef = mobDefence(mt, mob);
      const attrs = effectiveAttributes(w, p);
      const per = attrs.perception || 0;
      const attacker = {
        band: p.perception,
        hitBonus: per * HIT_PER_PERCEPTION,
        dmgBonus: spellScaleBonus(attrs, weapon.scale),
        crit: per * CRIT_PER_PERCEPTION + (weapon.crit || 0),
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
          defender: this._mobDefender(mob, mt, p.location, { id: p.id, kind: "player", actor: p }, events),
        });
        if (attackerDeath) break; // a reflect killed the player — they've respawned away
      }
    }
  }

  /**
   * The full price of casting `spell`, in one place: mana, `shardCost` (glimmer burned
   * in the cast), and any `itemCost` material components (e.g. Glimmer Husk's chitin
   * plate). Returns a human-readable error string if the caster can't pay — nothing is
   * spent — or null if they can. The command handler calls this before committing.
   */
  costShortfall(player, spell) {
    const w = this.world;
    if (Math.floor(player.mana || 0) < (spell.manaCost || 0))
      return `You lack the mana for ${spell.name} (need ${spell.manaCost}, have ${Math.floor(player.mana || 0)}).`;
    if (spell.shardCost && (player.shards || 0) < spell.shardCost)
      return `${spell.name} burns ${spell.shardCost} shards as glimmer and you have ${player.shards || 0}.`;
    for (const need of spell.itemCost || []) {
      const have = (player.inventory || []).reduce((n, i) => (i && i.template === need.template ? n + (i.qty || 1) : n), 0);
      if (have < (need.qty || 1)) {
        const it = w.items[need.template];
        return `${spell.name} needs ${it ? it.name : need.template} (${need.qty || 1}) to shape, and you have ${have}.`;
      }
    }
    return null;
  }

  /**
   * Deduct a spell's full cost — mana, shards, and material components — in one place,
   * shared by every player cast-resolution path. Assumes the caster can pay (the
   * command handler has already run `costShortfall`). Shards are a currency counter,
   * not inventory, so they deduct numerically; `itemCost` pulls instances from the bag.
   */
  spendCost(player, spell) {
    player.mana = Math.max(0, (player.mana || 0) - (spell.manaCost || 0));
    if (spell.shardCost) player.shards = Math.max(0, (player.shards || 0) - spell.shardCost);
    for (const need of spell.itemCost || []) {
      let remaining = need.qty || 1;
      for (let i = player.inventory.length - 1; i >= 0 && remaining > 0; i--) {
        const inst = player.inventory[i];
        if (!inst || inst.template !== need.template) continue;
        const take = Math.min(remaining, inst.qty || 1);
        if (inst.qty != null && inst.qty > take) inst.qty -= take;
        else player.inventory.splice(i, 1);
        remaining -= take;
      }
    }
  }

  /**
   * Resolve an immediate spell cast by a player at a mob. Spends the cost, rolls the
   * target's Ward to (maybe) fizzle the whole spell, then applies the effect
   * primitive — today only `damage` (dice + scaling-attribute bonus). Hostile
   * spells earn the target's threat even when resisted. Returns a result the
   * caller narrates: { resisted } | { damage, killed, death }.
   *
   * Cost and target validation happen in the command handler; by here the cast
   * is committed. `events` is optional and used to push auto-retaliation events.
   */
  castSpell(player, spell, mob, events = []) {
    const w = this.world;
    const eff = spell.effect || {};
    this.spendCost(player, spell);

    const ward = mobDefence(w.mobs[mob.template], mob).ward || 0;
    if (spell.hostile && wardNegates(ward)) {
      this._addThreat(mob, player.id, 1); // a fizzled bolt still draws its ire
      return { resisted: true };
    }

    // Sleep: a non-damaging hex that drops a perceiving foe into slumber, making
    // it inert (see resolveMobAI) until any blow rouses it. Ward had its wholesale
    // chance to negate above; on success it draws no threat and does NOT rouse or
    // auto-engage — the point is to slip away or line up an ambush.
    if (eff.type === "sleep") {
      mob.posture = "sleeping";
      this.rooms[player.location].light = this.computeRoomLight(player.location);
      return { resisted: false, slept: true };
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
    } else if (eff.type === "damage-over-time") {
      // A clinging burn (Witchfire): no immediate blow, but a DoT stamped with the
      // caster so a smoulder-kill credits them (like a bleed). Intellect lengthens the
      // burn (more total damage, and a longer-lasting mark) rather than hitting harder.
      // Ward already had its wholesale chance to fizzle it above; per-tick damage runs
      // in _tickEffects.
      const duration = (eff.duration || 0) + durationScaleBonus(effectiveAttributes(w, player), eff.durationScale);
      this.applyEffect(mob, { type: "damage-over-time", name: eff.name || spell.name, damage: eff.damage, duration, sourceId: player.id, good: false });
      // The burning glimmer glows: a matching emit-light state marks the foe in the
      // dark for as long as it smoulders (summed into room light by computeRoomLight).
      if (eff.emitLight) this.applyEffect(mob, { type: "emit-light", name: eff.name || spell.name, magnitude: eff.emitLight, duration, good: false });
      this._addThreat(mob, player.id, 1);
      result.dot = true;
      result.duration = duration;
      result.name = eff.name || spell.name;
    } else if (spell.hostile) {
      this._addThreat(mob, player.id, 1);
    }
    // A kill may remove a luminous mob; refresh the room's light either way.
    this.rooms[player.location].light = this.computeRoomLight(player.location);

    // A hostile spell rouses a resting mob just as a blow does (only if it survived).
    if (spell.hostile && mob.hp > 0 && this._rouse(mob)) {
      const t = w.mobs[mob.template];
      events.push({ type: "mob-woke", roomId: player.location, mobId: mob.id, mobName: t.name, emitsLight: t.emitsLight > 0, light: this.rooms[player.location].light });
    }

    // Auto-retaliate on hostile spell: if the player isn't already attacking something, target this mob
    if (spell.hostile && !player.pending && player.hp > 0 && mob.hp > 0) {
      player.pending = { type: "attack", targetId: mob.id };
      const t = w.mobs[mob.template];
      events.push({ type: "combat-auto-start", playerId: player.id, targetId: mob.id, targetName: t.name });
    }

    return result;
  }

  /**
   * Resolve a hostile area spell (`effect.type === "damage-room"`, e.g. Arc Flash) cast
   * by a player. Spends mana and any `shardCost`, then blasts every mob in `targets`
   * (the caller has already filtered to the eligible) through the shared bomb
   * resolver, folding the caster's Intellect in as a flat per-target bonus. Returns
   * detonateRoom's per-target results for the caller to narrate.
   */
  castRoomSpell(player, spell, targets, events = []) {
    const eff = spell.effect || {};
    this.spendCost(player, spell);
    const bonus = spellScaleBonus(effectiveAttributes(this.world, player), eff.scale);
    return this.detonateRoom(player, eff, targets, bonus, events, true); // a magical burst rolls each foe's Ward
  }

  /**
   * Resolve a thrown area bomb (a consumable's `damage-room` effect), applying it to
   * every mob in `targets` (the caller has already filtered to the eligible — hostile
   * or already-engaged — mobs, so a stray toss never blasts a peaceful shopkeeper).
   * A bomb carries an instant burst (`damage`, fresh-rolled per target), a lingering
   * `dot` ({ name, damage, duration } — a corroding/poison cloud applied as a
   * damage-over-time state, credited to the thrower like an `onHit` venom), or both.
   * Either way it threatens the thrower so survivors turn on them, rouses any sleeper
   * it doesn't kill, and credits the thrower with kills (loot/xp). Mob removal, light
   * recompute and the kill's spoils are handled by `_hurtMob` (and, for the DoT, by
   * `_tickEffects`). Returns one result per target for the caller to narrate:
   * `{ id, name, damage, dot, killed, death }`.
   *
   * `bonus` is a flat per-target damage add (a caster's Intellect scaling for an
   * area spell); a thrown bomb passes none. `wardCheck` opts a target's Ward into a
   * per-target negation roll (a magical area *spell* — each foe's Ward may shrug the
   * burst off; see wardNegates), which a thrown bomb (mundane shrapnel/acid) skips.
   * A warded-off target still takes the thrower's threat but no damage or DoT.
   */
  detonateRoom(player, spec, targets, bonus = 0, events = [], wardCheck = false) {
    const w = this.world;
    const roomId = player.location;
    const rt = this.rooms[roomId];
    const results = [];
    // Snapshot the targets — _hurtMob splices the dead out of rt.mobs mid-loop.
    for (const mob of [...targets]) {
      const t = w.mobs[mob.template];
      // A magical burst rolls each foe's Ward independently — a shrugged-off blast
      // still earns the caster's ire, but lands no damage or burn on that target.
      if (wardCheck && wardNegates(mobDefence(t, mob).ward || 0)) {
        this._addThreat(mob, player.id, 1);
        results.push({ id: mob.id, name: t.name, damage: 0, dot: false, resisted: true, killed: false, death: null });
        continue;
      }
      let damage = 0;
      let death = null;
      if (spec.damage != null) {
        damage = Math.max(1, rollDice(spec.damage) + bonus);
        this._addThreat(mob, player.id, damage); // a survivor keeps the thrower in its sights
        death = this._hurtMob(mob, roomId, damage, events, { cause: spec.cause || "blast", killer: player });
      }
      // A lingering cloud sinks a DoT into anything the burst didn't outright kill,
      // stamped with the thrower so a corrosion kill credits them (like a bleed).
      let dot = false;
      if (spec.dot && !death) {
        this.applyEffect(mob, { type: "damage-over-time", name: spec.dot.name || spec.cause || "poison", damage: spec.dot.damage, duration: spec.dot.duration, sourceId: player.id, good: false });
        this._addThreat(mob, player.id, 1); // the splash sticks the thrower in its sights
        dot = true;
      }
      if (!death && this._rouse(mob))
        events.push({ type: "mob-woke", roomId, mobId: mob.id, mobName: t.name, emitsLight: t.emitsLight > 0, light: rt.light });
      results.push({ id: mob.id, name: t.name, damage, dot, killed: !!death, death });
    }
    rt.light = this.computeRoomLight(roomId); // a luminous mob blasted apart changes the room
    return results;
  }

  /**
   * Resolve a beneficial (non-hostile) spell cast by a player on a target actor —
   * `target` is the normalized descriptor the command handler built:
   *   { kind: "player"|"mob", actor, name, id, roomId, emitsLight }
   * Spends mana (and any `shardCost` material), then applies the effect
   * primitive. `heal-over-time` bakes its per-pulse magnitude from the caster's
   * scaling attribute at cast time (so the power follows the caster, while an
   * innate mob regen authors `magnitude` directly); `protect` likewise bakes its
   * armour/ward from the caster; an instant `restore` tops up hp/mana now.
   * Returns a result the caller narrates: { effect, name, perPulse?, restored?,
   * armour?, ward?, duration? }.
   *
   * Support-spell threat: mending or buffing an ally makes whatever is fighting
   * that ally turn on the caster too (see `_drawSupportThreat`), mirroring the
   * damage→threat convention — the amount is the HP/mana mended (a flat 1 for a
   * pure buff). This is the aggro hook this method long reserved.
   */
  castBeneficial(player, spell, target, events = []) {
    const w = this.world;
    const eff = spell.effect || {};
    const attrs = effectiveAttributes(w, player);
    this.spendCost(player, spell);

    if (eff.type === "restore") {
      const got = this.applyRestore(target.actor, eff);
      this._drawSupportThreat(player, target.id, (got.hp || 0) + (got.mana || 0));
      return { effect: "restore", name: spell.name, restored: got };
    }

    if (eff.type === "protect") {
      // Bake the caster-scaled defence into the instance (base + attribute bonus).
      const armour = scaledAmount(attrs, eff.armour);
      const ward = scaledAmount(attrs, eff.ward);
      // Lifetime can scale with the caster (durationScale, ticks per point) on top of
      // any flat base — a keener mage holds the weave longer.
      const duration = (eff.duration || 0) + durationScaleBonus(attrs, eff.durationScale);
      this.applyEffect(target.actor, { type: "protect", name: eff.name || "protect", armour, ward, duration, refresh: eff.refresh, good: true });
      // A radiant ward (Halo) also sheds light: a companion emit-light state, lasting
      // as long as the ward, brightens the room at once — mirrors the smouldering DoT's
      // glow (see castSpell) and the way a quaffed light potion lifts the room.
      if (eff.emitLight) {
        this.applyEffect(target.actor, { type: "emit-light", name: eff.name || "protect", magnitude: eff.emitLight, duration, refresh: eff.refresh, good: true });
        this.rooms[player.location].light = this.computeRoomLight(player.location);
      }
      this._narrateEffectApplied(events, target, eff.name || eff.type);
      this._drawSupportThreat(player, target.id, 1); // a pure buff: a flat sliver of threat
      return { effect: "protect", name: spell.name, armour, ward, light: eff.emitLight || 0, duration };
    }

    // Status effects (heal-over-time and future buffs). Bake any caster scaling
    // into the magnitude so the instance carries a fixed strength.
    const bonus = spellScaleBonus(attrs, eff.scale);
    const magnitude = Math.max(eff.scale ? 1 : 0, (eff.magnitude || 0) + bonus);
    // Lifetime can scale with the caster (durationScale, ticks per point) on top of
    // any flat base — a keener mage holds Candlelight longer, like a longer-lived summon.
    const duration = eff.durationScale
      ? (eff.duration || 0) + durationScaleBonus(attrs, eff.durationScale)
      : eff.duration;
    this.applyEffect(target.actor, { ...eff, magnitude, duration });
    // A light-shedding weave (Candlelight) brightens the room at once, like a potion.
    if (eff.type === "emit-light") this.rooms[player.location].light = this.computeRoomLight(player.location);
    this._narrateEffectApplied(events, target, eff.name || eff.type);
    this._drawSupportThreat(player, target.id, magnitude); // mend-over-time: per-pulse magnitude as threat
    return { effect: eff.type, name: spell.name, perPulse: magnitude, interval: eff.interval || 1, duration: duration || 0 };
  }

  /**
   * Resolve a player summon spell (effect.type "summon"). Spends mana/shards,
   * dismisses this caster's existing summons of the same `group` (recast replaces,
   * resetting the timer), then conjures the new one(s) via `_summon`. The per-owner
   * cap of one-per-group is enforced purely by the dismiss step. Returns
   * { mob, count, replaced } for the caller to narrate.
   */
  castSummon(player, spell, events = []) {
    const eff = spell.effect || {};
    this.spendCost(player, spell); // mana, shards, and the material component (e.g. a chitin plate)
    const group = eff.group || spell.id;
    // Lifetime scales with the caster's Intellect (durationScale, ticks per point), on
    // top of any flat base — so a keener mage holds a summon longer. A summon with
    // neither stays permanent (null).
    let lifetime = eff.duration != null ? eff.duration : null;
    if (eff.durationScale)
      lifetime = (eff.duration || 0) + durationScaleBonus(effectiveAttributes(this.world, player), eff.durationScale);
    const existing = [];
    for (const rt of Object.values(this.rooms))
      for (const m of rt.mobs) if (m.ownerId === player.id && m.summonGroup === group) existing.push(m);
    for (const m of existing) this._dismissSummon(m, "recast", events);
    const made = this._summon({
      roomId: player.location, mobId: eff.mob, count: eff.count || 1,
      faction: "player", ownerId: player.id, summonerId: player.id, group,
      lifetime, by: "player", byName: player.name,
    }, events);
    return { mob: this.world.mobs[eff.mob], count: made.length, replaced: existing.length, lifetime };
  }

  /** Support-spell threat (the deferred aggro hook): healing/buffing an ally makes
   *  whatever is currently fighting that ally turn on the caster too. `amount`
   *  mirrors the damage→threat convention — the HP/mana mended, or a flat 1 for a
   *  pure buff. For every live mob in the caster's room whose threat table already
   *  names the ally (so it is fighting them), the caster gains `amount` threat. A
   *  self-cast simply stokes the caster's own attackers — the intended healer-aggro
   *  feel. Co-located by construction: a beneficial cast resolves in the caster's room. */
  _drawSupportThreat(caster, allyId, amount) {
    if (!(amount > 0)) return;
    for (const m of this.rooms[caster.location].mobs) {
      if (m.hp > 0 && m.aggro && m.aggro[allyId] != null) this._addThreat(m, caster.id, amount);
    }
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
    events.push({ type: "mob-hurt", roomId, mobId: mob.id, mobName: t.name, cause, damage: amount, mobHp: Math.max(0, mob.hp), emitsLight: t.emitsLight > 0, light: rt.light });
    if (mob.hp > 0) return null;
    const idx = rt.mobs.indexOf(mob);
    if (idx >= 0) rt.mobs.splice(idx, 1);
    this._adjustOwned(mob, -1);
    const loot = this._dropSpoils(mob, roomId);
    const xp = t.xp || 0;
    const participants = (killer && !mob.noSpoils) ? this._awardKillXp(mob, killer, xp, roomId) : []; // shared credit; summons award nothing
    rt.light = this.computeRoomLight(roomId); // a luminous mob dying changes the room
    const death = { type: "death", victimKind: "mob", victimId: mob.id, victimName: t.name, victimTemplate: mob.template, roomId, killerId: killer ? killer.id : null, loot, xp: (killer && !mob.noSpoils) ? xp : 0, cause, participants };
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
          if (eff.message) events.push({ type: "room-effect", playerId: p.id, text: eff.message, dimsRoom: r.doused > 0 });
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

module.exports = { GameState, makeItemInstance, addToFloor, makeMobInstance, actorEmitLight, playerDefence, effectiveSpeed, buyValueOf, sellValueOf, SELL_RATE, itemVisibleTo, fixtureVisibleTo, mobVisibleTo, effectivePerception, canPerceive, isDiscovered, discoveryKey, xpForLevel, effectiveAttributes, spellScaleBonus, durationScaleBonus, MELEE_SCALE, roomEffectFires };
