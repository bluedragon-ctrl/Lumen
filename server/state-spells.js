"use strict";
// Spell-cast resolution + the summon primitive, split out of state.js (see PR
// refactor/split-state-mixins). Casting costs (costShortfall/spendCost), the
// hostile and beneficial per-effect cores shared by player and mob casts, the
// player cast entry points (castSpell, castRoomSpell, castBeneficial,
// castRoomBeneficial, castSummon), the area resolver detonateRoom (also the
// thrown-bomb engine — see commands/consume.js), support threat, and the
// summon lifecycle (_summon and its dismiss/relocate/lifetime ticks, used by
// both the player Summon spell and mob `summon` actions in state-mobai.js).
//
// These are GameState methods, factored into a mixin: the class below is never
// instantiated — state.js copies its prototype methods onto GameState.prototype
// (see `mixin()` there), so every `this` here is a GameState and `this._foo()`
// reaches methods that live in state.js or the other mixins. Pure relocation —
// no behaviour change.
const { rollDice } = require("./dice");
const { DEFAULT_FACTION } = require("./config");
const { makeMobInstance } = require("./instances");
const {
  effectiveAttributes, playerDefence, mobDefence,
  spellScaleBonus, durationScaleBonus, scaledAmount, wardNegates, mitigate,
} = require("./combat-math");

class SpellsMixin {
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

  /** This owner's live summons, optionally narrowed to one recast `group` —
   *  the world-wide scan behind the per-owner recast cap and owner-gone
   *  cleanup (few summons ever exist, so a scan is fine). */
  _ownedSummons(ownerId, group = null) {
    const owned = [];
    for (const rt of Object.values(this.rooms))
      for (const m of rt.mobs) if (m.ownerId === ownerId && (group == null || m.summonGroup === group)) owned.push(m);
    return owned;
  }

  /** Dismiss every summon owned by `ownerId` (owner death/disconnect). */
  _dismissOwnedSummons(ownerId, reason, events = []) {
    for (const m of this._ownedSummons(ownerId)) this._dismissSummon(m, reason, events);
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
    const inv = player.inventory || []; // same guard as costShortfall — the pair must agree
    for (const need of spell.itemCost || []) {
      let remaining = need.qty || 1;
      for (let i = inv.length - 1; i >= 0 && remaining > 0; i--) {
        const inst = inv[i];
        if (!inst || inst.template !== need.template) continue;
        const take = Math.min(remaining, inst.qty || 1);
        if (inst.qty != null && inst.qty > take) inst.qty -= take;
        else inv.splice(i, 1);
        remaining -= take;
      }
    }
  }

  /** A target's live defence profile, dispatching on kind — the one place both
   *  directions of hostile casting (a player's target mob, a mob's target
   *  player or mob) resolve Armour/Ward for the wholesale Ward-negate roll and
   *  the `mitigate()` reduction step. */
  _defenceOf(target) {
    return target.kind === "player"
      ? playerDefence(this.world, target.actor)
      : mobDefence(this.world.mobs[target.actor.template], target.actor);
  }

