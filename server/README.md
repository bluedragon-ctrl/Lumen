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

Admin commands are prefixed with `@` (`@create-player`, `@list-players`,
`@shards <n>`, `@attr <attribute> <value>`, `@help`).

**Server → Client**

```json
{ "type": "system", "text": "Welcome to Lumen…" }     // session/world notices
{ "type": "log",    "text": "A lightbug drifts in." }  // event feed
{ "type": "error",  "text": "malformed message" }      // problems

{ "type": "player", "player": { "name", "level", "xp", "shards", "hp", "maxHp",
  "mana", "maxMana", "energy", "speed", "armour", "ward", "evasion", "crit",
  "attributes", "perception", "equipment", "inventory", "states", "recipes" } }  // always full truth

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
`light [item]`/`douse`, `list`/`buy`/`sell`, `recipes`/`craft`, `drink`/`quaff`,
`use`/`switch` (operate a fixture here, else drink), `refuel`/`fill`, `help`, and admin
`@`-commands. (`light` auto-swaps a spent source for a fuelled one.) Effects
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
mutual, exploitable condition. The light tier is then nudged by the attacker's
**Perception** (`+2%`/pt to hit) and the defender's **Wits** (`−2%`/pt evasion),
clamped to `[5%, 100%]` — so accuracy can compensate for darkness, and a dodgy
defender slips blows (mobs carry an optional `attack.hitBonus` / `evasion`).

Damage = `roll(dice) + floor(Might/4) − mitigation` (min 1), where the Might bonus
comes from the weapon's `scale` (default `{might,4}`) and mitigation is the
defender's **Armour** for physical damage or **Ward** for magical — every attack
carries a damage type (physical today; Ward is groundwork for spells). A
**critical hit** (`Perception×1%`, or a mob's `attack.crit`) doubles the offensive
roll before mitigation. Players sum Armour/Ward from gear plus innate Ward from
**Wits** (`×2`); mobs have innate `armour`/`ward`. Mob HP≤0 → death, loot
dropped to the room, **shards dropped as a floor pile anyone can `get`**, XP to the
killer. Player HP≤0 → respawn at the rim, full HP, no penalty beyond lost progress
(DESIGN v1).

**Damage isn't only direct hits.** All HP loss flows through shared sinks
(`_hurtMob` / `_hurtPlayer`) so a death can come from the room or an effect, not
just a blow — spoils still drop where the victim stands, but XP is credited only
when a player is clearly responsible (else the kill is pure environment).
- **Light-bane** (`lightBane: { above, damage }` on a mob): each tick a mob in
  room light *above* its threshold is seared for `roll(damage)` — light as a
  weapon. Credited to the top-threat player if one is mid-fight. Carried by the
  deep-dweller (sears above 2) and the mini-boss Gnaw (above 3): bring a bright
  enough light and you can burn down a creature that won't flee it.
- **Damage-over-time** (`damage-over-time` status effect, `{ damage, duration,
  sourceId }`): a bleed/poison primitive ticked on **both players and mobs** by
  `_tickEffects`; a DoT kill credits its recorded `sourceId`. The scaffolding is
  in place; no bleed-inflicting content is authored yet.

**Repop** is data-driven per spawn rule: `{ mob, max, respawn }`. Each tick a
spawner below its `max` counts down `respawn` ticks and then puts one mob back in
its home room (a `mob-spawn` event). The cap counts a spawner's mobs wherever they
have since wandered, so roaming never multiplies the population. Omit `respawn`
for a static one-time spawn. Cadence stays on the single tick — cheap integer
countdowns, no separate timer (an event-scheduler is deferred until scale needs it).

Each tick a mob takes **one weighted action** from its `actions` table
(`attack` / `emote` / `wander` / `idle`) among those currently available — so mobs
fight, mutter flavour lines, wander, or lurk with distinct personalities. Mob
actions you can't see read as "Something …". Mobs act in their own room only (no
cross-room pursuit yet); `wander` lets them roam between rooms, bounded by its
`scope` (`"zone"` keeps a mob in its current zone, `"any"` crosses zones). A
`flee` action (also `scope`-bounded) is a light trigger, not a weighted choice:
the instant room light rises above its `lightAbove`, the mob bolts for a random
exit, overriding everything else (even combat) — used by the dark-dwelling
gloom-crawler, which flees light above 3.

**Trading.** A mob with a `shop` block is a trader. Pricing is **data-driven from
item `value`**, not a per-trader script. In its room a player can `list` the wares,
`buy <item>` (deducts the item's `value`, or a per-shop `price` override, and hands
over a fresh instance) and `sell <item>` — the trader buys *any* valued item at its
`sellValue` (default 20% of `value`); there is no per-trader buy list. Currency
(`shards`) has no value and can't be sold. Shards are an abstract integer balance on
the character, shown in the player panel.

Mobs keep a minimal **aggro table** (`{ playerId: threat }`): attacking a mob earns
threat and hostile mobs engage any delver present. A mob with live threat is *in
combat* — it won't `wander` away and strikes its highest-threat target. Threat is
dropped when a player leaves or dies (a fuller threat/decay/pursuit system later).

### Crafting

`craft <recipe>` produces a recipe's `output` when the player is at a fixture whose
`station` matches, **knows** the recipe (`knownRecipes`), and has the `inputs` plus
any `shards` cost — all then consumed. `recipes` lists known recipes and flags which
need a station you're not standing at. Shards are both currency and a crafting
component (the abyss's reason-for-being), so recipes may spend them directly.

### Status effects & potions

Actors carry timed status effects (`player.states`) applied from a data-driven spec
`{ type, name, magnitude, duration }` — the same primitive a potion or (later) a
spell references. The tick loop counts down each effect and removes it on expiry.
Implemented primitive: `emit-light` (the actor radiates `magnitude` light, summed
into room light and shown as a glow). `drink`/`quaff`/`use <potion>` applies the
item's `consumable.effect`.

### Switchable fixtures

A fixture template may carry a `switch` block (`{ emitsLight, on }`); each instance
holds live on/off state. `use`/`switch <fixture>` toggles it and recomputes room
light — e.g. the iron lamp at the shaft mouth adds 3 light when on. `use` operates a
matching fixture in the room, otherwise falls back to drinking.
