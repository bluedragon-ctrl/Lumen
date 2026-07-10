"use strict";
// The Tide (world clock) subsystem, split out of state.js (see PR
// refactor/split-state-mixins). Phase resolution and transitions, the
// worldwide darkening, NPC lamp-tending, the onset roster / ebb sweep, the
// per-tick predator creep, ambient phase emotes, and the per-room light
// offset. The clock's pure math lives in world-clock.js; the resolved config
// and current phase are constructed on GameState (see its constructor).
//
// These are GameState methods, factored into a mixin: the class below is never
// instantiated — state.js copies its prototype methods onto GameState.prototype
// (see `mixin()` there), so every `this` here is a GameState and `this._foo()`
// reaches methods that live in state.js or the other mixins. Pure relocation —
// no behaviour change.
const { tidePhaseAt, tideOffset } = require("./world-clock");
const { makeMobInstance } = require("./instances");

// Factions whose NPCs tend lamps against the Tide: the Rim's human settlers and
// the Umbrals. The wild fauna and beasts won't work a switch (see _setTideLamps).
const LAMP_TENDER_FACTIONS = new Set(["rim", "umbral"]);

class TideMixin {
  // Each tick, resolve the current phase (from the clock, or a pinned override)
  // and, when it changes, apply the transition: every room's effective light
  // shifts at once, predators stir on the way in and sink back on the way out.

  /** Is `phase` one of the dark phases — the ones that plunge the world into the
   *  void and loose the Tide's predators (as opposed to the gentle edge dims)? */
  _isDarkPhase(phase) {
    return (this.tide.darkening.tidePhases || ["tide"]).includes(phase);
  }

  /** Resolve the tide phase for this tick and, if it changed, apply it. */
  _tideTick(events) {
    if (!this.tide.enabled) return;
    const phase = this.tideOverride || tidePhaseAt(this.tick, this.tide.phaseTicks, this.tide.phases).phase;
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
    if (!this.tide.enabled) return { enabled: false, phase: this.tide.phases[0] || "calm", intensity: 0 };
    const info = tidePhaseAt(this.tick, this.tide.phaseTicks, this.tide.phases);
    const phase = this.tideOverride || info.phase;
    // Intensity keys off how a phase darkens the world: full during a dark phase,
    // partial during an edge (warning/ebb) phase, none otherwise. Under the live
    // clock the edge phases ramp/ebb with progress through the phase.
    const isDark = this._isDarkPhase(phase);
    const edgePhases = this.tide.darkening.edgePhases || [];
    const isEdge = edgePhases.includes(phase);
    let intensity;
    if (this.tideOverride) {
      intensity = isDark ? 1 : isEdge ? 0.5 : 0;
    } else {
      const frac = Math.min(1, info.sinceStart / (this.tide.phaseTicks[phase] || 1));
      // An edge phase before a dark one ramps up; one after it ebbs down. Heuristic:
      // ramp while the next phase is darker (approaching the Tide), ebb otherwise.
      const ramping = isEdge && this._edgeRampsUp(phase);
      intensity = isDark ? 1 : isEdge ? (ramping ? frac : 1 - frac) : 0;
    }
    return { enabled: true, phase, intensity: Math.round(intensity * 100) / 100 };
  }