  /**
   * Apply one hostile spell effect that already passed the target's Ward roll —
   * the per-type core shared by BOTH directions of casting (a player's castSpell
   * and a mob's _resolveSpellPayload), so damage scaling, DoT duration-baking and
   * the companion glow can never drift apart between them. `attrs` is the
   * caster's attribute block (a player's effective attributes, a mob template's
   * `attributes`); `sourceId` stamps a DoT so a smoulder-kill credits that player
   * (a mob's burn credits no one). Direction-specific work — dealing rolled
   * damage to hp, threat, kill resolution, light recompute and narration — stays
   * with the caller. Returns { kind, ... }:
   *   { kind: "damage", damage }        — rolled+scaled (Armour-mitigated if
   *                                       `damageType: "physical"`); caller applies it
   *   { kind: "dot", name, duration }   — burn (+ its glow) already applied
   *   { kind: "sleep" }                 — mob target dropped into slumber
   *   { kind: "douse", doused, name }   — target's carried light snuffed (players only)
   *   { kind: "status", name }          — any other type: a hostile status (a
   *                                       debuff/hex) applied as-is
   *   { kind: "unhandled" }             — a typed case refused this target (e.g.
   *                                       sleep at a player); warned — the
   *                                       command guard / validator should have
   *                                       refused it upstream
   */
  _applyHostileSpellEffect(eff, spellName, attrs, target, sourceId = null) {
    const name = eff.name || spellName;
    switch (eff.type) {
      case "damage": {
        let damage = Math.max(1, rollDice(eff.damage) + spellScaleBonus(attrs, eff.scale));
        // A physical-type spell (Iron Blast's hurled iron) is a blow, not a weave:
        // it's soaked flat by Armour, never touched by Ward (whose one shot was the
        // wholesale cast-negate the caller already rolled — see wardNegates callers).
        // Non-physical spells land at full roll here; a percent cut too would
        // double-count the Ward fizzle that already gated them.
        if (eff.damageType === "physical") damage = mitigate(damage, "physical", this._defenceOf(target));
        return { kind: "damage", damage };
      }
      case "drain": {
        // A necromantic siphon (Leech): lands like a non-physical damage weave
        // — Ward's wholesale negate already ran in the caller — and hands the
        // caller a drainFactor so it can heal the CASTER from the damage it
        // deals. The heal stays caller-side: only the caller knows the caster
        // and applies the rolled damage.
        const damage = Math.max(1, rollDice(eff.damage) + spellScaleBonus(attrs, eff.scale));
        return { kind: "damage", damage, drainFactor: eff.healFactor || 0.5 };
      }
      case "mana-drain": {
        // A siphon of will (a void leech's Leech Warmth): drinks the target's mana
        // rather than wounding them — no HP damage at all. Only a spellcaster (a
        // player) carries any mana, so it finds nothing on a mob. The amount rolls
        // from `drain` (dice), scaled by the caster's attribute. The drain itself is
        // caller-side: only the caller knows the target actor and narrates it.
        const amount = Math.max(1, rollDice(eff.drain || eff.damage) + spellScaleBonus(attrs, eff.scale));
        return { kind: "mana-drain", amount };
      }
      case "damage-over-time": {
        // A clinging burn (Witchfire): no immediate blow, but a DoT whose length
        // scales with the caster (more total damage, a longer-lasting mark)
        // rather than hitting harder. Per-tick damage runs in _tickEffects.
        const duration = (eff.duration || 0) + durationScaleBonus(attrs, eff.durationScale);
        this.applyEffect(target.actor, { type: "damage-over-time", name, damage: eff.damage, duration, sourceId, good: false });
        // The burning glimmer glows: a matching emit-light state marks the foe in
        // the dark for as long as it smoulders (summed in by computeRoomLight).
        if (eff.emitLight) this.applyEffect(target.actor, { type: "emit-light", name, magnitude: eff.emitLight, duration, good: false });
        return { kind: "dot", name, duration };
      }
      case "sleep":
        // A non-damaging hex that drops a foe into slumber, making it inert (see
        // resolveMobAI) until any blow rouses it. Only a mob can be lulled today.
        if (target.kind !== "mob") break;
        target.actor.posture = "sleeping";
        return { kind: "sleep" };
      case "douse": {
        // Snuff the target's carried light — a shadow's signature reach. Only a
        // player wields a doused-able lit source (a mob's glow is innate, not a
        // kindled flame), so it no-ops on a mob target.
        let doused = false;
        if (target.kind === "player") {
          const li = target.actor.equipment && target.actor.equipment.light;
          if (li && li.lit) { li.lit = false; doused = true; }
        }
        return { kind: "douse", doused, name };
      }
      default:
        // A hostile status effect (a debuff/hex — any type without its own case
        // above): applied as-is, marked hostile (`good: false`), no immediate
        // blow. No sourceId — a lingering hex credits no kill. The player cast
        // guard (magic.js HOSTILE_EFFECTS) and the validator's MOB_CASTABLE
        // whitelist still gate what authored data may use; this keeps the engine
        // able to land whatever they admit.
        this.applyEffect(target.actor, { ...eff, name, good: false });
        return { kind: "status", name };
    }
    // Only reachable when a typed case refused this target (sleep at a player).
    console.warn(`[lumen] spell "${spellName}": no hostile resolution for effect type "${eff.type}" on a ${target.kind} target`);
    return { kind: "unhandled" };
  }

