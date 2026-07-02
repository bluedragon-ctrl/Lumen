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
| `< 0`       | void       |
| `0`         | darkness   |
| `1`–`2`     | dim        |
| `3`–`9`     | bright     |
| `10`+       | searing    |

Searing is deliberately hard to reach — a torch plus a few lightbugs stays
*bright*. `void` is its dark-side mirror: a sub-zero band only reachable in a
room authored with negative `ambientLight` (a deep dark that drinks your light),
shown with a distinct "deep dark" treatment in the client. Effective light is
clamped to `-20..20`.

**Effective light** of a room each tick:

```
effective = clamp( room.ambientLight + Σ(active light-source output in room), -20, 20 )
```

- `ambientLight` is the room's authored base (usually falls toward 0 with depth).
  It may be **negative** for deep-dark rooms: the effective light can then fall
  below 0, which reads as the `void` band — carried light must first cancel the
  negative before anything becomes visible.
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
  "d0.plaza": {
    "id": "d0.plaza",
    "zone": "rim",
    "name": "The Rim Plaza",
    "description": "Lantern-light pools across worn flagstones at the abyss's lip...",
    "depth": 0,
    "ambientLight": 4,
    "exits": { "east": "d0.market", "down": "d1.landing" },
    "fixtures": ["alchemist-bench"],
    "groundItems": [{ "template": "vial", "qty": 2 }],
    "spawns": [{ "mob": "lightbug", "max": 1, "respawn": 20 }]
  }
}
```

| Field          | Type              | Notes |
|----------------|-------------------|-------|
| `id`           | string            | Unique, matches the map key. Convention: **`d<depth>.[region.]name`** — the depth prefix is mandatory and the validator enforces that it matches the `depth` field (so a retune can't leave an id lying about its depth). The middle `region` segment is optional and used only where a depth has named sub-areas (e.g. `d2.mine.3`, `d4.lake.shrine`, `d4.umbral.gallery`); through/connective rooms omit it (`d1.fissure`, `d2.crossing`). |
| `zone`         | string?           | Area tag (e.g. `rim`/`abyss`). Bounds `wander` with `scope: "zone"` — a mob only roams between rooms sharing its current zone. (Future: pursuit limits.) Independent of the id's depth prefix — `zone` is a movement boundary, not a location label. |
| `tags`         | string[]?         | Free-form terrain tags (e.g. `"water"`, `"outdoor"`). Cross-cut zones. Used by tag-aware mob movement: a `wander`/`flee` action's `requireTags`/`forbidTags` filter destinations by these. Untagged is the neutral default — an untagged room satisfies no `requireTags` and trips no `forbidTags`, so existing mobs roam unchanged. |
| `name`         | string            | Short room title. |
| `description`  | string            | Shown in the Inspect window when visible. |
| `depth`        | integer           | 0 at the rim; increases downward. Flavour + future scaling. |
| `ambientLight` | integer           | Base light before sources (see light scale). May be **negative** for deep-dark rooms: the effective light can fall below 0, which reads as the `void` band (carried light must first cancel the negative before anything is visible). |
| `exits`        | map dir→roomId    | Directions: `north`,`south`,`east`,`west`,`up`,`down` (extensible). |
| `fixtures`     | string[]          | Fixture ids present in the room (crafting stations, etc.). |
| `groundItems`  | ItemRef[]         | Initial items on the floor (instantiated at world load). |
| `spawns`       | SpawnRule[]       | Mob spawn rules. `{ "mob": id, "max": n, "respawn": ticks? }`. `respawn` (ticks) refills the population back to `max`, one mob per interval, once a kill or a wandered-off mob drops the count; omit it for a static one-time spawn. The cap counts a spawner's mobs **wherever they have wandered**, so wandering doesn't multiply them. |
| `effects`      | RoomEffect[]?     | Effects the room applies to players: each `{ trigger: "enter"|"tick", when?: { lightBelow|lightAbove: N }, interval?, action, message?, roomMessage? }`. `action` is exactly one of `douse: true` (snuff carried lights), `restore: { hp?, mana? }` (flat ints), or `damage: { hp?, mana? }` (dice). `enter` fires on arrival; `tick` fires every `interval` ticks while present (default 1), gated by the optional light `when`. Players only. |

`groundItems`/`fixtures`/`spawns` are optional (default empty).

---

## Targeting (keywords & abbreviation)

How typed input resolves to a thing or a command — shared by every command that
takes a target (`get`, `drop`, `equip`, `kill`, `cast`, `buy`, `craft`, …).

**Targets (items, mobs, spells, recipes).** A query matches a target when, in order:

1. it equals the target's `id` exactly; else
2. every word of the query is (a prefix of) one of the target's **keywords** —
   the optional `keywords` array if present, otherwise the significant words
   derived from `name` (articles/prepositions like *a/an/the/of/with* dropped).
   Multi-word queries use **AND** semantics, so `glimmer crystal` needs both; else
3. the query is a substring of the full `name` (legacy fallback).

So *Maeve the innkeeper* answers to `innkeeper`, *a sliver of glimmerstone* to
`glimmerstone` or `sliver` or `glimm`. Add a `keywords` array only for synonyms the
name lacks. (Ordinals like `2.rock` are **not** supported — the first match wins.)

**Commands.** A verb that isn't an exact match (or alias, or direction) resolves to
the first command it is a **prefix** of, in the priority order of `VERBS` in
`server/commands.js` — DikuMUD-style abbreviation (`exa`→`examine`, `cr`→`craft`).

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
| `keywords`   | string[]? | Words a player can target this by (`get <kw>`, `kill <kw>`, …). **Optional** — when omitted, the significant words of `name` are used automatically (articles/prepositions like *a/the/of* dropped), so a sliver of glimmerstone already answers to `sliver` and `glimmerstone`. Set it only to add synonyms the name doesn't contain (e.g. `["ore","rock"]`). See [Targeting](#targeting-keywords--abbreviation). |
| `type`       | enum    | `light` \| `weapon` \| `armour` \| `consumable` \| `material` \| `currency` \| `misc`. `currency` (e.g. `shards`) is gathered into the player's balance by `get`, not stowed in inventory. |
| `rarity`     | enum?   | `common` (default) \| `uncommon` \| `rare` \| `epic` \| `legendary`. Cosmetic tier surfaced in the client: a coloured frame on the ground-item chip (Common is neutral — no colour) and a tier badge in the Inspect window. Omit for Common. Colour is only legible in adequate light, like any other examine detail. |
| `slot`       | enum?   | Equip slot: `hand` \| `body` \| `head` \| `neck` \| `finger` \| `light` … (omit if not equippable). Slots are **dynamic** — a slot exists once any item declares it; seed empty ones in `startEquipment` so `unequip <slot>` works fresh. |
| `weight`     | number  | For future carry-capacity. |
| `value`      | integer | Buy price in shards (what a trader charges). **Required** for every item except `currency`. |
| `sellValue`  | integer?| What a trader pays to buy it from a player. Defaults to `round(value × 0.2)` (20%); set it to override. |
| `stackable`  | bool?   | If true, instances stack as `qty` (materials). |
| `light`      | block?  | `{ output, fuelMax, burnPerTick }` — makes it a fuelled light source. Add `fuelItem` + `refuelPerUnit` to make it **refuellable** (`refuel <item>` consumes one `fuelItem` and adds `refuelPerUnit` fuel); omit them for a disposable light (e.g. a torch). |
| `weapon`     | block?  | `{ damage: { physical?, magical? }, actionCost, scale?, crit?, onHit? }`. Damage values are **dice notation** (see below). `crit` is an optional flat crit chance (0..1) the weapon adds on top of the wielder's Perception-derived crit (mirrors a mob's `attack.crit`); a crit doubles the damage roll. |
| `armour`     | block?  | `{ armour, ward, speedPenalty, maxHp?, maxMana?, attrMod?, spikes?, onDamage? }`. `maxHp`/`maxMana` are bonus max HP/Mana the piece grants while worn (heavy gear → durability on top of Vitality; caster gear → a deeper mana well on top of Intellect); both are folded into derived stats and refreshed on equip/unequip, with the new capacity granted on equip and clamped on unequip. `attrMod` is a map of attribute → flat modifier applied to the wearer's **effective** attributes (read live at combat/cast time), e.g. `{ "intellect": 2 }` to lift spell power or `{ "wits": -1 }` for clumsy heavy gear. |
| `consumable` | block?  | `{ effect }` — `drink`/`use` applies `effect`, a **status-effect primitive** (see [Status effects](#status-effects-dynamic)). |
| `scroll`     | block?  | `{ spell }` — `learn`/`study` teaches the one spell, then consumes the item. |
| `recipe`     | string? | A recipe id — `learn`/`study` teaches the one recipe, then consumes the item. |
| `teaches`    | block?  | `{ recipes?: [...], spells?: [...] }` — a **book**: `learn`/`study` teaches every listed recipe/spell the player doesn't already know, then consumes the item. (If the player already knew all of them, it isn't consumed.) |

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
| `faction`    | enum?   | The side this creature fights *for*: `wild` (default — the deep's predators) \| `rim` (village NPCs & guards) \| `fauna` (peaceful wildlife) \| `umbral` (the deep-dwelling Umbrals) \| `player` (reserved for summons). Sets *sides* (see [Faction & ownership](#faction--ownership-runtime)); a summon overrides it at spawn. Tag village NPCs `rim`, peaceful creatures `fauna`, Umbrals `umbral`. |
| `ambush`     | bool?   | Predator that lies in wait. It still hunts (tracks perceivable enemies) but holds its **proactive** strike until a target is **sleeping**, then attacks; if `hidden`, that first strike **reveals** it to the victim (no `search` needed) and fires a `mob-ambush` appearance line. It emits no "spotted" tell, and once blows are traded it fights on normally (combat threat) regardless of posture. Requires `hostile: true`. |
| `helper`     | bool?   | Defender. On its action it **joins any fight an allied combatant is in** (ally = its faction *or* a faction it allies with, per the relations table) — it engages a present enemy that such an ally holds combat threat on, **or** one that is itself attacking an ally (so a guard steps in for a victim who hasn't fought back). Fires a one-shot `mob-assist` "rushes to join" line; perception-gated (won't join in the dark it can't see). Turns a pack into a swarm — and is how a `rim` guard defends a delver. |
| `remembers`  | bool?   | Holds a grudge. Normally a mob forgets a foe the instant they leave the room; a `remembers` mob instead **parks** the combat threat of a *player* it has traded blows with, and **re-engages them on sight** if they return within ~1 min (`GRUDGE_TICKS`), firing a "remembers you" tell. The grudge does not keep it pinned in combat — it wanders and mends between encounters — and lapses on the timer, or the moment the player dies or logs out. Suits guardians and sentinels (see Aggro / threat). |
| `pursues`    | bool?   | Hunts across rooms. Reading the same parked grudge as `remembers` (which it implies for parking purposes — a `pursues` mob parks a fled player's threat even without `remembers`), a `pursues` mob with no enemy in the room **stalks the fled quarry** one room per action along the shortest path toward where they now stand (DikuMUD `hunt_victim`). The chase is **leashed** to `pursueRange` rooms from its spawn room: it never steps into a room farther than that from home. When the grudge is gone — quarry dead, logged out, lapsed, or driven past the leash — a stray pursuer **returns home** (v1: a quiet relocate to its spawn room once no one is watching it leave). Suits lone predators. |
| `pursueRange`| int?    | Pursuit leash in rooms (BFS depth) from the mob's spawn room; default `4`. Only meaningful with `pursues`. |
| `attack`     | block?  | Melee profile: `{ damage (dice), actionCost, type?, bonus?, crit?, hitBonus?, onHit? }`. `onHit` (see below) lands effects on a struck defender. |
| `onDamage`   | block?  | General **when-struck** triggers (see below): a list of effect specs that fire when this mob is hit — reflect damage, retaliate with a DoT, or buff itself. Same shape on an item's `armour.onDamage`. |
| `spikes`     | block?  | Terse sugar for the commonest `onDamage` entry — a flat melee **reflect** ("thorns"): `{ damage (dice), chance? }`. Anyone who lands a melee hit takes the damage back. Fires even if the mob has no `attack` of its own. Equivalent to `onDamage: [{ type: "damage", damage, target: "attacker" }]`. |
| `shop`       | block?  | Makes the mob a trader: `{ "sells": [{ template, price?, requiresQuest? }] }` — its stock, each sold at the item's `value` (or an optional `price` override). A `requiresQuest` id gates that offer: it stays hidden from `list` and unbuyable until the player has that quest in `quests.done`. There is **no buy list**: the trader buys *any* valued item from a player at its `sellValue`. Players use `list`/`buy`/`sell` in the room. |
| `shards`     | dice?   | Shards dropped on death, e.g. `"1d4"`. They land on the floor as a `shards` (type `currency`) pile that **anyone** present can `get` — gathering tallies to the picker's balance rather than into inventory. Piles in a room merge. |
| `actions`    | Action[]?| Weighted behaviour table (see below). Without it, a hostile mob just attacks. |
| `lightBane`  | block?  | Light hurts it: `{ above, damage (dice) }` — each tick the room light exceeds `above`, the mob is seared for `damage` (credited to the top-threat player present, so light becomes a usable weapon against light-shy things). |
| `regen`      | block?  | Override **out-of-combat recovery**: `{ delay?, perTick? }`. A wounded mob with nothing fighting or watching it, in a room clear of living foes, mends back to full — but only after `delay` ticks out of combat (default 5), at `perTick` HP/tick (default `ceil(maxHp/20)`, i.e. ~full in 20 ticks). The counter to flee-heal-return. Omit for defaults; set a small `perTick` for a slow-mending boss, or a large one to snap back fast. |
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
| `wander`| Walk to a random adjacent room (carrying its light if it glows). **Suppressed while the mob is in combat** (has live threat). | `verb` (display, e.g. "flees"); `scope`: `"zone"` (default — only rooms sharing the mob's current `zone`) or `"any"` (cross-zone); `requireTags: string[]` (only enter rooms carrying **all** these `tags` — e.g. `["water"]` keeps a fish to water); `forbidTags: string[]` (never enter a room carrying any of these — e.g. a surface beast that shuns `["deep-dark"]`). |
| `idle`  | Do nothing this turn — raise its weight to keep a mob calm/quiet. | — |
| `summon`| Conjure reinforcements of the mob's own faction (allies that fight alongside it), up to a living-brood `max`; available only while in combat. | `mob` (template id), `count` (per cast), `max` (max living brood), `verb` (display line) |
| `react` | Single out **one visible player** and address them directly (quest delivery owed, wounds, gear, small talk). Walks `reactions` in authored order — the first entry with a matching player wins, then a random player among its matches and a random message pair. A per-player `cooldown` (ticks, default 120; in-memory only) rotates targets and stops pestering. The target reads `target` (second person); bystanders read `room` with `{name}` replaced by the target's name. Both render as `"<Mob name> <text>"` with a closing period added only if the line doesn't already end in punctuation (so quoted speech can punctuate itself), light-gated like `emote` — and the NPC itself must be able to see (room light vs its perception band) to react at all. `talk <npc>` reuses these reactions: with no quest business to discuss, the NPC answers with the first reaction matching the talker (bypassing — but arming — the cooldown); an NPC without a `react` action keeps the generic "has nothing for you" line. | `reactions: [{ if?, messages: [{target, room}] }]`, `cooldown?`. `if` keys (all must match; omit `if` for an unconditional fallback): `delivery: true` (active deliver step aimed at this NPC), `hpBelow: 0..1` (fraction of maxHp), `slotEmpty: "<slot>"`, `equipped: "<itemId>"` |
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

Allegiance is **instance-level** (an instance defaults to its template's `faction`,
else `"wild"`), so the same template can spawn on different sides. Every mob instance
carries:

| Field      | Default  | Meaning |
|------------|----------|---------|
| `faction`  | template's, else `"wild"` | The side this creature fights *for* — one of `player`, `rim`, `fauna`, `wild`, `umbral`. Players are always faction `"player"`. |
| `ownerId`  | `null`   | The player a `"player"`-faction creature belongs to (kill credit; future pet upkeep). |

Faction sets *sides*; `hostile`/provocation still gate whether a creature actually
engages. Two combatants relate as **ally** (assist each other, never targeted),
**enemy** (eligible to fight), or **neutral** (ignored — neither defended nor
hunted), by this symmetric table (a faction is always its own ally; any unlisted
pair falls back to enemy):

|         | player  | rim    | fauna   | wild    | umbral  |
|---------|---------|--------|---------|---------|---------|
| **player** | ally | ally   | enemy   | enemy   | enemy   |
| **rim**    | ally | ally   | ally    | enemy   | neutral |
| **fauna**  | enemy | ally   | ally    | neutral | neutral |
| **wild**   | enemy | enemy  | neutral | ally    | neutral |
| **umbral** | enemy | neutral | neutral | neutral | ally    |

`enemy` only marks who *may* fight — whether a creature *starts* one is the separate
`hostile` flag. So a `rim` guard counts predators (`wild`) as enemies and defends
players, NPCs, and fauna; `wild` predators war on players, guards, and player-summons.
**`fauna` are `enemy` to `player`** but `hostile: false`: they never initiate and are
never hunted, yet they fight back when farmed (a struck Old Grinder still has teeth) —
and because the player is the guard's *ally*, hunting livestock never pulls a `rim`
guard onto you. `fauna`↔`wild` is **neutral for now** (predators don't yet prey on
livestock) — flip both halves to `enemy` to switch that ecosystem on. `umbral` (the deep-dwellers — Mallki and kin) is
**enemy to `player`** so hostile Umbrals can engage delvers; a peaceful Umbral like the
trader is simply `hostile: false` and never acts on it, and an Umbral guard
(`umbral` + `helper`) defends its kin against anyone who strikes them. This is also the
substrate **summons** sit on (an allied mob spawned `faction:"player"` + `ownerId`).
The admin `@spawn <mobId> [count] [wild|player|rim|fauna|umbral]` overrides it for live
testing.

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
  A mob-id `aggro` key (an allied **summon** that helped) credits that summon's
  **owner** in the kill's XP share (present + alive); a wild mob's key credits no one.
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
| `type`   | enum   | `crafting` \| `switch` \| `door` \| `scenery` \| `resource` \| … |
| `station`| string?| Crafting station tag recipes reference (e.g. `alchemy`, `forge`). |
| `switch` | block? | Makes the fixture switchable: `{ emitsLight, on }`. `on` is the default state; each instance carries live on/off state. Toggled with `use <fixture>`. When on, `emitsLight` adds to room light (like a torch). |
| `mine`   | block? | Makes the fixture a mineable **resource vein**: `{ template, yield?, charges, respawn, energy?, drops? }`. `mine`/`dig` spends `energy` (defaults to the player's speed) to draw down one `charge`; a worked-out vein refills to full after `respawn` ticks (see `state._mineTick`). Requires light. **Yield** is either a single `template` (+`yield`, default 1) **or** a weighted `drops` table (see [Resource drop tables](#resource-drop-tables)) — not both. |
| `fish`   | block? | Makes the fixture **fishing water**, a sibling of `mine`: `{ template, yield?, charges, respawn, energy?, bait?, catchChance?, drops? }`. `fish`/`angle` spends `energy` (default speed) **and one `bait` item** (default `grub`, consumed every cast whether or not anything bites), then rolls `catchChance` (0–1, default 1) to land a catch and draw down a charge. Misses cost the bait but no charge. The catch is a single `template` (+`yield`) or a `drops` table, as for `mine`. Refills like a vein after `respawn` ticks. Requires light. |
| `door`   | block? | Makes the fixture a gated exit: `{ dir, to, open, key? }`. While **open**, the room gains an exit `dir → to`; **shut**, that way reads as no exit at all. `open` is the default state; each instance carries live open/shut state, toggled with `use <fixture>` (or `open`/`close <fixture>`). An optional `key` (an item template) **locks** the door: only a player carrying that item can `open` it, and the key is **kept, not consumed** (the way stays open once unlocked); closing is always allowed. The validator counts a room's door fixture as a graph edge, so a room reachable only through a door still validates, and checks `key` resolves to a real item. |

#### Resource drop tables

A `mine`/`harvest`/`fish` block yields its resource one of two ways:

- **Single resource** — `template` (+ optional `yield`, default 1). Every successful action gives `yield` of that one item.
- **Weighted `drops` table** — an array of `{ template, qty?, weight? }`. **One** entry is rolled per successful action, with probability proportional to `weight` (default 1). `qty` is an integer or a dice string (`"2d4"`), default 1. This lets a vein give *one outcome or another* per swing — "usually ore, rarely a few shards" — rather than always the same drop.

`template` and `drops` are mutually exclusive; declare exactly one. A drop whose item is type `currency` (i.e. `shards`) tallies straight to the miner's purse like gathering a floor pile; everything else goes into the pack. Example — an iron vein that mostly gives ore but occasionally a small shard windfall:

```json
"mine": {
  "charges": 5, "respawn": 90, "energy": 30,
  "drops": [
    { "template": "iron-ore", "qty": 1, "weight": 9 },
    { "template": "shards", "qty": "1d4", "weight": 1 }
  ]
}
```

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

## Quest (static) — `data/world/quests.json`

A map of `questId → quest`. A quest is **acquired** when its `start` trigger fires,
worked through as **ordered steps** (one objective each), and pays out `rewards` on
completing the final step. The engine lives in [server/quests.js](../server/quests.js);
the quest log is shown in the console with `quest` / `journal` (no UI pane).

```json
{
  "warrens-thinning": {
    "id": "warrens-thinning",
    "name": "Thin the Warrens",
    "description": "Maeve wants the rat warren culled.",
    "start": { "trigger": "talk", "npc": "rim-innkeeper", "offerText": "Cull a few for me?" },
    "steps": [
      { "kill": "giant-rat", "count": 5, "text": "Cull 5 giant rats" },
      { "deliver": "rat-meat", "count": 5, "npc": "rim-innkeeper", "text": "Bring 5 cuts to Maeve" }
    ],
    "rewards": { "xp": 45, "shards": 25, "items": [{ "template": "hearty-broth", "qty": 3 }] }
  }
}
```

| Field         | Type      | Notes |
|---------------|-----------|-------|
| `id`,`name`   | string    | `id` matches the map key; `name` is the journal title. |
| `description` | string?   | One-line summary shown when the quest is accepted. |
| `start`       | block     | How the quest is offered (see below). |
| `steps`       | Step[]    | Ordered objectives, revealed one at a time. `kill` steps accrue progress for the whole quest, so a mob matching a not-yet-current `kill` step still banks credit toward it; other objective types only accrue once their step is current. |
| `rewards`     | block?    | Paid out once, on completing the last step. |
| `repeatable`  | bool?     | Default `false` (one-time). `true` lets a finished quest be retaken. |

**Start trigger** — `{ trigger, … , offerText? }`. `offerText` is optional flavour shown on accept.

| `trigger` | Extra field | Fires when… |
|-----------|-------------|-------------|
| `talk`    | `npc` (mobId)     | the player `talk`s to that NPC. |
| `use`     | `fixture` (id)    | the player `use`s that fixture. |
| `item`    | `item` (id)       | the player acquires that item (pick up / buy / craft). |
| `enter`   | `room` (roomId)   | the player enters that room for the first time. |

**Step objective** — exactly **one** objective key per step, plus optional `text` (the journal line; a default is generated from the objective if omitted):

| Objective | Shape | Complete when… |
|-----------|-------|----------------|
| `kill`    | `{ kill: <mobId>, count }`              | the player is credited with `count` kills of that mob — credit banks even while an earlier step is active. |
| `deliver` | `{ deliver: <itemId>, count, npc }`     | the player `give`s `count` of the item to that NPC (consumed). |
| `use`     | `{ use: <fixtureId> }`                  | the player `use`s that fixture. |
| `collect` | `{ collect: <itemId>, count }`          | the player **possesses** `count` of the item (live inventory). |

**Rewards** — all optional: `xp` (via `awardXp`, level-ups and all), `shards`,
`items` (ItemRef[] into the pack), `recipes` (recipe ids taught), `spells` (spell ids taught).

> **Runtime state.** A player's quest log is dynamic state on the player object —
> `player.quests = { active: { [questId]: { step, progress, kills } }, done: [questId, …] }` —
> persisted with the rest of the character (not committed). `progress` is the running
> count for the current `deliver` step; `kills` is a `{ [mobId]: count }` tally banked
> across the whole quest, so a `kill` step may already be (partly) satisfied the moment
> it becomes current.

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
| `type`      | enum    | The primitive. Implemented: `emit-light` (actor radiates `magnitude` light, summed into room light like a torch — a **negative** `magnitude` is a *darkness aura* that subtracts, drinking the room toward black); `summon` (see below). |
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

A **`consumable`** item may carry the same `summon` effect (the pet path — e.g. a
`thornbug-egg` hatching a `baby-thornbug`). `use`-ing it consumes the item and
conjures a **permanent** companion (`duration` omitted), with the same per-owner
`group` recast cap. This is the pet counterpart to the time-limited combat Summon
spell; richer pet handling (naming, dismissal, following) is to come.

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
  "startLocation": "d0.plaza",
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
