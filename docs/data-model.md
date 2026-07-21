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
- **`blindAbove`** *(optional)* — the bright-side twin of `blindBelow`: light past
  this level **dazzles the actor blind** (combat accuracy drops to 5% and it can no
  longer *notice* an enemy — see the aggro table). Must sit above `harmedAbove` (it
  caps the glare band). Reserved for dark-adapted creatures; players carry none, so
  strong light never blinds a delver — it lets one **slip past** a light-hating
  hunter, the mirror of sneaking past a lantern-blind human in the dark. Omit for
  actors with no upper limit.

These define the visibility tiers used for **combat accuracy** (see the server
README): can't-see (5%) · partial/dim (50%) · clear (100%) · glare (50%) · dazzled
(5%, `blindAbove` only).

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
| `zone`         | string?           | Area tag (e.g. `rim`/`abyss`). Bounds `wander` with `scope: "zone"` — a mob only roams between rooms sharing its current zone. (Future: pursuit limits.) Independent of the id's depth prefix — `zone` is a movement boundary, not a location label. The validator requires each zone to be **one connected piece** (a split zone strands zone-scoped mobs); a zone deliberately split while its connecting content is upcoming must be declared in `PENDING_ZONE_LINKS` (validate-data.js). |
| `tags`         | string[]?         | Free-form terrain tags (e.g. `"water"`, `"outdoor"`). Cross-cut zones. Used by tag-aware mob movement: a `wander`/`flee` action's `requireTags`/`forbidTags` filter destinations by these. Untagged is the neutral default — an untagged room satisfies no `requireTags` and trips no `forbidTags`, so existing mobs roam unchanged. |
| `biome`        | string?           | Purely cosmetic. Tints the Inspect window with an ambient glow layered over the light band. Values: `"umbral"` (neon blue, living deep-folk), `"wraith"` (cold violet, darkness-tainted Umbrals), `"gloaming"` (cave green), `"slime"` (acid-lime, slug middens), `"mutant"` (blood-crimson, dark-warped vermin nests), `"water"` (deep blue, lakes/drowned reaches), `"rim"` (lantern gold, the surface town), `"ember"` (lava orange — reserved for upcoming volcanic content, no rooms yet). Enum-checked by the validator; the palette + rules live in `client/styles.css` (`.biome-*`), with the tint receding under `searing` and suppressed under `void`/`darkness`. No gameplay effect. Add a value there and in `BIOMES` (validate-data.js) to introduce a new one. |
| `name`         | string            | Short room title. |
| `description`  | string            | Shown in the Inspect window when visible. |
| `depth`        | integer           | The **progression band** — the rung of the descent (0 at the rim, rising with the journey). Drives the Tide's depth-scaled darkening and onset spawn bands, and prefixes the id. **Not elevation and not a strict threat promise** — true elevation (the *floor*) is derived from the exit graph: an `up`/`down` exit moves one floor (or its `exitSpans` count), every other direction stays level. The validator solves every room's floor and fails when two routes disagree (a vertical loop that doesn't close); `node tools/validate-data.js --floors` prints the solved elevation report. Up/down structure *within* one band (a tower, a cellar) is normal and expected. |
| `ambientLight` | integer           | Base light before sources (see light scale). May be **negative** for deep-dark rooms: the effective light can fall below 0, which reads as the `void` band (carried light must first cancel the negative before anything is visible). |
| `exits`        | map dir→roomId    | Directions: `north`,`south`,`east`,`west`,`up`,`down` (extensible). A one-way passage is just an exit with no matching return exit on the destination (e.g. a chute you slide down but can't climb back). Where a return edge **does** exist, the validator requires it to run in the exact opposite direction — "down one way, west back" lies about the world's shape. A hidden exit may not share a direction with a visible exit in the same room (the visible one shadows it in `move()`). Compass directions are **authored truth, distances are not**: a `west` passage may be long or short, but a loop of exits must be able to close at *some* choice of passage lengths — the validator rejects loops that net a direction no matter how they stretch (a room can't be both east and west of another). Deliberate exceptions pending a content decision live in `GRID_CUTS` (validate-data.js). |
| `exitMessages` | map dir→string?   | Optional per-exit departure flavour. When the mover leaves via `dir`, this line replaces the plain "You go `dir`." shown to them (bystanders still see the generic leave/arrive). Each key must be a real `exits` direction. Flavour only — it does not change where the exit goes. |
| `exitSpans`    | map dir→int?      | Optional multi-floor span for a vertical exit: `{ "down": 4 }` means that one move descends four floors — a chute or long shaft acting as a **progression shortcut**. Keys must be `up`/`down` and match a real exit (plain, hidden, or door); values are integers ≥ 2 (1 is the implicit default). Cartographic metadata only — the engine never reads it; the validator's floor solve and the map tools do. The paired return exit, if any, must imply the same span, or the floor solve fails. A spanned exit **must** also carry an `exitMessages` entry for that direction (validator-enforced) — the mover should feel the extra distance. |
| `fixtures`     | string[]          | Fixture ids present in the room (crafting stations, etc.). |
| `groundItems`  | ItemRef[]         | Initial items on the floor (instantiated at world load). Each entry may carry `hidden: { perception }` (unseen until a `search` meets the threshold) and/or `respawn` (ticks; regrows a picked-up item after a delay). A non-hidden item with no `respawn` is static (placed once, gone when taken); a **hidden** item with no `respawn` falls back to `DEFAULT_HIDDEN_ITEM_RESPAWN` (config.js) instead of staying gone for good — a room's explicit `respawn` always overrides. |
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
| `slot`       | enum?   | Equip slot: `hand` \| `shield` \| `body` \| `head` \| `neck` \| `finger` \| `light` … (omit if not equippable). Slots are **dynamic** — a slot exists once any item declares it; seed empty ones in `startEquipment` so `unequip <slot>` works fresh. A `shield`-slot piece and a two-handed weapon (see `weapon.twoHanded`) compete for the grip: equipping either auto-unequips the other. |
| `weight`     | number  | For future carry-capacity. |
| `value`      | integer | Buy price in shards (what a trader charges). **Required** for every item except `currency`. |
| `sellValue`  | integer?| What a trader pays to buy it from a player. Defaults to `round(value × 0.2)` (20%); set it to override. |
| `stackable`  | bool?   | If true, instances stack as `qty` (materials). |
| `light`      | block?  | `{ output, fuelMax, burnPerTick }` — makes it a fuelled light source. Add `fuelItem` + `refuelPerUnit` to make it **refuellable** (`refuel <item>` consumes one `fuelItem` and adds `refuelPerUnit` fuel); omit them for a disposable light (e.g. a torch). |
| `weapon`     | block?  | `{ damage: { physical?, magical? }, actionCost, scale?, crit?, pierce?, twoHanded?, onHit? }`. Damage values are **dice notation** (see below). `crit` is an optional flat crit chance (0..1) the weapon adds on top of the wielder's Perception-derived crit (mirrors a mob's `attack.crit`); a crit doubles the damage roll. `pierce` (int, default 0) ignores that many points of the defender's **Armour** before the physical soak — a blunt weapon cracking shell/plate; it only affects `physical` blows (Ward, a percent cut on `magical` blows, is untouched) and never drives the soak below zero. A mob's `attack.pierce` does the same for its swing. `twoHanded: true` marks the weapon as filling both hands — it can't be worn alongside a `shield`-slot piece, and equipping either auto-unequips the other. |
| `armour`     | block?  | `{ armour, ward, voidWard?, speedPenalty, maxHp?, maxMana?, attrMod?, spikes?, onDamage? }`. `armour` soaks physical flat; `ward` (shown to players as **spellward**) cuts magical; `voidWard` cuts **void only** as a percent (Umbral gear — the *only* source of Voidward, since Wits grants none). `maxHp`/`maxMana` are bonus max HP/Mana the piece grants while worn (heavy gear → durability on top of Vitality; caster gear → a deeper mana well on top of Intellect); both are folded into derived stats and refreshed on equip/unequip, with the new capacity granted on equip and clamped on unequip. `attrMod` is a map of attribute → flat modifier applied to the wearer's **effective** attributes (read live at combat/cast time), e.g. `{ "intellect": 2 }` to lift spell power or `{ "wits": -1 }` for clumsy heavy gear. |
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
| `ward`       | integer?| Innate **magical** damage reduction (default 0), like a player's Ward (spellward). |
| `voidWard`   | integer?| Innate **void** damage reduction (default 0), percent-cut, like a player's Voidward. For Umbral mobs. |
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
| `attack`     | block?  | Melee profile: `{ damage (dice), actionCost, type?, bonus?, crit?, pierce?, hitBonus?, onHit? }`. `pierce` (int, default 0) ignores that much of the target's Armour on a physical swing (see `weapon.pierce`). `onHit` (see below) lands effects on a struck defender. |
| `onDamage`   | block?  | General **when-struck** triggers (see below): a list of effect specs that fire when this mob is hit — reflect damage, retaliate with a DoT, or buff itself. Same shape on an item's `armour.onDamage`. |
| `spikes`     | block?  | Terse sugar for the commonest `onDamage` entry — a flat melee **reflect** ("thorns"): `{ damage (dice), chance? }`. Anyone who lands a melee hit takes the damage back. Fires even if the mob has no `attack` of its own. Equivalent to `onDamage: [{ type: "damage", damage, target: "attacker" }]`. |
| `shop`       | block?  | Makes the mob a trader: `{ "sells": [{ template, price?, requiresQuest? }] }` — its stock, each sold at the item's `value` (or an optional `price` override). A `requiresQuest` id gates that offer: it stays hidden from `list` and unbuyable until the player has that quest in `quests.done`. There is **no buy list**: the trader buys *any* valued item from a player at its `sellValue`. Players use `list`/`buy`/`sell` in the room. |
| `shards`     | dice?   | Shards dropped on death, e.g. `"1d4"`. They land on the floor as a `shards` (type `currency`) pile that **anyone** present can `get` — gathering tallies to the picker's balance rather than into inventory. Piles in a room merge. |
| `actions`    | Action[]?| Weighted behaviour table (see below). Without it, a hostile mob just attacks. |
| `lightBane`  | block?  | Light hurts it: `{ above, damage (dice) }` — each tick the room light exceeds `above`, the mob is seared for `damage` (credited to the top-threat player present, so light becomes a usable weapon against light-shy things). |
| `regen`      | block?  | Override **out-of-combat recovery**: `{ delay?, perTick? }`. A wounded mob with nothing fighting or watching it, in a room clear of living foes, mends back to full — but only after `delay` ticks out of combat (default 5), at `perTick` HP/tick (default `ceil(maxHp/20)`, i.e. ~full in 20 ticks). The counter to flee-heal-return. Omit for defaults; set a small `perTick` for a slow-mending boss, or a large one to snap back fast. |
| `posture`    | enum?   | Starting posture: `standing` (default) \| `sitting` \| `sleeping`. A **`sleeping`** mob perceives nothing — fully inert (no wander/attack/emote, builds no aggro) until a blow (melee or hostile spell) **rouses** it to standing. A **`sitting`** mob is alert-at-rest: it won't wander or emote, but it *does* detect enemies and **stands as it engages** (see Aggro / threat). Authors dozing guardians, resting NPCs, and creatures you can creep past while they sleep. |
| `spawnMessage` | string? | Custom **arrival** line, used by every spawn path (respawn, the Tide's creep, an onset roster). `{name}` interpolates the light-gated mob name (an unseen arrival reads as "something"); `{Name}` capitalises it. Without one, a generic line (`"X appears."` / `"Something stirs in the dark."`). The void-shadow uses this for its "peels itself out of the unlit air" wording. |
| `despawnVerb` | string? | Custom **exit** fragment for when the creature vanishes without a corpse (e.g. the Tide's ebb reclaiming a tide-spawned mob), rendered as `"<name> <verb>."`. Defaults to `"sinks back into the dark"` on the tide sweep. |

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
`restore` / `damage-over-time` / `immobilize`) plus an optional `chance` (default
1). When the attacker is a **player**, the engine stamps `sourceId` so a poison
kill credits them (like a bleed); a **mob's** venom credits no one. Re-applying each
hit stacks independent instances. DoT ticks bypass armour (it's poison, not a blow).

`immobilize` is a timed **hold** (`{ type: "immobilize", name, duration, chance? }`,
`duration` in ticks, required): while any `immobilize` state is live the struck
delver **cannot leave the room** (`commands.move` refuses) — they can still fight,
rest, and act, but the way out is barred until the grip lapses or they die. It
counts down and clears like any timed state; a fresh hit re-applies it, so a
persistent attacker (the ember snapper) can keep a delver pinned in the fight.

```json
"onHit": [
  { "type": "damage-over-time", "name": "venom", "damage": "1d2", "duration": 5, "chance": 1 },
  { "type": "immobilize", "name": "Held", "duration": 3, "chance": 0.35 }
]
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
  | above `blindAbove` (dazzled by glare) | **0** — never noticed; can be passed |
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
| `door`   | block? | Makes the fixture a gated exit: `{ dir, to, open, key?, requires? }`. While **open**, the room gains an exit `dir → to`; **shut**, that way reads as no exit at all. `open` is the default state; each instance carries live open/shut state, toggled with `use <fixture>` (or `open`/`close <fixture>`). An optional `key` (an item template) **locks** the door: only a player carrying that item can `open` it, and the key is **kept, not consumed** (the way stays open once unlocked); closing is always allowed. An optional `requires` **gates opening on an attribute** — `{ attr, value, failText?, successText? }`: the door only opens for a delver whose **effective** `attr` (base + gear `attrMod` + status buffs, so a Might potion or a ring counts) is ≥ `value`. A stuck rusty gate (`might`) or a puzzle-lock (`intellect`). The needed attribute is named on the refusal (`failText` override, else a generic line, always with the player's current score), on the success line (`successText` override), and as a `needs: <Attr> <value>` line on `examine`. Closing is never gated. `key` and `requires` compose (both must pass). The validator counts a room's door fixture as a graph edge, so a room reachable only through a door still validates, checks `key` resolves to a real item, and checks `requires.attr` is a real attribute with a positive `value`. |

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

## The Tide (static) — `data/world/tide.json`

The **Tide** is the world clock (see [server/world-clock.js](../server/world-clock.js)):
the abyss breathes on a fixed cycle of phases — a long **Calm**, a brief **Stirring**
(the telegraph), the **Tide** (every room darkens, depth-scaled, and light-fearing
predators stir), then a **Receding** ebb back to Calm. The phase is a pure function of
the tick, so a restart simply begins again in the first phase.

The whole configuration is data-driven: this one file drives timing, darkening,
generation, messages, and ambient emotes, so the same engine can carry a different
story by swapping it. Built-in defaults (`DEFAULT_TIDE`) are merged **under** the
authored file by `resolveTide`, so a partial file keeps the untouched defaults, and a
world with no `tide.json` behaves exactly like the shipped one. The engine reads the
resolved config off `state.tide`.

```json
{
  "enabled": true,
  "phases": ["calm", "stirring", "tide", "receding"],
  "phaseTicks": { "calm": 600, "stirring": 60, "tide": 240, "receding": 60 },
  "darkening": {
    "deepCap": -5, "edgeOffset": -1, "tideBase": -2, "tideDepthDivisor": 3,
    "tidePhases": ["tide"], "edgePhases": ["stirring", "receding"]
  },
  "lamp": {
    "onPhases": ["stirring", "tide"], "offPhases": ["calm"],
    "onMessage": "Lamps flare to life…", "offMessage": "The lamps are snuffed out…"
  },
  "phaseMessages": { "tide": "<#red>The Tide comes in…<#reset>" },
  "predator": [
    { "mob": "void-shadow", "chance": 0.05, "cap": 5, "faction": "wild", "noSpoils": false, "maxLight": -1 },
    { "mob": "void-leech", "chance": 0.05, "cap": 10, "faction": "wild", "noSpoils": false, "maxLight": -4 }
  ],
  "spawns": [],
  "emotes": {
    "tide": { "everyTicks": 20, "chance": 0.5, "requireDark": true, "lines": ["The dark presses close…"] }
  }
}
```

| Field | Type | Notes |
|-------|------|-------|
| `enabled` | bool | Master switch. `false` = no clock (rooms sit at ambient, HUD hidden). |
| `phases` | string[] | The cycle order. Phase *names* are free — the roles below reference them by name, so a re-storied world can rename/reorder freely. |
| `phaseTicks` | map | Per-phase length in ticks (≈ seconds at `TICK_MS`). Every phase in `phases` needs one. |
| `darkening` | block | The depth-scaled light offset a phase folds into a room's ambient (always ≤ 0). A **tidePhase** applies `max(deepCap, tideBase − floor(depth / tideDepthDivisor))`; an **edgePhase** applies the flat `edgeOffset`; any other phase applies 0. |
| `lamp` | block | Lamp-tending NPCs (factions `rim`/`umbral`) throw a room's switchable light fixtures on when the Tide enters an `onPhases` phase and snuff the Tide-lit ones on an `offPhases` phase; `onMessage`/`offMessage` narrate it. A phase in neither list leaves lamps as they are. |
| `phaseMessages` | map | One world-wide line per phase change, keyed by the phase being entered. A phase with no entry announces nothing. Supports the client colour tags (`<#red>…<#reset>`). |
| `predator` | rule \| rule[] \| null | The per-tick **creep**: while in a tidePhase, each tick every room where a living delver stands in dark enough light has `chance` to birth one `mob` beside them, up to `cap` of that mob worldwide. `maxLight` (default `-1`) is the light level *at or below which* the mob births — anywhere the delver's own light has failed by default; a deeper predator raises the bar (e.g. `-4`, only the drowned deep). `faction` (default `wild`) and `noSpoils` tag the spawn. May be a single rule or an **array** of rules — several predators sharing the dark, each with its own mob, cap, chance and threshold, ticked independently. `null` = a toothless Tide (darkening only). Tide-spawned mobs are reclaimed by the ebb. |
| `spawns` | Rule[] | Optional **onset roster**: mobs the dark pours across whole depth bands the instant it comes in. Each rule `{ mob, minDepth?, maxDepth?, count?, maxLight?, faction?, noSpoils? }`; a rule skips any room already brighter than `maxLight` (a lit camp keeps the hunters out). Empty by default. |
| `emotes` | map | Ambient atmospheric lines the Tide itself performs, keyed by phase: `{ everyTicks, chance, requireDark, lines[] }`. Fires at most once per `everyTicks`, per occupied room, gated by `chance` and (if `requireDark`) a failed-light room. Flavour that belongs to the Tide, not a mob. |

> **Where flavour lives.** A *creature's* own arrival/exit wording is authored on the
> mob (`spawnMessage` / `despawnVerb` in `mobs.json`), reused by every spawn path
> (respawn, creep, roster, **the Scheduler**) — not in `tide.json`. `tide.json` holds
> only what belongs to the world clock itself.

---

## The Scheduler (static) — `data/world/schedule.json`

Timed world events, independent of the Tide. An **array** of entries; each fires on
its own cadence and delegates the effect to an **action-type handler** (registered
in `server/schedule-actions.js`). The engine (`server/state-scheduler.js`) owns only
the timers — new timed behaviours are added by writing a handler, so entries stay
pure data. Purely in-memory (resets on restart, like repop and the Tide).

```json
[
  { "id": "visiting-trader", "everyTicks": 1200,
    "action": { "type": "visit", "mob": "visiting-trader", "room": "d0.roadgate", "stayTicks": 300 } }
]
```

| Field | Type | Meaning |
|---|---|---|
| `id` | string | Unique entry id. |
| `everyTicks` | int | Fire-to-fire cadence (ticks ≈ seconds at `TICK_MS` 1000). |
| `firstTicks` | int? | Ticks until the **first** fire (default `everyTicks`) — phases a fresh world so it isn't populated the instant it boots. |
| `action` | Action | What happens on each fire (`{ type, … }`). |

A handler's `fire` may return a **duration** (ticks) to become a *duration action* —
the engine calls its `end` that many ticks later; anything else is a one-shot. A
fire is skipped while an entry is still active, so a short cadence never stacks
overlapping runs.

**Action types** (only `visit` today):

| `type` | Params | Effect |
|---|---|---|
| `visit` | `{ mob, room, stayTicks }` | An NPC arrives in `room`, then leaves after `stayTicks`. An ordinary instance with **no** spawner `origin` (never repops, never counts against a cap) — a `shop` template makes it a trader through the usual trade path. Arrival/departure reuse `mob-spawn` (`spawnMessage`) and `mob-flee` (`despawnVerb`). `stayTicks` must be `< everyTicks`. |

The **visiting trader** at the Landward Gate (`d0.roadgate`) is the first entry:
arrives every 20 min, trades 5 min, then gone.

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
| `type`      | enum    | The primitive. Implemented: `emit-light` (actor radiates `magnitude` light, summed into room light like a torch — a **negative** `magnitude` is a *darkness aura* that subtracts, drinking the room toward black); `summon` (see below); `cleanse` (strips every `damage-over-time` state from the target instead of applying a new one — an instant, not a lingering effect; an optional `guard` leaves a `dot-guard` after-sheen for that many ticks, during which any NEW hostile DoT is turned aside — without it the very next venomous swing undoes the cast). |
| `name`      | string  | Display label for the state chip. |
| `magnitude` | number  | Effect strength (e.g. light output). |
| `duration`  | integer | Lifetime in **ticks** (1s each); omit for a permanent effect. |
| `attrMod`   | object? | For `attr-buff`: flat attribute bonuses (`{ might: 3, wits: -2 }`), folded into `effectiveAttributes` while live — flows through to-hit, melee, Ward, and evasion. |
| `maxHp`     | number? | For `attr-buff`: a **fortify** bonus — a flat, timed lift to the actor's max HP. Unlike a Vitality `attrMod` (pools derive from *base* attributes, so a Vitality buff is inert), this actually raises the pool: `deriveStats` folds it in, applying it grants the added capacity as current HP (like a level-up), and expiry clamps HP back down. Player-only. |

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

A `damage-room` effect (a hostile area spell, e.g. Arc Flash, or a thrown bomb) may
carry an optional `dot` sub-spec — an instant burst plus a lingering burn/poison,
e.g. Flame Burst:

```json
{ "type": "damage-room", "damageType": "fire", "damage": "3d6", "dot": { "name": "Flame Burst", "damage": "1d4", "duration": 10, "durationScale": { "attr": "intellect", "per": 2 }, "emitLight": 2 } }
```

`dot` applies a `damage-over-time` state (see above) to every target the initial
burst doesn't kill, stamped with the caster like the single-target `damage-over-time`
spell type; a spell's `dot.durationScale` scales the same way as a top-level spell
`durationScale`. `dot.emitLight`, if set, pushes a matching `emit-light` state so a
burning target glows for as long as it smoulders (mirrors Witchfire's `emitLight`).

**`damageType` selects a mitigation rule** on any `damage` / `damage-room` effect
(spell or thrown bomb), via the shared `mitigate` helper that weapons use too:

- `"physical"` — the damage is a *blow*, not a weave: soaked flat by the target's
  **Armour** (floor 1), and **immune to the Ward fizzle** — a physical spell always
  lands (Ward never negates it). Iron Blast is the reference spell.
- `"void"` — cut by the target's **Voidward** pool, *not* Ward: a hostile void
  *cast* is fizzled by Voidward (all-or-nothing, `wardPoolFor` picks the pool), and
  a void *weapon* blow is cut by Voidward as a **percent** (see `mitigate`).
  Voidward is granted **only by Umbral gear and weaves** (never by Wits), so a
  delver with none faces void unmitigated — the intended pressure as void spreads.
  A **DoT** pulse of a classified non-physical type (a `damage-over-time` state with
  `damageType`) is handled separately from `mitigate`: on each due tick it rolls the
  same all-or-nothing Ward fizzle a *cast* does — void → Voidward, else Spellward
  (`_dotResisted` → `wardNegates`/`wardPoolFor`) — and a negated pulse deals nothing
  that beat, silently. A **physical** DoT pulse can't fizzle; instead it is soaked
  flat by the *player* defender's **Vitality** — `floor(vitality / 8)` per tick, the
  lingering-wound counterpart to Armour soaking a physical blow (`physicalDotSoak`,
  floored at 1). This is **player-only** (mobs never soak a DoT by Vitality, so bleed
  offence stays predictable) and applies to explicitly-typed physical only — *untyped*
  DoTs are soaked by neither Vitality nor Ward (legacy bleeds land as before). Only
  **environmental** void's own hp drain is still unmitigated — a deliberate deferral;
  see CHANGELOG.
- **anything else** (`"magical"`, `"fire"`, `"light"`, or omitted) — the existing
  behavior: a hostile spell *cast* is negated wholesale by **Ward** (`wardNegates`,
  all-or-nothing per target), and lands at full damage if it isn't. `physical` and
  `void` have concrete rules today; other strings are accepted as labels and
  behave like magical until they earn their own rule (a new branch in `mitigate`
  plus a defensive stat). For a *weapon*, `magical` is instead a Ward **percent**
  cut (see `strike`) — the per-cast fizzle is a spell-only gate.

**Spell targeting (`target`).** Every spell declares who a cast may land on —
`"self" | "creature" | "room"` — and the `cast` command routes on it, crossed
with the `hostile` flag (which decides *eligibility* for `room`):

| `hostile` | `target` | Behaviour |
|-----------|----------|-----------|
| `false` | `self`     | Self-only weave — naming anyone else is refused outright. |
| `false` | `creature` | The classic support targeting: self by default, an ally delver, or any creature you can see. |
| `false` | `room`     | Lays the full caster-baked effect on the caster **and every ally present** — co-located delvers and mobs of factions *allied* to the caster's side (your summons and pets, the rim watch in town). Healer-aggro fires per ally mended. |
| `true`  | `creature` | Single-target attack (`damage`, `drain` (damage + heal the caster by `healFactor`), `damage-over-time`, `sleep`, mob-only `douse`, mob-only `mana-drain` (drinks the target's mana — no HP damage; a void leech's *Leech Warmth*)). |
| `true`  | `room`     | Blasts every eligible foe at once (`damage-room` only). |

Summons are `target: "self"` (they conjure at the caster). The validator
requires the field and cross-checks it against the effect shape (`damage-room`
⇔ `room`, summon ⇔ `self`, hostile single-target effects ⇔ `creature`), so it
can never contradict how the spell resolves. Mobs honour the same axis: a mob's
non-hostile `cast` action self-buffs (`self`/`creature`) or, with `room`, mends
its whole side (see `state._mobCastRoomSupport`).

**Spell narration overrides (`messages`).** A spell may reflavour its landed-hit
lines without touching code — an optional `messages` block of template strings:

```json
"messages": {
  "self": "You drive {spell} through {target} for {damage} damage.",
  "room": "{caster} drives a spear of frozen light through {target}.",
  "hitVerb": "scorches"
}
```

| Key        | Used by | Default |
|------------|---------|---------|
| `self`     | the caster's line for a landed, non-lethal hit (single-target `damage`) or the loosing line (`damage-room`, outcomes appended). | `You hurl {spell} at {target} for {damage} damage.` / `You loose {spell}; {flavour.self}.` |
| `room`     | the onlookers' line for the same beat. | `{caster} hurls a crackling {verb} at {target}.` / `{caster} looses {flavour.room} {verb} and {flavour.wave}!` |
| `hitVerb`  | the per-target verb in a `damage-room` outcome clause ("It *sears* X for 5"). | `flavour.hitVerb` |
| `killVerb` | the per-target verb in a `damage-room` kill clause ("It *burns apart* X!"). | `flavour.killVerb` |

Placeholders: `{caster}`, `{target}`, `{spell}` (proper name), `{verb}`
(lower-cased name), `{damage}`. Resist/DoT/sleep/kill beats (outside
`damage-room`) keep their generic type-level narration.

For a `damage-room` spell, `flavour` above is `BURST_FLAVOUR[effect.damageType]`
(magic.js) — a per-damage-type row of stock wording (`fire`, `physical`; anything
else, including omitted, falls to a generic light-burst default) that a spell
gets for free without authoring `messages` at all. Iron Blast (`physical`) and
Flame Burst (`fire`) both rely on their row's defaults; `messages` is for a
spell that wants to diverge from its damage type's stock wording, or for a
single-target spell (`messages.self`/`.room` only — see Glimmer Spike).

---

## Starting character template (static) — `data/templates/player.json`

The blueprint a new player is instantiated from.

`shards` is the player's money (a special light-crystal currency; abstract integer
balance, shown in the player panel). New characters start with the template's value.
`knownRecipes` lists the recipe ids a fresh character can already `craft`; the field
is backfilled from this template onto older saves that predate it.
`unspentPoints` (optional, default 0) seeds a fresh character's bank of attribute
points to spend with `train` — the level-1 grant.

```json
{
  "level": 1, "xp": 0, "unspentPoints": 2, "shards": 10,
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
