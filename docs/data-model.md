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
| `3`–`5`     | bright     |
| `6`+        | searing    |

**Effective light** of a room each tick:

```
effective = clamp( room.ambientLight + Σ(active light-source output in room), 0, 9 )
```

- `ambientLight` is the room's authored base (usually falls toward 0 with depth).
- Light sources contribute their `output` (a lit torch, a glowing mob, etc.).

### Per-actor perception band

Every actor (player + mob) carries:

```json
"perception": { "blindBelow": 1, "harmedAbove": 5 }
```

- **`blindBelow`** — minimum effective light required to *see*. If the room's
  effective light `< blindBelow`, the actor is effectively blind (sees only
  self-illuminating things). `0` means the actor sees even in total darkness
  (darkvision).
- **`harmedAbove`** — maximum comfortable light. If effective light `> harmedAbove`,
  the actor is harmed/blinded by excess light. Deep-dwellers have low values
  (bright light hurts them); humans tolerate up to searing.

Example actors:

| Actor        | blindBelow | harmedAbove | Reads as                                  |
|--------------|-----------:|------------:|-------------------------------------------|
| Human        | 1          | 5           | needs dim+, harmed only by searing        |
| Deep-dweller | 0          | 2           | sees in dark, harmed by bright            |
| Lightbug     | 0          | 6           | sees in dark, very light-tolerant         |

---

## Room (static) — `data/world/rooms.json`

A map of `roomId → room`.

```json
{
  "settlement.plaza": {
    "id": "settlement.plaza",
    "name": "The Rim Plaza",
    "description": "Lantern-light pools across worn flagstones at the abyss's lip...",
    "depth": 0,
    "ambientLight": 4,
    "exits": { "east": "settlement.market", "down": "shaft.landing-1" },
    "fixtures": ["alchemist-bench"],
    "groundItems": [{ "template": "flint", "qty": 2 }],
    "spawns": [{ "mob": "lightbug", "max": 1 }]
  }
}
```

| Field          | Type              | Notes |
|----------------|-------------------|-------|
| `id`           | string            | Unique, matches the map key. Convention: `area.name`. |
| `name`         | string            | Short room title. |
| `description`  | string            | Shown in the Inspect window when visible. |
| `depth`        | integer           | 0 at the rim; increases downward. Flavour + future scaling. |
| `ambientLight` | integer           | Base light before sources (see light scale). |
| `exits`        | map dir→roomId    | Directions: `north`,`south`,`east`,`west`,`up`,`down` (extensible). |
| `fixtures`     | string[]          | Fixture ids present in the room (crafting stations, etc.). |
| `groundItems`  | ItemRef[]         | Initial items on the floor (instantiated at world load). |
| `spawns`       | SpawnRule[]       | Mob spawn rules. `{ "mob": id, "max": n }`. |

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
    "armour": { "armour": 2, "ward": 0, "speedPenalty": 0 }
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
| `attributes` | block   | `{ might, vitality, intellect, wits, perception }`. |
| `perception` | block   | `{ blindBelow, harmedAbove }`. |
| `emitsLight` | integer?| Self-illumination output. >0 → visible even in darkness *and* adds room light. |
| `behavior`   | enum    | `wander` \| `guard` \| `hunt` \| `passive` (extensible). |
| `hostile`    | bool    | Attacks players on sight when able. |
| `loot`       | LootRule[] | `{ template, chance }`, chance 0..1. |

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

```json
{
  "level": 1, "xp": 0,
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
- **ItemInstance** (runtime, dynamic state): a concrete thing carrying its own
  mutable state, e.g. `{ "template": "torch", "fuel": 150, "lit": true }`.
  Stackable materials collapse to `{ "template": "flint", "qty": 3 }`.

---

## Runtime player (dynamic, illustrative) — `data/runtime/players/<name>.json`

Not committed; shown here so the shape is documented:

```json
{
  "id": "player.varan", "name": "Varan",
  "level": 1, "xp": 0,
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
