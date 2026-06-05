# Lumen — Content Quick Reference (annotated golden records)

A compact, copy-and-edit template for each world-data type: one fully-featured
example with a one-line note per field. This is the **fast path** for drafting
content — read it instead of the full [data-model.md](data-model.md) for routine
additions, and reach for the data-model only when you need deeper semantics.

> **Source of truth is the validator.** Every rule below is enforced by
> [../tools/validate-data.js](../tools/validate-data.js); if this file and the
> validator ever disagree, the validator wins — fix this file. The examples use
> `//` comments for annotation, but **real JSON has no comments** — strip them
> when you paste. Always run `npm run validate` after editing data.

Universal rules:

- **Dice notation:** `"<count>d<sides>"` with optional `±flat` (`"1d6"`,
  `"2d4+1"`), or a plain integer string. Anything in a `damage`/`shards` field
  must match.
- **References must resolve:** any `template`, `spell`, `mob`, `recipe`,
  `fuelItem`, `output.template`, spawn `mob`, etc. must name an id that exists in
  the relevant file. New ids you reference must be created too.
- **Ids match their map key** for rooms and spells (`r.id === key`). Items, mobs,
  fixtures, recipes also carry an `id` matching the key by convention.

---

## Item — `data/world/items.json`

Map of `itemId → template`. Common fields, then ONE type-specific block.

```jsonc
"iron-dagger": {                       // key === id
  "id": "iron-dagger",
  "name": "an iron dagger",            // includes the article; lowercase
  "description": "A short, plain blade forged from abyssal iron.",
  "type": "weapon",                    // light|weapon|armour|currency|treasure|material|consumable|scroll|recipe|book
  "slot": "hand",                      // ONLY if equippable: hand|body|head|light (slots are dynamic)
  "weight": 1,
  "value": 24,                         // buy price. REQUIRED & ≥0 unless type==="currency"
  "sellValue": 12,                     // optional; sell = sellValue if set, else 20% of value
  "stackable": true,                   // for materials/consumables/currency
  "weapon": { "damage": { "physical": "1d6" }, "actionCost": 12,
              "scale": { "attr": "might", "per": 2 } }   // per +2 might → +1 dmg (optional)
}
```

Type-specific blocks (include exactly the one matching `type`):

```jsonc
// light:
"light": { "output": 4, "fuelMax": 600, "burnPerTick": 1,
           "fuelItem": "lamp-oil", "refuelPerUnit": 300 }  // fuelItem must exist; refuelPerUnit >0
// armour:
"armour": { "armour": 1, "ward": 0, "speedPenalty": 0,
            "attrMod": { "wits": -1 },                     // optional stat trade-off
            "spikes": { "damage": "1d3", "chance": 1 } }   // optional melee reflect (chance in (0,1])
// consumable: effect.type ∈ emit-light|restore|damage-over-time
"consumable": { "flavour": "optional one-off cast message.",
                "effect": { "type": "restore", "hp": 5, "mana": 5 } }
// scroll: teaches scroll.spell (spell must exist)
"scroll": { "spell": "spark" }
// recipe item: names a recipe id that must exist
"recipe": "searing-flare"
// book: teaches every listed recipe/spell at once (ids must exist; ≥1 total). Consumed on study.
"teaches": { "recipes": ["mushroom-soup", "cooked-skewer"], "spells": ["spark"] }
```

`currency` (shards) skips `value`/`slot`. `treasure`/`material` are usually just
common fields + `stackable`.

---

## Mob — `data/world/mobs.json`

