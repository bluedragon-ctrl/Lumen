# Lumen — Phase 2: Summoning design

Status: approved design, pending implementation plan.
Builds on: Phase 1 (combatant-agnostic threat + instance faction/`ownerId`).

## Context

Lumen's combat now has instance-level **factions** and a **combatant-keyed threat
table** (Phase 1): a mob instance can be `faction: "player"` (allied) with an
`ownerId`, mob-vs-mob targeting/damage works, and support spells draw threat. A
*summon* — a temporary creature that fights for its summoner — is now expressible
but not yet built. This phase adds it via one **data-driven summon primitive**
reused by two callers:

1. **Player summon spell** — `Summon Wisp`: conjures a single allied Wisp for
   3 minutes (180 ticks). Learned from a scroll sold by Vesper the glimmer-mage.
2. **Gnaw reinforcements** — Gnaw, the Brood-Mother gets a weighted `summon`
   action that calls `giant-rat` reinforcements mid-fight, capped so the room
   can't flood.

The intended outcome: a player can summon an autonomous ally that follows them
and fights; a boss can sustain pressure by calling capped, spoil-less brood — both
through the same small mechanic.

### Decisions captured (from brainstorming)

- **Control model:** fully autonomous. The summon uses its own template AI (a
  summoned Wisp casts Spark at enemies on sight via Phase 1 faction logic). No
  pet/order commands in v1. **Plus follow** (below).
- **Cap model:** per **(owner, summonGroup)**, not global. Recasting the *same*
  summon spell dismisses and replaces that owner's existing summon of that group
  (timer resets). A *different* summon spell is a different group and coexists.
  v1 ships one group (`summon-wisp`), cap 1.
- **Gnaw:** weighted `summon` action with a **living-brood cap** (don't summon
  while `max` of her brood are alive). Reinforcements are permanent (no timer).
- **Lifecycle (player summon):** ends on the **timer OR owner-loss** (owner death
  *or* disconnect). Those endings **wink out silently** — no corpse, loot, XP, or
  death event. If an enemy *kills* it in combat first, it instead dies through the
  normal combat death path (a regular "dies"/"you slay" line) but still drops **no
  loot or XP** — the silent unravel is reserved for the timer/recast/owner-loss
  endings. (Implementation note: confirmed as the intended framing during build.)
