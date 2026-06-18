# Unify the mob hostile-action pipeline

**Date:** 2026-06-18
**Status:** Approved (design) — pending spec review
**Scope:** `server/state-mobai.js` (mob side only)

## Problem

`_mobAttack` (melee) and `_mobCast` (hostile spell) are parallel methods that
are really *one concept* — a mob takes a hostile action against its top-threat
enemy — differing only in the payload (physical damage / magical damage / status
effect / douse). Today they independently:

- select the target (`_topThreat` else random), and bail if none;
- stoke a base point of aggro (`_addThreat(m, target.id, 1)`);
- derive `isPlayer` / `tmt` / `targetName`;
- push an outcome event;
- rouse a resting player target and auto-retaliate.

Because the shared logic is duplicated, the two paths have **drifted**, and one
copy is wrong:

- `_mobCast` gates its rouse/retaliate tail on an explicit `killed` flag
  (`if (!isPlayer || killed || target.actor.hp <= 0) return;`). **Correct.**
- `_mobAttack` ignores `applyHitOutcome`'s return value and guards each tail
  line with `p.hp > 0`. **Ineffective:** `_respawn` sets `player.hp =
  player.maxHp` and `player.pending = null`, so after a *fatal* melee blow the
  player is respawned at the rim with full HP, and `_mobAttack` then sees
  `p.hp > 0` (true) and `!p.pending` (true) and sets `pending` to attack the mob
  that just killed them — emitting a spurious `combat-auto-start`. This fires on
  **every** melee kill of a player, not a rare edge.

The correct death signal is already available and discarded:
`applyHitOutcome` returns `{ defenderDeath, attackerDeath }`, and in `_mobAttack`
the player is the *defender*.

## Goal

Unify the shared orchestration into one pipeline with swappable payload
resolvers, so a melee hit and a hostile cast handle target selection, aggro,
death, and rouse/retaliate **consistently** — and fix the death-guard bug as a
direct consequence.

## Non-goals (explicitly out of scope this pass)

- **No combat-math change.** Ward still negates a spell cast wholesale and only
  percent-reduces a magical melee hit; armour still soaks physical. Payload
  resolution stays byte-identical.
- **No new triggers.** Spell damage still does *not* fire the defender's
  `onDamage` (the reserved `on:["spell"]` hook stays unwired); melee `onHit` is
  unchanged. (These remain easy follow-ups once the seams exist.)
- **Player side untouched.** `resolvePlayerAttacks` and the `castSpell` family
  (in `state.js`) are not part of this pass. The shared helpers are designed so
  the player side *could* adopt them later, but that work is deferred.

## Design

Four focused methods in `state-mobai.js` replace the two large ones. The two
public-ish entry points keep their signatures so `_mobAct`'s dispatch is
untouched.

### 1. Orchestrator — `_mobHostileAction(m, t, roomId, events, enemies, action)`

`action` is `{ kind: "melee" }` or `{ kind: "spell", spell }`.

```
const target = this._topThreat(m, enemies) || enemies[Math.floor(Math.random() * enemies.length)];
if (!target) return;
this._addThreat(m, target.id, 1);              // stick the mob to its quarry
const ctx = {
  m, t, roomId, rt: this.rooms[roomId], events, target,
  isPlayer: target.kind === "player",
  tmt: target.kind === "player" ? null : this.world.mobs[target.actor.template],
};
const died = action.kind === "spell"
  ? this._resolveSpellPayload(ctx, action.spell)
  : this._resolveMeleePayload(ctx);
if (ctx.isPlayer && !died) this._rouseAndRetaliate(target.actor, m, t, events);
```

### 2. `_resolveMeleePayload(ctx)` → `died` (boolean)

The current `_mobAttack` body from the ambush-reveal through `applyHitOutcome`,
verbatim, with two changes:

- capture the return: `const { defenderDeath } = this.applyHitOutcome({ ... });`
- `return !!defenderDeath;`

The rouse/retaliate tail is removed (moved to the orchestrator). `defenderDeath`
is authoritative: it also reflects a self-targeted `onDamage` that kills the
player after the initial blow, so it is strictly more correct than the old
`p.hp > 0` check.

