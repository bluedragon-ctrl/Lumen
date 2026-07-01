# Lumen — Side Areas Backlog

> **Status: idea backlog, not canon.** A running list of optional side pockets /
> mini-dungeons that branch off the main descent, each built around a distinct
> enemy theme and a twist on the light system, to give the delve more variety.
> Nothing here is committed content and **all names/lore are provisional pending
> maintainer sign-off** (see the naming rules in [lore.md](lore.md)).
>
> Each entry carries a short **review** — does the idea hold up against lore, the
> threat ladder, and the existing systems in `server/` and `data/world/*.json`.

## Legend

- **Depth** — target rung on the threat ladder (see lore.md → *The threat ladder*).
  `d0` = the Rim (surface); danger rises with depth.
- **Lift** — implementation cost. **JSON** = pure data (`mobs.json` / `rooms.json` /
  `spawns` / `recipes.json`), the preferred path per CLAUDE.md. **JSON + server** =
  needs a new mechanic in `server/`.
- **Verdict** — ✅ solid / ⚠️ works with caveats / 🔴 needs a design pass first.

---

## 0. Shallow-Layer Map Extension (d0–d1) — the foundation
- **Depth:** 0–1 · **Theme:** connective geography · **Lift:** JSON · **Verdict:** ✅ prerequisite · **In progress**
- **Groundwork laid (Rim town, d0):** added **Prospectors' Walk** (`d0.street`) east of the
  market — a lodging-lane of prospectors' sheds — and **The Landward Gate** (`d0.roadgate`) beyond
  it, a chained iron gate onto the old road out of town (flavour only, no exit through yet, room
  reserved for later content). The **Mage's Shed** now hangs south off the Walk. Both new rooms are
  `patrol`-tagged (inside Hale's beat). This fleshes out the town and gives the frontier an
  established "edge" to push wild content past. *(Names provisional pending sign-off.)*
- **Not a monster area — the enabling work for the shallow cluster (#1, #4, #5).**
  The d0–2 side areas all compete for the same scarce shallow real estate, and d1
  is already dense (Bat Roost, Sporechoke → Centipede Nest, the rat nest, the
  gallery branches). Before they can land without crowding, d0/d1 need more
  **branch stubs and un-patrolled edges** to hang content off.
- **Existing seams to grow from:** `d0.fault` (**"The Riven Yard"** — where the
  boomtown gives out onto bare rock) and `d0.burrow`/`d0.corral` on the town's
  ragged north edge; the **d1.first** hub and the **d1** gallery below the gate.
- **Guardrails:** keep `patrol` tags on Rim lanes only (so Hale's beat stays
  coherent and new wild content reads as *beyond* the watch); preserve the single
  main descent line (`d0.descent → d1.first → d1.drift ↓ d2`) so side areas branch
  *off* it rather than blocking it; run `npm run validate` (room reachability) after
  every new stub.
- **Build this first** — it unblocks the bandit camp (#5) and gives the bat spire
  (#1) and tremor burrow (#4) somewhere to open from.

## 1. Bat Spire — swarm & light-as-weapon
- **Depth:** ~0–2 · **Theme:** cave-bats · **Lift:** JSON · **Verdict:** ✅ · **Seed exists:** `d1.roost`
- Multi-level bat-focused mini-dungeon. `cave-bat` exists but is a lone nuisance;
  here the *swarm* is the point. **`d1.roost` ("The Bat Roost") already exists** — an
  upward reeking vault with a fissure of grey light and a colony that wheels when
  disturbed. The spire **extends that seed** (climb/branch off it) rather than
  starting from scratch, which lowers the cost further. Roster: waves of roost-bats (individually trivial),
  a blood-draining dire bat, and a **brood-matriarch** boss that summons waves until
  downed (reuse `summon`, as Gnaw/broodmother do).
- **Light twist — inverts the usual pressure:** bright light is your *weapon* here.
  A searing flare scatters a whole wave (`lightBane` + `flee`-on-light already
  supports this — see `gloom-crawler`). Going dark = swarmed blind.
- **Loot hook:** bat-leather (light-armour material) + guano/saltpetre → a native
  reagent for the flare / shard-grenade alchemy line.
- **Review:** Strong, near-pure JSON, reuses existing systems. **Naming caveat:** the
  world *descends* into a hole — a "spire" reads as going up. Reframe as a vertical
  bat-choked **shaft/chimney** dropping off the early descent (still multi-level,
  just downward).

## 2. Abandoned Prospector Camp — the Hollowing's human face
- **Depth:** ~5–7 · **Theme:** hollowed humans · **Lift:** JSON (+ optional server) · **Verdict:** ✅
- A prospector camp the dark took whole. Squarely canon: the Hollowing claims
  "Umbral and human alike," and abandoned camps are named environmental
  storytelling. Roster: **hollowed prospectors** (early/mid-stage husks going
  through the motions of a dead camp — cold forge, dead hearth), and a **claim-mad
  survivor** boss who fights *like a delver*: wears armour, throws a flare to blind
  *you*, drinks a potion mid-fight.
- **Light twist:** first enemy that uses the player's own toolkit (light-as-weapon
  pointed back at you).
- **Loot hook:** delver gear/schematics; a claims-ledger quest thread for Fenn (his
  dialogue already knows "which owners stopped coming up").
- **Review:** Strong and lore-perfect. Differentiate the husks from the Umbral
  Necropolis's — these are **human** and mid-stage, not the necropolis's deep
  end-stage. The boss's flare/potion use is the only piece that may want a small
  server tweak (mob item/ability use).

## 3. Mutated Fauna Dungeon (the Bright Seam) — glimmer-warped bodies
- **Depth:** ~4–5 · **Theme:** glimmer-mutants · **Lift:** JSON · **Verdict:** ✅
- An exposed raw-glimmer vein where ordinary fauna are twisted (lore: proximity to
  raw glimmer *mutates the body*). Roster: crystal-crusted versions of known fauna
  (glimmer-gorged stonebug, shardback centipede), **wisp swarms**, and a
  part-mineral **glimmer-gorged apex** — a deliberate low rung toward the Glimmer
  Dragon myth.
- **Light twist:** the vein *emits light* (`emitsLight` fixture) → a room you
  **can't** darken, flipping the survival calculus. Enemies are `ward`-heavy and
  physically tanky → punishes glimmer-craft (which burns your shards) and rewards
  plain steel.
- **Loot hook:** rich crystals + a mutation-reagent for Ward/enchant gear.
- **Review:** Solid. Keep the **body-mutation (glimmer)** cause cleanly distinct from
  the **self-loss (the dark / Hollowing)** — the two rhyme but the lore forbids
  stating either is behind the other.

## 4. Tremor-Mole Burrow — giving a wasted creature a home
- **Depth:** ~2–3 · **Theme:** tremor-moles / burrowers · **Lift:** JSON (server = optional stretch) · **Verdict:** ✅
- **Problem it fixes:** `tremor-mole` is near-invisible today. It spawns in just two
  rooms (one near the top, one at the deep waterfall), has **empty loot**, does
  nothing memorable, and **flees at `lightAbove: 1`** — the faintest light sends it
  digging, so a delver carrying any real light never actually *sees* one. The
  creature is designed to be missed.
- **The refinement — give the species an ecology and a home:**
  - **Bold young (commonly visible):** a `young-tremor-mole` variant that is *not*
    light-shy — curious pups that surface and investigate rather than digging away
    (raise/remove the flee threshold, or make them `skittish` instead of `flee`).
    Seed them along the early descent so the creature is finally *seen* and becomes
    a recognisable part of the top-floor fauna.
  - **The burrow (the lair):** a small dark mini-dungeon of dug tunnels branching off
    the descent. Deeper in: **elder moles** (tougher, still light-shy — they dig away
    and ambush from fresh holes), broods of young, and at the heart a **breeding pair
    — a sire and dam** who *hold the nest* and do **not** flee light (a `guard` pair,
    the way Gnaw and the broodmothers hold their nests).
- **Light twist (emergent — no new code):** the tension is already latent in the
  base design — moles flee light, but you need light to see. In the burrow that
  becomes the whole puzzle: **carry light and the adults dig away before you can pin
  them; go dark and they surface to fight but you can't see them.** The guarding pair
  is the exception that gives the fight teeth.
- **Loot hook / reason to go:** moles that gnaw ore-rich rock → small shards/crystal
  lodged in the gizzard (echoing the Old Grinder's glimmer-gut), a **pale-mole hide**
  (a quiet-movement / stealth material), and digging-claws (a mattock/tool line). The
  pair drops the best of it.
- **Review:** This is the version to build — it turns a dead creature into a legible
  mini-ecology and is **mostly JSON** (new young/elder/pair mob defs, one small burrow
  zone; reuses `guard` + `flee`-on-light + `summon`, all of which exist). The exotic
  "light-indifferent, aggro-on-movement" hook from the first draft is now an
  **optional stretch**, not required. *(Note: the Old Grinder is an ancient stonebug,
  not a mole — the lair needs its own sire/dam pair.)*

## 5. Human Bandit Camp — the living-human enemy class
- **Depth:** ~1–2 · **Theme:** hostile living humans · **Lift:** JSON (+ optional server) · **Verdict:** ⚠️ · **Depends on:** #0 (map extension)
- Claim-jumpers / deserters preying on delvers. Fits the frontier tone (the Rim has
  "no formal law"; Hale is the only watch). Introduces **sane, hostile humans**
  early — tactical fighters in armour, coordinated, who may use flares/potions.
- **Pairs well with #2:** mundane human greed at 1–2 → tragic dark-taken humans at
  5–7 is a clean escalation of the same "human enemy" thread.
- **Location — the biggest concern, now with concrete anchors:** it must sit **off
  the patrolled Rim and below the gate**. Hale only walks `patrol`-tagged rooms (all
  d0 Rim lanes), so placing the camp at **d1 (or a d1 sub-branch), beyond the
  gate**, already puts it outside his rounds — the "why hasn't the watch cleared
  them" tension resolves by placement alone. Two ready seams to hang it off:
  - **`d0.fault` — "The Riven Yard,"** where *"the boomtown simply gives out"* on
    unfloored rock: the written edge-of-law, a natural mouth for a track down to a
    seized claim.
  - a fresh branch off the **d1.first** hub or the **d1** gallery — a **jumped /
    abandoned claim** the bandits squat, just past the watch's reach.
- **Review:** Works; keep them mechanically distinct from #2 (living tactics vs.
  hollow going-through-the-motions). No PvP concern — that rule is player-vs-player;
  hostile NPCs are fine. **Blocked on #0:** the shallow map needs room to breathe
  before a whole camp lands here.

## 6. Submerged Rooms — gated aquatic pockets & a reason to climb back up
- **Depth:** recipe deep (Umbral village, ~7–9) → pockets scattered in the river/lake zones (~4) and up · **Theme:** aquatic ambush · **Lift:** JSON + server · **Verdict:** 🔴 design pass first
- Underwater rooms scattered through the river/lake zones, **gated by an effect** (a
  water-breathing draught). Unique aquatic mobs (grasping Weeping Chasm-Moss
  tendrils, a drowned lurker, a blind river predator). Ties into untouched
  `yaku-runa` ("water-folk") river lore.
- **Gating & payoff — a backtracking loop:** the **recipe is learned in the Umbral
  village area** (deep, ~d7–9), not from a surface vendor. Because the submerged
  pockets sit in the **already-explored upper river/lake rooms**, the draught turns
  those old rooms into **new content on the way back up** — a Metroidvania-style
  return that fits Lumen's descend-*and-return* core loop and rewards going deep
  before it pays off shallow. Cleaner than the earlier "taught at level 10" gate:
  the gate is now **narrative/location**, not a bare level check.
- **Review:** Conceptually strong and the payoff is a genuine plus — but still the
  **biggest engineering lift**: needs new server support for a "submerged" room flag
  + a breath/effect **entry gate** (parallel to how light gates behaviour). Do a
  mechanic-design pass before authoring content. Absorbs the earlier "Drowned Run"
  concept — one system, scattered pockets rather than a single dungeon.

## 7. Living-Fungi Area — spores & status effects *(concept, needs a design pass)*
- **Depth:** ~10 (deep) · **Theme:** predatory fungus · **Lift:** JSON (+ effects) · **Verdict:** ✅ concept, design TBD
- A deep fungal sink. Roster: sporelings (spore-puff on death → lingering
  blind/poison cloud), **spore-ridden husks** (fauna the fungus has puppeted), and a
  **mother-bloom** that seeds hazard tiles. Leans on the existing
  `damage-over-time` / `onHit` effect system; searing light burns blooms back.
- **Anchor it to a specific place — hot springs / geothermal vents:** rather than a
  free-floating fungal zone, hang it on a **hot-spring / steaming-vent grotto**. This
  is squarely lore-supported *and* resolves the flora guardrail below in one stroke:
  the canon says Weeping Chasm-Moss grows *"wherever water runs or hot vents breathe
  moisture into the air"* and carries **its own light** in total dark. Warmth +
  moisture + self-luminous growth = a place fungus can plausibly run wild deep in the
  dark. Other specific anchors (a flooded sink, a mineral-hot pool) work too — the
  point is a **named environment**, not a generic cavern.
- **Loot hook:** spores + **gloom-silk** → the deep-cloth crafting line the lore sets
  up (Weeping Chasm-Moss) but nothing currently sources. Note `d1.spore.*`
  ("Sporechoke" / witchglow) already establishes luminous-fungus set-dressing
  vocabulary to build on — the enemy version is still new.
- **Review:** Good fit for the deep, but **still a concept** — do a design pass on the
  anchor (hot springs vs. other) and the spore/hazard mechanic before authoring.
  **Lore guardrail (now largely handled by the hot-springs anchor):** the flora rule
  says vegetation grows *only where there is light* — **except self-luminous species**.
  A dark, deep fungal area must lean on that exception: self-luminous blooms and/or
  fungus that feeds on **the dead**, not on light.

---

## Cross-cutting notes

- **New mechanics needed (server work), smallest → largest:**
  1. Mob use of items/abilities — flares & potions (#2, #5).
  2. Action-based (light-indifferent) aggro — **optional stretch for #4**, not required.
  3. Submerged-room flag + breath/effect entry gate (#6) — the big one.
- **Reuses existing systems (no new code):** `summon` waves, `lightAggro` /
  `lightBane` / `flee`-on-light, `emitsLight` fixtures, `damage-over-time` + `onHit`
  effects, `pursues`, boss `guard` behaviour.
- **Human-enemy thread:** #5 (living, 0–2) and #2 (hollowed, 5–7) together introduce
  and then escalate a new enemy class — worth building as a pair.
- **Suggested build order:** **#0 shallow-layer map extension first** (it unblocks
  the whole d0–2 cluster), then #1 Bat Spire (extends the existing `d1.roost`), then
  #3 Mutated Fauna (JSON, mid-ladder). Hold #5 Bandit Camp until #0 lands, and #6
  Submerged until its mechanic is designed.
- **Before any of this lands:** run `npm run validate`, update `CHANGELOG.md`, and get
  maintainer sign-off on every new name and any lore touch.
</content>
</invoke>