- **Spoils:** summoned creatures (player Wisp *and* Gnaw's rats) yield **no loot
  and no XP** however they die — a `noSpoils` instance flag. Prevents summon-kill
  farming and matches the conjured-creature fantasy.

### Out of scope (v1)

Pet commands (order/attack/stay/dismiss), summon upkeep/mana drain over time,
multiple groups beyond what falls out for free, cross-room *enemy* pursuit,
summon persistence across server restart (no snapshot/resume exists yet).

### Open balance values (owner to set before/at implementation)

| Value | Where | Note |
|---|---|---|
| `Summon Wisp` mana cost | `spells.json` | |
| scroll name / price | `items.json`, Vesper `shop.sells` | scroll teaches `summon-wisp` |
| Gnaw `summon` weight `W` | `mobs.json` gnaw actions | per-turn chance |
| rats per summon `C` | gnaw action `count` | |
| brood cap `K` | gnaw action `max` | max living brood at once |

Duration is fixed by design at **180 ticks** (3 min) for the Wisp.

---

## Architecture — the summon primitive (`server/state.js`)

The primitive is one helper plus a lifetime tick and a dismiss helper, built on
the existing `_spawnMob` and Phase 1 faction/`ownerId`.

### New instance fields (stamped by `_summon`)

Alongside Phase 1's `faction` / `ownerId` on a mob instance:

- `summonerId` — id of whoever summoned it (a player **or** a mob instance id).
  Drives caps and identifies a creature as summoned.
- `summonGroup` — string tag scoping the per-owner recast cap. Defaults to the
  source spell id (e.g. `"summon-wisp"`); `null` for mob summons.
- `expiresIn` — integer ticks until wink-out, or `null` for permanent.
- `noSpoils` — `true` → no loot/XP on any death.

### `_summon({ roomId, mobId, count, faction, ownerId, summonerId, group, lifetime })`

- Loops `count` times calling `_spawnMob(roomId, mobId)` (the existing path), then
  stamps `faction`, `ownerId`, `summonerId`, `summonGroup = group`,
  `expiresIn = lifetime`, `noSpoils = true` on each new instance.
- Summoned instances get **no `origin`** → invisible to `_respawnTick` /
  `_countOwned` (they don't respawn and don't inflate room spawner caps).
- Recomputes room light (a glowing Wisp lights the room).
- Returns `{ mobs, events }` where `events` includes a `summon` event for narration.

### `_dismissSummon(mob, reason)`

- Removes the mob from its room (splice + `_adjustOwned(-1)` for symmetry, though
  summons have no origin), recomputes room light, and pushes a `summon-end` event
  (`reason`: `"expired"` | `"owner-gone"` | `"recast"`). **No** loot/XP/death event.
- Shared by every early-end path.

### Lifetime tick (in `advance()`)

A small pass (near `_tickEffects` / `_respawnTick`): for every mob with
`expiresIn != null`, decrement; at `<= 0`, `_dismissSummon(mob, "expired")`.

### Spoils honoring `noSpoils`

Guard `_dropSpoils` to return `[]` when `mob.noSpoils` — this covers **every**
death path, since both `_killMobAt` (direct/melee kill) and `_hurtMob` (DoT,
light-bane, environment) call it. Additionally suppress XP in those kill paths for
a `noSpoils` victim (`xp: 0`, `participants: []`). So an enemy slaying a summon, or
a player slaying Gnaw's rat, yields nothing — no loot, no XP.

### Cap scans (no separate counters)

- Player group cap: count living mobs with `ownerId === player.id &&
  summonGroup === group`. v1 cap is 1, enforced by recast-replace (below).
- Gnaw brood cap: count living mobs with `summonerId === gnaw.id`; the `summon`
  action is unavailable while that count `>= max`.

---

## Player summon spell (`server/commands.js` + data)

### Data

`data/world/spells.json` — new spell:

```json
"summon-wisp": {
  "name": "Summon Wisp",
  "manaCost": <N>,
  "effect": { "type": "summon", "mob": "wisp", "count": 1, "duration": 180, "group": "summon-wisp" }
}
```

`data/world/items.json` — new scroll teaching it (mirrors existing `scroll-*`):

```json
"scroll-summon-wisp": {
  "id": "scroll-summon-wisp", "name": "a scroll of Summon Wisp",
  "description": "...", "type": "misc", "value": <P>, "weight": 0,
  "scroll": { "spell": "summon-wisp" }
}
```

`data/world/mobs.json` — add `"scroll-summon-wisp"` to Vesper (`rim-mage`)
`shop.sells`.

### Cast routing

In `cast` (`commands.js`), **before** the hostile/beneficial split: if
`spell.effect.type === "summon"`, ignore any target text and route to a new
`castSummon(state, player, spell, ctx)` handler. It checks/spends mana, then calls
`state.castSummon(player, spell, events)` which:

1. **Recast-replace:** `_dismissSummon` every living mob with
   `ownerId === player.id && summonGroup === group` (`reason: "recast"`).
2. `_summon({ roomId: player.location, mobId: effect.mob, count: effect.count,
   faction: "player", ownerId: player.id, summonerId: player.id,
   group: effect.group || spellId, lifetime: effect.duration })`.
3. Return a result the handler narrates ("You weave the glimmer into shape, and a
   Wisp answers your call.").

The cap of 1-per-group is enforced entirely by step 1 (no extra counter).

---

## Gnaw `summon` mob action (`server/state.js` + data)

### Data

`data/world/mobs.json` — add to Gnaw's `actions`:

```json
{ "type": "summon", "weight": <W>, "mob": "giant-rat", "count": <C>, "max": <K>,
  "verb": "throws back her head and shrieks; vermin boil out of the dark" }
```

### Dispatch

In `_mobAct` option filtering (mirrors the `attack`/`cast` gates):

- A `summon` option is available iff `aggressive` (she's engaged) **and** the
  living-brood count for `summonerId === m.id` is `< a.max`.
- When chosen, call `_summon({ roomId, mobId: a.mob, count: a.count,
  faction: "wild", ownerId: null, summonerId: m.id, group: null, lifetime: null })`
  and push the `verb` line. Rats are `wild` (Gnaw's side → don't fight her, target
  players), permanent, spoil-less.

Killing a rat lowers the brood count, so Gnaw can summon again over a long fight —
sustained pressure capped at `K` alive.

---

## Follow + lifecycle hooks

### Follow (`server/commands.js` `move` + `state._moveSummonsWith`)

After `setPlayerLocation(player, dest)`:

- `state._moveSummonsWith(player, from, dest)`: for each living mob in `from` with
  `ownerId === player.id`, splice from `from.mobs` → push to `dest.mobs`, recompute
  light for **both** rooms, and collect a `summon-follow` event (depart + arrive
  lines). `move` folds the returned events into its output.
- A following summon abandons its current fight (enemies in `from` prune it from
  threat per Phase 1); it re-engages autonomously in `dest`. No enemy pursuit.
- Scoped to `ownerId`-bearing summons → Gnaw's wild rats never follow.

### Lifecycle hooks (all call `_dismissSummon`)

- **Owner death** — in `_respawn(player, …)`: dismiss the player's summons
  (`reason: "owner-gone"`).
- **Owner disconnect** — in `removePlayer(playerId)`: dismiss their summons.
- **Expiry** — the `advance()` lifetime tick.
- **Recast-replace** — same-group dismiss in `castSummon`.

---

## Rendering (`server/index.js`)

New event handlers, following existing `mob-spawn` / `mob-move` light-gating with
`canSeeMob` and room-view refreshes:

- `summon` — Wisp: "A Wisp coalesces from the gloom." Gnaw: her `verb` line; rats
  appear (light-gated names).
- `summon-end` — silent wink-out: "The Wisp unravels into motes and is gone."
  (no death/loot framing).
- `summon-follow` — depart line in `from`, arrive line in `dest`.

---

## Edge cases

- Summoned mob carries `noSpoils` → no loot/XP even when slain by an enemy/player.
- Phase 1 `_killerPlayerFor` / `_awardKillXp` already ignore mob-id aggro keys, so
  a Wisp landing a kill credits its owner only via primary-killer resolution —
  unchanged.
- No `origin` on summons → untouched by `_respawnTick` and `_countOwned`.
- `entityId` covers new instances; no snapshot/resume exists → no persistence
  migration.
- A Wisp summoned into a bright room obeys its own template behaviour (it has no
  `lightBane`/`flee`, so this is inert in v1).

---

## Verification

1. **`npm run validate`** exits 0 (new spell, scroll, Gnaw action cross-reference
   cleanly; Vesper sells a real item).
2. **Headless harness** (scratch, not committed), loading the real world:
   - `castSummon` → exactly one `faction:"player"` Wisp with correct
     `ownerId`/`summonGroup`/`expiresIn`/`noSpoils`.
   - Recast → prior Wisp dismissed, exactly one remains, timer reset.
   - Tick `expiresIn` to 0 → wink-out, room mob gone, no loot/XP/death event.
   - Enemy kills a summon → no loot/XP.
   - Gnaw `aggressive` summons rats up to `max`, not beyond; kill one → can summon
     again.
   - `_moveSummonsWith` → Wisp relocates with owner; wild rats do not.
   - Owner death and `removePlayer` → summons dismissed.
3. **Live run** (`npm start` on **3738**; restart after server edits — no hot
   reload): admin studies/buys the scroll from Vesper (or admin-casts),
   `cast summon-wisp`, walk between rooms (Wisp follows), fight a wild mob;
   `@spawn gnaw`, fight her, watch the brood spawn and cap. Capture the log pane.

## Workflow / deliverable

Branch `feat/summoning` off `main` (Phase 1's faction foundation must be merged
first — it is the substrate). Update `CHANGELOG.md` under `[Unreleased]` and
`docs/data-model.md` (the `summon` spell effect, the `summon` mob action, and the
instance fields `summonerId` / `summonGroup` / `expiresIn` / `noSpoils`).
Conventional commits; PR into `main`; maintainer merges (no self-merge).