  /** For the HUD: does this edge phase build toward the dark (ramp up) or follow
   *  it (ebb down)? True when the next phase in the cycle is a dark phase. */
  _edgeRampsUp(phase) {
    const order = this.tide.phases;
    const i = order.indexOf(phase);
    if (i < 0) return false;
    const next = order[(i + 1) % order.length];
    return this._isDarkPhase(next);
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
    // NPCs light their lamps against the gathering dark (the lamp `onPhases`) and
    // snuff them once it has receded (the `offPhases`) — before spawn, so a lit
    // camp's brightness already repels the predators' maxLight check. A phase in
    // neither list leaves the lamps as they are.
    const lamp = this.tide.lamp || {};
    if ((lamp.onPhases || []).includes(phase)) this._setTideLamps(true, events);
    else if ((lamp.offPhases || []).includes(phase)) this._setTideLamps(false, events);
    if (this._isDarkPhase(phase)) this._tideSpawn(events);
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

  /** Loose the Tide's onset roster — mobs the dark pours across whole depth bands
   *  the instant it comes in. Data-driven from `tide.spawns` (empty by default, so
   *  the dark comes empty-handed unless a world authors a roster). Each rule:
   *  { mob, minDepth, maxDepth, count, maxLight, faction, noSpoils }. A rule skips
   *  any room already brighter than `maxLight`, so a lit camp keeps the hunters
   *  out. Spawned mobs are tagged `tideSpawn` so the ebb can reclaim them; they
   *  carry no spawner `origin` (never repop, never count against a room's cap). */
  _tideSpawn(events) {
    const roster = this.tide.spawns;
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
        events.push({ type: "mob-spawn", roomId, mobId: last.id, mobTemplate: rule.mob, mobName: t.name, emitsLight: t.emitsLight > 0, light });
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
        // The exit flavour is the creature's own (mobs.json `despawnVerb`); the ebb
        // just falls back to a generic sink if the mob authors none.
        events.push({ type: "mob-flee", roomId, mobName: t.name, emitsLight: t.emitsLight > 0, light: rt.light, verb: t.despawnVerb || "sinks back into the dark" });
      }
      if (removed) rt.light = this.computeRoomLight(roomId); // a dark predator leaving lifts the gloom
    }
  }

  /** The Tide's living teeth, per tick (called from advance only while in a dark
   *  phase). `tide.predator` is one rule or an ARRAY of them — several predators
   *  sharing the dark, each ticked independently (its own mob, cap and light
   *  threshold), so a deeper, more numerous swarm can pool where the void runs
   *  deepest alongside the shallower hunters. */
  _tideCreepTick(events) {
    const cfg = this.tide.predator;
    if (!cfg) return;
    for (const rule of Array.isArray(cfg) ? cfg : [cfg]) this._tideCreepRule(rule, events);
  }

  /** One predator rule's per-tick creep. The dark itself births the mob beside a
   *  delver who has let their light fail: every room holding a living player whose
   *  effective light is at or below the rule's `maxLight` (default -1 — anywhere the
   *  delver's own light has failed; a deeper predator sets it lower, e.g. -4) has
   *  `chance` to spawn one right there. Capped at `cap` of THIS mob worldwide, so a
   *  long dark mounts pressure toward the cap rather than flooding, and each predator
   *  swarms to its own ceiling. A room brighter than `maxLight` is never a birthplace
   *  — keeping a flame is the whole counterplay — and a spawn that strays into light
   *  is seared by its lightBane as usual. Spawns are tagged `tideSpawn`, so the ebb's
   *  `_tideSweep` reclaims any still abroad; they carry no `origin` (never repop, and
   *  their pursuit is unleashed — the dark does not give up). */
  _tideCreepRule(cfg, events) {
    if (!cfg || !cfg.mob || !this.world.mobs[cfg.mob]) return;
    const cap = cfg.cap != null ? cfg.cap : 5;
    const maxLight = cfg.maxLight != null ? cfg.maxLight : -1;
    let alive = 0; // living tide-spawned mobs of THIS template already abroad (the cap)
    for (const rt of Object.values(this.rooms))
      for (const m of rt.mobs) if (m.tideSpawn && m.hp > 0 && m.template === cfg.mob) alive++;
    if (alive >= cap) return;
    const chance = cfg.chance != null ? cfg.chance : 0.05;
    const t = this.world.mobs[cfg.mob];
    for (const [roomId, rt] of Object.entries(this.rooms)) {
      if (alive >= cap) break;
      if (rt.light > maxLight) continue; // only where the dark is deep enough for this predator
      if (!this.playersIn(roomId).some((p) => p.hp > 0)) continue; // beside a living delver
      if (Math.random() >= chance) continue;
      const m = makeMobInstance(cfg.mob, this.world);
      m.tideSpawn = true; // the ebb reclaims it (see _tideSweep)
      m.faction = cfg.faction || "wild";
      m.noSpoils = !!cfg.noSpoils;
      rt.mobs.push(m);
      alive++;
      const light = (rt.light = this.computeRoomLight(roomId)); // a dark-shedding predator deepens the room
      events.push({ type: "mob-spawn", roomId, mobId: m.id, mobTemplate: cfg.mob, mobName: t.name, emitsLight: t.emitsLight > 0, light, tideCreep: true });
    }
  }

  /** Ambient Tide emotes: the world clock itself performs atmospheric lines during
   *  a phase that authors one in `tide.emotes[phase]` — flavour with no home on any
   *  mob. Config per phase: { everyTicks, chance, requireDark, lines:[...] }. Fires
   *  at most once per `everyTicks`, per occupied room, gated by `chance` and (if
   *  `requireDark`) a failed-light room. A `tide-emote` event carries the line. */
  _tideEmoteTick(events) {
    const cfg = this.tide.emotes && this.tide.emotes[this.tidePhase];
    if (!cfg || !Array.isArray(cfg.lines) || !cfg.lines.length) return;
    const every = cfg.everyTicks || 0;
    if (every > 0 && this.tick % every !== 0) return;
    const chance = cfg.chance != null ? cfg.chance : 1;
    for (const [roomId, rt] of Object.entries(this.rooms)) {
      if (cfg.requireDark && rt.light >= 0) continue; // only where the dark has taken hold
      if (!this.playersIn(roomId).some((p) => p.hp > 0)) continue; // nobody to feel it
      if (chance < 1 && Math.random() >= chance) continue;
      const text = cfg.lines[Math.floor(Math.random() * cfg.lines.length)];
      events.push({ type: "tide-emote", roomId, text });
    }
  }

  /** The Tide's light offset for a room right now (≤ 0): the current phase's
   *  depth-scaled darkening, folded into ambient by computeRoomLight. 0 when the
   *  system is disabled or the world is Calm. See world-clock.js. */
  tideOffsetFor(roomId) {
    if (!this.tide.enabled) return 0;
    const room = this.world.rooms[roomId];
    return tideOffset(this.tidePhase, room ? room.depth : 0, this.tide.darkening);
  }
}

module.exports = TideMixin;
