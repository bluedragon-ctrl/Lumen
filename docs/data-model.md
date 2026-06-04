# Lumen — Data Model

This document specifies the JSON data structures for Lumen. It is the contract
the server and tools build against. See [DESIGN.md](../DESIGN.md) for the game
design these structures serve.

## Guiding split: static vs. dynamic

- **Static / authored content** (this directory: `data/world/`, `data/templates/`)
  — hand-written, version-controlled, treated as **read-only at runtime**. Rooms,
  item/mob/fixture/recipe *templates*, the starting-character template.
- **Dynamic / runtime state** — live player characters, item instances on the
  ground or in inventories, mob instances, current room occupancy. **Not committed**
  (see `.gitignore` → `data/runtime/`). Created from templates at runtime and
  snapshotted to disk periodically.

Templates are *definitions* (a "torch" in the abstract); instances are *things*
(this particular torch with 150 fuel left).

---

## Light scale

Light is a single integer per room (the **effective light level**). Bands map from
the integer:

| Light value | Band       |
|------------:|------------|
| `0`         | darkness   |
| `1`–`2`     | dim        |
| `3`–`9`     | bright     |
| `10`+       | searing    |

Searing is deliberately hard to reach — a torch plus a few lightbugs stays
*bright*. Effective light is clamped to `0..20`.

**Effective light** of a room each tick:

```
effective = clamp( room.ambientLight + Σ(active light-source output in room), 0, 20 )
```

- `ambientLight` is the room's authored base (usually falls toward 0 with depth).
- Light sources contribute their `output` (a lit torch, a glowing mob, etc.).

### Per-actor perception band

Every actor (player + mob) carries:

```json
"perception": { "blindBelow": 1, "dimBelow": 3, "harmedAbove": 9 }
```

- **`blindBelow`** — minimum effective light required to *see* at all. Below it
  the actor is effectively blind (sees only self-illuminating things). `0` means
  the actor sees even in total darkness (darkvision).
- **`dimBelow`** — light at/above which the actor sees *clearly*; between
  `blindBelow` and `dimBelow` sight is **partial** (a combat accuracy penalty,
  but not harmful). Defaults to `blindBelow` (no partial tier) if omitted.
- **`harmedAbove`** — maximum comfortable light. Above it the actor is harmed and
  dazzled by glare. Deep-dwellers have low values (bright light hurts them).

These define four visibility tiers used for **combat accuracy** (see the server
README): can't-see (5%) · partial/dim (50%) · clear (100%) · glare (50%).

Example actors:

| Actor        | blindBelow | dimBelow | harmedAbove | Reads as                                            |
|--------------|-----------:|---------:|------------:|-----------------------------------------------------|
| Human        | 1          | 3        | 9           | blind in dark, partial in dim, clear in bright, glare in searing |
| Deep-dweller | 0          | 0        | 2           | sees clearly in the dark; bright light dazzles it   |
| Lightbug     | 0          | 0        | 6           | sees clearly in the dark, very light-tolerant       |

---

## Room (static) — `data/world/rooms.json`

A map of `roomId → room`.

```json
{
  "settlement.plaza": {
    "id": "settlement.plaza",
    "zone": "settlement",
    "name": "The Rim Plaza",
    "description": "Lantern-light pools across worn flagstones at the abyss's lip...",
    "depth": 0,
    "ambientLight": 4,
    "exits": { "east": "settlement.market", "down": "shaft.landing-1" },
    "fixtures": ["alchemist-bench"],
    "groundItems": [{ "template": "vial", "qty": 2 }],
    "spawns": [{ "mob": "lightbug", "max": 1, "respawn": 20 }]
  }
}
```

| Field          | Type              | Notes |
|----------------|-------------------|-------|
| `id`           | string            | Unique, matches the map key. Convention: `area.name`. |
| `zone`         | string?           | Area tag (e.g. `rim`/`abyss`). Bounds `wander` with `scope: "zone"` — a mob only roams between rooms sharing its current zone. (Future: pursuit limits.) |
| `name`         | string            | Short room title. |
| `description`  | string            | Shown in the Inspect window when visible. |
| `depth`        | integer           | 0 at the rim; increases downward. Flavour + future scaling. |
| `ambientLight` | integer           | Base light before sources (see light scale). |
| `exits`        | map dir→roomId    | Directions: `north`,`south`,`east`,`west`,`up`,`down` (extensible). |
| `fixtures`     | string[]          | Fixture ids present in the room (crafting stations, etc.). |
| `groundItems`  | ItemRef[]         | Initial items on the floor (instantiated at world load). |
| `spawns`       | SpawnRule[]       | Mob spawn rules. `{ "mob": id, "max": n, "respawn": ticks? }`. `respawn` (ticks) refills the population back to `max`, one mob per interval, once a kill or a wandered-off mob drops the count; omit it for a static one-time spawn. The cap counts a spawner's mobs **wherever they have wandered**, so wandering doesn't multiply them. |

