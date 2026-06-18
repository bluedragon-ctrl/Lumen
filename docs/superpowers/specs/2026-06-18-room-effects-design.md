# Room effects — design

A room can act on the players standing in it: once when they **enter**, or
regularly while they **stay**. The first content uses three shapes — a waterfall
that douses carried lights on arrival, an inn that mends HP/mana while you rest,
and a deep room where, left in the dark, something drinks your warmth.

## Goals

- Author room effects as **JSON edits to `rooms.json`**, no new code per room
  (data-driven first).
- Reuse the existing damage/restore machinery and the `lightBane` light-condition
  idea rather than inventing a parallel system.
- Keep room effects **on the room** — they never become carried `player.states`
  that could follow a player out the door.

## Scope (v1)

- **Players only.** Mobs already have `lightBane` for environmental hazards; room
  effects do not touch them.
- **Light-only conditions.** The only gate is the room's effective light level.
- **Walking only.** Enter-effects fire on `move()`. Respawn/login into an
  effect-bearing room does not fire enter-effects in v1.

Out of scope: mob targeting, non-light conditions (posture, inventory, faction),
and any UI beyond the existing event→client text path.

## Data model

A room (`data/world/rooms.json`) gains an optional `effects` array. Each entry is
a **RoomEffect**:

```json
"effects": [
  { "trigger": "enter",
    "action": { "douse": true },
    "message": "Cold spray drowns your flame in a hiss of steam." },

  { "trigger": "tick", "interval": 3,
    "action": { "restore": { "hp": 1, "mana": 1 } } },

  { "trigger": "tick", "when": { "lightBelow": 1 },
    "action": { "damage": { "hp": "1d2", "mana": "1d2" } },
    "message": "The dark presses close and drinks the warmth from you." }
]
```

| Field         | Type     | Notes |
|---------------|----------|-------|
| `trigger`     | enum     | `"enter"` (fires once, on arrival) or `"tick"` (fires while present). |
| `when`        | block?   | Optional light condition. Exactly one of `lightBelow: N` (fires when room effective light **< N**; `lightBelow: 1` = total darkness) or `lightAbove: N` (fires when light **> N**, mirroring `lightBane.above`). Omitted = unconditional. |
| `interval`    | integer? | Tick-trigger only. Fire every N ticks via global `tick % interval === 0` (no per-player counter). Default 1. Ignored for enter. |
| `action`      | block    | Exactly **one** action key (see below). |
| `message`     | string?  | Flavour shown to the affected player when the effect fires. |
| `roomMessage` | string?  | Optional line shown to the other players in the room. |

### Actions

Exactly one key per `action`:

| Action    | Shape                         | Effect |
|-----------|-------------------------------|--------|
| `douse`   | `true`                        | Extinguish **every lit light source the player carries** (equipped `light` slot + inventory): set `lit = false`, then recompute room light. A non-refuellable husk is left as-is (not consumed — unlike burning out). |
| `restore` | `{ hp?: int, mana?: int }`    | Flat restore, clamped to maxima. Reuses `applyRestore(actor, { hp, mana })`. |
| `damage`  | `{ hp?: dice, mana?: dice }`  | Dice-notation damage (like `lightBane.damage`). `hp` routes through `_hurtPlayer` (can kill → respawn); `mana` through a new `_drainMana` (clamps at 0). |

Dice strings follow the existing notation (`"1d2"`, `"2d4+1"`, …). `restore`
amounts are flat ints (matching consumable `restore`).

## Engine wiring

`server/state.js`:

- **`applyRoomEffect(player, effect, events)`** — the one place an effect resolves.
  Evaluates `effect.when` against the room's **current** effective light; if it
  passes, runs the single action, then pushes the mechanical event (`player-hurt`
  for hp damage, `vitals` for restore/mana change, light recompute for douse) and,
  if present, the `message` (to the player) and `roomMessage` (to bystanders) via a
  new player-facing `room-effect` text event.
- **`_drainMana(player, amount, events)`** — small sink mirroring the mana side of
  `applyRestore`: `player.mana = max(0, mana - amount)`, push `vitals` if it moved.
- **`_roomEffectsTick(events)`** — iterates rooms that have `trigger:"tick"`
  effects and, for each player present (`hp > 0`), calls `applyRoomEffect` for each
  due effect (`interval` gate via `this.tick % interval`). Called from `advance()`
  **immediately after `_environmentTick`**, so it reads freshly recomputed light
  (and so a darkness effect bites on the same tick `lightBane` would).

`server/commands.js`:

- **`move()`** ([commands.js:351](../../../server/commands.js)) runs the room's
  `trigger:"enter"` effects on the destination **after** the arrival light
  recompute (`state.rooms[dest].light = computeRoomLight(dest)`), so a douse darkens
  the room before its view is built. Enter-effect messages fold into the player's
  arrival output alongside the existing exploration/quest tails.

`tools/validate-data.js`:

- Validate each room `effects` entry: `trigger` ∈ {`enter`,`tick`}; `when` (if
  present) has exactly one of `lightBelow`/`lightAbove` with an integer value;
  `action` has exactly one known key; `damage` dice strings parse; `restore` values
  are integers; `interval` (if present) is a positive integer. Must exit 0.

## Event / client

A new `room-effect` event `{ type: "room-effect", playerId, text }` carries the
flavour line to the affected player, dispatched like other per-player notices in
`server/index.js`. Mechanical changes reuse existing events (`player-hurt`,
`vitals`), so vitals/HP bars update through the current paths. `roomMessage`, when
set, is sent to the other occupants as a room log line.

## Tick ordering (load-bearing)

Within `advance()`:

1. light recompute (existing)
2. `_environmentTick` — `lightBane` (existing)
3. **`_roomEffectsTick`** — new, reads the same fresh light

Enter-effects run inside `move()`, not the tick loop, after that room's light is
recomputed on arrival.

## POC content

| Room | id | Effect |
|------|----|--------|
| The Plunge Cave | `third.cave` | `enter` → `douse` (spray drowns the flame; ambient 0 leaves you in the dark with the crayfish). |
| The Lantern's Rest | `rim.inn` | `tick`, `interval: 3` → `restore { hp: 1, mana: 1 }` (rest and mend at the inn). |
| Where the Dark Goes Bad | `warren.throat` | `tick`, `when: { lightBelow: 1 }` → `damage { hp: "1d2", mana: "1d2" }` (the dark drinks your warmth unless you keep a light). |

## Extensibility

- New actions plug into `applyRoomEffect`'s single switch (e.g. a future
  `applyEffect`-style status grant) without touching authoring of existing rooms.
- `when` is a block, so non-light conditions slot in later as extra keys.
- A `trigger:"tick"` `douse` would keep a room perpetually wet — supported by the
  same action, deliberately unused in v1 (the waterfall douses on entry only).

## Testing

- **Validator:** malformed `effects` (bad trigger, two action keys, bad dice,
  two `when` keys) fail `npm run validate`; the POC rooms pass.
- **Enter douse:** walk into `third.cave` with a lit torch → torch `lit` becomes
  false, room light drops, flavour line shown.
- **Inn regen:** stand wounded in `rim.inn` → HP and mana climb 1 every 3 ticks,
  clamped at maxima, `vitals` updates flow.
- **Darkness damage:** stand in `warren.throat` with no light → HP and mana drop
  each tick; bring a lit light so room light ≥ 1 → damage stops. Confirm an
  HP-drain killing blow respawns the player cleanly.
