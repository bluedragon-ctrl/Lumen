"use strict";
// Status-effect engine + shared vitals helpers, split out of state.js (see PR
// refactor/split-state-mixins). Applying and ticking status effects (DoTs,
// heal-over-time, buffs), instant restores, out-of-combat mob recovery, the
// heal/douse/mana-drain primitives, and the room-effect action core shared by
// the tick driver and the on-enter driver (move() in commands.js).
//
// These are GameState methods, factored into a mixin: the class below is never
// instantiated — state.js copies its prototype methods onto GameState.prototype
// (see `mixin()` there), so every `this` here is a GameState and `this._foo()`
// reaches methods that live in state.js or the other mixins. Pure relocation —
// no behaviour change.
const { rollDice } = require("./dice");
const { roomEffectFires, playerDefence, mobDefence, wardNegates, wardPoolFor, effectiveAttributes, physicalDotSoak } = require("./combat-math");

// Default damage *type* for a room effect's `cause` (see applyRoomEffect): the dark
// drinks life as "void", the ember rooms burn as "physical". Only causes with a
// classified nature appear here; anything else stays untyped (untagged) unless the
// effect names its own `damage.damageType`. Light-bane's "light" is set at its own
// source (_environmentTick). Cosmetic today; a future resist pass reads the type.
const ENV_DAMAGE_TYPE = { darkness: "void", heat: "physical" };

// Out-of-combat recovery (see _recoverMobsTick): a wounded mob that
// nothing is fighting or watching, in a room clear of living foes, knits its
// wounds shut. It must hold OOC_REGEN_DELAY ticks past its last combat first (so
// a brief retreat barely helps), then mends maxHp/OOC_REGEN_TICKS per tick to
// full. The counter to flee-heal-return: a real heal-trip finds the mob whole.
// A per-mob `regen: { delay, perTick }` overrides either knob.
const OOC_REGEN_DELAY = 5; // ticks out of combat before recovery starts
const OOC_REGEN_TICKS = 20; // ticks to mend from empty to full (sets the default rate)