  /**
   * Resolve an immediate spell cast by a player at a mob. Spends the cost, rolls
   * the target's Ward to (maybe) fizzle the whole spell, then applies the effect
   * primitive via the shared `_applyHostileSpellEffect`. Hostile spells earn the
   * target's threat even when resisted. Returns a result the caller narrates:
   * { resisted } | { slept } | { dot, duration, name } | { damage, killed, death }.
   *
   * Cost and target validation happen in the command handler; by here the cast
   * is committed. `events` receives the side-effects the caller must deliver
   * (a rousted sleeper, auto-retaliation) — see the cast command in magic.js.
   */
  castSpell(player, spell, mob, events = []) {
    const w = this.world;
    const eff = spell.effect || {};
    this.spendCost(player, spell);

    // Ward negates a hostile spell *cast* wholesale — but only a non-physical one.
    // A physical spell (Iron Blast's hurled iron) is a blow, not a weave: Ward can't
    // fizzle it; it always lands and is soaked by Armour below (see mitigate).
    const ward = mobDefence(w.mobs[mob.template], mob).ward || 0;
    if (spell.hostile && eff.damageType !== "physical" && wardNegates(ward)) {
      this._addThreat(mob, player.id, 1); // a fizzled bolt still draws its ire
      return { resisted: true };
    }

    const applied = this._applyHostileSpellEffect(eff, spell.name, effectiveAttributes(w, player), { kind: "mob", actor: mob }, player.id);

    // Sleep: Ward had its wholesale chance to negate above; on success it draws
    // no threat and does NOT rouse or auto-engage — the point is to slip away or
    // line up an ambush.
    if (applied.kind === "sleep") {
      this.rooms[player.location].light = this.computeRoomLight(player.location);
      return { resisted: false, slept: true };
    }

    const result = { resisted: false };
    if (applied.kind === "damage") {
      result.damage = applied.damage;
      // Damage, threat and any kill resolve in the shared sink. Silent: the cast
      // command narrates the blow — and the kill, so magic.js filters the death
      // event out of its dispatch for the same reason.
      result.death = this._hurtMob(mob, player.location, applied.damage, events, { silent: true, threatTo: player.id, killer: player });
      if (result.death) result.killed = true;
      // A drain heals the caster from the blow it just dealt (capped at max).
      if (applied.drainFactor) {
        const heal = Math.min(player.maxHp - player.hp, Math.floor(applied.damage * applied.drainFactor));
        if (heal > 0) { player.hp += heal; result.drained = heal; }
      }
    } else if (applied.kind === "dot") {
      // Stamped with the caster above, so a smoulder-kill credits them (like a bleed).
      this._addThreat(mob, player.id, 1);
      result.dot = true;
      result.duration = applied.duration;
      result.name = applied.name;
    } else if (spell.hostile) {
      this._addThreat(mob, player.id, 1);
    }
    // A kill may remove a luminous mob; refresh the room's light either way.
    this.rooms[player.location].light = this.computeRoomLight(player.location);

    // A hostile spell rouses a resting mob just as a blow does (only if it survived),
    // and sticks the caster to it: if the player isn't already attacking something,
    // they auto-engage this mob.
    if (spell.hostile && mob.hp > 0) {
      this._rouseMob(mob, player.location, events);
      if (player.hp > 0) this._autoEngage(player, mob, events);
    }

    return result;
  }

  /**
   * Resolve a hostile area spell (`effect.type === "damage-room"`, e.g. Arc Flash) cast
   * by a player. Spends mana, shards and any `itemCost` material (e.g. Flame Burst's
   * guano), then blasts every mob in `targets` (the caller has already filtered to the
   * eligible) through the shared bomb resolver, folding the caster's Intellect in as a
   * flat per-target damage bonus. A room spell's `dot` (Flame Burst's follow-up burn)
   * gets its duration scaled by Intellect here too, the same as a single-target
   * `damage-over-time` spell (see castSpell). Returns detonateRoom's per-target results
   * for the caller to narrate.
   */
  castRoomSpell(player, spell, targets, events = []) {
    const eff = spell.effect || {};
    this.spendCost(player, spell);
    const attrs = effectiveAttributes(this.world, player);
    const bonus = spellScaleBonus(attrs, eff.scale);
    const spec = eff.dot
      ? { ...eff, dot: { ...eff.dot, duration: (eff.dot.duration || 0) + durationScaleBonus(attrs, eff.dot.durationScale) } }
      : eff;
    return this.detonateRoom(player, spec, targets, bonus, events, true); // a magical burst rolls each foe's Ward
  }