```jsonc
"cave-centipede": {
  "id": "cave-centipede",
  "name": "a cave centipede",
  "description": "A whip-fast length of armoured segments...",
  "maxHp": 13,
  "speed": 12,                         // lower = faster; player is 12
  "armour": 1,                         // flat physical mitigation (number)
  "ward": 0,                           // magical mitigation / resist (number)
  "evasion": 0.8,                      // optional miss-chance (wisp uses it)
  "emitsLight": 1,                     // optional: this mob is a light source
  "attributes": { "might": 6, "vitality": 5, "intellect": 0, "wits": 6, "perception": 7 },
  "perception": { "blindBelow": 0, "dimBelow": 0, "harmedAbove": 3 },  // see light scale below
  "behavior": "hunt",                  // passive|wander|hunt|guard|lurk (flavour/AI posture)
  "hostile": true,
  "helper": true,                      // optional: piles into an ally's fight
  "ambush": true,                      // optional: drops on prey (with behavior "lurk")
  "posture": "sleeping",               // optional authored start: standing|sitting|sleeping (inert until struck)
  "attack": { "damage": "1d4", "actionCost": 11,
              "onHit": [{ "type": "damage-over-time", "name": "venom",
                          "damage": "1d2", "duration": 5, "chance": 1 }] },  // attacker triggers
  "spikes": { "damage": "1d3", "chance": 1 },   // optional contact-reflect sugar (chance in (0,1])
  "lightBane": { "above": 3, "damage": "1d2" }, // optional: hurt each tick when light > above
  "lightAggro": { "above": 0 },                 // optional: roused to attack when light > above
  "xp": 9,                             // XP awarded on kill
  "shards": "1d3",                     // dice dropped on death (optional)
  "actions": [                         // weighted per-tick behaviour
    { "type": "attack", "weight": 7 },
    { "type": "idle", "weight": 3 },
    { "type": "emote", "weight": 2, "messages": ["rears, antennae testing the air"] },
    { "type": "wander", "weight": 2, "verb": "skitters off", "scope": "zone" },  // scope: zone|any
    { "type": "flee", "lightAbove": 3, "verb": "recoils and flees", "scope": "zone" },
    { "type": "cast", "weight": 5, "spell": "spark" },        // spell must exist AND be hostile
    { "type": "summon", "weight": 2, "mob": "giant-rat", "count": 2, "max": 4, "verb": "shrieks" }
  ],
  "loot": [{ "template": "venom-gland", "chance": 0.7 }],     // templates must exist
  "shop": { "sells": [{ "template": "torch" }, { "template": "lantern", "price": 35 }] }  // NPC trader
}
```

Action types: `attack | cast | emote | wander | idle | flee | summon`. `emote`
needs a non-empty `messages[]`. `onDamage` (defender-side trigger array) mirrors
item armour `onDamage` — see data-model "Combat triggers" for the full shape.

**Perception band** (gates sight & combat accuracy): `blindBelow` = min light to
see at all (0 = darkvision); `dimBelow` = light for clear sight (partial between);
`harmedAbove` = max comfortable light (glare above). Deep-dwellers: low
`harmedAbove`. Place power on the **threat ladder** by depth — see lore.

---

## Spell — `data/world/spells.json`

```jsonc
"spark": {
  "id": "spark",                       // key === id
  "name": "Spark",
  "description": "A snapping bolt of static light...",
  "manaCost": 4,                       // ≥0
  "shardCost": 5,                      // optional ≥0 (glimmerskin burns shards)
  "hostile": true,                     // hostile spells are required for mob `cast` actions
  "target": "creature",
  "effect": { /* exactly one of the shapes below */ }
}
```

Effect shapes (`effect.type` ∈ `damage | emit-light | heal-over-time | protect | summon`):

```jsonc
// damage — instantaneous; optional attribute scaling
{ "type": "damage", "damageType": "magical", "damage": "1d4",
  "scale": { "attr": "intellect", "per": 4 } }
// emit-light — timed light status
{ "type": "emit-light", "magnitude": 1, "duration": 180 }
// heal-over-time — pulses every interval for duration
{ "type": "heal-over-time", "name": "Regeneration", "interval": 2, "duration": 10,
  "magnitude": 0, "scale": { "attr": "intellect", "per": 2 }, "good": true }
// protect — timed armour/ward; needs at least one of armour|ward
{ "type": "protect", "name": "Glimmerskin", "duration": 180, "refresh": true,
  "armour": { "base": 1, "scale": { "attr": "intellect", "per": 4 } },
  "ward":   { "base": 0, "scale": { "attr": "intellect", "per": 1 } }, "good": true }
// summon — conjure a mob (must exist) for a time
{ "type": "summon", "mob": "wisp", "count": 1, "duration": 180, "group": "summon-wisp" }
```

