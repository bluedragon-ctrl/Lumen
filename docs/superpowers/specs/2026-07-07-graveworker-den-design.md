# The Graveworker's Den — design spec

> **Status:** approved design, 2026-07-07. All names are **provisional pending
> maintainer sign-off** (lore.md naming rules). Implementation follows the plan
> derived from this spec.

A new side area west of the Thornreach browse: a grazing-edge room at depth 4,
a lightly human-modified descent to depth 5, a human-made tunnel, and behind a
plank door a four-room mini-dungeon where an outlaw necromancer — the
Graveworker — experiments with glimmer-based animation of the dead.

## Goals

- Extend the d4 Thornreach zone westward with a natural-feeling descent branch.
- Introduce **glimmer-based necromancy** as an outlaw-human experiment: bodies
  animated by shard-wire, strictly distinct from the Hollowing.
- Deliver a d5 mini-dungeon one clear step above the d1 Seized Working camp.
- Stay data-driven: everything is JSON except **one small server addition**
  (a `drain` spell-effect type).

## Decisions taken (with the maintainer)

| Decision | Choice |
|---|---|
| d4 anchor | West off `d4.thornreach.approach` (the Capwalk) |
| What is raised | Mixed: fauna (thornbug carcasses) + human dead |
| Den door | Closed, **unlocked** (deliberate act, no key hunt) |
| Tunnel west face | Sealed — flavour only, future content hook |
| Scope | Lean: 8 rooms, 4 mobs, no quest, **no boss item loot yet** |
| Boss casting | Human tradition (mana-only): Mage Armour + new life-drain spell. **No glimmer spells** — glimmer is the animation *material* (wire), not his casting medium |
| Boss summon | **Two wired human skeletons** (not thornbugs) |
| Den light | `ambientLight 3` + a `den-lamps` fixture (`emitsLight 1`) in every den room → light 4 in calm, and a dim 1 even during the Tide (whose depth-5 offset is −3); the lamps are the "his light outlasts the dark" statement |

## Rooms — 8 new

Compass: west = deeper into the new area. One existing room is touched:
`d4.thornreach.approach` gains `"west": "d4.thornreach.verge"`.

### Approach (zone `fourth-thornreach` / new zone `fifth-underway`)

| id | name (prov.) | depth | light | exits | notes |
|---|---|---|---|---|---|
| `d4.thornreach.verge` | The Far Verge | 4 | 1 | east→approach, down→stair | tags `["grazing"]` so browsing thornbugs wander in; niche **cut** into the cave wall (lamp-shelf, iron stake stub, chalk blaze) — the first hint of human hands; spawn: thornbug ×1; ground: palecap-mushroom ×2 |
| `d5.underway.stair` | The Cut Descent | 5 | 0 | up→verge, west→pinch | natural shaft, lightly human-improved: notched steps, knotted rope stub, drag-marks (he hauls carcasses down); no spawns |
| `d5.underway.pinch` | The Pinch | 5 | 0 | east→stair, west→gallery | narrow natural squeeze; scrape-polished walls, snagged sacking; no spawns |
| `d5.underway.gallery` | The Straight Gallery | 5 | 0 | east→pinch; **south via door fixture**→porch | dead-level, tool-marked, timbered — no natural force made this; west face **sealed** (scenery fixture, future hook); ground: lamp-oil ×1 (long respawn) |

The corridor is deliberately **empty** — the creep toward the door is silence
and drag-marks; everything hostile lives behind it.

### The den (new zone `graveworker-den`, all depth 5, all `ambientLight 3`)

| id | name (prov.) | exits | contents |
|---|---|---|---|
| `d5.den.porch` | The Cold Porch | north→gallery (back through the door), south→work | hooks, aprons, quicklime; spawn: risen-thornbug ×2 |
| `d5.den.work` | The Workroom | north→porch, west→store, south→sanctum | wire benches, half-wired carcasses; spawn: risen-thornbug ×3 |
| `d5.den.store` | The Still Store | east→work | cold corpse-store fed by a seep; spawn: stitched-prospector ×1 + risen-thornbug ×1; ground: shards cache + **hidden** crystal (perception 4) |
| `d5.den.sanctum` | The Grafting Room | north→work | his bench and journal (scenery fixture); spawn: graveworker ×1 (respawn 900) |

The lit den (3) against the black corridor (0) reuses the Seized Working motif:
**living humans keep light** — the tell that something organized holds this ground.

### New fixtures

- `den-door` — "a heavy plank door" in the gallery: `type: "door"`,
  `door: { "dir": "south", "to": "d5.den.porch", "open": false }` (no key).
- `gallery-sealed-face` — scenery: the tunnel visibly runs on west, collapsed/
  barred (Landward Gate pattern; no exit).
- `verge-niche` — scenery: the cut lamp-shelf niche in the Far Verge.
- `graveworker-journal` — scenery in the sanctum: environmental storytelling;
  matter-of-fact notes on wire gauges and "subjects". Carries the lore framing.

## Mobs — 4 new, all `faction: "outlaw"`, all `helper: true`

Calibration: d1 camp runs 16/22/50 hp (xp 9/24/36); elder thornbug 26 hp (xp 18).

### `risen-thornbug` — chaff
Thornbug carcass rewired with glimmer shard-wire, cold light pulsing in the
joint seams. **14 hp · speed 9 · armour 3 · ward 1 · attack 1d4 (cost 13) ·
spikes 1d2 · xp 10 · shards 1d3**; loot: chitin-spike 50%. `guard`, hostile,
pursues 2. **Light-indifferent** (`blindBelow: 0`, no flee, no lightBane) —
nothing natural down here ignores light; that's the tell it isn't alive.
Emotes are pure puppetry ("hangs slack until the wire pulls it taut") — never
habit-mimicry, which belongs to the Hollowed.