### 3. `_resolveSpellPayload(ctx, spell)` → `died` (boolean)

The current `_mobCast` body from the ward roll through the `mob-cast` event
(and the `if (death) events.push(death)`), verbatim. Returns its existing
`killed` flag. The `!spell.hostile → _mobCastSelf` redirect and the `if (!spell)
return` guard stay in the `_mobCast` entry point (they run before target
selection).

Note: the old guard `|| target.actor.hp <= 0` is subsumed by returning `killed`
— after a damage payload `killed === (hp <= 0)`, and douse/effect payloads never
drop HP, so `died = killed` is equivalent.

### 4. `_rouseAndRetaliate(player, mob, t, events)`

The shared tail, with **no `hp > 0` guards** (the orchestrator only calls it when
the player is alive):

```
if (this._rouse(player)) events.push({ type: "player-woke", playerId: player.id });
if (!player.pending) {
  player.pending = { type: "attack", targetId: mob.id };
  events.push({ type: "combat-auto-start", playerId: player.id, targetId: mob.id, targetName: t.name });
}
```

### Entry points (thin; preserve current call sites)

```
_mobAttack(m, t, roomId, events, enemies) {
  return this._mobHostileAction(m, t, roomId, events, enemies, { kind: "melee" });
}

_mobCast(m, t, roomId, events, enemies, spellId) {
  const spell = this.world.spells[spellId];
  if (!spell) return;
  if (!spell.hostile) return this._mobCastSelf(m, t, roomId, events, spell);
  return this._mobHostileAction(m, t, roomId, events, enemies, { kind: "spell", spell });
}
```

## Behavior changes (exactly two, both from the single fix)

1. A melee blow that **kills** a player no longer mis-fires
   `combat-auto-start` / `pending` against the killer post-respawn.
2. Rouse + auto-retaliate is now **identical** for hits and casts.

Everything else is byte-identical: ward/armour math, `onHit`, the distinct
`attack` vs `mob-cast` event shapes, mob-vs-mob (no rouse/retaliate), aggro
stoking, target selection.

### Known pre-existing quirk left as-is

If a defender's reflect/`onDamage` kills the *mob* mid-exchange (attacker death),
the player still gets `pending` set against the now-dead mob. Both methods do
this today; the unification preserves it. Out of scope.

## Testing

Add `test/mob-combat.test.js` (`node --test`), with a mutable test world
carrying a mob template that has both an `attack` block and a hostile damage
spell, plus a douse/effect spell. Cases:

- **melee kills player** → a `death` event fires and **no** `combat-auto-start`
  event is emitted *(pins the bugfix)*.
- **melee non-fatal** → `combat-auto-start` fires exactly once, `player.pending`
  targets the mob, and a resting player is roused (`player-woke`).
- **cast (damage) kills player** → no `combat-auto-start` *(parity)*.
- **cast (damage) non-fatal** → rouse + retaliate fire.
- **cast (effect / douse) non-fatal** → effect applied, retaliate fires once.
- **mob-vs-mob (melee and cast)** → no `player-woke` / `combat-auto-start`.
- **target selection** → both paths pick the highest-threat enemy.

Plus the existing guarantees: `npm test` green, `npm run validate` exits 0, and
a multi-tick smoke run advances cleanly.

## Risk & mitigation

- **Hot combat path.** The `defenderDeath` capture in the melee resolver is new
  wiring; a mistake could mis-credit kills or break auto-retaliate. Mitigated by
  the test matrix above (kill vs survive for both payloads) and the smoke run.
- **Not a pure no-op.** This is a deliberate bugfix, so it is framed as
  `fix:` (with the unification as the vehicle), reviewed with the behavior-change
  list above stated explicitly, rather than as a behavior-preserving refactor.

## Method-count note

Goes from 2 methods to 4 (orchestrator + two resolvers + tail helper), all
small and single-purpose. This is consistent with the recent splits: the shared
behavior becomes explicit and independently testable rather than duplicated.
