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

## 1. Bat Spire — swarm & light-as-weapon
- **Depth:** ~0–2 · **Theme:** cave-bats · **Lift:** JSON · **Verdict:** ✅
- Multi-level bat-focused mini-dungeon. `cave-bat` exists but is a lone nuisance;
  here the *swarm* is the point. Roster: waves of roost-bats (individually trivial),
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

## 4. Tremor-Mole Lair — burrowers & "light doesn't matter here"
- **Depth:** ~2–3 · **Theme:** tremor-moles / burrowers · **Lift:** JSON + server · **Verdict:** ⚠️
- `tremor-mole` and `old-grinder` already exist (a natural boss). A burrow-warren of
  blind diggers with ambush-from-below and cave-in hazards.
- **The caveat:** as a plain burrower pit it's the **lowest-variety** idea — it
  overlaps the tremor/ambush niche the gloom-crawler and cave-lurker already cover.
  It gets *interesting* if built around turning the signature system **off**: blind
  hunters that aggro on the player's **actions** (movement, combat, casting) and
  **ignore light entirely**, so carrying a lamp neither helps nor hurts. That makes
  it high-variety by subtraction — and a natural lesson in why light mattered
  everywhere else.
- **Loot hook:** a stealth / quiet-movement material line (padded boots, muffling gear).
- **Review:** Worth doing **only** with the light-indifferent hook; otherwise it's a
  reskin. Needs a small server change (action-based aggro instead of light-based).

## 5. Human Bandit Camp — the living-human enemy class
- **Depth:** ~0–2 · **Theme:** hostile living humans · **Lift:** JSON (+ optional server) · **Verdict:** ⚠️
- Claim-jumpers / deserters preying on delvers. Fits the frontier tone (the Rim has
  "no formal law"; Hale is the only watch). Introduces **sane, hostile humans**
  early — tactical fighters in armour, coordinated, who may use flares/potions.
- **Pairs well with #2:** mundane human greed at 0–2 → tragic dark-taken humans at
  5–7 is a clean escalation of the same "human enemy" thread.
- **Review:** Works, with one tension to resolve — this close to the Rim, *why hasn't
  Hale's watch cleared them?* Place the camp **off the patrolled descent** (a
  side-cut / jumped claim beyond the watch's reach) and it holds. Keep them
  mechanically distinct from #2 (living tactics vs. hollow going-through-the-motions).
  No PvP concern — that rule is player-vs-player; hostile NPCs are fine.

## 6. Submerged Rooms — gated aquatic pockets
- **Depth:** river/lake zones (~4) + scattered · **Theme:** aquatic ambush · **Lift:** JSON + server · **Verdict:** 🔴 design pass first
- Underwater rooms scattered through the river/lake zones, **gated by an effect**
  (a water-breathing potion) with the recipe taught at **level 10**. Unique aquatic
  mobs (grasping Weeping Chasm-Moss tendrils, a drowned lurker, a blind river
  predator). Ties into untouched `yaku-runa` river lore.
- **Review:** Conceptually good but the **biggest engineering lift** here — needs new
  server support: a "submerged" room flag + a breath/effect **entry gate** (parallel
  to how light gates behaviour). Confirm "level 10" = **character level** (recipe
  taught by Vesper/alchemist) vs. depth 10. Do a mechanic-design pass before
  authoring any content. Overlaps the earlier "Drowned Run" concept — treat as one
  system, scattered rather than a single dungeon as intended.

## 7. Living-Fungi Area — spores & status effects
- **Depth:** ~10 (deep) · **Theme:** predatory fungus · **Lift:** JSON (+ effects) · **Verdict:** ✅ with a lore guardrail
- A deep fungal sink. Roster: sporelings (spore-puff on death → lingering
  blind/poison cloud), **spore-ridden husks** (fauna the fungus has puppeted), and a
  **mother-bloom** that seeds hazard tiles. Leans on the existing
  `damage-over-time` / `onHit` effect system; searing light burns blooms back.
- **Loot hook:** spores + **gloom-silk** → the deep-cloth crafting line the lore sets
  up (Weeping Chasm-Moss) but nothing currently sources.
- **Review:** Good fit for the deep. **Lore guardrail:** the flora rule says
  vegetation grows *only where there is light* — **except self-luminous species**
  (Weeping Chasm-Moss). A dark, deep fungal area must be built on that exception:
  self-luminous blooms and/or fungus that feeds on **the dead**, not on light.

---

## Cross-cutting notes

- **New mechanics needed (server work), smallest → largest:**
  1. Mob use of items/abilities — flares & potions (#2, #5).
  2. Action-based (light-indifferent) aggro (#4).
  3. Submerged-room flag + breath/effect entry gate (#6) — the big one.
- **Reuses existing systems (no new code):** `summon` waves, `lightAggro` /
  `lightBane` / `flee`-on-light, `emitsLight` fixtures, `damage-over-time` + `onHit`
  effects, `pursues`, boss `guard` behaviour.
- **Human-enemy thread:** #5 (living, 0–2) and #2 (hollowed, 5–7) together introduce
  and then escalate a new enemy class — worth building as a pair.
- **Suggested build order:** #1 Bat Spire first (near-pure JSON, reuses everything,
  slots at d0–2), then #3 Mutated Fauna (JSON, mid-ladder). Hold #6 Submerged until
  its mechanic is designed.
- **Before any of this lands:** run `npm run validate`, update `CHANGELOG.md`, and get
  maintainer sign-off on every new name and any lore touch.
</content>
</invoke>