class EffectsMixin {
  /**
   * Apply a status-effect primitive to an actor. `spec` is the data-driven
   * descriptor authored on a potion/spell, e.g.
   *   { type: "emit-light", name: "Light", magnitude: 1, duration: 180 }
   * Effects stack as independent instances, each with its own countdown; the
   * engine reads them where relevant (emit-light is summed into room light).
   * `spec.refresh` opts out of stacking: any existing instance of the same
   * type+name is dropped first, so re-applying just resets the timer (the right
   * behaviour for buffs like Glimmerskin; DoTs leave it unset to keep stacking).
   * Returns true when the effect took hold, false when it was turned aside.
   */
  applyEffect(actor, spec) {
    if (!actor.states) actor.states = [];
    // A `dot-guard` (Cleanse's after-sheen) turns aside any NEW damage-over-time
    // while it holds — without it, the very next venomous swing undoes the
    // cleanse and the cast is wasted. Only fresh DoTs are refused; every other
    // effect type lands as usual. Callers read the false to skip the take-hold
    // narration (and any companion state, e.g. a smoulder's glow).
    if (spec.type === "damage-over-time" && actor.states.some((s) => s.type === "dot-guard"))
      return false;
    const name = spec.name || spec.type;
    if (spec.refresh) actor.states = actor.states.filter((s) => !(s.type === spec.type && s.name === name));
    actor.states.push({
      type: spec.type,
      name,
      magnitude: spec.magnitude || 0,
      armour: spec.armour || 0, // flat defence buffs (see "protect" / playerDefence)
      ward: spec.ward || 0,
      voidWard: spec.voidWard || 0, // vs void only, from a "protect" weave (Halo) — see playerDefence

      damage: spec.damage || null, // dice string, for "damage-over-time" (bleed/poison)
      damageType: spec.damageType || null, // "physical"/"magical" for a DoT tick, so the console names it (see _tickEffects)
      attrMod: spec.attrMod || null, // flat attribute bonuses, for "attr-buff" (folded into effectiveAttributes)
      maxHp: spec.maxHp || 0, // flat, timed max-HP bonus (a "fortify" buff — see _stateHpBonus / _refreshMaxHp)
      interval: spec.interval || null, // ticks between pulses, for periodic effects (heal-over-time)
      onDamage: Array.isArray(spec.onDamage) ? spec.onDamage : null, // reflect/retaliate triggers a buff grants while it holds (Fire Shield) — see combat-math stateOnDamage
      pulse: 0, // counts ticks toward the next pulse (see _tickEffects)
      sourceId: spec.sourceId || null, // player to credit if a DoT lands the kill
      source: spec.source || null, // "item" = sustained by worn/carried gear; survives death
      remaining: spec.duration != null ? spec.duration : null, // null = permanent
      good: spec.good !== false,
    });
    // A fortify buff lifts the pool the moment it lands: re-derive maxHp and
    // grant the added capacity as current HP (like a level-up). Player-only —
    // mobs carry a static template maxHp. Expiry clamps it back in _tickEffects.
    if (spec.maxHp && this.players.get(actor.id) === actor) this._refreshMaxHp(actor);
    return true;
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
   * Total active `slow` speed reduction on an actor (players or mobs). A `slow`
   * status (a vine-whip's snaring lash) shaves points off the rate the actor banks
   * action-energy each tick — so a slowed creature simply acts less often — read by
   * the tick driver's energy accrual (see advance()). Summed across live instances;
   * the caller floors the result so a slow can hobble but never fully freeze (that's
   * what `immobilize`/`sleep` are for).
   */
  slowAmount(actor) {
    if (!actor.states) return 0;
    let n = 0;
    for (const s of actor.states) if (s.type === "slow") n += s.magnitude || 0;
    return n;
  }

  /**
   * True if a defender's Ward fizzles this DoT pulse whole (no damage this tick).
   * The all-or-nothing roll a hostile *cast* faces (see wardNegates), applied per
   * due pulse against the pool that matches the tick's type — void → Voidward,
   * any other classified type → Spellward. Only an explicitly-typed non-physical
   * pulse can be resisted: physical (bleed/gash) and UNTYPED DoTs always land, so
   * legacy untyped bleeds keep their old behaviour rather than gaining a stealth
   * Spellward save. Each pulse rolls fresh; silent when it skips.
   */
  _dotResisted(s, defence) {
    return !!s.damageType && s.damageType !== "physical" && wardNegates(wardPoolFor(s.damageType, defence));
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
      let vit = null; // effective Vitality, computed lazily on the first physical DoT (soak = floor(vit/8))
      for (const s of p.states) {
        if (s.type !== "damage-over-time" || !s.damage) continue;
        if (this._dotResisted(s, playerDefence(this.world, p))) continue; // Ward shrugs this pulse
        let amount = Math.max(1, rollDice(s.damage));
        if (s.damageType === "physical") { // Vitality shrugs the lingering wound (player-only; see physicalDotSoak)
          if (vit === null) vit = effectiveAttributes(this.world, p).vitality || 0;
          amount = Math.max(1, amount - physicalDotSoak(vit));
        }
        if (this._hurtPlayer(p, amount, events, { cause: s.name || "bleed", damageType: s.damageType })) { dead = true; break; }
      }
      if (dead) continue;
      for (const s of p.states) {
        if (s.type !== "heal-over-time" || !this._pulseReady(s)) continue;
        const healed = this._heal(p, s.magnitude);
        if (healed) events.push({ type: "regen-tick", playerId: p.id, amount: healed, name: s.name });
      }
      const expired = this._expireStates(p, events, (s) => ({ type: "effect-expired", playerId: p.id, effectType: s.type, name: s.name }));
      if (expired.some((s) => s.maxHp)) this._refreshMaxHp(p); // a lapsed fortify drops maxHp; clamp current HP down
    }
    for (const [roomId, rt] of Object.entries(this.rooms)) {
      for (const m of [...rt.mobs]) {
        if (!m.states || !m.states.length) continue;
        let dead = false;
        for (const s of m.states) {
          if (s.type !== "damage-over-time" || !s.damage) continue;
          if (this._dotResisted(s, mobDefence(this.world.mobs[m.template], m))) continue; // Ward shrugs this pulse
          const src = s.sourceId ? this.players.get(s.sourceId) : null;
          if (this._hurtMob(m, roomId, Math.max(1, rollDice(s.damage)), events, { cause: s.name || "bleed", damageType: s.damageType, killer: src && src.hp > 0 ? src : null })) { dead = true; break; }
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
    if (!roomEffectFires(effect, this.rooms[roomId].light)) return { fired: false, doused: 0, died: false, silent: false };
    const a = effect.action || {};
    let doused = 0;
    let died = false;
    let silent = false; // the action ran but had no tangible effect (e.g. restore at full vitals) — suppress flavour
    if (a.douse) {
      doused = this._douse(player);
      if (doused) this.rooms[roomId].light = this.computeRoomLight(roomId);
    } else if (a.restore) {
      const got = this.applyRestore(player, a.restore);
      if (got.hp || got.mana) events.push({ type: "vitals", playerId: player.id });
      else silent = true; // already at full hp/mana — nothing to heal, so don't claim it
    } else if (a.damage) {
      // `cause` tags the hurt/death flavour (see events.js HURT_SRC); defaults to the
      // original darkness-drain wording so pre-existing rooms are unchanged.
      const cause = a.damage.cause || "darkness";
      // The damage *type* the console names (and a future resist pass will read):
      // the dark drinks life as "void", the ember rooms burn as "physical". An
      // effect may override per-room via `damage.damageType`; an unmapped cause
      // stays untyped (untagged) rather than guessing.
      const damageType = a.damage.damageType || ENV_DAMAGE_TYPE[cause] || null;
      if (a.damage.hp != null && this._hurtPlayer(player, Math.max(1, rollDice(a.damage.hp)), events, { cause, damageType })) died = true;
      if (!died && a.damage.mana != null && this._drainMana(player, Math.max(1, rollDice(a.damage.mana)))) events.push({ type: "vitals", playerId: player.id });
    }
    return { fired: true, doused, died, silent };
  }

  /** Count down an actor's timed states, dropping (and announcing via `mkEvent`)
   *  any that reach zero. Permanent states (remaining == null) persist. */
  _expireStates(actor, events, mkEvent) {
    if (!actor.states) return [];
    const expired = [];
    actor.states = actor.states.filter((s) => {
      if (s.remaining == null) return true;
      s.remaining -= 1;
      if (s.remaining <= 0) { expired.push(s); return false; }
      return true;
    });
    for (const s of expired) events.push(mkEvent(s));
    return expired;
  }
}

module.exports = EffectsMixin;