### `stitched-prospector` — heavy
A dead prospector stitched shut with shard-wire, swinging his own pick like a
marionette. **34 hp · speed 9 · armour 2 · ward 1 · attack 1d8+1 (cost 15,
slow heavy swings) · xp 24 · shards 1d6**; loot: dead man's kit at low odds
(prospectors-hatchet 10%, lamp-oil 15%). `guard` in the Still Store, hostile,
pursues 2. Light-indifferent as above.

### `wired-skeleton` — summon-only
A human skeleton strung on glimmer shard-wire — his refined work, the flesh
limed away in the store. **16 hp · speed 11 · armour 1 · ward 1 · attack 1d6 ·
xp 12 · shards 1d3**; no other loot. Hostile, `helper`, light-indifferent.
**Spawned nowhere** — only the Graveworker raises them.

### `graveworker` — the boss (title provisional, styled like "the Foreman")
The living human at the heart of it: gaunt, sane, matter-of-fact; stained
leather apron, shard-wire spooled at his belt, working under his own light
(`emitsLight 1`). Speaks in mild, unbothered lines (warder's vein).

**55 hp · speed 11 · armour 1 · ward 4 · melee 1d4 (hooked knife, cost 12) ·
attributes m4 v7 i8 w6 p7 · xp 48 · shards 3d6** · loot: four uniques at 20%
each (see *Boss loot* below). `guard` in the sanctum, hostile, pursues 2.

Actions:
- **summon** `wired-skeleton`, count 2, max 2, weight 3 — *"snaps his fingers,
  and shard-wire hauls two skeletons upright"*. He enters the fight alone;
  the wire pulls. Replacements rise as they fall (max 2 standing).
- **cast** `leech` (new spell, below), weight 4 — his sustain.
- **cast** `mage-armour`, weight 2 — renews under pressure (warder precedent).
- attack weight 1, emote weight 2.

## New spell: `leech` (name provisional)

Human-tradition necromantic drain — **mana only**, no shard cost (keeps the
human/glimmer-craft line clean per lore.md).

- `manaCost` 7, `hostile: true`, `target: "creature"`.
- Effect: `{ "type": "drain", "damageType": "magical", "damage": "2d6",
  "scale": { "attr": "intellect", "per": 3 }, "healFactor": 0.5 }` — damages
  the target, heals the caster for half the damage dealt.
- **Server addition (the only one):** a `drain` effect type in the spell-effect
  handler (damage target + heal caster). Everything else in this build is JSON.
- Mob-usable from day one; taught to players only by the Scroll of Leech the
  boss drops (see *Boss loot*).

## Lore compliance

- **Glimmer warps the body; the dark Hollows the self.** The risen are
  glimmer-animated *bodies* — no self at all, pure puppetry. Flavour text never
  uses "hollow" vocabulary or habit-mimicry. The husks lost themselves; these
  are meat machinery.
- His necromancy is an **in-world experiment**, never an assertion about what
  glimmer truly is (Dark Star stays legend).
- His **casting** is human tradition (mana only); glimmer appears only as
  material (wire). No glimmer-craft spells on him.
- He is `outlaw` because he is a living human criminal — a body-snatcher the
  Rim would hang — not because he is dark-touched.
- `server/factions.js` comment for `outlaw` gets one line noting the faction
  also covers the outlaws' wired dead (no logic change).

## Boss loot (added in the loot pass, 20% chance each)

- **`graveworked-apron`** — body, rarity rare: armour 0, ward 0,
  `attrMod { intellect: 2, wits: 2 }`. The summoner's trade-off: the biggest
  attrMod piece in the game, paid for with zero physical protection.
- **`graveworkers-scalpel`** — hand, rarity rare: physical 1d4, actionCost 11,
  scales `intellect/4`, `onHit restore 3 hp to self` (the hungering-dagger
  mechanism — flat self-heal per landed cut; at scalpel numbers that converts
  most of each blow). INT-scaled surgeon's counterpart to the perception-scaled
  dagger.
- **`scroll-leech`** — teaches `leech` (already player-castable end-to-end).
- **`scroll-summon-skeleton`** — teaches **`summon-skeleton`** (new spell):
  mana 12 + **4 shards**, summon-wisp pattern (one `wired-skeleton`, duration
  scales INT ×30, `group` recast-replaces). The shard cost is deliberate
  cross-craft: human will drives the weave, raw glimmer is spent as *wire* —
  flagged in the description so the "shards = glimmer-craft" lore rule reads
  as the graft it is. The skeleton stays wire-puppetry, distinct from the
  Hollowed husks.

## Explicitly deferred (follow-up passes)

- Quest hook (Fenn/Rim: a body-snatcher on the ledger).
- Content behind the gallery's sealed west face.
- Wider use of `wired-skeleton` outside the den.

## Validation & landing

1. Implementation on this branch; files touched: `data/world/rooms.json`,
   `data/world/mobs.json`, `data/world/fixtures.json`, `data/world/spells.json`,
   `server/` spell-effect handler (drain), `server/factions.js` (comment),
   `CHANGELOG.md`.
2. `npm run validate` must exit 0 (JSON, cross-refs, reachability — the verge
   hangs off the approach, so the whole area is reachable).
3. Manual check on the test instance (port 3738; server restart required):
   door opens south, den lights read 3, boss summons cap at 2, leech heals.
4. PR into `main` via compare URL (no `gh` here); maintainer reviews, squash.