  /**
   * Resolve a thrown area bomb (a consumable's `damage-room` effect), applying it to
   * every mob in `targets` (the caller has already filtered to the eligible — hostile
   * or already-engaged — mobs, so a stray toss never blasts a peaceful shopkeeper).
   * A bomb (or room spell) carries an instant burst (`damage`, fresh-rolled per
   * target), a lingering `dot` ({ name, damage, duration, emitLight? } — a
   * corroding/poison/burning cloud applied as a damage-over-time state, credited to
   * the thrower like an `onHit` venom, and optionally a matching emit-light state
   * for a DoT that glows, e.g. Flame Burst), or both.
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
      // A physical burst (Iron Blast's shrapnel) can't be warded off — it always
      // lands and is soaked by Armour below.
      if (wardCheck && spec.damageType !== "physical" && wardNegates(mobDefence(t, mob).ward || 0)) {
        this._addThreat(mob, player.id, 1);
        results.push({ id: mob.id, name: t.name, damage: 0, dot: false, resisted: true, killed: false, death: null });
        continue;
      }
      let damage = 0;
      let death = null;
      if (spec.damage != null) {
        damage = Math.max(1, rollDice(spec.damage) + bonus);
        // A physical burst is soaked flat by each foe's Armour; a magical one isn't
        // (its only defence was the Ward negation above).
        if (spec.damageType === "physical") damage = mitigate(damage, "physical", mobDefence(t, mob));
        // Threat is folded into the sink — a survivor keeps the thrower in its sights.
        death = this._hurtMob(mob, roomId, damage, events, { cause: spec.cause || "blast", killer: player, threatTo: player.id });
      }
      // A lingering cloud sinks a DoT into anything the burst didn't outright kill,
      // stamped with the thrower so a corrosion kill credits them (like a bleed).
      let dot = false;
      if (spec.dot && !death) {
        this.applyEffect(mob, { type: "damage-over-time", name: spec.dot.name || spec.cause || "poison", damage: spec.dot.damage, duration: spec.dot.duration, sourceId: player.id, good: false });
        // A burning cloud (Flame Burst) sheds its own light for as long as it smoulders.
        if (spec.dot.emitLight) this.applyEffect(mob, { type: "emit-light", name: spec.dot.name || spec.cause || "poison", magnitude: spec.dot.emitLight, duration: spec.dot.duration, good: false });
        this._addThreat(mob, player.id, 1); // the splash sticks the thrower in its sights
        dot = true;
      }
      if (!death) this._rouseMob(mob, roomId, events);
      results.push({ id: mob.id, name: t.name, damage, dot, killed: !!death, death });
    }
    rt.light = this.computeRoomLight(roomId); // a luminous mob blasted apart changes the room
    return results;
  }

  /**
   * Apply one beneficial spell effect to `target`, baked from `attrs` — the
   * per-type core shared by every support direction: a player's single-target
   * cast (castBeneficial), a player's room-wide weave (castRoomBeneficial), and
   * a mob's self/room support (_mobCastSelf / _mobCastRoomSupport). `target` is
   * the normalized descriptor { kind: "player"|"mob", actor, name, id, roomId,
   * emitsLight }. `heal-over-time` bakes its per-pulse magnitude from the
   * caster's scaling attribute at cast time (so the power follows the caster,
   * while an innate mob regen authors `magnitude` directly); `protect` likewise
   * bakes its armour/ward; an instant `restore` tops up hp/mana now.
   *
   * Threat is the CALLER's concern: the result carries a `threat` hint (HP/mana
   * mended, a flat 1 for a pure buff) that player casts feed to
   * _drawSupportThreat and mob casts ignore. Take-hold narration goes through
   * `events` (_narrateEffectApplied); callers forward or drop those. Returns
   * { effect, name, threat, perPulse?, restored?, armour?, ward?, duration? }.
   */
  _applyBeneficialSpellEffect(attrs, spell, target, events) {
    const eff = spell.effect || {};
    const roomId = target.kind === "player" ? target.actor.location : target.roomId;

    if (eff.type === "restore") {
      const got = this.applyRestore(target.actor, eff);
      return { effect: "restore", name: spell.name, restored: got, threat: (got.hp || 0) + (got.mana || 0) };
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
      // glow (see _applyHostileSpellEffect) and the way a quaffed light potion lifts the room.
      if (eff.emitLight) {
        this.applyEffect(target.actor, { type: "emit-light", name: eff.name || "protect", magnitude: eff.emitLight, duration, refresh: eff.refresh, good: true });
        this.rooms[roomId].light = this.computeRoomLight(roomId);
      }
      this._narrateEffectApplied(events, target, eff.name || eff.type);
      return { effect: "protect", name: spell.name, armour, ward, light: eff.emitLight || 0, duration, threat: 1 }; // a pure buff: a flat sliver of threat
    }

    if (eff.type === "cleanse") {
      const states = target.actor.states || [];
      const removed = states.filter((s) => s.type === "damage-over-time");
      target.actor.states = states.filter((s) => s.type !== "damage-over-time");
      return { effect: "cleanse", name: spell.name, removed: removed.length, threat: removed.length || 1 };
    }

    // Status effects (heal-over-time, emit-light, and future buffs). Bake any
    // caster scaling into the magnitude so the instance carries a fixed strength.
    const bonus = spellScaleBonus(attrs, eff.scale);
    const raw = (eff.magnitude || 0) + bonus;
    // A *darkness* aura is an emit-light effect authored with a negative magnitude
    // (it drinks the room's light rather than sheds it — see computeRoomLight, which
    // sums a source's output be it positive or negative). Preserve the negative; a
    // positive weave still floors at 1 when it scales, so a scaling source always shows.
    const magnitude = raw < 0 ? raw : Math.max(eff.scale ? 1 : 0, raw);
    // Lifetime can scale with the caster (durationScale, ticks per point) on top of
    // any flat base — a keener mage holds Candlelight longer, like a longer-lived summon.
    const duration = eff.durationScale
      ? (eff.duration || 0) + durationScaleBonus(attrs, eff.durationScale)
      : eff.duration;
    this.applyEffect(target.actor, { ...eff, magnitude, duration });
    // A light-shedding weave (Candlelight) brightens the room at once, like a potion.
    if (eff.type === "emit-light") this.rooms[roomId].light = this.computeRoomLight(roomId);
    this._narrateEffectApplied(events, target, eff.name || eff.type);
    return { effect: eff.type, name: spell.name, perPulse: magnitude, interval: eff.interval || 1, duration: duration || 0, threat: magnitude }; // mend-over-time: per-pulse magnitude as threat
  }

