# Lumen Server

Authoritative, in-memory game server for Lumen. Loads the static world
(`data/world/`) into memory, runs the living-world tick loop, and serves both
the browser client and the live WebSocket on a single port.

## Running

```sh
# Live server (default port 3737)
npm start
#   → http://localhost:3737

# Test server (adjacent port, throwaway world)
PORT=3738 node server/index.js          # macOS / Linux
$env:PORT=3738; node server\index.js     # Windows PowerShell
```

| Instance | Port | Purpose |
|----------|------|---------|
| Main     | 3737 | Live shared world |
| Test     | 3738 | Throwaway / dev instance |

The port is overridable via the `PORT` environment variable.

Until the real client lands (PR #3), opening the root URL serves a **temporary
dev console** — a bare WebSocket tester so the server is previewable.

## Architecture

- **`config.js`** — ports, tick interval, paths, version.
- **`light.js`** — the light model: `bandOf`, `effectiveLight`, `canSee`, `isHarmedByLight`.
- **`world.js`** — `loadWorld()`: reads static content into a frozen object.
- **`state.js`** — `GameState`: authoritative dynamic state (players, per-room
  mob/item instances), light computation, tick advance, snapshotting.
- **`index.js`** — HTTP + WebSocket server, connection handling, tick loop.

Dynamic state is snapshotted to `data/runtime/` (gitignored) every
`SNAPSHOT_EVERY_TICKS` ticks.

## WebSocket message protocol (v0)

JSON messages over a single socket per player.

### Login

On connect the server sends `{ "type": "login-required", "text": "…" }`. The
client's first input is the player **name** (name-only identity for now):

```json
{ "type": "login", "name": "admin" }      // client → server
{ "type": "authenticated", "name": "admin", "admin": true }  // server → client (on success)
```

Unknown names are rejected (admin-only account creation; admins use
`@create-player <name>`). The `admin` account is auto-created on first boot.
Accounts persist as one JSON file per character under `data/runtime/players/`
(gitignored), saved on disconnect and periodically.

### Commands

**Client → Server**

```json
{ "type": "command", "text": "look" }
```

Admin commands are prefixed with `@` (`@create-player`, `@list-players`, `@help`).

**Server → Client**

```json
{ "type": "system", "text": "Welcome to Lumen…" }     // session/world notices
{ "type": "log",    "text": "A lightbug drifts in." }  // event feed
{ "type": "error",  "text": "malformed message" }      // problems

{ "type": "player", "player": { "name", "level", "xp", "hp", "maxHp",
  "mana", "maxMana", "energy", "speed", "attributes", "perception",
  "equipment", "inventory", "states" } }               // always full truth

{ "type": "room", "room": { "id", "name", "depth",
  "light": { "value", "band" }, "canSee", "harmed",
  "description",                                        // null when canSee=false
  "exits": ["down", "east"],
  "contents": { "players", "mobs", "items", "fixtures" } } }  // filtered by light
```

```json
{ "type": "examine", "entity": { "kind": "mob|item|fixture|player", "id", "name",
  "description", "bars": [{ "label", "value", "max", "kind" }],
  "lines": ["type: weapon", "damage: 1d6 physical"], "hints": ["…"] } }
```

`look <target>` (and clicking an entity) returns an `examine` view rendered in
the Inspect window. The payload is generic — `bars` (e.g. HP), `lines` (specs),
`hints` (interactions) — so it extends without protocol churn. A subsequent
`room` message (move / `look` with no arg) returns the Inspect window to the
live room.

The `room` view is filtered by what the viewer can perceive: in darkness the
description and most contents are withheld, but self-illuminating things (a
lightbug) still appear. Commands handled today: `look [target]`, movement
(`n/s/e/w/u/d`, `go <dir>`), `get`/`take`, `drop`, `inventory`, `say`, `emote`,
`attack`/`kill`/`stop`, `equip`/`wield`/`wear`, `unequip`/`remove`,
`light [item]`/`douse`, `help`, and admin `@`-commands. (`light` auto-swaps a
spent source for a fuelled one.) Effects
visible to other players in the room (speech, arrivals/departures, picking
things up, combat) are broadcast to them.

### Combat

Tick-driven, Energy-gated. Each tick every actor banks `speed` action points
(capped); an attack fires when banked ≥ the weapon's `actionCost`, then deducts
it — faster actors/weapons act more often. `attack <target>` sets a pending
attack that resolves on subsequent ticks until the target dies, you `stop`, or
you move.

Accuracy is **light-gated**, in four tiers by how well the attacker sees the
target (per-actor thresholds `blindBelow`/`dimBelow`/`harmedAbove`):
**can't see** (below `blindBelow`) → 5% flailing; **partial/dim**
(`blindBelow`…below `dimBelow`) → 50%; **clear** (`dimBelow`…`harmedAbove`) →
100%; **glare** (above `harmedAbove`) → 50%. So lighting a torch lifts you from
dim/partial to clear *and* drops a light-sensitive deep-dweller into glare — a
mutual, exploitable condition.

Damage = `roll(weapon dice) + (Might − 5) − target Armour` (min 1). Mob HP≤0 →
death, loot dropped to the room, XP to the killer. Player HP≤0 → respawn at the
rim, full HP, no penalty beyond lost progress (DESIGN v1).

Each tick a mob takes **one weighted action** from its `actions` table
(`attack` / `emote` / `move` / `idle`) among those currently available — so mobs
fight, mutter flavour lines, wander, or lurk with distinct personalities. Mob
actions you can't see read as "Something …". Mobs act in their own room only (no
cross-room pursuit yet); `move` lets them wander between rooms.