`{ base, scale }` amount: `scale` must be `{ attr, per }` with `per > 0`. Durations
& intervals are in **ticks**, > 0.

---

## Recipe — `data/world/recipes.json`

```jsonc
"forge-iron-dagger": {
  "id": "forge-iron-dagger",
  "name": "Iron Dagger",
  "station": "smithing",               // MUST match a fixture's `station` (see below)
  "inputs": [{ "template": "iron-bar", "qty": 2 }],  // templates must exist; qty >0
  "shards": 5,                         // optional shard cost ≥0
  "output": { "template": "iron-dagger", "qty": 1 }  // template must exist
}
```

Known stations come from fixtures with a `station` field (currently `alchemy`,
`smithing`, `smelting`, `cooking`). A recipe with no matching station fails
validation. To be craftable from a fresh character, add the id to
`player.json` → `knownRecipes`.

---

## Fixture — `data/world/fixtures.json`

```jsonc
"forge": {
  "id": "forge",
  "name": "a smith's forge",
  "description": "A banked coal forge with anvil and tongs...",
  "type": "crafting",                  // crafting|switch|scenery|resource (flavour/behaviour)
  "station": "smithing"                // crafting station id recipes reference
}
```

Other variants:

```jsonc
// switch — a toggleable light source
"switch": { "emitsLight": 3, "on": false }     // emitsLight ≥0, on is boolean
// scenery with passive light
"emitsLight": 1                                 // ≥0
// resource — a mineable node
"mine": { "template": "iron-ore", "yield": 1, "charges": 5, "respawn": 90, "energy": 30 }
//   template must exist; charges & respawn >0; yield >0; energy ≥0
```

A fixture can be hidden behind `search` when referenced from a room as
`{ "template": "forge", "hidden": { "perception": 3 } }` (perception > 0).

---

## Room — `data/world/rooms.json`

```jsonc
"rim.inn": {                           // key === id; convention: area.name
  "id": "rim.inn",
  "zone": "rim",                       // string; bounds `wander`/`flee` scope:"zone"
  "name": "The Lantern's Rest",
  "description": "Warmth and low talk spill from a long common room...",
  "depth": 0,                          // 0 at the rim, increases downward
  "ambientLight": 5,                   // base light before sources (light scale: 0 dark, 1-2 dim, 3-9 bright, 10+ searing)
  "exits": { "south": "rim.plaza" },   // dir → roomId; dest MUST exist. north|south|east|west|up|down
  "hiddenExits": { "down": { "to": "deep.crack", "perception": 4 } },  // optional; gated by search, perception >0
  "fixtures": ["hearth"],              // fixture ids, or { template, hidden:{perception} }
  "groundItems": [{ "template": "palecap-mushroom", "qty": 2, "respawn": 120 }],  // respawn ticks >0
  "spawns": [{ "mob": "rim-innkeeper", "max": 1, "respawn": 60 }]      // max>0, respawn ticks >0
}
```

**Every room must be reachable** from `player.startLocation` (`rim.plaza`) via
exits or hidden exits — the validator walks the graph and rejects orphans. New
rooms need at least one path in.

---

## Starting character — `data/templates/player.json`

Not content per se, but where new items/recipes/spells become available to fresh
characters:

```jsonc
{
  "startLocation": "rim.plaza",        // must exist
  "startInventory": [{ "template": "torch", "fuel": 200 }],   // templates must exist
  "startEquipment": { "hand": "short-sword", "body": null, "head": null, "light": null },
  //   seed every slot (null is fine) so `unequip <slot>` works from a fresh character
  "knownRecipes": ["forge-iron-dagger"],   // recipe ids must exist
  "knownSpells": []                        // spell ids must exist
}
```