  /**
   * Resolve a beneficial (non-hostile) spell cast by a player on ONE target.
   * Spends the full cost, applies the effect via the shared beneficial core,
   * then draws support threat: mending or buffing an ally makes whatever is
   * fighting that ally turn on the caster too (see `_drawSupportThreat`),
   * mirroring the damage→threat convention. Returns the core's result for the
   * caller to narrate.
   */
  castBeneficial(player, spell, target, events = []) {
    this.spendCost(player, spell);
    const res = this._applyBeneficialSpellEffect(effectiveAttributes(this.world, player), spell, target, events);
    this._drawSupportThreat(player, target.id, res.threat);
    return res;
  }

  /**
   * Resolve a player's room-wide support spell (`target: "room"`): one cost,
   * the full caster-baked effect laid on every target in `targets` (the caller
   * has gathered the caster + their co-located allies — see _friendliesInRoom).
   * Support threat fires per ally mended, so a room-wide heal draws a room's
   * worth of healer-aggro. Returns one { id, name, isSelf, res } per target.
   */
  castRoomBeneficial(player, spell, targets, events = []) {
    this.spendCost(player, spell);
    const attrs = effectiveAttributes(this.world, player);
    return targets.map((t) => {
      const res = this._applyBeneficialSpellEffect(attrs, spell, t, events);
      this._drawSupportThreat(player, t.id, res.threat);
      return { id: t.id, name: t.name, isSelf: !!t.isSelf, res };
    });
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
    const existing = this._ownedSummons(player.id, group);
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
}

module.exports = SpellsMixin;
