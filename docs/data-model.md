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
    "groundItems": [{ "template": "flint", "qty": 2 }],
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
  "flint": {
    "id": "flint", "name": "a flint shard",
    "description": "Strikes a spark.",
    "type": "material", "weight": 0, "stackable": true
  }
}
```

| Field        | Type    | Notes |
|--------------|---------|-------|
| `id`,`name`,`description` | string | `name` is the noun phrase used in text. |
| `type`       | enum    | `light` \| `weapon` \| `armour` \| `consumable` \| `material` \| `misc`. |
| `slot`       | enum?   | Equip slot: `hand` \| `body` \| `head` \| `light` … (omit if not equippable). |
| `weight`     | number  | For future carry-capacity. |
| `stackable`  | bool?   | If true, instances stack as `qty` (materials). |
| `light`      | block?  | `{ output, fuelMax, burnPerTick }` — makes it a fuelled light source. |
| `weapon`     | block?  | `{ damage: { physical?, magical? }, actionCost }`. Damage values are **dice notation** (see below). |
| `armour`     | block?  | `{ armour, ward, speedPenalty }`. |
| `consumable` | block?  | `{ effect, … }` (TBD with effects system). |

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
| `armour`     | integer?| Innate physical damage reduction (default 0), like a player's Armour. |
| `attributes` | block   | `{ might, vitality, intellect, wits, perception }`. |
| `perception` | block   | `{ blindBelow, harmedAbove }`. |
| `emitsLight` | integer?| Self-illumination output. >0 → visible even in darkness *and* adds room light. |
| `behavior`   | enum    | `wander` \| `guard` \| `hunt` \| `passive` (flavour tag). |
| `hostile`    | bool    | May attack players when able. |
| `shop`       | block?  | Makes the mob a trader: `{ "sells": [{template, price}], "buys": [{template, price}] }`. `price` is in **shards**. Players use `list`/`buy`/`sell` in the room. |
| `actions`    | Action[]?| Weighted behaviour table (see below). Without it, a hostile mob just attacks. |

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
| `loot`       | LootRule[] | `{ template, chance }`, chance 0..1. |

### Aggro / threat (runtime)

Each mob instance carries an `aggro` table (`{ playerId: threat }`) — minimal today,
the foundation for a fuller threat system. A player swinging at a mob earns threat;
hostile mobs auto-engage any delver in their room. A mob with any live threat entry
is **in combat**: it won't `wander` off, and it attacks its **highest-threat** target.
Threat toward a player is dropped when they leave the room or die (later: gradual
decay, per-action threat weighting, cross-room pursuit).

---

## Fixture (static) — `data/world/fixtures.json`

Room-anchored objects, primarily crafting stations.

```json
{
  "alchemist-bench": {
    "id": "alchemist-bench", "name": "an alchemist's bench",
    "description": "Glass coils and a cold burner await reagents.",
    "type": "crafting", "station": "alchemy"
  }
}
```

| Field    | Type   | Notes |
|----------|--------|-------|
| `type`   | enum   | `crafting` \| `decoration` \| … |
| `station`| string?| Crafting station tag recipes reference (e.g. `alchemy`, `forge`). |

---

## Recipe (static) — `data/world/recipes.json`

A map of `recipeId → recipe`. Crafting happens via `use <components> on <fixture>`.

```json
{
  "minor-light-potion": {
    "id": "minor-light-potion",
    "name": "Minor Light Potion",
    "station": "alchemy",
    "inputs": [{ "template": "luminescent-gland", "qty": 1 }, { "template": "vial", "qty": 1 }],
    "output": { "template": "light-potion", "qty": 1 }
  }
}
```

| Field    | Type        | Notes |
|----------|-------------|-------|
| `station`| string      | Must match a fixture's `station` tag in the room. |
| `inputs` | ItemRef[]   | Consumed components. |
| `output` | ItemRef     | Produced item. |

---

## Starting character template (static) — `data/templates/player.json`

The blueprint a new player is instantiated from.

`shards` is the player's money (a special light-crystal currency; abstract integer
balance, shown in the player panel). New characters start with the template's value.

```json
{
  "level": 1, "xp": 0, "shards": 10,
  "attributes": { "might": 5, "vitality": 5, "intellect": 5, "wits": 5, "perception": 5 },
  "maxHp": 18, "maxMana": 10, "speed": 12,
  "perception": { "blindBelow": 1, "harmedAbove": 5 },
  "startLocation": "settlement.plaza",
  "startInventory": [{ "template": "torch", "fuel": 200 }, { "template": "flint", "qty": 3 }],
  "startEquipment": { "hand": null, "body": "leather-jerkin", "light": null }
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
  Stackable materials collapse to `{ "id": "item.7", "template": "flint", "qty": 3 }`.

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