`groundItems`/`fixtures`/`spawns` are optional (default empty).

---

## Item template (static) — `data/world/items.json`

A map of `itemId → template`. Common fields plus type-specific blocks.

```json
{
  "torch": {
    "id": "torch", "name": "a torch",
    "description": "A pitch-soaked length of wood.",
    "type": "light", "slot": "hand", "weight": 1,
    "light": { "output": 3, "fuelMax": 200, "burnPerTick": 1 }
  },
  "short-sword": {
    "id": "short-sword", "name": "a short sword",
    "description": "A plain, well-balanced short sword.",
    "type": "weapon", "slot": "hand", "weight": 2,
    "weapon": { "damage": { "physical": "1d6" }, "actionCost": 12 }
  },
  "leather-jerkin": {
    "id": "leather-jerkin", "name": "a leather jerkin",
    "description": "Stiff, abyss-cured hide.",
    "type": "armour", "slot": "body", "weight": 3,
    "armour": { "armour": 1, "ward": 0, "speedPenalty": 0 }
  },
  "vial": {
    "id": "vial", "name": "an empty vial",
    "description": "A small glass vial, stoppered with wax.",
    "type": "material", "weight": 0, "stackable": true
  }
}
```

| Field        | Type    | Notes |
|--------------|---------|-------|
| `id`,`name`,`description` | string | `name` is the noun phrase used in text. |
| `type`       | enum    | `light` \| `weapon` \| `armour` \| `consumable` \| `material` \| `currency` \| `misc`. `currency` (e.g. `shards`) is gathered into the player's balance by `get`, not stowed in inventory. |
| `slot`       | enum?   | Equip slot: `hand` \| `body` \| `head` \| `light` … (omit if not equippable). |
| `weight`     | number  | For future carry-capacity. |
| `value`      | integer | Buy price in shards (what a trader charges). **Required** for every item except `currency`. |
| `sellValue`  | integer?| What a trader pays to buy it from a player. Defaults to `round(value × 0.2)` (20%); set it to override. |
| `stackable`  | bool?   | If true, instances stack as `qty` (materials). |
| `light`      | block?  | `{ output, fuelMax, burnPerTick }` — makes it a fuelled light source. Add `fuelItem` + `refuelPerUnit` to make it **refuellable** (`refuel <item>` consumes one `fuelItem` and adds `refuelPerUnit` fuel); omit them for a disposable light (e.g. a torch). |
| `weapon`     | block?  | `{ damage: { physical?, magical? }, actionCost }`. Damage values are **dice notation** (see below). |
| `armour`     | block?  | `{ armour, ward, speedPenalty }`. |
| `consumable` | block?  | `{ effect }` — `drink`/`use` applies `effect`, a **status-effect primitive** (see [Status effects](#status-effects-dynamic)). |

### Dice notation

Damage (and other rolled values) use standard dice notation as a **string**:

```
"<count>d<sides>"            e.g. "1d6"  →  roll one 6-sided die
"<count>d<sides>+<flat>"     e.g. "2d4+1"
"<count>d<sides>-<flat>"     e.g. "1d8-1"
```

A plain integer string (e.g. `"3"`) is also accepted as a constant. Attribute
bonuses (e.g. Might added to physical damage) are applied by the combat system
at resolution time — they are **not** baked into the weapon's dice string.

---

## Mob template (static) — `data/world/mobs.json`

A map of `mobId → template`.

```json
{
  "lightbug": {
    "id": "lightbug", "name": "a lightbug",
    "description": "A drifting mote of soft luminescence.",
    "maxHp": 6, "speed": 10,
    "attributes": { "might": 1, "vitality": 3, "intellect": 0, "wits": 6, "perception": 4 },
    "perception": { "blindBelow": 0, "harmedAbove": 6 },
    "emitsLight": 1,
    "behavior": "wander",
    "hostile": false,
    "loot": [{ "template": "luminescent-gland", "chance": 0.5 }]
  }
}
```

| Field        | Type    | Notes |
|--------------|---------|-------|
| `id`,`name`,`description` | string | |
| `maxHp`      | integer | Starting/full HP. |
| `speed`      | integer | Action-point gain per tick (normal ≈ 12). |
| `armour`     | integer?| Innate **physical** damage reduction (default 0), like a player's Armour. |
| `ward`       | integer?| Innate **magical** damage reduction (default 0), like a player's Ward. |
| `attributes` | block   | `{ might, vitality, intellect, wits, perception }`. |
| `perception` | block   | `{ blindBelow, harmedAbove }`. |
| `emitsLight` | integer?| Self-illumination output. >0 → visible even in darkness *and* adds room light. |
| `behavior`   | enum    | `wander` \| `guard` \| `hunt` \| `passive` (flavour tag). |
| `hostile`    | bool    | May attack players when able (proactively *hunts* — builds detection; see Aggro / threat). |
| `ambush`     | bool?   | Predator that lies in wait. It still hunts (tracks perceivable enemies) but holds its **proactive** strike until a target is **sleeping**, then attacks; if `hidden`, that first strike **reveals** it to the victim (no `search` needed) and fires a `mob-ambush` appearance line. It emits no "spotted" tell, and once blows are traded it fights on normally (combat threat) regardless of posture. Requires `hostile: true`. |
| `helper`     | bool?   | Pack defender. On its action it **joins any fight a same-faction ally is already in** — for each present enemy that an ally it can **perceive** holds combat threat on, it engages that enemy too (fires a one-shot `mob-assist` "rushes to join" line). Perception-gated (won't join in the dark it can't see). Turns "pick them off one at a time" into a swarm. |
| `attack`     | block?  | Melee profile: `{ damage (dice), actionCost, type?, bonus?, crit?, hitBonus?, onHit? }`. `onHit` (see below) lands effects on a struck defender. |
| `onDamage`   | block?  | General **when-struck** triggers (see below): a list of effect specs that fire when this mob is hit — reflect damage, retaliate with a DoT, or buff itself. Same shape on an item's `armour.onDamage`. |
| `spikes`     | block?  | Terse sugar for the commonest `onDamage` entry — a flat melee **reflect** ("thorns"): `{ damage (dice), chance? }`. Anyone who lands a melee hit takes the damage back. Fires even if the mob has no `attack` of its own. Equivalent to `onDamage: [{ type: "damage", damage, target: "attacker" }]`. |
| `shop`       | block?  | Makes the mob a trader: `{ "sells": [{ template, price? }] }` — its stock, each sold at the item's `value` (or an optional `price` override). There is **no buy list**: the trader buys *any* valued item from a player at its `sellValue`. Players use `list`/`buy`/`sell` in the room. |
| `shards`     | dice?   | Shards dropped on death, e.g. `"1d4"`. They land on the floor as a `shards` (type `currency`) pile that **anyone** present can `get` — gathering tallies to the picker's balance rather than into inventory. Piles in a room merge. |
| `actions`    | Action[]?| Weighted behaviour table (see below). Without it, a hostile mob just attacks. |
| `posture`    | enum?   | Starting posture: `standing` (default) \| `sitting` \| `sleeping`. A **`sleeping`** mob perceives nothing — fully inert (no wander/attack/emote, builds no aggro) until a blow (melee or hostile spell) **rouses** it to standing. A **`sitting`** mob is alert-at-rest: it won't wander or emote, but it *does* detect enemies and **stands as it engages** (see Aggro / threat). Authors dozing guardians, resting NPCs, and creatures you can creep past while they sleep. |

### Mob actions (weighted)

Each tick a mob may take **one** action, chosen by weight from the options
currently available (e.g. `attack` only when a player is present, `move` only
when there's an exit). This gives mobs fight/emote/flee/idle personalities.

```json
"actions": [
  { "type": "attack", "weight": 7 },
  { "type": "emote",  "weight": 2, "messages": ["lets out a wet rattle", "tastes the air"] },
  { "type": "wander", "weight": 1, "verb": "skitters into the dark", "scope": "zone" },
  { "type": "idle",   "weight": 4 }
]
```

| Action  | Effect | Fields |
|---------|--------|--------|
| `attack`| Strike a player in the room (light-gated like player attacks). | — |
| `emote` | Broadcast a flavour line to the room (a name you can't see reads as "Something …"). | `messages: string[]` |
| `wander`| Walk to a random adjacent room (carrying its light if it glows). **Suppressed while the mob is in combat** (has live threat). | `verb` (display, e.g. "flees"); `scope`: `"zone"` (default — only rooms sharing the mob's current `zone`) or `"any"` (cross-zone). |
| `idle`  | Do nothing this turn — raise its weight to keep a mob calm/quiet. | — |
| `summon`| Conjure reinforcements of the mob's own faction (allies that fight alongside it), up to a living-brood `max`; available only while in combat. | `mob` (template id), `count` (per cast), `max` (max living brood), `verb` (display line) |
| `loot`       | LootRule[] | `{ template, chance }`, chance 0..1. |

### Combat triggers — `onHit` & `onDamage`

Two symmetric, data-driven primitives, resolved in one place
(`GameState.applyHitOutcome`) for both attack directions. `onHit` is the
**attacker** side ("I landed a hit"); `onDamage` is the **defender** side
("I was struck").

**`onHit`** — a list of effect specs applied to the defender on a *landed* hit.
Lives on a mob's `attack.onHit` and, identically, on an item's `weapon.onHit` (so
player weapons reuse it). Each entry is an `applyEffect` spec (`emit-light` /
`restore` / `damage-over-time`) plus an optional `chance` (default 1). When the
attacker is a **player**, the engine stamps `sourceId` so a poison kill credits
them (like a bleed); a **mob's** venom credits no one. Re-applying each hit stacks
independent instances. DoT ticks bypass armour (it's poison, not a blow).

```json
"onHit": [{ "type": "damage-over-time", "name": "venom", "damage": "1d2", "duration": 5, "chance": 1 }]
```

**`onDamage`** — a list of effect specs that fire when the bearer is struck. Lives
on a mob's top-level `onDamage` and, identically, on an item's `armour.onDamage`.
Each entry is the same effect-spec shape as `onHit` (plus a `type: "damage"` for an
instant flat hit), with two extra axes the attacker side never needs:

| Field    | Default       | Meaning |
|----------|---------------|---------|
| `target` | `"attacker"`  | Who the effect lands on: `"attacker"` (reflect / retaliate) or `"self"` (e.g. draw mana off the blow). |
| `on`     | `["melee"]`   | Which damage sources fire it. `"spell"` is reserved — spell hits don't route through this path **yet**, so an `on: ["spell"]` entry is forward-ready but inert until `castSpell` is wired. |

A `target: "attacker"` DoT credits the **defender** on a kill if the defender is a
player (the mirror of `onHit`'s credit). Instant `damage` and reflected DoTs bypass
the attacker's armour.

```json
"onDamage": [
  { "type": "damage",           "damage": "1d3", "target": "attacker" },
  { "type": "restore",          "mana": 2,        "target": "self"     },
  { "type": "damage-over-time", "name": "thornvenom", "damage": "1d2", "duration": 3, "target": "attacker" }
]
```

**`spikes`** is terse authoring sugar for the single commonest `onDamage` entry — a
flat melee reflect — normalized into `{ type: "damage", damage, target: "attacker" }`.

Reflect/retaliate is **melee-contact only** today (the `on` default). `onHit` and
`onDamage` share the same dispatch, so a later `on: ["spell"]` wiring (and any
future `onDeath` lifecycle trigger) slots in without reshaping the data.

### Faction & ownership (runtime)

Allegiance is **instance-level**, not a template property, so the same template can
spawn as an enemy or as a player-allied creature. Every mob instance carries:

| Field      | Default  | Meaning |
|------------|----------|---------|
| `faction`  | `"wild"` | The side this creature fights *for*. Players are always faction `"player"`. Two combatants are **enemies** iff their factions differ. |
| `ownerId`  | `null`   | The player a `"player"`-faction creature belongs to (kill credit; future pet upkeep). |

Faction defines *sides*; `hostile`/provocation still gate whether a creature
actually engages. A `"wild"` mob's enemies are players + `"player"`-faction mobs; a
`"player"` mob's enemies are `"wild"` mobs. This is the substrate **summons** sit on
(an allied mob spawned `faction:"player"` + `ownerId`). The admin
`@spawn <mobId> [count] [wild|player]` sets it for live testing.

**Summon instance fields.** Summoned instances also carry `summonerId` (the
conjurer's id — player or mob), `summonGroup` (the recast-cap key), `expiresIn`
(ticks until it winks out; `null` = permanent), and `noSpoils: true` (no loot or
XP on death, however it dies). They carry no spawner `origin`, so they never respawn
and never count against a room's spawn cap. Instance `faction`/`ownerId` (above)
decide allegiance and ownership; owned summons follow their player between rooms and
are dismissed (silently — a `summon-end`, no corpse) on the timer, the owner's death,
or disconnect.

### Aggro / threat (runtime)

Each mob instance carries two per-enemy tables, both keyed by **any combatant id**
(a player **or** a mob), so a creature can hold threat toward, and target, either:

- **`aggro` — combat threat.** Earned by *trading blows* (being hit, or hitting),
  and by healing/buffing an ally a mob is fighting (mirrors the damage→threat
  convention). Any live `aggro` entry engages a mob **outright** — so being struck
  provokes it in any light — and only `aggro` (real participation) earns **kill XP**.
- **`detect` — the detection meter.** A decaying notice value a *proactive hunter*
  (a `hostile` wild mob, or a `"player"`-faction ally) accrues on each enemy it can
  **perceive**, gated by the mob's sight in the room's current light:

  | Mob's sight (light vs its `perception` band) | gain per action |
  |---|---|
  | below `blindBelow` (blind / dark) | **0** — never noticed; can be passed |
  | dim, or glare above `harmedAbove` (impaired) | **0.5** — builds ~2× slower |
  | clear | **1.0** |

  Detection is capped at the engage threshold (`AGGRO_ENGAGE`, currently 2 → clear
  sight commits in ~2 actions). A target the mob can no longer perceive (light lost,
  or the mob blinded) **decays** after a short grace (`AGGRO_GRACE`) until forgotten
  — the hook for future hide/invisibility. A **sleeping** mob perceives nothing and
  never proactively aggros (only rouses when struck); a **sitting** mob detects and
  **stands as it engages**.

A mob is **engaged** with an enemy when it has any `aggro` on it **or** `detect ≥
AGGRO_ENGAGE`; engaging a *player* fires a one-shot `aggro-engage` "spotted" tell.
A mob holding any combat threat or live detection is **alerted** — it won't `wander`
off — and it attacks its **highest combined-threat** target. Both tables are dropped
for a combatant when it leaves the room or dies. Tuning constants (`AGGRO_RATE`,
`AGGRO_ENGAGE`, `AGGRO_GRACE`) live at the top of `server/state.js`. Because every
current hostile has `blindBelow: 0` (full dark-vision), the gate is presently a brief
telegraph rather than true stealth; dark-blind creatures (`blindBelow ≥ 1`) make it
bite. (Later: per-action threat weighting, cross-room pursuit.)

---

## Fixture (static) — `data/world/fixtures.json`

Room-anchored objects, primarily crafting stations.

```json
{
  "alchemist-bench": {
    "id": "alchemist-bench", "name": "an alchemist's bench",
    "description": "Glass coils and a cold burner await reagents.",
    "type": "crafting", "station": "alchemy"
  },
  "lamp": {
    "id": "lamp", "name": "an iron lamp",
    "description": "A heavy iron lamp bolted to the rock; a lever turns the flame up or down.",
    "type": "switch", "switch": { "emitsLight": 3, "on": false }
  }
}
```

| Field    | Type   | Notes |
|----------|--------|-------|
| `type`   | enum   | `crafting` \| `switch` \| `decoration` \| … |
| `station`| string?| Crafting station tag recipes reference (e.g. `alchemy`, `forge`). |
| `switch` | block? | Makes the fixture switchable: `{ emitsLight, on }`. `on` is the default state; each instance carries live on/off state. Toggled with `use <fixture>`. When on, `emitsLight` adds to room light (like a torch). |

---

## Recipe (static) — `data/world/recipes.json`

A map of `recipeId → recipe`. Crafting happens via `craft <recipe>` while standing
at a fixture whose `station` matches, and only for recipes the player has learned
(`knownRecipes`). `recipes` lists what you know.

```json
{
  "minor-light-potion": {
    "id": "minor-light-potion",
    "name": "Minor Light Potion",
    "station": "alchemy",
    "inputs": [{ "template": "luminescent-gland", "qty": 1 }, { "template": "vial", "qty": 1 }],
    "shards": 5,
    "output": { "template": "minor-light-potion", "qty": 1 }
  }
}
```

| Field    | Type        | Notes |
|----------|-------------|-------|
| `station`| string      | Must match a fixture's `station` tag in the room. |
| `inputs` | ItemRef[]   | Consumed components. |
| `shards` | integer?    | Shards spent to craft (default 0) — shards are also a crafting component, not just currency. |
| `output` | ItemRef     | Produced item. |

---

## Status effects (dynamic)

Status effects are runtime buffs/debuffs carried on an actor (`player.states`, a
runtime array). They are produced by a **data-driven primitive** so the same
effect can be authored on a potion, a spell, or a mob ability.

An **effect spec** is the descriptor authored on the source (e.g. a consumable's
`effect`):

```json
{ "type": "emit-light", "name": "Light", "magnitude": 1, "duration": 180 }
```

| Field       | Type    | Notes |
|-------------|---------|-------|
| `type`      | enum    | The primitive. Implemented: `emit-light` (actor radiates `magnitude` light, summed into room light like a torch); `summon` (see below). |
| `name`      | string  | Display label for the state chip. |
| `magnitude` | number  | Effect strength (e.g. light output). |
| `duration`  | integer | Lifetime in **ticks** (1s each); omit for a permanent effect. |

Applying an effect pushes a live instance `{ type, name, magnitude, remaining, good }`
onto the actor; instances **stack** (each counts and each ticks down on its own).
The tick loop decrements `remaining`, removes expired effects, and notifies the
owner. New primitives plug in here without touching potions/spells that reference them.

The **`summon`** effect type is the exception — it conjures creatures rather than
pushing a state onto the caster:

```json
{ "type": "summon", "mob": "wisp", "count": 1, "duration": 180, "group": "summon-wisp" }
```

`summon` conjures `count` instances of `mob` for `duration` ticks (omit `duration`
for a permanent summon), tagged to the caster. `group` (defaults to the spell id)
scopes the recast cap: recasting a spell of the same group dismisses the caster's
previous summon of that group before conjuring the new one. The conjured instances
spawn `faction:"player"` + `ownerId` (so they fight for and follow the caster); see
[Summon instance fields](#faction--ownership-runtime) below.

---

## Starting character template (static) — `data/templates/player.json`

The blueprint a new player is instantiated from.

`shards` is the player's money (a special light-crystal currency; abstract integer
balance, shown in the player panel). New characters start with the template's value.
`knownRecipes` lists the recipe ids a fresh character can already `craft`; the field
is backfilled from this template onto older saves that predate it.

```json
{
  "level": 1, "xp": 0, "shards": 10,
  "attributes": { "might": 5, "vitality": 5, "intellect": 5, "wits": 5, "perception": 5 },
  "maxHp": 18, "maxMana": 10, "speed": 12,
  "perception": { "blindBelow": 1, "dimBelow": 3, "harmedAbove": 9 },
  "startLocation": "rim.plaza",
  "startInventory": [{ "template": "torch", "fuel": 200 }],
  "startEquipment": { "hand": "short-sword", "body": "leather-jerkin", "light": null },
  "knownRecipes": ["minor-light-potion"]
}
```

---

## Item references & instances

Two shapes are used wherever items appear in data:

- **ItemRef** (authoring shorthand, in templates/world data):
  `{ "template": "<id>", "qty": <n> }` for stackables, or
  `{ "template": "<id>", "fuel": <n> }` for fuelled items.
- **ItemInstance** (runtime, dynamic state): a concrete thing carrying a unique
  runtime `id` plus its own mutable state, e.g.
  `{ "id": "item.42", "template": "torch", "fuel": 150, "lit": true }`.
  Stackable materials collapse to `{ "id": "item.7", "template": "vial", "qty": 3 }`.

### Runtime entity ids

Every **addressable runtime entity** carries a unique, type-prefixed id so it can
be targeted unambiguously by commands and clicks (even when names collide, e.g.
two lightbugs): `player.N`, `mob.N`, `item.N`, `fixture.N`. Authored static
definitions (rooms, item/mob/fixture templates) already have their own unique
string ids. Targeted commands resolve **by id first, then by name substring**.

---

## Runtime player (dynamic, illustrative) — `data/runtime/players/<name>.json`

Not committed; shown here so the shape is documented:

```json
{
  "id": "player.varan", "name": "Varan",
  "level": 1, "xp": 0, "shards": 10,
  "attributes": { "might": 5, "vitality": 5, "intellect": 5, "wits": 5, "perception": 5 },
  "hp": 18, "maxHp": 18,
  "mana": 10, "maxMana": 10,
  "speed": 12, "energy": 0,
  "perception": { "blindBelow": 1, "harmedAbove": 5 },
  "location": "shaft.landing-1",
  "equipment": { "hand": "<instance>", "body": "<instance>", "light": "<instance>" },
  "inventory": ["<instance>", "..."],
  "states": []
}
```
