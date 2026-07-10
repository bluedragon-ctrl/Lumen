# Changelog

All notable changes to **Lumen** are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.6.0] - 2026-07-10
### Changed
- **Versioning resynced to 0.6.0; the version now moves with every PR.** The
  release-batch scheme had stalled at 0.2.0 while ~200 PRs landed. From now on
  every PR bumps the **PATCH** in `VERSION` + `package.json` as part of the
  change (same rule as the changelog); the **MINOR** is a maintainer milestone
  cut with `npm run release` and tagged `vX.Y.0` — patch versions are not
  tagged. See [CONTRIBUTING.md](CONTRIBUTING.md) → *Versioning*.
- **DESIGN.md & CLAUDE.md refreshed to match the shipped game.** DESIGN.md is now
  a living intent record with shipped/partial/deferred markers: the `void` light
  band and the Tide join §3.1/§6.3's light formula, and new intent sections cover
  the Tide, magic & spells, shards & economy, rest/posture recovery, search &
  detection-based aggro, and factions (§3.9–3.14); the Open/Deferred list is
  brought current (mechanics detail stays in `server/README.md`). CLAUDE.md gains
  `npm test` in the pre-commit checklist, the real server layout (command modules,
  state mixins), the missing `quests.json`/`tide.json` and docs pointers
  (`templates-quickref.md`, `side-areas.md`, `docs/superpowers/`), the
  depth-viewer, a compact tools table, and the no-content-without-approval rule.
### Fixed
- **Depth viewer default port moved 3942 → 3944.** `tools/depth-viewer/` collided
  with the recipe editor (both defaulted to 3942), so the two tools couldn't run
  at the same time. The viewer now serves on 3944 (`DEPTH_VIEWER_PORT` still
  overrides); `start.bat`, `.claude/launch.json`, and CLAUDE.md's tools table
  updated to match.

### Added
- **Room editor (was the spawn-editor).** `tools/spawn-editor/` is renamed to
  `tools/room-editor/` (`npm run edit-rooms`, port 3940) and now also sets a
  room's cosmetic `biome` tag — pick from the eight biomes or clear it — alongside
  the existing spawn-rule and ground-item editing. Still source-preserving: only
  the changed field(s) are re-serialised; the `biome` line is inserted after
  `zone` (or removed when cleared).
- **Room biomes tint the Inspect window (`biome`).** A room may carry an optional,
  purely cosmetic `biome` tag that gives the Inspect window an ambient coloured
  glow layered *over* the existing light band, so searing and deep-dark behave
  exactly as before (the tint recedes under `searing` and switches off under
  `void`/`darkness`). The biome colours the room name, an ambient aura, and gently
  the description text. Seven biomes, 86 rooms: **umbral** (neon blue — the living
  deep-folk), **wraith** (cold violet, umbral's blue sickened by the dark — the
  Umbral Necropolis), **gloaming** (cave green — the gulf and the Falselight
  approach), **slime** (acid-lime — the sour-midden slug warren), **mutant**
  (blood-crimson — the dark-warped vermin nests of the sunken and gloom warrens),
  **water** (deep blue — the fourth-depth lake and the river stair), and **rim**
  (lantern gold — the surface town). An eighth, **ember** (lava orange), is defined
  but untagged, reserved for upcoming volcanic content. Enum-checked by the
  validator (`BIOMES`); palette and rules live in `client/styles.css`
  (`.biome-*`). No gameplay effect. See [docs/data-model.md](docs/data-model.md) → *Room*.
- **Biome colour lab (`tools/biome-preview/`).** A read-only, browser-based bench
  for designing room biomes (`npm run preview-biomes` / `start.bat`, port 3943).
  It links the live `client/styles.css`, so the preview pane renders exactly what
  the client does — no drift; pick any of the eight biomes and a light band, drag
  colours to test a new hue, and copy paste-ready token/rule/`BIOMES` CSS. Writes
  nothing.
- **Login screen (pick / create / delete a prospector).** The client now opens on
  a visual login screen instead of a bare name prompt: existing prospectors are
  listed (each with their level) one click to enter, a field creates a new one,
  and a `✕` deletes one behind a confirmation step (permanent, dev-only — no
  passwords yet). Creation
  and deletion are available to anyone at the screen (mirroring the dev-only
  intent); deleting an admin account, or a prospector who is currently logged in,
  is refused.
  A separate **Log in as Admin** entry is shown only when `SHOW_ADMIN_LOGIN` is
  on in `server/config.js` (default; set `SHOW_ADMIN_LOGIN=0` in the environment
  to hide it — the admin account still boots, but can't be entered from the
  client). New login-phase protocol frames: `accounts` (server roster),
  `create-account` / `delete-account` (client). See [server/README.md](README.md)
  → *Login*.
- **Garrick's shop stocks a regeneration draught and iron bars.** Garrick the
  quartermaster (`rim-shopkeeper`) now sells the `regeneration-draught` (a
  slow heal-over-time tincture) and `iron-bar` (smith's raw stock) alongside his
  usual light, armour, and oil.
- **Attribute-gated doors (`door.requires`).** A door fixture can now gate
  *opening* on an **effective** attribute score — `{ attr, value, failText?,
  successText? }` in its `door` block. The door only yields to a delver whose
  `attr` (base + gear `attrMod` + status buffs, so a Might potion or a ring
  counts) meets `value`; closing is never gated, and `requires` composes with an
  optional `key`. The needed attribute is spelled out on the refusal (with the
  player's current score), on the success line, and as a `needs: <Attr> <value>`
  line on `examine`, so it's never a guessing game. Two proof-of-concept gates:
  the Graveworker's plank door (`den-door`) now carries a wire-lattice puzzle-lock
  needing **Intellect 7**, and the caged gate at the Barred Mouth (`caged-gate`,
  the way into the false-light Gloaming past The False Dawn) is now a seized,
  rusted gate you force with **Might 7**. See the data model → *Fixture*.

### Fixed
- **Malformed `fixtures.json` (`gate-warning`) broke data loading.** The
  `gate-warning` fixture was missing its `"type"` field and closing brace, so
  `verge-niche` was parsed as a nested property and `JSON.parse` failed at EOF —
  `npm run validate` and the server's world load both errored. Closed the entry.
- **Fixture targeting now honours the authored `keywords` array.** `use`/`open`/
  `close`/`examine` resolved a fixture only by exact instance id or a substring
  of its display name, silently ignoring `keywords` in `data/world/fixtures.json`
  (so a keyword absent from the name — e.g. `niche` on "a cut lamp-shelf" —
  never matched). Both lookups (`findFixture`, and `examine`'s resolver) now go
  through the same keyword-aware `matchesQuery` used for item/mob targeting,
  moved to `server/query.js` so the view layer can share it without an import
  cycle. `examine` gains the same treatment for mobs, items, shop wares and
  craftables, so anything `get`/`use`/`attack` can name, `examine` can too.

### Changed
- **Command layer slimmed and re-modularised (no behaviour change).**
  `server/commands.js` drops from 950 to 655 lines (−38% bytes): the consumable
  cluster (`drink`/`eat`/`throw`, `refuel`, light-source toggling) moves to
  `server/commands/consume.js` and the fixture cluster (`use`, `open`/`close`
  doors, switches, restore springs) to `server/commands/fixtures.js`, so a task
  touching one domain reads a fraction of the old file. New shared helpers
  (`err`, `logMsg`, `roomLog`, `announce`, `relight`, `consumeOne` in
  `server/commands/shared.js`) replace the repeated single-message, broadcast+
  refresh, light-recompute+refresh, and stack-consume idioms across every
  command module — `relight` also encodes the recompute-light-and-refresh
  invariant from the disconnect fix as a single call. `learn` now normalises
  scrolls, schematics, and books into one teach-list flow. Verified
  byte-identical against `main` across a 90-command battery (messages,
  broadcasts, and emitted events, seeded RNG).
- **`list` marks wares that teach something you already know.** Schematics,
  scrolls, and books in a trader's stock are now tagged `(known)` when you
  already know every recipe/spell they'd teach — a warning against a wasted buy.
- **`recipes` highlights components you have vs. those you're missing.** Each
  input in the listing is now coloured on its own: green when you already hold
  enough, red (annotated with the quantity you currently have) when you're short.
  Shard costs get the same treatment, so the list reads as a shopping list of
  what's still needed. The recipe name keeps its green/grey "can I make this now?"
  signal.
- **Items** — rarity updates (lantern, prospectors-blaze-lantern, crystal, scroll-glimmerskin, scroll-glimmer-spike, scroll-glimmer-storm, schematic-insight-draught, schematic-might-draught, schematic-searing-flare, schematic-barbed-bomb, schematic-glimmersteel-staff, schematic-glimmersteel-lamp, schematic-glimmersteel-bar, schematic-ring-of-sight, schematic-ring-of-wits, schematic-regeneration-draught, schematic-acid-bomb, chitin-plate, grub, cave-fish, rat-meat, chitin-helm, chitin-cuirass, heavy-chitin-plate, schematic-dense-chitin-cuirass, chitin-maul, shadow-heart, shadow-shard, hungering-dagger, glimmerglass-blade, emberfruit, iridescent-carapace).
- **Levelling curve softened and mob XP re-priced by toughness.** `XP_GROWTH`
  drops from `2` → `1.7` in [server/config.js](server/config.js): the old
  doubling made level 10 cost 51,100 XP — more than every mob, room, and quest
  combined — so no one could pass ~level 6 without heavy grinding. Level 10 now
  sits at ~16,800 XP, so roughly three full clears of the depth-1–10 content reach
  it (~level 9 on the current 75% of that content, level 10 once the remaining
  content lands). Every mob's `xp` in `data/world/mobs.json` was re-derived from an
  **effective-HP** power model — HP adjusted for evasion (hit-chance), armour (flat
  soak) and ward (magical cut) plus a threat term for its damage — so a dodgy or
  armoured mob is worth more than its raw HP suggests (e.g. the evasive Wisp 12→20)
  and squishy-but-generous mobs ease down (nawpa 90→55). Totals are held roughly
  constant; the curve change does the heavy lifting. Deep-floor mob *difficulty*
  (not their XP) still wants a balancing pass.
- **`search` finds are shared with everyone in the room.** When a delver searches
  out a hidden feature — a stashed item, a lurking mob, a hidden fixture or exit —
  it now becomes discovered for every other player present too, regardless of their
  own Perception or light: the searcher is pointing it out. Permanent secrets
  (fixtures/exits) land on each onlooker's record; ephemeral item/mob reveals join
  theirs for the visit. The room log now names what a search turns up.
- **`server/state.js` split into subsystem mixins (no behaviour change).** The
  GameState class drops from 2,017 to 1,016 lines by relocating three method
  clusters into mixin files alongside the existing `state-mobai.js`:
  [server/state-tide.js](server/state-tide.js) (the Tide world clock — phases,
  lamp-tending, tide spawns/sweeps/creep/emotes),
  [server/state-spells.js](server/state-spells.js) (cast resolution, the shared
  hostile/beneficial effect cores, `detonateRoom`, and the summon lifecycle), and
  [server/state-effects.js](server/state-effects.js) (status effects, restores,
  out-of-combat mob regen, room effects). Pure relocation — every method stays a
  `GameState` method at runtime via the established `mixin()` copy, and a
  command + tick A/B battery (casts, summons, forced tide phases, DoTs, OOC
  regen) is byte-identical against `main`.
- **Event rendering extracted from `server/index.js` (no behaviour change).**
  The ~500-line event-rendering layer — `EVENT_HANDLERS` (one handler per engine
  event type), the flavour tables, the light-gated room broadcast helpers, and
  the mob/player death handlers — moves verbatim into
  [server/events.js](server/events.js), the narration sibling of `render.js`'s
  views. `index.js` drops from 827 to 331 lines and keeps only transport:
  HTTP/WebSocket serving, login, view coalescing, and the tick loop; it wires
  the dispatcher once at startup via `createDispatcher(...)`. Verified with a
  live two-client WebSocket battery (combat both directions, mob death + loot +
  quest credit, aggro engage, tide phase turn + HUD frames, disconnect
  broadcast, view refreshes) — all handler paths fire, server log clean.

### Added
- **The Gloaming descends — depth 6, the insect floor (six rooms).** The Weeping
  Stair now drops (`down`) into a new zone `gloaming` beneath the false-sky canopy:
  dimmer, hotter, thick with rot and wings. **The Sunless Landing** branches east to
  **the Fungal Gallery** (giant-mushroom timber, grazing **grubs**) and south to **the
  Steaming Terraces** (scalding pools, **vent-scorpions**, a `salt-crust` yielding the
  new **spring-salt**). Off the terraces, **the Droning Hollow** is a lure — a bank of
  glowing moss pulls a biting **glow-midge** swarm and feeds the floor's local miniboss,
  a **steam-mantis** (a hound-sized ambush hunter, ~56 HP), which stands between the
  delver and **the Shucked Crawl**, its moulting larder, where a `chitin-drift` and the
  mantis's own kill yield the new **iridescent-carapace** (vent-scorpions now drop it
  rarely too). **The Gulf Throat** describes the way to depth 7 but leaves it unrigged,
  as the stair did above. Every glow lives in Tide-dimmable `ambientLight` (the lure
  included), so the whole floor still goes dark at the flood. No recipes yet; the
  giant antlion pitched for the pit waits for a lower floor. Names provisional.
- **The Gloaming's first gatherables (three materials + harvest nodes).** The top
  floor now rewards foraging, distributed to give each room a purpose: **the False
  Dawn** carries a **stand of giant mushrooms** (`cut` for **fungal hardwood** — the
  deep's only real timber, raw stock for future shafts/hafts) and a **bed of
  steam-ferns** (`pick` for **steam-fern**, a warm-damp medicinal herb), while **the
  Steaming Brink** hangs a **trailing canopy frond** heavy with **emberfruit** (a
  warm, dim-glowing fruit) — reachable, but only by braving the Gloamback that shares
  the rim. All three harvest nodes are Tide-honest (no `emitsLight`; the mushrooms'
  and fruit's glow is flavour, so the whole floor still goes dark at the flood). No
  recipes yet — the materials stand ready for a later crafting pass. Names provisional.
- **The Gloaming's first fauna (three depth-5 mobs).** The three top-floor rooms are
  now inhabited, pacing a deliberate lull-then-bite: **the False Dawn** holds only
  **basking newts** (soft, harmless grazers cropping the moss — the oasis's calm face),
  while **the Steaming Brink** and **the Weeping Stair** hold the threat. The gatekeeper
  is **the Gloamback** (`the-gloamback`), a basking newt grown into a ~50-HP ambush apex
  whose moss-crusted back glows like the safe canopy until it opens an eye — an elite
  step above the depth-5 norm that tells a delver at once this is higher-level ground.
  Between them roams the **vent-scorpion**, whose sting carries a venom
  damage-over-time. Names provisional pending sign-off; no bespoke loot yet (they drop
  existing materials).
- **Canon lore for the Tide.** `docs/lore.md` gains a top-level section (after *The
  Abyss*) defining the Tide as the Abyss's rhythm — an Abyss-wide cycle of darkness
  rising and ebbing in phases (calm → stirring → flood → receding), biting harder the
  deeper you are, that the creatures and prospectors alike keep their hours by. Framed
  as **known but not understood**: its timing is lived-by, its cause is a deliberate
  mystery (added to *Deliberately unknown*, let to rhyme with the dark of the Hollowing
  without equating them). First prose home for the mechanic behind `data/world/tide.json`.
- **Canon lore for the Gloaming (the hot-spring hollows).** `docs/lore.md` gains a
  section on the depth-5+ hot-spring biome east of the Gullet: its self-luminous
  Chasm-Moss "false sky", its standing of the Abyss's one lush, forageable place, the
  light-as-lure inversion of the usual light-fearing ecology, its going fully dark at
  the Tide, and its distinct fauna (ordinary animals grown strange — not the dark-taken
  or the glimmer-warped). Names the area **the Gloaming** (previously the working title
  "Falselight").
- **The Gloaming — top floor of the hot-springs area (three depth-5 rooms
  behind the caged gate).** South through the gate (now a passable `door` — its
  lock has rusted through) opens the first level of the area teased east of the
  Gullet: **The False Dawn** (you step out under a warm, lit, green cavern),
  **The Steaming Brink** (the rim of a great steaming gulf — you can look down
  but not descend), and **The Weeping Stair** (the way down, described but not
  yet wired — the lower floors land next pass). The light is a **false sky**: a
  self-luminous Weeping-Chasm-Moss canopy grown across the whole roof (new
  `false-sky` fixture), glowing like overcast dawn — no sun, no glimmer. Rooms
  sit at `ambientLight` 3/3/2, so the cavern reads as daylight in Calm and goes
  fully **dark at the Tide** (the false day has a false night). Zone `falselight`;
  names provisional pending sign-off. No bespoke fauna yet — the area's distinct
  monsters are the next content pass.
- **Philtre of the Kindled Mind — a temporary Intellect buff potion.** A second
  `attr-buff` consumable (+3 Intellect for 60 ticks), matched to the Draught of
  Iron Sinew. Crafted at the alchemy station from weeping chasm-moss, a witchglow
  cap and glimmer dust — a scholar's brew — and Vesper the glimmer-mage sells the
  schematic. Names/balance provisional, pending sign-off.
- **Draught of Iron Sinew — a temporary Might buff potion.** A new `attr-buff`
  consumable effect raises an attribute for a duration; `effectiveAttributes`
  now folds active `attr-buff` states in on top of gear, so the bonus flows
  through to-hit, melee damage, Ward and evasion until it expires. The first
  such potion (+3 Might for 60 ticks) is crafted at the alchemy station from
  chitin-spike, bug-tallow and slug-slime (giving the underused slime binder a
  second home); Vesper the glimmer-mage sells the schematic. Names/balance
  provisional, pending sign-off.
- **The approach to the hot-springs area — two depth-5 rooms east of the Gullet.**
  A side-mouth partway down the Gullet's switchback now opens east into **The
  Windway** (a long, winding passage carrying a warm, damp draught from somewhere
  ahead) and on to **The Barred Mouth**, a prospector-dressed chamber whose
  southern arch is sealed floor-to-ceiling by a forged **caged gate** (chained,
  locked, painted with a DO-NOT-ENTER warning and a dead-men's tally). Through
  the bars: steam, a green smell of growing things, and a pale wash of light no
  one is carrying — the first breadcrumbs of the springs area to come. The gate
  is scenery for now and becomes a real `door` fixture when the area behind it
  lands. Room and fixture names are provisional pending sign-off.
- **The Graveworker's den (d5 mini-dungeon, names provisional).** West of the
  Thornreach browse a new grazing-edge room (The Far Verge) drops down a
  human-improved descent to depth 5, through a squeeze into a human-made tunnel,
  and behind an unlocked plank door: a four-room den where an outlaw necromancer
  wires the dead back onto their feet with glimmer shard-wire. Four new `outlaw`
  mobs (risen thornbug, stitched prospector, summon-only wired skeleton, and the
  Graveworker — summons skeleton pairs, casts Mage Armour and the new Leech),
  five fixtures (the den door, his journal, and his ever-burning lamps —
  `emitsLight 1` in every den room, so the den reads light 4 in calm and keeps
  a dim light 1 even through the Tide's depth-5 darkening), and a sealed west
  face reserved for future content. The boss drops (20% each): **the graveworked
  apron** (+2 INT/+2 WITS, zero armour — the summoner's trade-off), **the
  Graveworker's scalpel** (small INT-scaled blade whose every cut mends the
  wielder, hungering-dagger mechanism), **a Scroll of Leech**, and **a Scroll of
  Summon Skeleton** — a new player summon (`summon-skeleton`, mana + shards:
  the glimmer is spent as wire, a deliberate Umbral/human cross-craft) that
  raises a single wired skeleton, recast replacing it.
- **New spell-effect type `drain` + spell: Leech (mana-only life drain).** A
  hostile drain lands like a damage weave and heals the caster for half the
  damage dealt (capped at max hp), in both cast directions. Mob-castable and
  player-ready (`HOSTILE_EFFECTS`/`MOB_CASTABLE`/validator updated); not yet
  learnable by players.
- **Per-creature arrival flavour.** 30 of the wild bestiary now carry a
  `spawnMessage` in `data/world/mobs.json` — the atmospheric line onlookers see
  when the creature spawns into their room (respawn, Tide creep, or onset roster),
  replacing the generic "X appears." Covers the wandering/hunting fauna, predators,
  necropolis undead, and the roving outlaws; the name stays light-gated, so an
  unseen arrival still reads as "something." Named town/camp NPCs and unique
  lair-bound bosses are left on the generic line by design.
- **Ambient Tide emotes.** The world clock can now perform atmospheric room lines
  during a phase (authored in `data/world/tide.json` `emotes`, keyed by phase with
  `everyTicks` / `chance` / `requireDark` / `lines`) — flavour that belongs to the
  Tide itself rather than any mob. Shipped with lines for Stirring and the Tide.
- **Lastlight Camp — a 4-room prospectors' frontline camp at depth 10** (zone
  `frontline-camp`), reached east from The Keeper's Lake across a worked causeway.
  The deepest human foothold in the Abyss: the rare expedition that made the whole
  descent from the Rim and dug in beside the Umbral fields as a staging-post for
  going deeper, kept standing by a wordless truce with the deep-folk across the
  water. Four rooms — **The Lastlight Picket** (entry, an iron seam to mine),
  **The Lastlight Common** (hearth and heart), **Corvane's Bench** (alchemy
  station), and **The Rope-Head** (the descent jump-off, not yet riggable) — and
  four new `rim`-faction NPCs, each with `react`/`talk` dialogue, Tide-aware lines,
  and a shop of existing goods: **Bricke the pickman** (a seasoned miner learning
  Umbral stonecraft — light, tools, armour), **Captain Sella** (founder of the camp
  and broker of the truce — provisions), **Corvane the alchemist** (an adventurer
  who gathers his own deep reagents — potions, glimmer-dust, alchemy schematics),
  and **Wren the mender** (a human-tradition healing mage at the shaft's lip —
  healing and warding scrolls). Added an `east` exit to `d10.fields.lake`.
- **Aegis — a room-wide ward (the party counterpart to Mage Armour).** Throws a
  shared lattice of hardened light over the caster and every ally present,
  granting each the same armour-only protection Mage Armour gives one
  (`1 + Intellect/8`) for one cast at roughly double the mana. Non-hostile,
  `target: "room"`; keeps Mage Armour's no-shard, armour-only identity (Glimmerskin
  stays the single-target armour+ward option). Cast prefix `ae`. Taught by a
  new **Scroll of Aegis**, sold by Vesper.
- **Purge — a room-wide cleanse (the party counterpart to Cleanse).** A wide
  pulse of scouring light that strips every `damage-over-time` affliction
  (witchfire, poison) off the caster and every ally present at once, where
  Cleanse scours only one target. Non-hostile, `target: "room"`. Named for a
  short, unambiguous cast prefix (`p`) that doesn't collide with Cleanse
  (`cle`). Taught by a new **Scroll of Purge**, sold by Vesper.
- **Chorus of Mending — the first room-wide support spell (a party heal).** A
  `heal-over-time` sung wide over the caster and every ally present (co-located
  delvers and allied creatures — summons, pets), knitting each a little every
  couple of ticks. Thinner per-target than a single Regeneration (`Intellect/3`
  per pulse vs `/2`) and costing near double the mana, but it mends the whole
  line at once — the group counterpart to Regeneration, and the first spell to
  exercise the `target: "room"` support path in live content. Taught by a new
  **Scroll of the Mending Chorus**, sold by Vesper.
- **Iron Skin — a new advanced self-only ward, the defensive twin of Iron Blast.**
  Works a smelted iron bar thin over the caster's own hide for a heavy flat
  Armour stack (`3 + Intellect/3`, well above Mage Armour or Glimmerskin) — but
  being iron, not glimmer, it grants **no Ward**: pure physical protection that
  a warded bolt slides straight through, the mirror of Iron Blast's "warded by
  nothing, blunted only by armour." Self-only (naming an ally is refused),
  consumes an **iron bar**, re-cast renews rather than stacks. The first spell
  to exercise the new `target: "self"` shape. Taught by a new **Scroll of Iron
  Skin**, sold by Vesper the glimmer-mage beside the Blast scroll.
- **`target` is now the spell targeting contract** (`self` / `creature` / `room`,
  crossed with `hostile` — see docs/data-model.md). The previously dead field
  drives `cast` routing and unlocks two new spell shapes: **self-only** support
  (naming anyone else is refused — "X can only be laid on your own skin") and
  **room-wide support**, which lays the full caster-baked effect on the caster
  and every ally present (co-located delvers plus mobs of allied factions —
  summons, pets, the rim watch) for one cast cost, drawing healer-aggro per
  ally mended. Mob AI honours the same axis: a mob's non-hostile `cast` action
  with `target: "room"` mends its whole side (one room-wide narration beat;
  mended delvers get their personal take-hold), sharing the new beneficial-
  effect core with player casting. Summons backfilled as `target: "self"`; the
  validator requires the field and cross-checks it against the effect shape so
  it can never contradict how the spell resolves. The `spells` listing shows
  the shape ("self only" / "you and every ally present").
- **Spells can reflavour their cast narration from data.** An optional `messages`
  block on a spell (`self` / `room` templates plus a `hitVerb` for area bursts —
  see docs/data-model.md) overrides the generic landed-hit lines, so a new
  spell's flavour no longer needs code. Flame Burst's fire narration moved from
  a hardcoded branch into its data, and Glimmer Spike gained bespoke lines
  ("You drive Glimmer Spike through…"). The validator checks the block's keys.

### Fixed
- **Contact triggers can no longer strike a corpse twice.** A melee contact
  trigger (`onHit`/`onDamage`/spikes) now only ever lands on a side still
  standing: a self-targeted `onHit` that kills its wielder (a blood-price
  weapon) is captured as the attacker's death — previously it was silently
  discarded, so the exchange carried on as if the attacker were alive — and
  once either combatant is down, no further trigger fires at them (a second
  "kill" would double-run the death path, double-decrementing the spawner count).
- **A mob slain with no nameable finisher now still pays the players who fought
  it.** Every mob death resolves through one shared sequence (`_killMobAt`), so
  an indirect kill — light-bane, a bleed whose caster logged out — credits kill
  XP to players holding live combat threat, exactly as a direct blow's death
  path always did. Pure-environment kills with no participants still award nothing.
- **`weaponOf` no longer crashes on an equipped hand item whose template is
  missing** (guards like its sibling helpers; previously unreachable in practice
  thanks to the login-time orphan filter, but a tick-loop crash if ever hit).
- **A mob's hostile status spell (a debuff/hex) lands again.** The shared
  hostile-cast core (`_applyHostileSpellEffect`) had no fallback for effect
  types outside damage / damage-over-time / sleep / douse, so a mob casting a
  generic hostile status warned "no hostile resolution" and applied nothing —
  behaviour the mob-cast path had before the shared-core refactor (#186), and
  that `npm test` has been failing on since. Restored as a `default` branch:
  the status is applied as-is (marked `good: false`), and the mob-cast event
  narrates it ("— the Hex takes hold"). The validator's `MOB_CASTABLE` and the
  player cast guard stay strict, so authored data is unaffected; this only makes
  the engine able to land whatever they admit. The full test suite is green again.
- **Spell casts no longer drop their side-effect messages.** The player cast
  resolvers produced events nobody delivered, so: a sleeping mob roused by a
  hostile cast (or caught in an Arc Flash / thrown bomb) woke silently, the
  "You turn on X and fight back!" auto-engage line after a hostile cast never
  appeared, an ally buffed by another delver got no "takes hold" confirmation
  (or prompt vitals refresh), and a summon replaced by a recast while standing
  in another room vanished unseen. All four paths now deliver their events.
- **A spell whose effect the cast paths can't resolve is refused up front, not
  half-cast.** Casting e.g. a mob-only weave (Snuff) used to spend the mana,
  do nothing, and narrate "for undefined damage"; `cast` now refuses before any
  cost is spent (and warns server-side). The validator enforces the same rule:
  every learnable spell (scroll, book, quest reward, player template) must use
  a player-castable effect type, and a mob's hostile `cast` action must use one
  the mob path resolves.
- **Mob-cast damage-over-time spells now bake duration and glow correctly.**
  Player and mob casting resolve hostile effects through one shared core
  (`_applyHostileSpellEffect`), fixing the mob path applying a DoT's raw spec —
  which ignored `durationScale` (making e.g. a mob-cast Witchfire permanent)
  and dropped its `emitLight` companion glow.

### Changed
- **All combat damage now flows through two shared sinks (`_hurtMob` /
  `_hurtPlayer`).** Every path that used to hand-roll `hp -=` + threat + kill —
  melee `deal`, a player's damage spell, a mob's cast, a room burst/bomb — now
  calls the sink, which owns the damage→threat convention (`threatTo` stokes
  `max(1, damage)`, so the minimum can no longer differ between the two cast
  directions, as it quietly did), suppresses its `mob-hurt`/`player-hurt` event
  where the swing/cast event already narrates the blow (`silent`), and resolves
  every kill through the one shared death sequence. A missed swing provoking its
  target is now an explicit `defender.provoke` rule rather than a side-effect of
  dealing 0 damage; "quarry slain → stop swinging" moved from the mob defender's
  damage closure to the player attack loop where it belongs; a mob's killing cast
  now narrates cast-then-death (the cast event carries the post-blow hp, like
  melee) instead of relying on caller-side event ordering; and the now-unused
  `_killMob` wrapper is gone. New `test/damage-sink.test.js` pins the
  conventions. No tuning changes.
- **Melee combat internals dedup (no gameplay change beyond the fixes above).**
  The uniform `attack` event is now built in one place (`applyHitOutcome`) for
  both directions — player swings gain the `targetKind`/`attackerEmitsLight`
  fields mob swings already carried, and the never-read `targetMaxHp` is dropped;
  the duplicated death block in `_hurtMob` now delegates to `_killMobAt`; the
  thrice-copied "rouse a struck sleeper" and twice-copied auto-retaliate blocks
  are shared helpers (`_rouseMob`/`_autoEngage`); a missed swing provoking its
  target (threat on a miss) is now documented as deliberate; `combat-math.js`
  stops exporting its internal-only constants and `state.js` drops two unused
  imports.
- **Action-economy tuning knobs live in `server/config.js`.** The scattered
  literals — default weapon/mob-attack action cost (12), the unarmed swing (10),
  the default mob speed (10, previously duplicated in two places), and the
  3-actions energy-bank cap (also duplicated) — are now `DEFAULT_ACTION_COST`,
  `UNARMED_ACTION_COST`, `DEFAULT_MOB_SPEED` and `ENERGY_BANK_ACTIONS`, so the
  accrual and gating sides of the energy system can no longer drift apart;
  `search`'s cost references the same action constant. No values changed.
- **A mob's defence is read fresh on every swing of a multi-swing tick** (was
  snapshotted once per tick), so a future contact trigger that shifts Armour/Ward
  mid-exchange (an armour-shredding `onHit`) counts from the very next blow.
- **The Tide is now fully data-driven (`data/world/tide.json`).** Its whole
  configuration — timing (`phaseTicks`, phase order), depth-scaled `darkening`
  (formula params + which phases darken vs. edge-dim), lamp on/off phases and
  messages, per-phase transition messages, and the generation rules (the per-tick
  creep `predator` + an onset `spawns` roster) — moved out of `server/config.js`
  into one JSON file, so the same engine can carry a different story by swapping it.
  Built-in defaults live in `server/world-clock.js` (`DEFAULT_TIDE` / `resolveTide`),
  merged under the authored file; a world that omits `tide.json` behaves as before.
  The validator now cross-checks the file (phase vocabulary, every mob the dark
  looses, message/emote shapes).
- **Spawn/despawn flavour moved onto the creature (`mobs.json`).** A mob may now
  author a `spawnMessage` (with `{name}`/`{Name}` for the light-gated name) and a
  `despawnVerb`, reused by every appearance/exit path — normal respawn, the Tide's
  creep, and the onset roster — instead of the Tide hardcoding the void-shadow's
  lines. The void-shadow carries its own "peels itself out of the unlit air" /
  "sinks back into the dark" wording; other mobs fall back to the generic lines.
- **Mob self-buffs resolve through the shared beneficial core.** `_mobCastSelf`
  now bakes through the same per-type core as player support casts (which also
  gained the core's negative-magnitude handling, so a darkness aura like Drink
  the Light keeps its pull whoever weaves it). Behavioural side-effects for
  mobs: `durationScale` on a self-buff now bakes properly instead of being
  ignored, and a protect buff's `emitLight` companion glow applies — nothing
  currently authored relied on either gap.
- **`spells` listing consistency.** All durations now render as m:ss (DoT and
  area-burn durations were raw tick counts), heal-over-time durations fold in
  `durationScale`, and scaling amounts share one formatter. The unknown-spell
  error now quotes the full attempted name instead of its first word.
- **Room-burst narration reconciled with Iron Blast's per-damage-type flavour
  table.** Iron Blast (below) landed its own hardcoded fire/physical/default
  wording for `damage-room` casts at the same time `messages` (above) gave
  spells a data-driven override; the two are now one system — a spell's
  `damageType` picks a stock wording row (physical/fire/default) it gets for
  free, and `messages` (now with a `killVerb` key too) overrides any piece of
  it. Flame Burst's `messages` block was removed as redundant with its `fire`
  row's identical defaults. A mob's hostile `cast` also now skips the
  wholesale Ward-negate roll for a `damageType: "physical"` spell, matching
  the player path — no authored mob spell uses one yet.

### Added
- **New quest: "Something Worse in the Pens".** Wick (`rim-hatcher`) now also offers a
  follow-up to the stonebug-stalker quest — a huge bat out of the Bat Spire has taken to
  raiding his pens, and he wants it dead. Kill Night Wing (`d1.spire.roost`) to complete it.
- **The room spawn editor (`tools/spawn-editor/`) now also edits ground items.** It was
  scoped to the `spawns` field only; it now has a second table per room for `groundItems`
  (template / qty / hidden perception / respawn), using the same source-preserving save
  and PR flow. The natural home for tuning the new hidden-item respawn default below.

### Fixed
- **Mage Armour's cast message no longer calls itself a glimmer effect.** The shared
  "protect" narration hardcoded "a crust of hardened glimmer," but Mage Armour's own
  description explicitly draws its ward from "pure will rather than glimmer." The
  generic line now reads "a lattice of hardened light," matching Mage Armour while
  staying neutral for other protect spells (Glimmerskin keeps its glimmer flavor via
  its own description).
- **Searchable (hidden) ground items no longer stay gone forever once picked up.** A
  hidden groundItem with no authored `respawn` was static — found once, never again —
  while plenty of hidden items elsewhere already regrow on an explicit timer. It now
  falls back to a 30-minute default (`DEFAULT_HIDDEN_ITEM_RESPAWN`, config.js) when a
  room doesn't set its own `respawn`, so every searchable find eventually comes back.
  Fixed a latent bug in the same code path: a regrown item never got its `hidden` flag
  reapplied, so any item using this respawn-after-pickup behavior (even before this
  change) popped back into plain view instead of requiring another search.
- **Killing a quest's later target no longer wastes the kill if it dies alongside an
  earlier one.** Multi-step kill quests (e.g. thin the outlaw crew, then put down the
  Foreman) only credited the *current* step, so a Foreman felled while the outlaw-count
  step was still active simply didn't count — you'd have to find and kill another one
  once the crew step cleared. Kill credit now banks per-mob across the whole quest, so
  it's available the moment its step becomes current, no matter when the kill happened.
- **A delver leaving the game now darkens the room for those left behind.** On
  disconnect (a dropped tab *or* `quit`), the vacated room's light was never
  recomputed and co-located players were never refreshed or told — so if the
  departing delver carried the room's only light, the others kept seeing a lit
  room with the delver still in it until some unrelated event happened to refresh
  their view. The socket-close teardown now recomputes the room's light, announces
  the departure ("X slips away into the dark."), and refreshes the remaining
  occupants. Both paths share this teardown, so a dropped connection reads exactly
  like `quit`; the now-redundant announcement was removed from the `quit` command.

### Added
- **Spells can now deal true physical damage**, soaked by the target's Armour and
  immune to the Ward fizzle (a physical spell always lands) — the melee damage-type
  mitigation was pulled into a shared helper so spells and weapons resolve damage the
  same way, leaving a clean seam for more types (light, fire) later.
- **Iron Blast — a new advanced war-spell**: bursts a smelted iron bar into a room-wide
  hail of shrapnel that tears every foe in the room. Physical damage — no ward turns it,
  only Armour blunts it — a heavy single burst (no follow-up) that contrasts with Flame
  Burst's fire-and-burn. Hostile, consumes an **iron bar** as its component. Taught by a
  new **Scroll of Iron Blast**, sold by Vesper the glimmer-mage.
- **Bat guano to gather in the Bat Spire's deepest rooms.** The Sink and The Guano
  Sump (depth 1) describe floors heaped with droppings, but had no `guano` on the
  ground to actually pick up — it now spawns there (respawning), matching the
  existing `guano` material's own flavor text about gathering saltpetre from a
  roost floor.
- **Flame Burst — a new advanced war-spell**: a room-wide fire burst that leaves every
  survivor it doesn't kill outright to keep burning (a follow-up damage-over-time burn
  that also sheds its own light, like Witchfire, but scaled up to hit the whole room).
  Hostile, consumes bat guano as a material component alongside its (steep) mana cost.
  Taught by a new **Scroll of Flame Burst**, sold by Vesper the glimmer-mage.
- **Cleanse — a new support spell that burns off damage-over-time afflictions** (Witchfire
  and the like). Non-hostile, targets the caster by default like Regeneration or Mage Armour,
  or any ally/creature in the room. Taught by a new **Scroll of Cleanse**, sold by Vesper the
  glimmer-mage alongside her other scrolls.
- **The Seized Working — an outlaw prospector camp and Lumen's first living-human enemy class
  (`docs/side-areas.md` #5).** Opens **east off The Crooked Cut** (`d1.crook`), well below the
  gate and off the watch's beat: five rooms of outlaws squatting a working they took by force — **The
  Roasting Flue** (`d1.flue`, the entry, held by a lone sentry, where a smelter's chimney bores
  up to the surface as the crew's bolt-hole — visible but not climbable), **The Stripped Face**
  (`d1.diggings`) and **The Cutthroats' Commons** (`d1.commons`), both worked by common
  outlaws, **The Foreman's Cut** (`d1.foremans-cut`, the boss's rich seam), and **The Warder's
  Nook** (`d1.nook`, off the commons). Four new mobs on a **new `outlaw` faction** (`enemy` to
  both the player and the `rim` watch, `neutral` to the deep's own things): the **camp sentry**
  and **outlaw prospector** (melee brawlers), **the Foreman** (a `guard`-behaviour melee captain,
  drops the brigandine), and **the camp warder** (a hedge-mage who lights the camp and fights
  from range with Witchfire, Spark and a self-cast Mage Armour). The whole crew is a
  **coordinated unit** — every outlaw `assist`s (attack one and its roommates pile on) and
  `pursues` (a fleeing delver is chased up to three rooms, the Foreman included), so the camp
  fights as a rallying whole rather than a set of isolated encounters. Light **inverts** the bat
  spire's rule: these are living
  humans who *keep* light — cook-fires and lamps make the camp a lit pocket in the dark, a tell
  that something organized holds this ground. New drops: **the Foreman's brigandine** (a
  flexible body armour that rivals the iron cuirass without dulling a delver's wits) and **a
  warder's staff** (a caster's focus); the Foreman may also drop an **acid bomb** and the warder a
  **regeneration draught**, so the camp fields potions and thrown weapons of its own. Sentries and
  prospectors also drop, at a low chance, the
  ordinary supplies of a camp squatting in the dark — an iron weapon, a flask of lamp-oil, a
  torch, or a bit of cooked camp food. **New quest — _The Prospectors' Bane_:** Fenn the recorder
  (`rim-recorder`) notices registered prospectors working the eastern seams have stopped coming
  up — the outlaw crew that seized the working is robbing and killing honest diggers — and sends a delver to thin
  the outlaws and put down the Foreman so the ground is safe to work again. Rewards xp + shards.
- **The Bat Spire — a vertical bat-choked mini-dungeon (`docs/side-areas.md` #1).** Built the
  full shaft off **The Foot of the Spire** (`d1.spire.foot`): two rooms **down** into the reeking
  base — **The Gullet** (`d1.spire.gullet`) and **The Sink** (`d1.spire.sink`) with a dead-end
  **Guano Sump** (`d1.spire.sump`) off it — and three **up** toward daylight — **The Chimney**
  (`d1.spire.climb`), **The Hanging Gallery** (`d1.spire.gallery`), and **The Open Crown**
  (`d1.spire.crown`). The Crown breaks into open air on the mountain's flank (`ambientLight 3`):
  a still daylight vista over wild pine and bare peaks with no sign of civilization — a deliberate
  break in the always-downward descent, and a light-safe breather. Off the Gallery, **The Brood
  Vault** (`d1.spire.roost`) is the lightless lair of the mini-boss. Two new mobs: the **blood
  bat** (a blood-draining mid-tier flier that shuns light and routs to a searing flare) and
  **Night Wing** (the brood-matriarch boss — `guard` behaviour, summons `cave-bat` waves, holds
  its ground under light and will not rout). Bats dislike light but are not readily harmed by it:
  `lightBane` only bites at searing intensity (10+). New drop: **bat guano** (`guano`), a
  saltpetre-bearing material foreshadowing a later alchemy line. Light inverts the usual pressure
  here — the dark swarms you, and bright light scatters the swarm rather than killing it.
  **Secrets:** the Crown is the cave-mouth out onto the high mountainside; a hidden **via ferrata**
  (iron rungs and cable, `perception 5`) climbs from it to **The Summit** (`d1.spire.summit`) — a
  fully-outside reward vista on the roof of the mountain, sky and peaks in every direction. Three
  minor finds are hidden across the shaft for a searching eye: a spilled purse of shards in the
  Gullet (`perception 3`), a delver's flask of lamp-oil in the Guano Sump (`perception 4`), and a
  dropped torch in the Hanging Gallery (`perception 4`).
- **Foot of the Bat Spire — the shallow entry to a future vertical shaft.** Added
  **The Bending Cave** (`d1.spire.approach`) west of `d1.roost` — a quiet cave-traversal beat —
  and **The Foot of the Spire** (`d1.spire.foot`) north of it: the base of a natural flue that
  climbs to a coin of grey daylight far above (`ambientLight 2`), where the way onward is a climb
  up into the dark. Enabling geography for the multi-level bat spire (`docs/side-areas.md` #1);
  the spire proper and its bat roster are a later run — no new mobs added here.
- **Eastward passages off the Rat Warren — the approach to a future bandit camp.** Added
  **The Long Squeeze** (`d1.squeeze`) and **The Crooked Cut** (`d1.crook`) east of `d1.warren`:
  two dark, shoulder-wide crawl-passages. Both hold an ambushing `cave-lurker`; the Squeeze adds
  warren-overflow `giant-rat`s and the Cut a `cave-centipede`. The Cut is dressed as a **seized
  working** — a hand-worked ore seam (`iron-vein`), a cold lean-to, an unstamped work-tally —
  with fresh scuffs leading further east (no exit built yet; reserved for the bandit camp,
  `docs/side-areas.md` #5). Environmental storytelling only — **no human enemies yet.**
- **Rim town map groundwork — two new patrolled rooms.** Added **Prospectors' Walk**
  (`d0.street`), a lodging-lane of prospectors' sheds inserted east of the Rim Market, and
  **The Landward Gate** (`d0.roadgate`) beyond it — a locked iron gate barring the old road out
  of the settlement (flavour only, no exit through it yet). The **Mage's Shed** (`d0.mageshed`)
  now hangs **south** off the Walk rather than directly off the market; the Warded Cellar link is
  unchanged. Both new rooms carry the `patrol` tag so they fall inside Hale's beat. Enabling
  geography for the shallow-layer side-area cluster (see `docs/side-areas.md` #0); no monster
  content added.
- **Side-areas idea backlog (`docs/side-areas.md`).** A living design list of proposed optional
  side pockets / mini-dungeons keyed to the threat ladder — bat spire, hollowed prospector camp,
  glimmer-mutated fauna, tremor-mole lair, human bandit camp, submerged rooms, and a living-fungi
  area — each with a lore/mechanics review, implementation lift, and light-system twist. Backlog
  only; no game content added yet, all names provisional pending sign-off.
- **Rarity is now hinted in the player panel's Equipment and Inventory lists.** Non-common item
  names are tinted with the same rarity palette used by the room item chips and the Inspect
  badge (uncommon/rare/epic/legendary); Common stays neutral.

### Fixed
- **Sanctuary→Midden connection now respects depth.** The link between `d9.sanctuary.run`
  (depth 9) and `d8.midden.seam` (depth 8) used horizontal `south`/`north` exits across a depth
  boundary; since depth 8 is shallower, the seam is now reached **up** from the run and the run
  **down** from the seam (matching the seam's "climbs, worming up" flavour). Directional flavour
  text in both rooms updated to suit.

### Added
- **Necropolis boss equipment — four unique drops.** The two necropolis bosses now drop
  best-in-slot gear (20% each). The **Aya-Keeper** drops **a grave-warden's spear**
  (`grave-wardens-spear`, rare — magical `1d8`, Perception-scaled, high innate crit `0.12`, with a
  grave-chill burn on hit) and **the Aya-Keeper's vestments** (`aya-keepers-vestments`, rare body —
  light caster-warden cloth: `armour 1, ward 2, maxMana 5` and `wits +2`, which the engine turns
  into extra Ward *and* dodge). **Supay** drops **a mantle of interred night**
  (`mantle-of-interred-night`, epic `cloak` — `ward 3, manaRegen 0.125, intellect +2`) and **a staff
  of drinking dark** (`staff-of-drinking-dark`, epic caster focus — magical `1d6`, Intellect-scaled,
  `intellect +2, maxMana 6`, life-drain on hit). Names provisional, pending sign-off.
- **Depth 8 — the Umbral Necropolis: an 8-room side-dungeon of the dark-taken dead.** North of
  the ward-post the bridge lands in a Quechua-inspired underground necropolis (zone
  `umbral-necropolis`), the most dangerous place mapped so far — pitched harder than the depth 7/8
  areas. A dead second warding (**The Grave-Gate**, `d8.necropolis.gate`) gives onto **The Bone
  Causeway** (`d8.necropolis.causeway`), the **Niche-Walls** dead-end lurker den
  (`d8.necropolis.niches`), the open **Ancestor Plaza** of chullpa towers (`d8.necropolis.plaza`),
  the **Ossuary** (`d8.necropolis.ossuary`), the **Silent Procession** (`d8.necropolis.procession`),
  the **Tomb-Foot** (`d8.necropolis.vault`), and — up a ladder into the sealed tomb — **The Sealed
  Crypt** (`d8.necropolis.crypt`). **Negative light** deepens toward the tomb (causeway/niches/
  ossuary/procession at `-1`, the crypt at `-2`), and the crypt carries an **offensive room effect**
  that drinks hp + mana each tick while it is dark. New enemies (all dark-taken, harmed by bright
  light — reusing the existing `snuff`/`drink-light`/`gloom-bolt`/`glimmer-spike`/`glimmerskin`
  spells, no new spells): the shambling **grave-husk** and heavier **bound husk** (Hollowing
  husks — emptied Umbral dead), the hidden ambushing **crypt-lurker** (a light-drinking shade that
  waits in the niches), the **Aya-Keeper** mini-boss (a fading Umbral gravekeeper that raises husks
  and guards the ladder), and **Supay, the Interred Night**, the crypt boss — the strongest creature
  in the game (185 HP), a living shadow the sealed tomb bred, kin to the Starving Dark. Adds three
  scenery fixtures (`broken-ward`, `grave-niches`, `chullpa-tower`). Adds two craft materials:
  **dark cinder** (`dark-cinder`, a common dark reagent — the snuffed remnant of a dark-taken body;
  drops from the necropolis husks, crypt-lurker, and Aya-Keeper for now, and is designed to extend
  to the wider shadow-touched family later) and **glyph-silk** (`glyph-silk`, an uncommon
  glyph-inscribed gloom-silk ritual/burial cloth — dropped by the bound husk and Aya-Keeper and
  hidden in the Niche-Walls, and forward-designed to be weave-craftable and to appear in future
  ritual/burial contexts). The Aya-Keeper also has a 20% `shadow-heart`; Supay drops one outright.
  Other drops reuse existing `crystal`/`shadow-shard`/`shadow-heart`/`shards`. Necropolis, creature,
  and material **names are provisional, pending sign-off.**
- **Depth 8 — the Chasm Bridge: a 3-room span to a coming necropolis.** The Chasm Ledge
  (`d8.ledge`) is no longer a dead-end: a long hanging bridge of glimmer-wire and Umbral plank
  now runs **north** across the abyss (zone `chasm-bridge`). **The Span** (`d8.span`) is the
  mid-bridge vista — suspended in the roaring dark beside the great fall, flame drowned by spray,
  lit only by the far moss-glow high up the shaft. **The Ward-Post** (`d8.wardpost`) is the far
  bridgehead: a lit, warded haven (`ambientLight 1`, no douse) where the deep-folk set a cold
  glimmer-lamp and a ring of glimmer-stakes "against the dark, and the things the dark makes" —
  the same warding that keeps the sanctuary above, standing here at the edge of the kept places.
  Its north way waits, unopened, on the **umbral necropolis** to come (a distinct side-dungeon,
  designed next). Adds a reusable **`glimmer-ward`** scenery fixture (emits light).
- **New equipment slot — `cloak`.** Adds a back/mantle slot alongside the existing worn slots
  (seeded empty in the new-player template so `unequip cloak` works from a fresh character), and a
  first item for it: **a gloom-silk cloak** (uncommon, **+2 Ward**), woven whole from gloom-silk in
  the deep-folk method. The **`weave-gloom-silk-cloak`** recipe (2 gloom-silk, at the alchemy bench)
  is taught by Mallki's **Umbral weaving-method** book, so it's available from the umbral trader.
- **Lore — the Hollowing and the lost village.** `docs/lore.md` now records the **second deep
  fate** alongside glimmer-mutation: where glimmer warps the *body* (the Mutated), the deep's own
  dark slowly takes the *self* — **the Hollowing**, a one-way decline in three stages (**husk** with
  dim memories → **fading** body → mindless **living shadow**) that claims Umbral and human alike.
  This gives the threat ladder's existing **living shadows** an origin and names the **"things the
  dark makes"** the deep Umbrals ward against. Adds **the lost village** — an Umbral settlement the
  Hollowing thinned to nothing, the dark-taken still going through the motions in its streets — sited
  below the shut warded gate beneath the Umbral fields. Whether the dark and glimmer are one force or
  two is left a **deliberate mystery**. Updates the threat ladder, the Umbrals' settlements note,
  *Deliberately unknown*, and the consistency rules; village place-name left provisional pending
  sign-off.
- **Depth 8 — the Sour Midden: a 6-room slug dungeon off the sanctuary.** The Centipede Run's
  previously-unmapped seam (`d9.sanctuary.run`) now opens into a sealed depth-8 charnel pit
  (zone `sour-midden`) where the deep-folk gave their dead to the cleaner-slugs — and the gluttony
  went sour. **The Sour Seam** climbs in to the reek; **The Reeking Midden** is a bone-heaped
  charnel swarming with harmless grazing **scour-slugs** (with a searchable **fulgurite** shard,
  Perception 6, hidden among the bones); **The Gorge Pools** is where the danger
  lives — fuming caustic basins crowded with the new hostile **glut-slug** (bloated mid-tier slug,
  acid-burn DoT on hit) — which drops a new special crafting material, the **caustic gland** (a
  rare corrosive reagent; ~35% from a glut-slug, guaranteed from the boss); a lit **Witchglow
  Cleft** branches west as a safe forage/rest pocket; and
  past **The Sour Descent** lies **The Glut's Pit**, lair of the mini-boss **the Great Glut** — a
  vast caustic bruiser (150 HP, heavy corrosion DoT, loot-only: slug-slime, shards, a chance at a
  crystal). A **fulgurite vein** runs the wall of the Glut's Pit — minable once the boss is down.
  The two slime-flooded rooms (Gorge Pools, Glut's Pit) carry a **corrosion-slime room
  effect** that burns anyone standing in them every few ticks (1d3 / 1d4 hp), so they punish
  loitering. All slugs are light-baned, so carrying light into the dark both reveals the rooms and
  weakens what lives in them.
- **Depth 10 — the Umbral fields: a 5-room farmland before the village.** The shrine's long
  black stair now **descends** into the deep-folk's own kept ground (zone `umbral-fields`) — the
  ominous sealed way down pays off not in horror but in a living, tended farmland. **The Field
  Stair** lands you in lit crop; **The Lightfield Commons** is the hub, where lightbugs drift
  thick overhead (they wander the whole zone, glow and all) and stonebugs, thornbugs and an elder
  stonebug graze the rows; **The Moss Terraces** add the mushroom crop and a **weeping
  chasm-moss** (`gloom-silk`) source over grubs in the rot. A stream wells up cold
  in **The Tended Channel** and runs south to **The Keeper's Lake** — a stocked **fishing** spot
  (new `keepers-lake` resource, grub-baited) where the water finally slides away into a cleft in
  the cave wall and is gone. The whole zone is fully safe and lit (no hostile spawns); stonebugs
  are confined to the two `grazing` rooms while lightbugs roam everywhere. South of the common a
  **warded gate stands shut for now**, the way down to the Umbral village (not yet built).
- **Depth 9 — the Umbral Sanctuary core: a 7-room warded haven.** The sealed inner door below
  **The Sanctuary Threshold** (`d9.sanctuary.landing`) now opens **south** into the kept place
  the deep-folk still hold whole (zone `umbral-sanctuary`). At its heart is **The Umbral Shrine**,
  lit by a cold glimmer-lamp with a drinkable font — the source of the warding: no hostile spawns,
  and the warren's dark is zone-bounded above, so the shrine and its lit rooms read as a true safe
  haven against the depth-7/8 monsters. The calm core is deliberately gentle: **The Glow Garden**,
  **The Grub Hollow**, and **The Kept Cistern** are all `grazing` rooms where stonebugs, thornbugs,
  grubs, scour-slugs and blind cave-fish forage, patrolled by **two elder stonebugs** — a new
  `helper`/`pursues` grazer (modelled on the Old Grinder) that puts its bulk between a threat and
  the lesser bugs and has a 40% chance to drop a **slab of dense chitin**. Two small lakes anchor
  the edges: the **Kept Cistern** (a clean, lit, separate pool) and the dark **Plunge Basin** —
  the foot of the great fall, the same Far Bank water seen far overhead from the d8 Chasm Ledge,
  hung with **weeping chasm-moss** (a `gloom-silk` source) and home to pale salamanders and a
  tremor-mole at the unlit water's edge. The one hostile room, **The Centipede Run**, sits on the
  southern margin where the warded light gives out — cave centipedes, and an unmapped dark beyond
  as a hook for later. From the shrine itself a broad black stair now descends to depth 10 (see
  above).
- **Glimmerglass crafting.** A new material line: **fulgurite** (an uncommon raw glass
  mined from a new **fulgurite seam**) is fused with **glimmer dust** to make **glimmerglass**,
  a rare pane of dark glass veined with captive light. The fusing happens at a new crafting
  station, **an Umbral kiln** (`station: "kiln"`), via the `Glimmerglass Pane` recipe
  (1 fulgurite + 2 glimmer dust, 4 shards). Mallki sells the `schematic-glimmerglass` as a
  **placeholder** — its real home, and the locations of the fulgurite seam, kiln, and the
  glimmerglass recipe, come in an upcoming content pass. (Glimmerglass is the same material
  the existing `glimmerglass-blade` is described as being ground from.)
- **Depth 8 — the Sunken Warren: a 12-room maze beneath the gloom-warren.** A drowned
  lower warren that opens via a new `down` from **The Drowned Black** (`d7.lair`, past the
  Starving Dark): a looping maze of flooded cave and old Umbral stone, fully dark, with the
  gloom-crawler family carried over at higher density (elders and gloom-touched promoted to
  common). Two waterfall rooms — **The Plunge Foot** and **The Chasm Ledge** — sit at the foot
  of the great fall and **douse** your flame on entry; from the Ledge, the far outfall of the
  black lake spilling over the Far Bank (`d4.lake.farshore`) is visible far up the shaft. Two
  minibosses: **the Pale Mother** (the warren's swollen brood-queen, who summons crawlers and
  drops a guaranteed unique rare material, the **brood-caul** — its recipes to come later) and
  **Ñawpa, the Hollow Watch** (a mutated-Umbral glimmer-singer who raises glimmer-husks from
  worked plates and strikes with glimmer-spikes — drops `chitin-plate`, the husk-spell's own
  reagent, plus a 25%-each chance at two unique glimmer weapons: the **glimmerspine spear** and
  the **glimmer lash**, both dealing **magical** damage that Ward, not Armour, blunts). A warded
  Umbral stair descends south to a depth-9 **Sanctuary Threshold** (new zone `umbral-sanctuary`):
  the gaunt things of the warren will not cross it, so the descent reads as a true safe haven. The
  Sanctuary proper is a sealed inner door — a hook for later.
- **Six Perception-gated secrets across the Sunken Warren.** Every one sits in a non-doused room,
  so finding them needs your own carried light (the douse rooms stay barren): **The Prospectors'
  Last Camp** (hidden off the Drowned Cache, Perception 8) — a true rest stop with a cooking fire,
  a seep to drink from, and a striking oil-lamp, reachable only by its hidden crack so nothing
  wanders in; **The Slug Grotto** (hidden off Silt Crawl, Perception 6) — a faintly-lit fungus
  pocket of glowing pale-caps and witchglow grazed by five scour-slugs, around the rotting wreck
  of a camp that didn't last (a torch and a regeneration draught lie hidden in the gear, Perception 7); a one-way **flooded escape** behind the Pale Mother's nest dropping
  out at the cache (Perception 7); a **silt-buried prospector's cache** of lamp-oil and shards
  under the Cistern (Perception 6); a **hidden glimmer vein** in the tainted wall of the Backwash
  (Perception 7); and a **concealed Umbral glyph-panel** behind the Waking Reliefs (Perception 6)
  whose intact carving foreshadows the sealed sanctuary below, with a glimmer crystal and shards
  cached at its foot.
- **Weapons can now deal magical damage.** A weapon declaring `damage.magical` (instead of
  `damage.physical`) lands a magical blow — cut by the defender's Ward percentage rather than
  soaked flat by Armour, exactly as `strike` already anticipated. Completes long-dormant
  wiring in `weaponOf`; physical weapons are unaffected. First users are Ñawpa's glimmer
  weapons above (the glimmerspine spear scaling on Perception, the glimmer lash on Wits).
- **The barbed bomb — a new thrown consumable, and a sink for two orphan materials.**
  A vial of thornbug barbs bound with slug-slime: thrown, it bursts for a small physical
  hit (`2d4`) *and* sinks a lingering **bleed** (`1d4` for 4 ticks) into anything it
  doesn't kill — the burst-plus-bleed hybrid neither existing bomb does (the shard
  grenade is one big burst, the acid bomb a pure corrosion cloud). Crafted at the alchemy
  station from `chitin-spike ×4 + slug-slime ×1 + vial ×1` (recipe `craft-barbed-bomb`),
  giving `chitin-spike` an alchemy sink and **slug-slime its first use anywhere** (it was
  flavoured as "an alchemist's binder" but used in no recipe). The method
  (`schematic-barbed-bomb`) sells from Mallki — a testing placeholder alongside the other
  Umbral recipes.
- **Examine works on what you can craft.** As with a shopkeeper's wares, you can now
  `examine <item>` against the output of any recipe you know — previewing its stats,
  rarity, and what it's made from before you gather the materials. The examine view
  offers a one-click Craft action. Real items you hold or wares on a counter still win
  a name clash; this only fills in for things you could make but don't yet have.
- **The Tide — a world clock that makes the abyss breathe.** On a fixed cycle the
  world passes through **Calm → Stirring → Tide → Receding**: during the Tide every
  room darkens, scaled by depth (`-2` at the rim down to a `-5` floor in the deep),
  pulling unlit passages into the dark and starving all but the best-lit camps. The
  **Stirring** phase telegraphs it with a world-wide warning ("the lamps gutter…")
  and a gentle dim; **Receding** ebbs the light back. Lamps and torches still sum on
  top, so light sources are the only refuge. Engine + tuning only for now — the
  light-fearing predators and the lamp-lit safe camps that build on it follow below.
  As the dark gathers (Stirring through the Tide), a Rim or Umbral NPC present in a
  room throws on its switchable lamps — and snuffs them again once the Tide recedes
  — so a tended camp lights itself against the dark (wild fauna won't work a switch;
  author/player-lit lamps are left be).
- **NPCs speak to the Tide.** As the dark gathers (Stirring and Tide), every settled
  human and Umbral NPC takes on Tide-specific behaviour: Maeve turns the inn's lamps
  up high, Garrick counts his lanterns, Vesper sets a glimmer-light turning, Mallki —
  born to the dark — turns his lamp *down* as the others raise theirs, and so on (the
  bound chitin warden bristles at the deepening black). The four who'd naturally warn
  a delver — **Hale** (the watch), **Maeve** (the inn), **Garrick** (who sells the
  lamps), and **Mallki** (the deep-dweller) — now call out an under-lit delver during
  the Tide: a sharp warning for **no light at all**, a gentler nudge for a **weak lamp**
  (torch/brass lantern), and a "stay in the glow" word for the well-equipped. Built on
  three new data hooks: a `phase` filter on any mob action, and `phase` /
  `carriedLightBelow` conditions on react reactions.
- **The Tide grows teeth — void shadows.** During the Tide the dark itself hunts:
  each tick, any room where a delver stands in failed light (room light below 0) has
  a small chance to birth a **void shadow** right beside them — lesser kin of the
  Starving Dark, conjured by a delver's own unlit risk. They are fast, relentless
  pursuers that snuff your flame and deepen the dark around them, and **bright light
  sears them** (any light above darkness), so a lamp is at once shield and weapon.
  Capped at five abroad worldwide, so a long dark mounts pressure without flooding; a
  lit camp (light ≥ 0) is never a birthplace, and the ebb reclaims every shadow still
  abroad — no corpse, like a dismissed summon. Unmade by the light, a shadow leaves a
  **shadow shard** 5% of the time: a rare crafting material (recipes to come) that
  sells dear. One tier for now; deeper, stronger kin follow later. Tunable in
  `config.TIDE.predator`.
- **Settled NPCs now have lamps, keeping their rooms safe through the Tide.** Every
  non-wandering Rim and Umbral NPC's room now holds a lamp that lifts its light to
  at least 1 during the Tide: the six Rim shops/halls (inn, market, reeve's office,
  hatchery, mage's shed, workshop) gain the descent's iron lamp, lit by their keeper
  as the dark closes in. Their base ambient is lowered to 3 (the hatchery to 0, left
  to its captive lightbugs) so the lamp, the patrolling watchman's lamp, and the
  hatchery's bugs stack into a bright, welcoming glow rather than overshooting into
  painful glare. The Umbral hall's cold glimmer-lamp is strengthened (now
  sheds 4) so it stays habitable when the Tide is deepest.
- **Hale the watchman now carries a lit lamp** (sheds 3) — a moving pool of light
  that travels his patrol, lighting whichever Rim room he walks rather than fixing a
  lamp to the plaza. So the watched heart of the Rim is safe while the watch is on
  it, and falls dark when Hale has moved on.
  A small **Tide indicator** sits on the shards line in the player panel: a phase
  label and a bar that fills with the dark — quiet in Calm, gold as it Stirs, red at
  the Tide, cool on the ebb — creeping forward on a slow heartbeat so you can read
  the dark coming. Tunable in `config.TIDE`; admins drive it by hand with `@tide
  <phase|auto|status>`.
- **Function-key shortcuts (`alias`).** Bind a command to **F1–F4** and fire it with
  one keypress (e.g. `alias F1 cast spark`). Run `alias` with no arguments to list
  your bindings, or `alias F1` (key only) to clear one. Bindings live on the
  character and persist across sessions and devices. Keys work whether or not the
  command line has focus; F5+ are left to the browser.
- **Backspace closes the Inspect window** (same as the ‹ back button), returning you
  to the room view — but only when the command line is empty, so it still edits text
  mid-typing.
- **Gloom-silk now has a use: two Umbral caster garments.** A **Gloom-silk Robe**
  (body: +2 Ward, +6 max mana, +1 speed) and a **Gloom-silk Hood** (head: +1 Ward,
  +3 max mana), both woven at an alchemy bench from gloom-silk + glimmer-dust.
  Recipes are taught by *an Umbral weaving-method* (teaches both), sold by Mallki
  the qhatuq. Previously gloom-silk could be processed but nothing consumed it.
- **New `Halo` light spell** — an Umbral cold-light weave, stronger than Candlelight
  (sheds 3 light) that also lays a **Ward = Intellect** against hostile magic.
  Fuelled by a luminescent gland (consumed on cast); both light and ward last
  60s + 15s/Intellect. Learned from a *Scroll of Halo*, sold by Mallki the qhatuq.
  As part of this, the `protect` effect type now supports companion light
  (`emitLight`) and Intellect duration scaling (`durationScale`).
- **New `Fried Mushrooms` cooking recipe** — 2 palecap mushrooms fried in
  bug-tallow for a small HP restore. Taught by *a book of cooking*.

### Changed
- **Hidden items are no longer remembered — only the room's lasting secrets are.**
  `search` still records found **exits** and **fixtures** permanently (a secret passage
  or hidden lever stays found), but a hidden **item** you uncover and *leave behind* is
  now forgotten the moment you leave the room — it reveals ephemerally, like a lurking
  mob, and must be searched out again on your next visit. Pick it up and it's yours as
  before.
- **The chitin maul is now a high-variance crusher.** Re-tuned to give it a niche of
  its own between the steady iron sword and the hard-scaling iron mace: damage goes
  `1d8` → **`1d12`** and it swings slower (`actionCost` 14 → **17**), keeping its
  Might/3 scaling. Average throughput is essentially unchanged (~0.38/tick, on par with
  the sword) — the trade is reliability for big, infrequent, feast-or-famine blows. Its
  recipe now studs the head with thornbug barbs: `chitin-plate ×4 + chitin-spike ×2 +
  iron-bar ×1` (was `chitin-plate ×4 + iron-bar ×1`), shards 6 → 7.
- **The barbed flail is now the weeping lash — a Wits attrition weapon.** Renamed and
  re-themed from a chain-and-iron flail into a whip-like lash of plaited **gloom-silk**
  set with thornbug barbs. It now scales its damage off **Wits** (per 6) instead of
  Might, giving the deep's purely-defensive stat its first offensive outlet: an evasive,
  magic-warded duelist who wins by attrition (the armour-ignoring bleed) rather than
  burst. Crafting moves to match the new form — woven at the **alchemy** station from
  `gloom-silk ×2 + chitin-spike ×4` (recipe `weave-weeping-lash`), and its method moves
  off the chitin-smithing tome onto the Umbral weaving-method book beside the gloom-silk
  garments.
- **Daggers are now finesse weapons.** The iron dagger and the hungering dagger scale
  their damage off **Perception** (per 6) instead of Might, and each gains a flat +5%
  crit. They lose to a sword in a Might build but pull ahead for a Perception/crit
  build — the dagger is now the natural pick for a high-Perception delver rather than
  a strictly-worse sword. (Crit alone couldn't separate the builds: a ×2 crit scales
  every weapon equally, so the lever is what the damage scales *with*.)
- **Exit destinations are hidden in the dark.** When a delver can't see (room light
  below their perception), the Inspect window still lists which directions lead off
  (e.g. "south") but no longer names where they go — you can feel for a passage, but
  can't read its destination until you have light.
- **The inn's hearth mends in slower, larger pulses.** The Lantern's Rest now restores
  5 hp/mana every 12 ticks instead of 1 every 3 — a touch faster overall, but the
  "the hearth's warmth eases your hurts" message fires a quarter as often.
- **NPCs speak up less often.** The global damper on ambient NPC chatter is halved
  (idle `emote` weight scaled by 0.25 instead of 0.5), so settled folk and creatures
  alike fall quiet roughly twice as often between remarks.
- **The void-light (below-zero) Inspect visuals are gentler.** The dark-closing-in
  vignette now breathes slowly and shallowly (8s, a smaller swing) instead of a
  fast, deep pulse that yanked the readable centre out from under the text — so
  examining or reading a room in the void no longer feels like a disruptive blink.
  The shiver and gray tint are unchanged.
- **The Inspect window no longer shows an Attack button for a creature.** Examining a
  mob is now purely informational; attack via the command line or the room chip.
- **`Candlelight` duration now scales with Intellect** (30s per point) instead of a
  flat 60s, matching the summon-wisp convention. A keener mage holds the light
  longer; the `spells` listing reflects the scaled duration.
- **`cast` now defaults to a sensible target when none is named.** A hostile spell
  cast with no target (`cast spark`) strikes the foe you're already engaged with —
  the pending attack target shown in the Inspect pane — instead of refusing. (Buffs
  and heals already default to self.)
- **`Hearty Broth` moved from *a book of cooking* to *a book of hearty cooking*.**
  The common cookbook now teaches the new Fried Mushrooms recipe in its place,
  while the broth joins Deep Stew in the rarer folio.
- **Max HP now grows with level, not just Vitality.** Previously a player's max
  HP was `Vitality × 5`, so any build that didn't pour points into Vitality stayed
  at its starting 15 HP forever while foes scaled with depth — making Vitality a
  mandatory tax. The new formula is `6 + 2 × (level − 1) + 3 × Vitality + gear`:
  every build gains durability each level, while a dedicated Vitality build still
  pulls meaningfully ahead. A fresh level-1 character is unchanged at 15 HP, and
  each level-up now grants its new HP capacity immediately (mirroring `train`).
- **Perception accuracy past 100% now sharpens into crit instead of being wasted.**
  When a delver's to-hit (light tier + Perception bonus − target evasion) would
  exceed a sure hit, the surplus converts 1:1 into bonus critical chance. Evasion
  is subtracted first, so it is paid down before anything spills over. This keeps
  Perception meaningful in good light or against low-evasion foes — where the raw
  hit bonus previously hit the cap and did nothing — without touching its
  dark-fighting edge. Mobs are unaffected (they carry no Perception hit bonus).

### Fixed
- **Room-effect test caught up to the result shape.** `applyRoomEffect` now returns
  a `silent` flag (added alongside the heal-only-when-healing fix); the
  `room-effects.test.js` restore assertion's expected object was updated to include
  `silent: false` so the suite is green again.
- **Healing room effects only speak when they heal.** A regen effect (e.g. the
  inn's hearth) no longer prints its flavour line when you're already at full hp and
  mana — the "warmth eases your hurts" message now appears only when it actually
  restores something.
- **Candlelight no longer stacks on itself.** Re-casting the cantrip now renews the
  single mote rather than piling up independent light-shedding instances, matching
  Halo and Mage Armour.
- **Mage Armour scales a touch harder with Intellect** — its armour now grows by
  `intellect / 8` rather than `/ 10`.
- **Resource verbs honour authored fixture keywords.** `mine`/`gather`/`fish`
  matching ran on fixture id and display name only, ignoring `keywords` — so
  `mine vein` missed a glimmer-seam that carries "vein" as a keyword but not in its
  name. Matching now routes through the canonical query matcher, so keywords count.
- **A creature of darkness no longer gives itself away in the dark.** Mob visibility
  treated any non-zero `emitsLight` as self-illuminating, so a *dark-shedding* mob
  (negative `emitsLight`, like the new void shadow) was wrongly always visible — named
  in the log and shown glowing in the room view even to a blind delver. Only positive
  light now counts as visible; a shadow in the void reads as an unseen "something"
  until you bring light to it. (No other mob emits negative light, so nothing else
  changes.)

### Changed
- **Fenn reframed from claims-recorder to _reeve_.** The Rim has no claim-reservation
  system, so Fenn no longer administers mining claims. He is now the self-appointed
  **reeve** — a local administrator and part-sheriff who licenses the descent and the
  digging, takes his fees, settles disputes, and keeps the register of who goes below
  and who never comes up; below the gate, where Hale's watch won't walk, his word is the
  only order there is. Reworded his mob entry and dialogue, **The Reeve's Office**
  (`d0.claims`, formerly The Claims Office), the chained ledger and notice board, the
  sealed condemned-adit door, the delver's tag and condemned-adit key items, and Fenn's
  quests (**Quiet Too Long** and the new **The Prospectors' Bane**) accordingly. Also
  de-claimed the outlaw camp's flavour (now a *seized working*) and the three surface-tone
  lines in `docs/lore.md`. Internal ids (`d0.claims`, `delver-claim-tag`, `quiet-claim-key`,
  `sealed-claim-door`, `claims-ledger`) are unchanged to avoid breaking references; only
  player-facing text moved. The deep `d2.claim.*` "a dying prospector staked his last claim"
  rooms are left as personal prospector romance, not an office reservation.

## [0.2.0] - 2026-06-23
### Added
- **`examine`/`look <ware>` now inspects a shopkeeper's stock before you buy.**
  When a visible trader is present, examining a ware you don't already carry
  falls back to the trader's offers and renders full item detail (stats,
  description, buy price) in the Inspect pane, with a one-click **Buy** action —
  the same view you get for a held item. Quest-gated stock stays hidden until
  earned, and anything in your own pack still wins a name clash. The shopkeeper's
  examine hint now advertises the flow (`list` → `examine <ware>` → `buy`).
- **A hidden centipede lair behind the stockpens, and a reworked Wick quest that
  teaches `search`.** Two new depth-0 Rim rooms east of `d0.corral`: *Behind the
  Stockpens* (`d0.backpens`), a transitional dead-end yard whose `north` exit into
  the lair is hidden behind a **Perception 3** check, and *The Drag-Burrow*
  (`d0.burrow`), a cave-centipede's nest strewn with dragged-in stonebug shells
  and chitin plates, breathing the same deep dark as the adjacent Riven Yard.
- **A rat-nest off the Sunken Cut.** Two new depth-1 abyss rooms west of the rat
  corridor: *The Rat-Run* (`d1.ratrun`, west of `d1.cut`) and *The Brood-Nest*
  (`d1.brood`, west of `d1.den`), linked north/south to close a loop with the
  cut/den. The Brood-Nest holds a **witchglow cluster** (faint light + harvestable
  caps). All four nest rooms (`d1.cut`, `d1.den`, `d1.ratrun`, `d1.brood`) now carry
  a `nest` tag.
- **A new mob, the `brood-rat`.** Gnaw's oversized get — stats between the common
  giant-rat and Gnaw (20 HP, 1d4, xp 14) — that **wanders** the `nest`-tagged rooms
  on patrol and hunts on sight, but won't stray out of nest territory.
- **A new Umbral sword, the `glimmerglass-blade`** (1d8, `crit 0.10`, +2 mana on
  hit), the reward for a new quest, *The Blade He Lost* (`mallki-lost-blade`):
  Mallki the qhatuq lost an old deep-stone blade on a climb toward the surface;
  find it (rats dragged it into the Brood-Nest) and return it, and he shapes you a
  finer one. He keeps his old blade, and reacts to its return.

### Removed
- **The "Proof of Venom" notice-board bounty (`board-venom-proof`).** The
  repeatable centipede-gland bounty has been retired.
- **The orphaned `deep-dweller` mob.** It was defined but never spawned anywhere,
  so its loot (the `rusted-blade`) was unobtainable. The blade now has a home (see
  below); `vial`, its other drop, remains available from shops, recipes, and ground.

### Changed
- **Wick's quest is now "Something in the Pens" (replaces "Wings over the
  Hatchery").** Instead of culling cave-bats below, Wick reports stonebugs being
  killed and dragged off by something denning near the pens and asks the player to
  **search the ground around the stockpens** — the only way to find the hidden
  burrow exit — then kill the cave-centipede within. The reward is now the
  **Minor Light Potion recipe** (previously two potions), and that recipe has been
  **removed from the new-player starting recipes** so the quest is how a delver
  first learns to brew their own light.
- **`vespers-caps` now uses witchglow caps instead of palecaps**, and its reward
  gains a **regeneration-draught** (itself brewed from witchglow), alongside the
  existing xp/shards.
- **Retuned two notice-board bounties.** `board-tallow-order` now asks for **10**
  bug-tallow (was 3) and pays 20 xp / 15 shards — a premium over selling the lumps
  directly. `board-crawler-bounty` now culls **7 gloom-crawlers and 3 cave-lurkers**
  (was 4 crawlers) and pays 50 xp / 35 shards.
- **The `rusted-blade` is now a placed, lore-bearing quest item.** Found on the
  floor of the Brood-Nest, reflavoured as a *damaged Umbral deep-stone blade* (its
  "rust" is glimmer-tarnish, not iron), with stats raised to match an iron sword
  (1d8). It is the target of *The Blade He Lost*.
- **A release cutter (`tools/release.js`, `npm run release`, or `tools/release.bat`).**
  Versions are now cut
  from the Conventional Commit history rather than bumped per-PR: `[Unreleased]`
  accumulates merged PRs, and `npm run release` derives the next SemVer from the
  commits since the last `v*` tag (pre-1.0: any `feat` → MINOR, else PATCH), stamps
  `VERSION`, `package.json`, and the `CHANGELOG.md` (leaving an empty `[Unreleased]`
  on top and dating your hand-written notes under a new version header — prose
  untouched), commits on a `chore/release-x.y.z` branch, and pushes + opens the PR
  via `gh` (falling back to a compare URL if `gh` is absent). Flags: `--dry-run`,
  `--major`/`--minor`/`--patch`, an explicit version (e.g. `1.0.0`), `--no-pr`, and
  `--no-commit`. See CONTRIBUTING.md → *Cutting a release*.
- **A browser-based recipe editor (`tools/recipe-editor/`, `npm run edit-recipes`,
  port 3942).** A local form for editing `data/world/recipes.json` the same way the
  item and mob editors work: pick a recipe (or add a new one), edit its name, station,
  shards cost, repeatable `{ template, qty }` inputs, and output, then **Validate &
  preview** (writes, runs `npm run validate`, shows the `git diff`, then restores the
  tree) or **Create pull request** (validates, branches, commits, pushes, opens a PR
  via `gh`). Item templates and crafting stations are offered from `items.json` and the
  fixtures, so a recipe can only reference things that exist. Unchanged recipes keep
  their exact source text byte-for-byte, so the PR diff is minimal.
- **A thornbug grazing range south of the Drowned Strand (`d4.thornreach.*`).**
  Four new depth-4 rooms reached through a new `south` exit off `d4.lake.strand`,
  laid out as a connected loop in their own `fourth-thornreach` zone: **The Capwalk**
  (the lit, cap-strewn entrance), **The Bristle Hollow** (the rich heart of the
  browse), **The Mossed Terraces**, and **The Quiet Browse**. A peaceful, moss-lit
  range of common **thornbugs** (2–4 a room) that turns dangerous only if a delver
  draws first blood. Two new **elder thornbug** mobs roam the whole zone (`grazing`
  wander): grown vast and armoured, hitting for `3d4` with guaranteed spikes, they
  `assist` any thornbug a player attacks and `pursue` a fleeing victim up to 2 rooms
  from their lair — so striking one bug brings the elders down on you together. A
  visual-only **egg sacks** fixture clusters in the Bristle Hollow (more to come).
- **Thornbug eggs you can hatch into a pet.** A **thornbug egg** lies among the egg
  sacks in the Bristle Hollow (respawns). `use` it and the egg is consumed, hatching
  a friendly **baby thornbug** — a `player`-faction, **permanent** companion that
  trundles at your heel (the pet counterpart to the time-limited combat Summon spell,
  not a war asset). A per-owner recast cap holds you to one at a time: hatching another
  sends the first off into the dark. Built on a new `summon` **consumable** effect type
  (`{ type: "summon", mob, group }`), reusing the existing summon primitive — so the
  baby **follows you between rooms** like any owned summon. Richer pet handling (naming,
  dismissal) is to follow.
- **A condemned prospector mine — the Quiet Claim (`d2.claim.*`).** A seven-room
  working driven north off **The Prospectors' Road**, dug too greedily until the
  picks broke into older Umbral stone and the gloom-crawler nest behind it came up
  and overran the camp. The recorder's office struck the claim from the rolls and
  **barred the adit behind a locked `sealed-claim-door`** — there is no other way
  in. Deliberately harder than the rest of depth 2: the drifts are thick with
  `gloom-crawler`s (denser than the road's lone wanderers), and **two**
  **`elder-gloom-crawler`s** — deep-dwellers that climbed the breach — hold the area,
  one denned in the blind west cut (**The Far Cut**) and one in **The Crawler-Hold**
  guarding the way to the prize. The elders do not flee bright light the way the lesser
  crawlers do, so the claim stays dangerous even for a well-lit delver. The reward for pushing in is the claim's three
  `glimmer-seam`s (in **The Greedy Drift**, **The Breach**, and the crawler-free
  **Quiet Pocket**) and, hidden at the dead end (**The Dead Face**, `perception 5`),
  the dead prospector's kit — including **the Prospector's blaze-lantern**: a unique
  light that throws a searing `output 7` (the brightest in the game) but burns oil at
  `5×` a brass lantern's rate, a flare to scatter the crawlers and scorch the elder
  rather than a torch to walk by. It drinks the very `lamp-oil` the claim drops.
- **The Quiet Claim's key, won from Fenn's "Quiet Too Long" (`fenn-quiet-claim`).**
  The office key to the sealed adit is now the headline reward for confirming Marl
  Wender dead — Fenn trusts the claim to a delver who walks a dead man's ground and
  comes back honest. The quest's cash reward is trimmed (45 → 20 shards) to suit;
  the 60 XP stands.
- **Doors can now be locked with a key** via an optional `door.key` (item template)
  on a `door` fixture. A locked door refuses to `open` for anyone not carrying the
  key, and names the key in the refusal; the key is **kept, not consumed**, so the
  way stays open once unlocked. The validator checks `door.key` resolves to a real
  item. Existing doors (no `key`) are unchanged.
- **A hidden witchglow warren below the Spore Vault (`d1.spore.*`).** Four new
  depth-1 rooms reached through a concealed crack south of `d1.vault`, gated behind
  a `perception 3` search: **The Sporechoke** (the choked entrance), **The Mushroom
  Beds** (a witchglow-lit grazing chamber of stonebugs, thornbugs, and grubs), **The
  Glinting Pocket** (a side-pocket holding a shallow `glimmer-seam`), and **The
  Centipede Nest**. The nest is held by a new **centipede broodmother** mob — a
  swollen, nest-bound centipede that summons `cave-centipede` young from the wall-runs
  mid-fight (capped brood of 3), guarding the one corner of the warren the glow runs
  weakest. She drops her venom-gland as the lesser centipedes do, and — only she — a
  **warding ring** at 25% (a slim silver finger-band granting `ward 5`: ~5% magical
  damage reduction and a 5% chance to negate a hostile spell). Reuses existing fungus,
  grazers, and the `glimmer-seam` vein; the only new content is the four rooms, the
  broodmother, and the ring.
- **The Tinker's Hammer quest (`smiths-hammer`).** A **rusty hammer** lies hidden
  (`perception 6`) by the glimmer seam in The Glinting Pocket, struck with Tobin the
  tinker-smith's own maker's mark. Picking it up offers the quest; carrying it back to
  Tobin on the Craftsmen's Row (he recognises his own first hammer — the one he lost
  on the single descent that drove him to the forge for good) repairs and gifts it as
  **Tobin's hammer**: a light, fast blunt weapon (`1d6` at action cost 9 with a 5%
  crit chance), plus 50 XP. Tobin gains a delivery react line for the hand-off.
- **Weapons can now grant a flat crit chance** via an optional `weapon.crit` (0..1),
  mirroring a mob's `attack.crit` and stacking on top of the wielder's Perception
  crit; surfaced in the Inspect window. Existing weapons (no `crit`) are unchanged.

### Fixed
- **Examining a mob or item is no longer interrupted by room activity.** A reactive
  room refresh (a mob entering, someone healing, light flickering) used to snap the
  Inspect window back from an examine view to the live room, stealing the player's
  focus. Such passive refreshes are now tagged `reactive` server-side and the client
  leaves an open examine view in place — `look` or the back button still return to a
  freshly-fetched room.
- **Examining an entity that then vanishes no longer leaves a stale view.** As a
  follow-up to the focus-preserving fix above: if the thing you're examining was in
  the room and a reactive refresh shows it gone from a room you can still see (a mob
  died, a floor item was taken, another delver left), the Inspect window now drops
  back to the room. Carried/equipped items you examine are unaffected.
- **The release cutter (`tools/release.js`) no longer crashes when its target branch
  already exists.** A re-run after a failed/abandoned release used to stamp the
  version files and *then* die with a raw stack trace at `git checkout -b`, leaving a
  dirty working tree behind. It now checks for the `chore/release-x.y.z` branch up
  front — before touching any files — and fails fast with recovery guidance, or
  replaces the branch when re-run with the new `--force` flag.

### Changed
- **Items** — item tuning (prospectors-hatchet, apprentice-glimmer-charm, glimmersteel-coil, delver-claim-tag, scroll-regeneration, palecap-mushroom, witchglow-cap, deep-stew, book-of-chitin-craft).
- **Recipes** — recipe tuning (minor-light-potion, regeneration-draught, mana-tonic, acid-bomb, forge-chitin-cuirass, forge-kingshell-cuirass, forge-heavy-chitin-plate, forge-barbed-flail, forge-glimmersteel-cuirass).
- **Light is now tiered into "see" vs "repel the dark", and the two premium lamps
  carry stats.** Output drops: **brass lantern 4 → 3**, **glimmersteel lamp 5 → 4**.
  Since the whole gloom-crawler family (and the elder) only flees or takes light-burn
  above light level **3**, a cheap light (torch/brass lantern, output 3) now lets you
  *see and act* but no longer pushes those creatures back — crossing the threshold
  takes premium light (glimmersteel 4 / blaze-lantern 7), a consumable (a `light
  potion` is +3, `minor` +1, a `searing-light` flare +10), the `candlelight` spell
  (+1), or a second delver's lamp, since room light sums all sources. Creatures keyed
  at "above 2" (rats, moles, slugs, bats) are unaffected. To give the premium lamps an
  identity beyond brightness, the **glimmersteel lamp** now grants `ward 3` (the alloy
  turns aside a little spell-stuff; value 160 → 185) and the **Prospector's
  blaze-lantern** grants `perception +2` (its searing glare reveals what a dimmer light
  hides — sharper search/crit while carried). Both surface in the Inspect window.
- **The Drowned Hollow (`d2.mine.grotto`) now holds a rich glimmer vein instead of
  a loose crystal.** The single `crystal` ground item has been replaced with a
  mineable `glimmer-vein` fixture, so the deep pocket's prize is worked out of the
  seam with a pick (and respawns as a vein) rather than simply picked up off the
  ledge. Room prose updated to match.
- **Room ids are now depth-led: `d<depth>.[region.]name`.** The old prefixes were
  an inconsistent mix of theme and ordinal (`abyss.*` at depth 1, `second.*` at
  depth 2, `lake.*` at depth 4) that told you nothing reliable about where a room
  sat. All 71 rooms were renamed so the id leads with its depth (`d1.fissure`,
  `d2.mine.3`, `d4.lake.shrine`, `d7.lair`); the optional middle `region` segment
  groups named sub-areas (mine/graze, lake/umbral, fault). Room ids are pure data
  with no code references, so only the four data files that point at rooms changed
  (`rooms.json`, `fixtures.json`, `quests.json`, the player template). `zone`
  fields are untouched — they bound mob wander and are deliberately independent of
  the id. The validator now enforces that an id's `d<depth>` prefix matches the
  room's `depth` field, so a future retune can't leave an id lying about its depth.

### Removed
- **The concealed crawlway between the Spore Vault and the Echoing Fissure.**
  The two-way hidden passage (`abyss.vault` ↔ `abyss.fissure`) didn't fit the
  rooms' layout, so both halves were removed. The Spore Vault remains reachable
  from the grotto to the north.

### Fixed
- **Follow-line grammar for summons/pets.** A delver moving with an owned summon at
  heel read "Your a baby thornbug follows." — the article is now stripped, so it reads
  "Your baby thornbug follows." (also affects spell summons like "a Wisp").
- **Combat and room-effect death tests updated for paced death.** Pacing player
  death (`#121`) split the instant respawn into a `death-begin` + dying beat with
  the `death`/respawn deferred to the tick loop, but five tests still asserted the
  old immediate-death contract (an instant `death` event and same-tick respawn to
  the rim). They now assert the paced behaviour — `death-begin` on the lethal blow,
  the felled delver lying dying where they fell — so the suite passes again. No
  runtime behaviour changed; a stale `applyRoomEffect` doc comment was corrected too.
- **A delver leaving the game now darkens the room for those left behind.** On
  disconnect (a dropped tab *or* `quit`), the vacated room's light was never
  recomputed and co-located players were never refreshed or told — so if the
  departing delver carried the room's only light, the others kept seeing a lit
  room with the delver still in it until some unrelated event happened to refresh
  their view. The socket-close teardown now recomputes the room's light, announces
  the departure ("X slips away into the dark."), and refreshes the remaining
  occupants. Both paths share this teardown, so a dropped connection reads exactly
  like `quit`; the now-redundant announcement was removed from the `quit` command.

### Added
- **Depth viewer — a read-only browser inspector for the world by depth.** New
  tool `tools/depth-viewer/` (`npm run view-depths` or `start.bat`, port 3942)
  lists every depth in a sidebar and, for the selected depth, shows each room's
  description, zone, ambient light, exits (hidden exits flagged with their
  perception requirement), ground items, fixtures, and **spawns resolved to mob
  names** with population cap, respawn cadence, and hostility — plus a text
  filter. A **List / Map toggle** adds a visual floor map: rooms are laid out on
  a grid by their north/south/east/west exits (BFS from a seed, disconnected
  clusters placed side by side), with connecting lines (one-way exits arrowed,
  hidden exits dashed), up/down and off-floor exits shown as ▲▼ badges, and a
  spawn dot (red if any spawn is hostile); click a room to jump to its list
  entry. It only reads `data/world/*.json` and never writes; editing still lives
  in the mob / item / spawn editors.
- **Mining can now roll varied drops — and the first glimmer vein comes to the
  shallows.** Resource veins (`mine`/`harvest`/`fish`) gained an optional weighted
  `drops` table: instead of always yielding the same item, a fixture can list
  `{ template, qty?, weight? }` entries and roll **one** per swing — so a vein gives
  "usually ore, rarely a few shards" rather than a guaranteed drop. A currency drop
  (shards) tallies to the purse like a gathered floor pile; ore/crystals go to the
  pack. Iron and silver veins now have a ~10% chance of a small shard windfall in
  place of ore. A **new shallow glimmer vein** (*a thin glimmer seam*) yields mostly
  loose shards with a ~10% chance of a whole crystal, and replaces the iron vein in
  *The Collapsed Gallery* (`abyss.gallery`) — the first glimmer to be worked on
  Depth 1, near the Rim. The **deep `glimmer-vein`** (Depth 7, The Brood-Heart) was
  revised onto the same drops model to live up to its "a rich find" flavour: mostly
  one crystal, often two (~28% of swings), with a rare shard scatter — lifting a
  cleared 2-charge cycle from ~140 to ~170 shard-equivalent. Single `template`/`yield`
  veins keep working exactly as before; the validator enforces one of `template` or
  `drops`. See `docs/data-model.md` → *Resource drop tables*.
- **Four more glimmer seams across Depths 2–4 — bridging the crystal gap.** The thin
  glimmer seam now appears in *The Adit* (`second.mine1`, beside the iron) and *The
  Umbral Stope* (`second.mine4`) on Depth 2, *The River Stair* (`third.landing`) on
  Depth 3, and *The Failing Reliefs* (`lake.gallery`) on Depth 4 — so glimmer is no
  longer a Depth-1-trickle / Depth-7-jackpot affair with nothing between. Each room's
  description gained a line noting the seam.
- **A second rich glimmer vein — The Last Claim (`warren.relict`, Depth 7).** The dead
  prospector's chamber now holds the seam they died defending: the rich `glimmer-vein`
  is staked over the wall beside the corpse, the strike they came all this way for.
  Mining it means striking a light one room north of the Starving Dark's lair — the
  very thing the prospector's chalked warning cautions against — a sneak-and-grab
  counterpart to the Brood-Heart's swarm. (Its loose ground crystal + shards remain.)

### Changed
- **Glimmer crystal mob-drop chances lowered.** The four named bosses that dropped a
  guaranteed crystal — Gnaw, the Old Grinder, the Pale King, and the Starving Dark —
  now drop one at 0.5. The lesser crystal-droppers drop at 0.3: the pallid hunter (was
  0.6) and the elder / gloom-touched gloom-crawlers (was 0.4).
- **The Riven Yard and the deep fault — a hidden shortcut down.** A new Rim room,
  *The Riven Yard* (`rim.fault`, north of the Stockpens), where the boomtown's made
  ground gives out at a bare shelf of split rock. A long crack in the floor breathes
  a cold draft up from far below; spotting that it's actually passable is a steep
  `perception: 8` hidden `down` exit — an expert-only shortcut for higher-level
  delvers. It drops to *The Fault's Foot* (`fault.deep`, depth 5, `ambientLight: -1`
  void), a quiet transition chamber on the deep way down: not a fight, just a lone
  `cave-lurker` (slow respawn) so resting here never feels fully safe. The fault
  foreshadows a further descent — a `down` exit to floor 9 will be wired when that
  floor exists.
- **The feral mongrel now spawns.** The authored `feral-mongrel` (a surface dog gone
  wild, an Outsider of the shallows) had no placement; it now hunts the rat-warren of
  *The Collapsed Gallery* (`abyss.gallery`, `max: 1`, `respawn: 240`) alongside the
  giant rats it preys on.
- **Void light band — deep-dark rooms.** Rooms may now author a *negative*
  `ambientLight`; when the effective light falls below zero the room reads as the
  new `void` band — a distinct deep-dark client treatment (a breathing black
  vignette that swells inward, a faint shiver on the room text, and a `⚠ blind`
  meter) that ordinary light can't beat. A delver must carry enough light just to
  claw back to a visible level. `warren.throat` ("Where the Dark Goes Bad") is the
  first such room (`ambientLight: -1`), composing with its existing creeping-dark
  drain. The reduced-motion fallback is a static heavy vignette.
- **`@teleport <roomId>` admin command.** A dev affordance to jump straight to any
  room by id (e.g. reaching deep abyss rooms for testing) without walking the whole
  descent. Seats the player, recomputes light, and refreshes bystanders — no
  exploration xp, quest triggers, or summon-follow.
- **`quit` / `logout` command.** A discoverable way to leave the game. There was
  never any danger in just closing the tab — the account already saves on
  disconnect and periodically — but nothing told players that. `quit` (aliases
  `logout` / `logoff`) prints a farewell that says so explicitly, tells the room
  the delver has slipped away, and closes the connection without the client
  auto-reconnecting. (`q`/`qu` still abbreviate to `quaff`; quitting needs `qui`+.)
- **Room effects** — rooms can act on players on enter or each tick: a light-condition
  gate plus a `douse` / `restore` / `damage` action, authored as `effects` in
  `rooms.json`. Seeded on the Plunge Cave (spray douses your flame), the Lantern's Rest
  (the hearth mends you), and Where the Dark Goes Bad (the dark drains you unless lit).
- **Item editor.** A browser-based form for editing `data/world/items.json`,
  mirroring the mob editor (`npm run edit-items` or `tools/item-editor/start.bat`,
  port 3941). Edit each item's common fields (name, description, type, slot,
  rarity, weight, value, sellValue, stackable, keywords) with a raw-JSON escape
  hatch for the type-specific blocks (light, weapon, armour, consumable, scroll,
  …). "Validate & preview" writes, runs the validator, shows the `git diff`, then
  restores the tree; "Create pull request" branches, commits, pushes, and opens a
  PR via `gh`. Source-preserving splice keeps the diff to only the items you
  touched.
- **Predators that hunt you down.** A mob marked `pursues` no longer loses you at
  the room line. Once you've traded blows and fled, it **follows** — stepping one
  room per action along the shortest path toward wherever you now stand
  ("...stalks off, hunting"), until it catches you, you die, you log out, or you
  outrun its **leash** (`pursueRange` rooms from its lair, default 4). Give it the
  slip for good and the stray hunter slinks back home. (DikuMUD-style `hunt_victim`,
  built on the `remembers` grudge from the previous release.) Pursuers, by leash:
  the **pallid hunter** and the **feral mongrel** run you down across the shallows
  (4 rooms); the **elder** and **gloom-touched crawlers** drag themselves after you
  through the warren (3); **Yana** and the **Starving Dark** stalk warmth a room or
  two out of the deep before the light turns them back (2); and the **Pale King**
  lunges only to the water's edge to haul a fleeing delver back, never leaving his
  lake (1). The deep's set-piece dread no longer ends at the doorway.
- **Mobs that remember you.** A mob marked `remembers` no longer forgets a delver
  the instant they leave the room. Once it has traded blows with you, it holds a
  grudge: step out and back within ~1 minute and it **re-engages on sight** ("it
  remembers you, and its old hate rekindles") instead of having to notice you
  afresh. The grudge doesn't pin it in combat — between encounters it wanders and
  mends as normal — and it lapses on the timer, or the moment you die or log out.
  **Mallki's chitin warden** is the first to bear one: pick a fight with the
  trader's guardian and slipping next door won't wipe the slate. (DikuMUD-style mob
  memory; cross-room *pursuit* is a planned follow-up.)
- **Your own summons read friendly.** Mobs you own (faction `player`, owned by
  you — e.g. an `@spawn …​ player` test summon, and future pet summons) now show
  as a blue **ally** pill in the room/inspect view instead of the enemy-red
  `hostile` tint. The friendly tint takes precedence over `hostile`, so a combat
  pet built on an otherwise-hostile template still reads as yours; other players'
  summons and every non-owned mob are unaffected.
- **Filter `list` and `recipes` by a word.** Both commands now take an optional
  search term: `list glimmer` shows only the trader's wares whose name matches
  "glimmer". `recipes <word>` matches a recipe's name, its output item, **or any
  input material** — so `recipes glimmer` finds glimmer craft and `recipes chitin`
  answers "what can I make with chitin?". Matching is case-insensitive substring,
  the same way `buy` resolves a ware; an empty result says so plainly. The bare
  `list` / `recipes` behave exactly as before.
- **Factions: guards that defend you.** Mobs now belong to one of five sides —
  `player` (PCs + summons), `rim` (village NPCs & guards), `fauna` (peaceful
  wildlife), `umbral` (the deep-dwelling Umbrals — Mallki the trader and kin), and
  `wild` (the deep's predators, the default) — related by a symmetric
  ally/enemy/neutral table instead of the old "any different faction is an enemy"
  binary. A `helper` mob now joins a fight an **ally** is in *or* steps
  in when an enemy is attacking an ally who hasn't fought back. **Hale the
  watchman** is now `rim`, carries a cudgel (`1d6`), and piles in to defend a
  delver (or a fellow Rim NPC) the moment a predator attacks on his beat — no
  more decorative guard. Village NPCs are tagged `rim`, peaceful creatures
  (stonebugs, grubs, lightbugs, salamanders, moles, cave-fish, the Old Grinder)
  `fauna`, and **Mallki the qhatuq** `umbral` — the seed of the coming Umbral
  content. `umbral` is enemy to `player` so future hostile Umbrals engage on
  sight, while a peaceful one like the trader is simply non-hostile (and an Umbral
  guard would defend its kin from anyone who strikes them). `fauna` are enemy to
  `player` but `hostile: false`: they never start a fight or get hunted, yet they
  still fight back when farmed (a struck Old Grinder keeps its teeth), and hunting
  them never pulls a guard onto you. `fauna`↔`wild` is neutral for now (predators
  don't yet prey on livestock) — a one-cell flip away from switching that
  ecosystem on. The admin `@spawn` testing aid takes the new
  factions (`@spawn <mob> [n] [wild|player|rim|fauna|umbral]`). The faction
  whitelist now lives once in `server/config.js` (shared by the game and the data
  validator), the default faction is a single named constant, and the
  ally/enemy/neutral table is asserted symmetric at load — a one-sided edit fails
  fast instead of causing one-way aggression.
- **Room tags gate where mobs roam.** Rooms may carry free-form terrain `tags`
  (e.g. `"water"`) that cut across zones, and a `wander`/`flee` action may filter
  its destinations by them: `requireTags` enters only rooms carrying **all** the
  listed tags, `forbidTags` shuns any room carrying one. Untagged rooms are the
  neutral default — excluded by `requireTags`, allowed by `forbidTags` — so a
  tagless world and every existing mob roam exactly as before; tags only constrain
  mobs that ask for them. First use: the dozen river/lake/sump rooms across depths
  2–4 are tagged `"water"`, and the **blind cave-fish** now drifts between them on a
  low-weight water-only wander, so calm fish swim the shallows but never flop onto
  dry stone. Reusable groundwork for patrol/biome behaviour to come.
- **Mallki stocks lamp oil.** The depth-3 umbral trader (Mallki the qhatuq) now
  sells `lamp-oil`, so delvers can refuel deep without the long climb back to the Rim.
- **Mallki has a guardian — and teeth of his own.** A new **chitin warden**
  (`umbral`, `helper: true`) — a low, plated arthropod Mallki keeps on a gut-line —
  now walks his three-room hollow and piles into any fight against the trader, the
  first live test of an Umbral guard defending its kin. Rob the trader and you
  answer to the warden; it ignores the stonebugs and grubs sharing the zone
  (`fauna` is neutral to `umbral`). Mallki himself is no longer a free kill: he
  fights back with a slow glimmer-touched strike (`1d6`), is sturdier (`44` HP,
  `armour 2`/`ward 2`), and drops only a trader's odds and ends (`2d6` shards, a
  chance at lamp-oil or a palecap) — never his rare wares, so killing him stays a
  net loss. The warden is confined to the `third-umbral` zone by its zone-scoped
  wander, so it never strays up the river.
- **Inventory filter bar.** Five switchable tabs (All / Gear / Use / Mats / Other)
  appear above the inventory list in the player panel. Each tab shows a live count
  badge; empty tabs are dimmed. The active filter persists in `localStorage` across
  page refreshes. Filtering is purely client-side — the server sends the full
  inventory as usual.
- **`filterGroup` item field.** Optional override on item records that controls
  which filter tab the item appears under, independent of its mechanical `type`.
  `lamp-oil` and `bug-tallow` are tagged `consumable` (fuel you use up);
  `delver-claim-tag` is tagged `other` (story item, not a crafting material).
  New item types fall through to the client-side `type → group` mapping and land
  in Other if unrecognised.
- **Watchman keeps to his beat.** Hale the watchman's wander now carries
  `requireTags: ["patrol"]`, and the six public rooms that make up his round —
  `rim.plaza`, `rim.inn`, `rim.market`, `rim.claims`, `rim.workshop`, and
  `rim.gate` — are tagged `"patrol"`. He no longer drifts into the farm sheds,
  the mage's shed, or out to the lip of the descent shaft; he walks the lanes
  he's paid to be seen on. (The two cellars were already beyond his reach.)
- **Grazing mobs confined to grazing rooms.** Stonebugs and thornbugs gain a
  low-weight wander action (`requireTags: ["grazing"]`); the Old Grinder's
  existing wander is similarly gated. Seven rooms across depths 0–3 are tagged
  `"grazing"`: `rim.corral`, `abyss.drift`, `second.graze1–4`, and
  `third.grazing`. Bugs now drift between their feeding grounds and stay put
  rather than wandering into mine tunnels or unrelated corridors.
- **Room tags gate where mobs roam.** Rooms may carry free-form terrain `tags`
  (e.g. `"water"`) that cut across zones, and a `wander`/`flee` action may filter
  its destinations by them: `requireTags` enters only rooms carrying **all** the
  listed tags, `forbidTags` shuns any room carrying one. Untagged rooms are the
  neutral default — excluded by `requireTags`, allowed by `forbidTags` — so a
  tagless world and every existing mob roam exactly as before; tags only constrain
  mobs that ask for them. First use: the dozen river/lake/sump rooms across depths
  2–4 are tagged `"water"`, and the **blind cave-fish** now drifts between them on a
  low-weight water-only wander, so calm fish swim the shallows but never flop onto
  dry stone. Reusable groundwork for patrol/biome behaviour to come.
- **Gloom-creepers — the warren's moving dark.** A new depth-7 mob
  (`gloom-creeper`): a lone gloom-crawler that has left the chamber swarms to range
  the warren tunnels, with a zone-`wander` action so it drifts room to room. Same
  stats as a base gloom-crawler (it *is* one, just nomadic) — goaded to fury by faint
  light, scorched into flight by a bright one. Two roam from **The Crawling Hall**.
  Unlike the room-bound swarms, these wander into corridors, so the dark itself feels
  like it moves. Distinct template from `gloom-crawler`, so the cull quest does not
  count them.
- **Mobs recover out of combat — no more flee-heal-return.** A wounded mob that
  nothing is fighting or watching, in a room clear of living delvers, now knits its
  wounds shut. It must stay out of combat for a short grace (`OOC_REGEN_DELAY`, 5
  ticks) so darting out and back barely helps, then mends to full over ~20 ticks
  (`ceil(maxHp/20)` HP/tick by default). A genuine heal-trip to town now finds the
  mob whole again instead of still at the sliver you left it. Reuses the existing
  `mob-regen` narration ("*its wounds close over*"). New optional per-mob
  `regen: { delay, perTick }` field overrides either knob (e.g. a slow-mending boss).
- **Gloom-touched crawlers — the warren's first magical threat.** A new depth-7
  mob (`gloom-touched-crawler`), a gloom-crawler mutated by lingering too long
  against the Starving Dark, now flings a **Gloom Bolt** — magical damage scaled
  by Intellect and resisted by **Ward** (both the wholesale cast-negation roll and
  the percentage damage cut). Gives Ward real work at depth and seeds magical enemy
  attacks for the deeper tiers. They replace the elder gloom-crawler in **The Long
  Gallery** and **The Brood-Heart**, the two warren rooms nearest the Drowned Black;
  the elders still hold the upper warren.
- **Glimmersteel armour.** Two new rare pieces forged from glimmersteel bars at the
  smithing station: a **glimmersteel cuirass** (`armour 3, ward 1`, 3 bars) and a
  **glimmersteel helm** (`armour 2, ward 1`, 2 bars). Their niche is protection
  *without* the senses-dulling `wits` penalty every iron/chitin plate carries — the
  captive light keeps a delver's ear for the dark sharp. Sits between the chitin and
  dense-chitin tiers as the best-balanced gear, distinct from the unique kingshell
  caster shell.
- **Glimmersteel warhammer.** A rare two-hander forged from 3 glimmersteel bars —
  `1d12` damage at `actionCost 16` (vs the sword's `1d8`/12) with the same Might
  scaling and `+1 Might`. Slower but far harder per blow: fewer big hits beat many
  small ones against armoured foes, where the sword stays better against fast,
  evasive targets — two distinct glimmersteel playstyles.
- **The Book of Glimmersteel.** A rare tome sold by **Tobin** that teaches his whole
  glimmersteel gear-line at once — the sword, warhammer, cuirass, and helm. Replaces
  the separate glimmersteel-sword schematic.
- **The Pale King's armour is now Mallki's to teach.** Looting a **kingshell plate**
  from the Pale King auto-offers a quest, *The King's Shell*, to carry it to
  **Mallki** — who returns the plate and grants the **kingshell method**
  (`schematic-kingshell-cuirass`), the recipe for the kingshell cuirass. Mirrors the
  shadow-heart chain: a deep boss trophy delivered to the Umbral smith unlocks the
  gear it makes.
- **Shadow-craft: the Starving Dark's heart, and a blade that drinks life.** The
  Starving Dark now drops a **shadow-heart** (a craftable material). Looting one
  auto-offers a quest, *The Heart of the Dark*, to carry it to **Mallki** (the Umbral
  trader — the deep-folk understand the shadows). He studies it, **returns it**, and
  grants the **Book of Shadow-Binding**, a `study`-able tome that teaches an
  expandable set of shadow-craft recipes (seeded with one). Mallki's Hollow gains an
  **Umbral glimmer-hearth** — a `smithing` station deep down. The first recipe forges
  **a hungering dagger**: fast and low base damage, but it **steals life** — every
  landed hit heals the wielder (2 hp). A new reusable combat primitive backs it: an
  attacker's `onHit` entry marked `target: "self"` lands on the *attacker* (life-
  steal), mirroring the defender's `onDamage` target axis — data-attachable to any
  future weapon or life-draining mob.
- **A hidden vertical shortcut between depth 3 and depth 7.** The Plunge Cave
  (`third.cave`, depth 3) and the Gloom-Warren's *Black Chimney* (`warren.chasm`,
  depth 7) are linked by a concealed flue worn by the river's overspill — a steep
  shortcut between the two tiers. Hidden from **both** sides: the bottom end (a
  flowstone fissure in the chimney's west wall) is hinted by a warm, wet draught and
  found by `search` at **perception 4** — the search turns up **old prospectors'
  climbing-rigging** (a new `prospectors-rigging` fixture: pitons and a knotted line),
  marking the flue as a Rush-era shortcut rigged before the warren went bad, and a
  fast way back up for a delver deep below; the top end (a drowned crack under the
  plunge-pool, whose water never overflows) is unhinted and gated at **perception 8**,
  so only a sharp-eyed delver finds the way down from above. Reuses the existing
  hidden-exit/search mechanic; no code changes.
- **The Gloom-Warren (depth 7) — the first hard tier below the lake.** The low,
  unstaked passage south of *The Forward Camp* (`deep.camp`) is now traversable and
  opens into a ten-room, fully-dark warren of big caves crawling with gloom-crawlers.
  A spine of great caverns — *Where the Dark Goes Bad* (the threshold), *The
  Crawling Hall* (the hub), *The Long Gallery*, *The Black Chimney* (a natural flue
  that plunges on past reach — the hook for a deeper tier to come), *The Hush* (a
  worked-stone chamber where an old **Umbral ward-glyph** reads *turn back* and the
  crawlers will not cross), *The Last Claim* (the furthest prospector who ever got
  this deep, dead at the wall with a warning chalked beside them), and *The Drowned
  Black* (the lair) — with three branches off it: *The Moulting Drift* (husk dunes +
  an unworked glimmer seam), *The Bone Field* (a feeding ground of bone worked by
  **scour-slugs**, hiding a search-gated prospector cache), and *The Brood-Heart*
  (the densest swarm in the warren). Difficulty is a clear step above the deep lake:
  the swarm itself is the threat — many weak crawlers in a dark you can barely see
  in — anchored by **elder gloom-crawlers** (elite: ~40 hp, armoured, a festering
  *gloom-rot* bite, too old to flinch from a torch) and a boss, **the Starving
  Dark**. The warren also carries its own resource nodes: an **iron vein** (The
  Long Gallery), a **silver vein** (The Black Chimney), and a **mineable glimmer
  crystal** won at the swarm's heart (The Brood-Heart, via a new `glimmer-vein`
  fixture), plus a forage pocket in The Hush — a lightless cave-fungus patch (new
  `gloom-fungus` fixture, sheds no light) with a few grubs feeding on it.
- **The Starving Dark — a living shadow, the first of its kind a delver meets.** A
  light-vulnerable boss (`lightBane` from *any* light) that fights to take your
  light away: it **snuffs** your carried flame and **drinks the room to black**,
  then closes in the dark of its own making (it sees in the black where you flail).
  Bright light is the weapon that unmakes it — a true tug-of-war over the dark. It
  answers the question the empty camp asks. The reusable shadow kit below is built
  so it won't be the last of its kind.
- **Two reusable darkness mob-abilities** (data-attachable, for the shadow family to
  come): a `douse` spell effect that snuffs a target's equipped light (new `Snuff`
  spell), and **darkness auras** via an `emit-light` effect authored with a
  *negative* magnitude — it subtracts from room light rather than adding (new
  `Drink the Light` spell, cast on self). `computeRoomLight` already summed source
  outputs; the self-cast path now preserves a negative magnitude instead of flooring
  it at zero.
- **Quest-gated shop stock.** A trader's `shop.sells` offer may carry a
  `requiresQuest` id; the item stays hidden from `list` and unbuyable until the
  player has finished that quest (it sits in `quests.done`). Lets vendors reveal
  new wares as a reward for completed work. Data-driven — no new command.

### Changed
- **Server output hot-path performance (`server/index.js`, `server/accounts.js`).**
  Three changes that cut redundant work as rooms get busy, with no behaviour or
  message-text change:
  - **Per-tick view coalescing.** Room/vitals views are idempotent snapshots, but
    a single tick often fires several events in one room — each previously rebuilt
    and resent every onlooker's full view. Reactive refreshes now mark a view
    dirty and `flushViews` rebuilds each dirty view once, after the dispatch burst
    (flushed at the tick, command, and disconnect entry points). A room of 4 mobs
    fleeing/re-entering the light dropped from ~13+ room-view sends to ~5 (≈1/tick).
  - **Serialize broadcasts once.** `send` stringified per recipient; `roomCtx.toRoom`
    now serializes its identical message once and reuses the frame, and
    `broadcastRoom` memoizes frames by line text (light-gating yields ~2 distinct
    lines), instead of once per onlooker.
  - **Non-blocking account saves.** `accounts.save` was synchronous `mkdirSync` +
    `writeFileSync` looped over every player inside the tick loop. The dir is now
    ensured once; the periodic snapshot and disconnect paths use a new `saveAsync`
    that writes off the event loop and skips players whose data is unchanged.
    Account creation and the shutdown flush stay synchronous.
- **`server/index.js` event dispatch made table-driven.** The ~510-line
  `dispatchEvent` if-chain (one `if (ev.type === …) { … return; }` per event) is
  replaced by an `EVENT_HANDLERS` lookup table (event type → handler), mirroring
  the `commands.js` refactor — O(1) dispatch on the tick hot path instead of a
  linear scan. The three patterns that recurred across nearly every handler are
  pulled into shared helpers: `mobNameFor` (light-gated mob name per observer),
  `withPlayer` (get-the-live-player-or-bail guard), `refreshViews` (room + vitals
  panels), and `broadcastRoom` (narrate one line to everyone present, optionally
  refreshing each room view). Per-event flavour maps (`HURT_SRC`,
  `MOB_HURT_FLAVOUR`, `MOB_DEATH_VERB`, …) are hoisted to module scope instead of
  being rebuilt each call. Pure refactor — no behaviour or message-text change.
- **`server/commands.js` split into a `commands/` folder and made table-driven.**
  The 2019-line monolith is now an ~830-line core (dispatcher + movement, posture,
  items, fixtures, social, combat) plus focused modules under `server/commands/`:
  `shared` (targeting/inventory/view helpers), `help`, `trade`, `craft`,
  `resource`, `magic`, and `admin`. The hand-maintained dispatch `switch` is
  replaced by a `COMMANDS` table (verb → handler), with a load-time check that
  every abbreviation/alias has a handler — retiring the "keep VERBS in sync with
  the switch" hazard. `mine`/`gather`/`fish` collapse into one `workResource`
  worker driven by a per-kind flavour spec, and repeated narration/targeting
  snippets (`restoreGain`, `roomHostiles`, `stickToSurvivor`, `findFixture`,
  `TRAINABLE`) are deduplicated into `shared`. Pure reorganization — no behaviour,
  wording, or data changes; all 42 tests and `validate` still pass.
- **Room-graph pathfinding extracted to a pure, tested module.** The two BFS walks
  that drove mob cross-room pursuit (`_bfsNextDir`/`_bfsDist` in `state-mobai.js`)
  are now pure functions in `server/pathfinding.js` — `bfsNextDir(rooms, from, to)`
  and `bfsDist(rooms, from, to)` — taking the room map explicitly rather than reading
  `this`. `_pursue` calls them directly; the instance-method wrappers are gone. Adds
  `test/pathfinding.test.js` (directedness, unreachable targets, missing-exit
  tolerance). Pure relocation, no behaviour change.
- **Mob hostile actions (melee + cast) unified behind one pipeline — and a death
  bug fixed.** `_mobAttack` and `_mobCast` were parallel implementations of the
  same concept (a mob acts against its top-threat enemy) that had drifted. They now
  share `_mobHostileAction` — target selection, aggro, and a single correct
  rouse/auto-retaliate tail — and delegate to payload resolvers
  (`_resolveMeleePayload` / `_resolveSpellPayload`); the public `_mobAttack`/`_mobCast`
  become thin entry points. **Two player-facing fixes fall out of the shared gate:**
  (1) a mob's *killing* melee blow no longer makes the freshly-respawned delver
  "auto-attack" their killer (the old `hp > 0` guard was a no-op after `_respawn`
  restores HP); (2) when a delver's reflect (`spikes`/`onDamage`) kills the attacker
  mid-blow, the delver still wakes but no longer retaliates against the corpse —
  matching the spell and player-attack paths. No combat-math change (ward/armour,
  onHit untouched); adds `test/mob-combat.test.js`.
- **Mob AI carved out of `state.js` into a mixin.** The mob-AI subsystem — decision
  loop (`resolveMobAI`/`_mobAct`), faction targeting, the threat/detection/grudge
  model, cross-room pursuit + BFS pathing, and the mob-side combat actions
  (attack/cast/summon/move) and kill resolution — now lives in `server/state-mobai.js`
  (~37 methods). `state.js` copies its prototype methods onto `GameState.prototype`
  via a small `mixin()` helper, so they remain ordinary `GameState` methods at
  runtime. The aggro/grudge/pursuit/emote tuning constants moved with them. Pure
  relocation, no behaviour change; `state.js` drops to ~1440 lines. Second of the
  staged split (after the pure-helper extraction).
- **`state.js` slimmed by extracting its pure helpers.** The stateless math and
  lookup helpers that opened `server/state.js` now live in focused modules —
  `combat-math.js` (attribute/defence math, scaling, `strike`, weighted picks),
  `factions.js` (the relation table + readers), `economy.js` (buy/sell values),
  `instances.js` (entity-id source + item/mob factories), and `perception.js`
  (sight, light-emission, hidden-feature visibility). `state.js` re-imports and
  re-exports them, so the module's public surface is unchanged; this is a pure
  refactor with no behaviour change (~400 lines lighter). First of a staged split
  to keep per-feature context smaller.
- **Mob-stat editor surfaces the behaviour fields.** `tools/mob-editor/` now has a
  dedicated **Behaviour & AI** section: `behavior` and `posture` are dropdowns, and
  `faction`, `hostile`, `helper` (assist), `ambush`, `remembers`, `pursues`,
  `pursueRange`, and `pursueVerb` are proper form fields instead of hand-edited raw
  JSON. The wander action's own knobs (verb/scope/tags) still live in the raw-JSON
  block, with a pointer to them.
- **Light-maddened mobs strike indiscriminately.** A creature roused by light
  (`lightAggro`) now treats *every* delver in the room as a valid target, not just
  one it had already noticed — a single spotted target no longer shields the rest
  from a light-enraged beast.
- **Mob targeting is now tiered, not additive.** A mob always fixates on whatever
  it has actually traded blows with over anyone it has merely noticed, regardless
  of how long it has been watching — so its quarry no longer depends on the exact
  size of the detection cap. No change to current behaviour; it removes a latent
  trap where retuning the detection threshold could silently flip target priority.
- **Spawn rules** — Mob respawn rate review (rim.inn, rim.market, rim.claims, rim.corral, rim.mageshed, rim.training, rim.workshop, abyss.first, abyss.gallery, abyss.warren, abyss.drift, abyss.fissure, abyss.roost, abyss.tunnel, abyss.grotto, abyss.hollow, abyss.cut, abyss.den, second.descent, second.graze1, second.graze3, second.graze4, second.mine1, second.mine2, second.mine4, second.mine5, third.shallows, third.pools, third.cave, third.dwelling, third.grazing, lake.shallows, lake.islet, warren.throat, warren.hall, warren.drift, warren.midden, warren.gallery, warren.brood, warren.chasm, warren.relict, warren.lair).
- **NPC stats** — Minor mobs update (cave-lurker, stonebug, thornbug, yana).
- **Depth-7 is deadlier in the light.** Doubled the warren's no-flee elites — the
  **elder gloom-crawler** in The Crawling Hall and The Moulting Drift, and the
  **gloom-touched crawler** in The Long Gallery and The Brood-Heart, all go from
  `max 1` to `max 2`. Where base gloom-crawlers scatter from a delver's lamp, these
  stand and fight — so a lit player no longer empties the room, and the dark becomes
  a death trap as the swarms and the elites pile on together.
- **Combat tuning.** **The Old Grinder** is sturdier and hits harder — `maxHp`
  60→90, `armour` 5→6, melee `1d6`→`2d4`. The **pale crayfish** is tougher too —
  `maxHp` 11→17, melee `1d4`→`1d6`. **The Pale Shallows** now spawns up to two
  cave-lurkers (was one). **Yana, the lost apprentice** is reworked from a pushover
  into a real mini-boss: `maxHp` 30→70, `armour` 2→3, `ward` 2→4, melee `1d6`→`1d8`,
  and her action table leans harder into Glimmer Spike (fewer idle/emote turns).
  Crucially her light thresholds moved from 2 to **5/6**: a single carried lamp no
  longer sears her or wrecks her aim, so she fights at full strength solo — a player
  must burn a **searing flare** (light 10) for a timed glare-and-burn window, while
  any two delvers stacking light clear the threshold together. Her `lightBane` was
  also softened to `1d2` so two-player light pressures the fight without instakilling
  her.
- **Skittish prey — grubs and cave-fish behave like animals, not pickups.** A new
  data-driven `skittish` mob flag lets a calm critter *bolt out of the world* (it
  slips out of sight rather than fleeing room-to-room, freeing its spawn slot to
  repop on the normal timer). It bolts readily once alarmed — and because grubs and
  blind cave-fish are now `helper` mobs with no `attack`, striking one spooks the
  whole cluster into scattering instead of fighting, so a delver must be quick to
  catch more than the one they hit. A faint *ambient* bolt chance while a delver is
  watching makes a populated fungus bed or pool visibly breathe (the count drifts
  under its cap as critters slip away and respawn). Both gained rare reactive
  emotes. Harvest yield is unchanged — they still drop bait/meat when caught.
  Each grub bed's spawn cap is raised by one (the three grub rooms now hold 3, 3,
  and 4) so the new flee/respawn flux leaves enough on the beds to gather.

### Added
- **A second witchglow source — Behind the Paqcha.** The hidden Umbral shrine behind
  the falls (`lake.shrine`, depth 4) now grows a **witchglow-cluster** in its lamp-lit,
  spray-damp niche, plus a respawning loose `witchglow-cap`. Gated behind the shrine's
  perception-4 hidden ledge, it gives lake-tier delvers a witchglow source without
  backtracking to the depth-1 Spore Vault, while staying scarce.
- **Mallki sells witchglow caps.** The Umbral trader now stocks `witchglow-cap`
  (price 12) — a paid, controlled source fitting a deep-folk who knows the wild
  witchglow of the tunnels, without putting a free farm in his safe hub garden.

### Changed
- **Two mushroom-cluster fixtures instead of three.** The `glow-caps` and
  `gloom-fungus` fixtures both yielded the same `palecap-mushroom` under different
  names — confusing. They're merged into a single **`pale-cluster`** ("a cluster of
  pale mushrooms", still emits a faint light) used across the abyss/grazing rooms,
  leaving a clean two-type split: the pale cluster (→ palecap) and the glowing
  `witchglow-cluster` (→ witchglow-cap). The merged cluster is **removed from The
  Hush** (depth 7) to keep the Gloom-Warren dark — that room keeps its lightless
  scenery fungus and grubs, but no longer offers a palecap harvest node.
- **Glimmersteel gear is gated through Tobin.** The glimmersteel sword recipe is no
  longer a standalone schematic — it's folded into the new Book of Glimmersteel (with
  the warhammer, cuirass, and helm). The bar recipe (`schematic-glimmersteel-bar`)
  remains the separate gating prerequisite Tobin sells, and the lamp, coil, and staff
  schematics are unchanged (staff still Vesper's).
- **Ambient NPC emotes are half as frequent.** A global `EMOTE_WEIGHT_SCALE`
  (0.5) thins idle mob chatter to cut console spam, applied to `emote` actions
  before the per-tick action roll. Targeted `react` actions are exempt — they
  already carry a per-player cooldown and can deliver quest nudges.
- The kingshell-cuirass method is no longer **sold** by Mallki — it's earned through
  *The King's Shell* quest (above), so the Pale King's drop is the path to his armour.
- The **hungering dagger** now forges from a **silver bar** (was iron) + a
  shadow-heart — tying it to the silver vein in the warren's own Black Chimney.

### Fixed
- **Blind cave-fish now leave a catch when killed.** The swimming `blind-cave-fish`
  mob dropped nothing on death, so a delver who speared one by hand got nothing —
  surprising next to the fishing spots that hand over a `cave-fish`. It now drops a
  blind cave-fish (the same item the line yields).

### Added
- **The descent below the lake.** The half-built line at The Far Bank
  (`lake.farshore`) is now made fast and runs `down` into two new rooms forming the
  long descent toward the deep: *The Gullet* (depth 5) — a dark, wet switchback
  following the lake's outflow — and *The Forward Camp* (depth 6), an abandoned
  prospectors' camp that serves as a rest/refit haven before the hard areas begin.
  The camp gains four fixtures: a `camp-lamp` (oil lamp, **off by default**, lights
  the dark camp when switched on), a `camp-firepit` (cooking station), a `camp-bench`
  (alchemy station), and a `camp-seep` (water basin restoring a little hp/mana). A
  low unstaked passage runs on south from the camp — described but not yet
  traversable — left as the hook for the deep beyond. All data-only.
- **The notice board is up.** Fenn's Claims Office gains a `notice-board` fixture;
  `use board` reads the postings and picks up the posted work. Three **repeatable**
  board quests: *Bounty: Crawlers on the Descent* (cull 4 gloom-crawlers),
  *Proof of Venom* (cull 3 cave-centipedes and lay a venom gland on Fenn's
  counter — the only posting settled at the office itself), and *Standing Order:
  Tallow* (bring 3 lumps of bug-tallow to Garrick, closing the stonebug → lamp-oil
  loop). Fenn and Garrick gain `delivery` reactions so they call you over when you
  owe them a hand-in. All data-only — the quest engine already supported
  `use`-trigger starts and `repeatable`.
- **Wick's first quest.** *Wings over the Hatchery* (`talk wick`): cave-bats are
  picking her lightbugs off the wire — cull 4 in the roosts below. Pays shards and
  two minor light potions (her own stock's making).
- **Wick's stall stocks up.** Alongside bug-meat she now sells dead grubs (bait for
  the deep pools, finally buyable topside), minor light potions, and luminescent
  glands — all products of her own sheds. Bug-tallow deliberately *not* stocked: it
  would arbitrage straight into the new tallow standing order.
- **Fenn's story quest.** *Quiet Too Long* (`talk fenn`): a fourth-level seam is
  registered to one Marl Wender, three seasons quiet — find his claim-tag where the
  deep left him (the Pale King's bone-littered islet, completing the dead-delver
  cache already hidden there) and lay it on the counter so Fenn can cross the name
  out. New `delver-claim-tag` item; the office's **chained ledger** is now an
  examinable fixture (Wender's entry underlined twice), and Fenn gained a react
  line for delvers wearing unregistered glimmersteel.
- **Two new Rim figures.** **Fenn the claims-recorder** keeps the new **Claims
  Office** (`rim.claims`, a plank-and-canvas annex south of the market) — a
  self-appointed clerk whose chained ledger names every claimed seam below; his
  bare notice board is the planned anchor for posted bounty/contract quests.
  **Hale the watchman** — an ex-sellsword paid by the traders to be seen —
  patrols the whole village (the first *wandering* social NPC), reacting to
  delvers wherever his round takes him. Both carry full `react` sets; lore.md's
  Rim roster updated. Peacekeeping behaviour and claims/bounty quests are
  planned follow-ups.
- **NPCs notice you.** A new data-driven **`react` mob action** lets an NPC single
  out one player in the room and address them directly — nudge a quest delivery
  they owe (`delivery`), fuss over their wounds (`hpBelow`), comment on their gear
  (`slotEmpty` / `equipped`), or just make small talk (unconditional fallback).
  Reactions are authored in priority order with `{target, room}` message pairs
  (the target reads second person, bystanders read third person with the player's
  name), and a per-player cooldown rotates the NPC's attention between players.
  All Rim traders use it — **Maeve** (the PoC), **Garrick** (gruff upsells),
  **Tobin** (scattered tinker-talk), **Vesper** (cool appraisals; delivery nudges
  for her two quests), and **Mallki** (slow Umbral courtesy; flinches from carried
  lanterns/torches), plus **Wick** (soft-spoken bug-keeper fuss) — and any NPC can gain reactions with a pure `mobs.json`
  edit. Validator checks the shape; data model documents it.
  `talk <npc>` uses the same reactions: when an NPC has no quest business for you,
  they now answer in character (first reaction matching you, always — though it
  arms the tick cooldown) instead of the generic "has nothing for you right now"
  (NPCs without reactions keep the shrug). A finished non-repeatable quest no
  longer announces "You have already completed …" on talk — the NPC just chats
  (the quest log still lists it). Authoring guide: templates-quickref "NPC
  reactions".
- **Quests — goals that string the world's systems together.** A new data-driven
  quest system (`data/world/quests.json` + `server/quests.js`): a quest is acquired
  by **talking to an NPC**, **using a fixture**, **acquiring an item**, or **entering
  a location** for the first time, then worked through as **ordered steps** — *kill N
  monsters*, *deliver N items to an NPC*, *use a fixture*, or *collect N of an item* —
  and pays out **XP, shards, items, and recipes/spells** on completion. New commands:
  **`talk <npc>`** (take quests, hear what they need), **`give <item> <npc>`** (hand
  over delivery goods), and **`quest`/`journal`** (the console quest log, split *In
  progress* / *Finished*). Quests are one-time by default (`repeatable: true` opts
  back in) and persist with the character. Three starter quests ship: *Thin the Warrens*
  (talk to Maeve — cull rats, bring meat for the pot), *Caps for the Mage* (entering
  Vesper's shed — gather palecap mushrooms and bring them back), and *A Shard of Light*
  (picking up a glimmer crystal — return it to Vesper). Validator now checks quest data;
  data model documents the schema.
- **Glowing mushroom clusters can be picked — and every fixture now tells you what
  it affords.** The `glow-caps` and `witchglow-cluster` fixtures (long pure scenery,
  with their caps trickling onto the floor nearby) are now harvestable via a new
  `harvest` fixture block — a charged crop that depletes and regrows on a timer just
  like an ore vein or fishing pool. A new **`gather`/`forage`** verb (and `use
  <cluster>`) picks them by hand; **`mine`** redirects to it when there's no vein to
  swing at, so the player's instinct works either way. Floor spawns are kept, so the
  clusters are a second, faster source. Examining *any* fixture now shows an
  affordance hint — *"Pick them by hand with `gather`"*, *"Work it with `mine`"*,
  *"Work a line here with `fish`"*, *"Drink from it with `use …`"*, or, for genuine
  scenery, *"It's part of the cavern — nothing here to work or take."* — so players
  can tell what's interactive without trial and error. Validator now checks `harvest`
  blocks alongside `mine`/`fish`.
- **Mallki's cold glimmer-lamp can be switched.** The `umbral-coldlamp` was always-on
  scenery; players reasonably expected to `use` it like any lamp. It's now a switch
  fixture (a sliding stone shutter hoods or bares the glimmer) that gives 1 light when
  on, and starts lit so the hollow's lighting is unchanged.
- **The Grazing Hollow — a stonebug feeding ground behind Mallki's garden.** A new
  depth-3 room (`third.grazing`) opening south off the Sunless Garden, where wild
  stonebugs drift in to crop a broad, untamed mat of glowing moss. Nothing is penned:
  Mallki simply lives beside the herd and takes what the balance allows, making his
  hollow a genuinely self-sustaining place and giving the stonebug economy (chitin
  plate, bug meat, bug tallow) a home at its source. Adds the `umbral-stonebug-grounds`
  fixture and a stonebug spawn.
- **A water source for Mallki's hollow.** New `umbral-cistern` fixture in the Sunless
  Garden — a tended stone basin catching a clean seep, drinkable via `use` (+2 HP,
  +2 MP, same as a dark seep). Its overflow runs a worked channel down to the Grazing
  Hollow, so the garden, the herd, and any delver passing through all draw on the same
  water — the last piece that makes the hollow self-sustaining.
- **Glimmer Husk — an Umbral craft-summon.** A glimmer construct you *build* rather
  than conjure: **Glimmer Husk** (8 mana + 4 shards + **1 chitin plate**, consumed)
  raises a slow, armoured, spined guard (18 HP, armour 3, 1d4 melee + 1d4 spike
  reflect) that plants itself between the mage and the dark — the melee counterpart to
  the ranged, fragile Wisp. Sold by Mallki (`scroll-glimmer-husk`). Adds a reusable
  `itemCost` material-component path to spells (validated, and priced alongside
  mana/shards in one place — a shared `costShortfall`/`spendCost` pair the command
  handler and every cast-resolution path now use).
- **Three new attack spells fill out the mage's kit.** **Witchfire** (5 mana) — a
  clinging damage-over-time burn (`1d4`/tick; resisted wholesale by Ward, otherwise
  unstoppable once it catches) that rewards cast-then-melee. Intellect lengthens the
  burn rather than hitting harder — it clings one tick per point of Intellect
  (`length = int`: 3 ticks at INT 3, 12 at INT 12) — so a keener mage gets more total
  damage *and* a longer mark. The burn also sheds a dim
  light, so a witchfired foe glows where it stands — marked in the dark, and lighting
  the fight for as long as it smoulders. **Arc Flash** (8 mana) — an Intellect-scaled area burst
  (`2d6 + int/4`) that lashes every hostile in the room at once; each foe rolls its
  own Ward, so a warded creature may earth the arc and take nothing. **Glimmer Storm**
  (10 mana + 5 shards) — a heavier, shard-burning area spell (`3d6 + int/3`, per-target
  Ward roll) that hits harder and scales better than Arc Flash; the deep sibling of
  Glimmer Spike, sold by Mallki down the river. Witchfire and Arc Flash are sold by
  Vesper (`scroll-witchfire`, `scroll-arc-flash`); Glimmer Storm by Mallki
  (`scroll-glimmer-storm`). `cast` and the `spells` listing handle the new
  damage-over-time and area shapes; `detonateRoom` now folds in a caster's Intellect
  bonus and an optional per-target Ward roll (thrown bombs unaffected by either).
- **A produce economy on stonebugs and rats.** Two common mobs become supply
  chains. **Stonebugs** now also drop **`bug-tallow`** (≈50%) on top of chitin and
  bug-meat — the keystone for a new **oil-rendering** craft (`bug-tallow ×2 →
  lamp-oil` at a cooking fire, so lantern fuel is farmable, not buy-only) and the
  kitchen's standard frying fat. **Giant rats** drop **`rat-meat`** (≈60%; Gnaw
  always), edible raw in a pinch and the meat for Maeve's broth.
- **Deep stew — the best field food.** A four-ingredient dish (`beer + bug-meat +
  palecap + bug-tallow`) restoring **+12 HP / +6 mana**. Taught by a tier-2
  **`book-of-hearty-cooking`** Maeve keeps back from the common cookbook.
- **Garrick sells an `oil-rendering` schematic**, gating the new render craft.
- Maeve now stocks the **deep stew** ready-made alongside her other dishes.

### Changed
- **`spells`, `recipes`, and the quest log share the `help` palette.** All three now
  open with a gold title, use cyan section headings (recipes' Here/Elsewhere, the
  quest log's In progress/Finished), and lead each entry with a green name — spells,
  recipe outputs, active quests. Unaffordable recipes and finished quests read muted
  grey. Purely cosmetic; unifies the four list screens visually.
- **Leaner starting loadout.** A new delver now begins with a single **short sword,
  unequipped** (was an equipped sword *plus* a spare in the pack) and **no Scroll of
  Spark** — first weapon and first spell are now choices to make, not freebies. Still
  starts with a torch; all equipment slots remain seeded empty so `unequip` works.
- **`help` is reorganised, coloured, and admin-aware.** The flat command list is now
  grouped into titled sections (Exploration, Items & gear, Combat & magic, Gathering
  & crafting, People & trade, Resting) with a catch-all **Other** before the admin
  block, rendered with the existing `<#colour>` markup — gold title, cyan section
  headings, green command signatures. Admin `@`-commands appear in `help` **only for
  admins** (everyone keeps `@help`). Entries now show the new targeting syntax
  (`get [N.]<item> | all`). The client documents `<#reset>`, the tag that returns a
  line to the default ink mid-string.

### Added
- **DikuMUD-style target selection.** When several things share a name, pick one
  with an ordinal — `kill 2.crawler`, `get 3.shard` — or act on the whole lot with
  `all`: `get all`, `get all.shard`, `drop all`, `drop all.pelt`, `sell all`,
  `sell all.crystal` (a stack sells in full). Works for items (get/drop/sell) and
  creatures (attack/cast/talk/give), routed through a shared `parseTarget` layer so
  the syntax is uniform. `help` documents it.
- **"Did you mean?" on a mistyped command.** An unknown verb that isn't just a
  prefix now suggests the closest real command (`atttack` → *Did you mean "attack"?*)
  instead of a bare error.

### Removed
- **Tab completion removed from the command input.** The partial-verb abbreviation
  system on the server already lets you type `ga` for `gather` or `mi` for `mine`;
  client-side Tab-to-complete added noise without being reliable. Tab now moves focus
  as the browser expects.

### Changed
- **Summon lifetime now scales with Intellect.** Both **Summon Wisp** and **Glimmer
  Husk** last `30 ticks per point of Intellect` (≈1:30 at INT 3, ≈6:00 at INT 12), so
  a keener summoner holds their conjuration far longer. (Generalized via a
  `durationScale` field + `durationScaleBonus` helper, shared with Witchfire.)
- **Mage damage spells rebalanced into a clear ladder.** **Spark** buffed from
  `1d4 + int/4` @ 4 mana to **`2d4 + int/3` @ 3 mana** — now worth the keystroke
  over a free swing instead of strictly worse. To preserve progression, **Bolt**
  goes `1d8 → 2d8 + int/3` and **Glimmer Spike** goes `2d6 + int/3 @ 8 mana → 3d8
  + int/2 @ 9 mana`, with the heavier spells scaling harder on Intellect.
- **Mushroom soup is now Hearty Broth.** Maeve's signature is renamed (item/recipe
  id `mushroom-soup` → `hearty-broth`) and made meatier — `palecap ×2 + rat-meat
  ×1`, restoring **+8 HP / +6 mana** (was +5/+5) — reflecting the cellar-bred meat
  the inn lore always implied went into the broth-pot.
- **Bug-meat skewers are fried in tallow.** `cooked-skewer` now also takes
  `bug-tallow ×1` and heals **+9 HP** (was +8), weaving the new fat into a staple.
- **Resource verbs forgive the wrong guess.** `mine`, `gather`, and `fish` all
  pull a resource from a charged fixture and differ only in flavour, but players
  reach for whichever verb the *thing* suggests. Each verb now hands off to the
  sibling that fits when it finds nothing of its own kind — `gather`/`mine`/`fish`
  a vein, a bed, or fishing water and the right action runs regardless. (Previously
  only `mine`→`gather` redirected; the courtesy is now symmetric and covers `fish`.)
- **Weeping chasm-moss is gathered, not mined.** The two moss fixtures are
  reclassified from `mine` to `harvest` (verb *pull*), matching their "pull a clump
  free" flavour — so `gather moss` / `pick moss` works as expected. `harvest` and
  `pick` join `gather`/`forage` as verbs for hand-picked crops.

### Fixed
- **Hidden ore veins no longer leak through `mine`.** `mine`/`fish` now skip
  undiscovered hidden fixtures (as `gather` already did), so the hidden silver vein
  in the Black Drift is no longer listed by a bare `mine` or workable by name before
  you `search` it out.
- **Summoned guardians no longer pick fights.** A player's summon (the Glimmer Husk,
  the Wisp) is a defensive guard, but it inherited the proactive-hunter behaviour of
  any `hostile` mob and would aggro and engage wild creatures on sight even while its
  master stood idle. A player-faction summon now never hunts on its own: it engages
  only what it has traded blows with, or what its owner is already fighting (it piles
  into the master's fights like a `helper`). Stand peacefully beside a stonebug and
  your husk stands with you; lift a hand against it and the husk lifts with you.
- **Light fuel gauge updates while standing still.** A lit lantern/torch burns fuel
  every tick, but the player panel only refreshed when the view was re-sent (on move,
  vitals change, etc.) — so an idle player saw their fuel frozen until it suddenly hit
  empty. The burn loop now nudges a `vitals` refresh at least once per ten ticks while a
  light is burning, so the gauge ticks down visibly.
- **Player panel now shows gear-modified attributes.** The attributes block (and
  the Perception-derived crit chance) is rendered from a player's *effective*
  attributes — base plus equipped-gear `attrMod` — rather than the raw base. So
  donning an iron helm that dulls **Wits −1** is reflected in the panel, matching
  the value combat (Ward, evasion, to-hit) already used.

### Changed
- **Thrown bombs can leave a lingering cloud.** A `damage-room` consumable's
  effect now takes an optional `dot` block (`{ name, damage, duration }`) applied
  to each caught mob as a damage-over-time, an instant `damage` burst, or both —
  and its room-burst line is now data-driven (`consumable.burst`) instead of
  hardcoded shrapnel (the shard grenade keeps its existing text via the default).
- **`recipes` is sorted and split by where you can make it.** The known-recipe
  list now shows a **Here** block (recipes whose station is in the room) before
  an **Elsewhere** block (with the station to seek appended), and within each
  orders output by kind — worn gear by slot, then consumables, then materials.
  Recipes you can't currently afford the components/shards for are **greyed
  out**, so what you can make right now reads at a glance.
- **Shop `list` greys what you can't afford.** Wares priced above your shard
  balance are shown greyed, matching the `recipes` treatment.
- **Iron weapon balance.** The **iron sword** now hits for `1d8` (was `1d6`),
  making it a clear step up from the bought short sword at the same speed. The
  **iron mace** keeps its lower `1d6` base but now scales harder with Might
  (`/2`, was `/3`), so it starts behind the sword and overtakes it as Might
  climbs — a strength-bruiser to the sword's all-rounder.
- **Weapon examine shows the full damage formula.** Inspecting a weapon now
  spells out the attribute scaling every swing gets — the weapon's own `scale`
  or the default **Might/4** when it declares none — plus the viewer's current
  bonus, e.g. `damage: 1d8 +2 (might/2)`. Previously the implicit Might/4 was
  hidden, so a plain sword and a Might-scaling weapon could read identically.
  The `spells` list likewise now shows the caster's current attribute bonus on
  damage spells (e.g. `1d6 +1 fire damage (intellect/4)`), for parity.
- **Glimmer crafting is now gated behind schematics.** New characters no longer
  start knowing **Glimmer Dust**, **Pressed Glimmer Dust**, or the **Glimmersteel
  Bar** smelt — the entry point to all glimmer-work. The three methods are now
  taught by schematics: **Vesper the glimmer-mage** sells the two dust methods
  (`schematic-glimmer-dust`, `schematic-pressed-glimmer-dust`) and **Tobin the
  tinker-smith** sells the `schematic-glimmersteel-bar` smelt, so the glimmer
  line is something a delver buys into rather than knows from the rim.

### Added
- **Regeneration draught — a craftable heal-over-time potion.** A portable,
  no-mana counterpart to the **Regeneration** spell that bridges the gap between
  instant food and casting: drunk down it knits **3 HP every 3 ticks for 24
  ticks** (24 HP over ~24s), ticking on through combat rather than bursting you
  out of it. Uncommon, value 35. Brewed at an **alchemy** station from
  `palecap-mushroom ×2 + witchglow-cap ×1 + vial ×1` (6 shards) — distilling the
  witchglow's coaxed virtue into a slow mending the raw mushrooms can't reach.
  **Vesper the glimmer-mage** sells the schematic. Pure data — reuses the
  existing `heal-over-time` effect primitive.
- **Mana tonic — a craftable mana potion.** Fills a real gap (there was no
  dedicated mana restore — only `beer` +4 and `mushroom-soup` +5). Drunk, it
  restores **12 MP**. Uncommon, value 30. Brewed at an **alchemy** station from
  `weeping-chasm-moss ×1 + vial ×1` (4 shards). **Vesper the glimmer-mage** sells
  the schematic.
- **A depth-1 moss source.** The Dripping Tunnel (`abyss.tunnel`) now bears a
  **weeping-moss-fringe** — a sparse mineable variant of the deep moss curtain (2
  charges, 320-tick respawn) — so `weeping-chasm-moss` (and the mana tonic it
  brews) is reachable near the rim, not only in the depth-3+ river caves. The
  deep `weeping-moss-curtain` veins also slow to a 320-tick respawn (was 150).
- **Acid bomb — a thrown corroding cloud.** A sibling of the shard grenade, but
  it leaves a lingering **damage-over-time** instead of an instant burst: each
  caught mob takes `1d4`/tick for 6 ticks (~15 magical, **armour-ignoring**),
  crediting the thrower on a corrosion kill like a bleed. The anti-armour answer
  to foes shrapnel bounces off. Uncommon, value 30. Brewed at an **alchemy**
  station from `venom-gland ×1 + vial ×1` (4 shards). **Vesper the glimmer-mage**
  sells the schematic.
- **Glimmersteel lamp.** A craftable high-end light source: output **5** (a step
  past the brass lantern's 4), `fuelMax` **900**, and a `burnPerTick` of **0.5**
  with `refuelPerUnit` **450** — so it burns brighter yet sips its oil, a single
  flask outlasting three in a lantern. Forged at a **smithing** station from
  `glimmersteel-bar ×2 + glimmer-dust ×1` (15 shards); **Tobin the tinker-smith**
  sells the schematic.

- **`@give <itemId> [count]` admin command.** A testing aid mirroring `@spawn`:
  drops any item template straight into the admin's pack — stacking for
  stackables, minting separate instances otherwise (count clamped to 99). Saves
  having to craft or grind for gear/consumables/materials when exercising a
  change. Listed in `@help`.
- **Glimmersteel coil — gear that quickens mana regen.** Worn gear can now carry
  an `armour.manaRegen` bonus, added to the standing mana trickle and refreshed
  whenever gear changes (and re-derived on admit, so it survives a reload). The
  **glimmersteel coil** is a `finger`-slot ring (rare, value 120) granting
  `+0.125`/tick — doubling the default standing regen, so a caster's well refills
  even on the move. Forged at a **smithing** station from `glimmersteel-bar ×1 +
  glimmer-dust ×1` (12 shards); **Tobin the tinker-smith** sells the schematic.
  `examine` now also lists a piece of gear's max-HP, max-mana and mana-regen
  bonuses (previously hidden), and no longer prints `armour 0, ward 0` for
  pure-bonus gear like rings.
- **Shard grenade — a thrown area bomb.** A new `damage-room` consumable effect:
  `throw`/`hurl`/`lob` (or `use`) a bomb to blast **every hostile in the room at
  once** for its rolled damage, crediting and threatening the thrower so survivors
  turn on them. Peaceful NPCs (and anyone not already fighting you) are spared, and
  a throw into an empty room is refused so the bomb isn't wasted. The **shard
  grenade** itself hits for `4d6` physical; crafted at an **alchemy** station from
  `glimmer-dust ×1 + iron-bar ×1` (8 shards), with **Tobin the tinker-smith**
  selling the schematic. `examine` shows a thrown bomb's damage and reach.

- **Inline colour markup for console text.** Authored messages can now tint a
  run of text with `<#name>` (e.g. `<#gray>`, `<#gold>`, `<#rainbow>`); the
  colour holds until end of line and resets on the next, drawn from a small
  themed palette in `styles.css`. Player-typed text (say/emote) has these tags
  stripped server-side, so it stays trusted styling for content and effects.

- **Drinkable fixtures.** A fixture can now declare a `restore` block
  (`{ hp, mana }`); `use`/`drink <fixture>` draws from it and heals on the spot,
  with the fixture staying put. The **dark seep** restores `+2 HP / +2 MP`, and a
  new **carved stone font** behind the falls in the Umbral shrine (*Behind the
  Paqcha*) gives the same — a small sanctuary apart from the undrinkable black
  lake, for delvers who find the hidden ledge.

- **Item rarity tiers.** Items carry an optional `rarity`
  (`common`/`uncommon`/`rare`/`epic`/`legendary`, default Common). The client
  surfaces it two ways: a coloured frame on the ground-item chip (Common stays
  neutral; Uncommon green, Rare blue, Epic purple, Legendary orange) and a tier
  badge in the Inspect window. Glimmersteel/starsilver stock and the
  unique-mob & Umbral pieces are now **Rare**; minor-magic gear and worked
  deep-craft (the sight/wits rings, spiked chitin, barbed flail, gloom-silk,
  light potions, searing flare, …) are **Uncommon**. Like any examine detail,
  rarity colour is only legible in adequate light.
- **Three distinct chip silhouettes — beings, items, fixtures.** Players and
  mobs keep their pill shape (round = alive); loose **items** are soft-cornered
  squares; **fixtures** are hard-cornered with a leading `⌂` marker, so a
  room-anchored installation never reads as a being or a pick-up-able item. (A
  blue Rare item also no longer reads as a blue, mana-coloured player chip.)
- **Buff-casting mobs (engine).** A mob's `cast` action may now name a
  **non-hostile** spell, which it lays on **itself** as a self-buff (see
  `state._mobCastSelf`) — defence/heal magnitudes baked from the mob's own
  attributes, mirroring player `castBeneficial`. A mob's live defence now folds in
  active `protect` states (`mobDefence`), so a self-cast Glimmerskin actually
  toughens the caster against melee and the ward-negate roll. A refresh-buff is
  gated so a mob won't recast it while it's still up. Reusable for future
  warder/healer mobs.
- **Loot for the Sunless Lake.** **the Pale King** now drops a **kingshell plate**
  (a unique glimmer-veined carapace material) and a
  **glimmer crystal**, both guaranteed. **Yana** now fights as the game's first
  real **spellcasting mob** — opening with **Glimmerskin** to crust himself in a
  glimmer shell, then flinging **Glimmer Spikes** — and drops a **glimmer-singer's
  circlet**, a new head-slot caster item (the first magical headpiece: +4 max mana,
  +1 ward, no helm weight), read as his master's old apprentice-mark gone cold.
- **Kingshell cuirass — the first warded body armour.** **Mallki** now sells **a
  kingshell method** (`schematic-kingshell-cuirass`), which teaches a smithing
  recipe forged from the Pale King's own two drops — a **kingshell plate** + a
  **glimmer crystal**, plus 2 silver bars and 12 shards. Where the chitin/iron line
  is heavier physical plate paid for in Wits, the **kingshell cuirass** is a light,
  glimmer-enhanced shell: `armour 2`, **`ward 2`** (the first body armour to carry
  any), **`+4 max mana`**, **no Wits penalty**, and it draws **`+2 mana`** back into
  the wearer off every melee blow that lands (`armour.onDamage`). A caster's/battle-
  mage's bodywear, pairing with the glimmer-singer circlet — all pure data, no new
  code.
- **Dense chitin cuirass — the heaviest tank, and `speedPenalty` made real.**
  **Mallki** also sells **a dense chitin method** (`schematic-dense-chitin-cuirass`),
  a smithing recipe forged from **dense chitin plate ×3** (the Old Grinder's drop,
  finally given a use) + 2 iron bars + 12 shards. The **dense chitin cuirass** is the
  game's heaviest armour — `armour 4` (top), `+8 max HP`, `Wits −2` — and the
  counterpart to the light kingshell shell. To make "heavy" mean heavy, the
  long-documented-but-unwired **`speedPenalty`** field is now live: equipped
  `armour.speedPenalty` lowers a player's effective action speed (`effectiveSpeed`),
  so they bank action-energy — and thus act and swing — more slowly. The dense
  cuirass carries `speedPenalty 2` (speed 12 → 10); the player panel shows the
  reduced speed. No existing gear changes (everything else is `speedPenalty 0`).
- **A silver seam in the Sunless Lake.** `lake.fissure` (the worked-stone side
  passage) now holds a **silver vein** — a local source of silver ore at depth 4,
  so the kingshell cuirass's silver requirement can be supplied near where it's
  found rather than only from the depth-2 mine.
- **Secret: the Drowned Claimant.** `lake.islet` (the King's Reach) now hides a
  dead prospector's silt-logged cache among the bone-heap — `search` it (Perception
  3) to turn up glimmer shards, lamp-oil, and a leather jerkin. The reward for
  beating the Pale King and looking closer.
- **Secret: Yana's keepsake.** `lake.warren` hides **an apprentice's glimmer-charm**
  in the swept wreckage — `search` (Perception 4) to find the unfinished neck-charm
  Yana was making under Mallki before the deep took him (neck slot: Perception +2,
  Ward +2; a senses-and-magic-guard piece, distinct from the Intellect mind-charm).
  The emotional capstone of the Mallki→Yana arc.
- **Secret: Behind the Paqcha.** A 10th room hidden behind the waterfall at
  `lake.strand` — `search` (Perception 4) reveals a slick ledge through the spray
  into **`lake.shrine`**, an old Umbral shrine to the paqcha they named, lamp-lit
  and untouched by the Rush, holding a respawning glimmer crystal and a pile of
  offered shards.
- **Palecaps on the lake shore.** `lake.strand` now grows a small patch of
  **palecap mushrooms** in the weeping-moss glow — the lake's first foraged food
  besides the fishing shallows, and consistent with fungus growing where there's
  light.

### Changed
- **Spawn rules** — Spawn speed updates (rim.cellar, rim.hatchery).
- **The Inspect window now switches to your target the instant you `attack`**,
  instead of waiting for the first swing to land on a later tick. Combat keeps
  this view pinned and refreshes the target's HP each swing (unchanged), so the
  readout no longer pops in unpredictably mid-fight. In the dark, where there is
  nothing to make out, nothing is pinned.

### Added
- **The Sunless Lake (depth 4).** The paqcha at the Sunless Falls now has its
  descent made fast: `down` from `third.falls` drops to a new nine-room zone
  around a vast underground lake. A generally safe shore-walk runs from the foot
  of the falls (`lake.strand`, with a weeping chasm-moss harvest) past a fishing
  shallows and a pinched chokepoint to the far bank, where the next descent is
  begun but not yet open. Two branches leave the shore: a gravel spit out to **the
  Pale King** — a glimmer-crusted crayfish miniboss holding the richest water — and
  a worked-stone side passage past a gallery of Umbral reliefs that decay into
  twisted figures, ending at **Yana, the lost apprentice**, the first corrupted
  Umbral a delver meets: kin to Mallki the trader one floor above, and what the
  deep has made of him. Wandering pool fauna (crayfish, cave-fish, salamanders)
  are the only risk on the safe path. (Loot and secrets still to come.)
- **NPC stat editor (`tools/mob-editor/`).** A local, browser-based form for
  editing `data/world/mobs.json` — run `npm run edit-mobs` (or double-click
  `tools/mob-editor/start.bat`) and open `http://localhost:3939`. Edit each mob's common stats (HP, speed, armour, ward,
  attributes, perception band, flags) via form fields, with a raw-JSON escape
  hatch for advanced blocks (attack, loot, actions, shop). **Validate & preview**
  writes the file, runs `npm run validate`, shows the exact `git diff`, then
  restores the file; **Create pull request** branches, commits (Conventional
  Commit), pushes, and opens a PR via `gh`. Diff hygiene: unedited mobs keep their
  exact source text byte-for-byte, so a PR touches only the NPCs you changed.
- **Room spawn-rule editor (`tools/spawn-editor/`).** A sibling tool for editing
  the per-room `spawns` rules (mob / max / respawn) in `data/world/rooms.json` —
  run `npm run edit-spawns` (or double-click `tools/spawn-editor/start.bat`) and
  open `http://localhost:3940`. Pick a room, add/remove/edit its spawn rows, then
  validate + preview the diff or open a PR via `gh`. Field-level splice: only the
  `spawns` value of an edited room is rewritten, every other byte is preserved.
- **Exit destinations on the room panel.** Each exit chip now reads `north → Rim Inn`
  when the room is lit enough to see — you can tell where a passage leads at a glance.
  In the dark the chips fall back to bare directions (you feel the openings but can't
  read where they go). Covers normal, discovered-hidden, and open-door-fixture exits.

- **Weeping Chasm-Moss** — lore-canon bioluminescent predatory moss that grows over
  abyssal rivers and hot vents (`docs/lore.md` updated). Yields `weeping-chasm-moss`
  (harvestable material, value 8), processed at an alchemist's bench via
  `process-gloom-silk` (3 moss → 1 `gloom-silk`, value 40), the base thread for
  future deep-made fabric gear.
- **`weeping-moss-curtain`** fixture placed in two third-floor river rooms:
  `third.shallows` (ceiling above slow water) and `third.falls` (the paqcha).
  The falls room description now names the moss as the source of the room's
  faint ambient glow. `mine`/`dig` to harvest; 4 charges, respawn 150 ticks.
- **Vesper's field journal** — a `scenery` fixture in the Warded Cellar (`rim.training`).
  Fragmentary research notes on the Umbrals: the eye-glyph reliefs, the word *ukhu-pacha*
  (the depth beneath depth), Mallki's cryptic remark about the deep-dwellers (*suti mana kan*
  — "the name is not"), and Vesper's uneasy observation of Umbrals watching the shaft-work.
  Examine it to read; the last entry trails off mid-sentence.
- **A cellar beneath the Rim inn (`rim.cellar`, "The Inn Cellar").** A low cellar
  hatch behind the bar of the Lantern's Rest (a `door` fixture, barred shut by
  default) drops to a cramped pen where **two giant rats** are kept fat on kitchen
  scraps. The room flavour hints that Maeve breeds them down here for the
  broth-pot's meat — whatever she tells the delvers upstairs.
- **The third abyss floor (depth 3) — the Underriver, reached down the Deep Stair.**
  Seven new rooms running along a black underground river. A mostly-gentle spine
  (`The River Stair` → `The Pale Shallows` → `The Still Pools` →
  `The Sunless Falls`) ends at a waterfall the Umbrals name the **paqcha**, beside
  which an unfinished ledge marks the descent to a future fourth floor. Two of the
  river rooms are **fishing water**; a **hidden cave-lurker** (perception 3) lies in
  ambush in the Pale Shallows, so the easy fishing is not quite as safe as it looks.
  North of the falls, a flooded **Plunge Cave** holds a richer fishing pool **owned
  by hostile pale crayfish** — risk-and-reward water for braver delvers. Off the
  pools, a worked side-path leads to the
  **first Umbral presence** in the game: **Mallki the qhatuq** — a quiet,
  bioluminescent Umbral trader — in his dim, lamp-lit hollow (`Mallki's Hollow`)
  with a tended fungus garden behind it (`The Sunless Garden`), where farmed grubs
  supply bait on the floor itself. New wander-zones `third` and `third-umbral`.
  (Umbral names draw on Quechua roots.)
- **Glimmer-craft moves to the deep.** The two glimmer-craft scrolls
  (**Glimmer Spike**, **Glimmerskin** — the shard-burning Umbral art) leave
  Vesper's shelf at the Rim and are now sold only by **Mallki** on the third
  floor, gating the heaviest spells behind reaching the first Umbral. He also
  takes over the **Book of Chitin Craft** (was Tobin the smith's), a fitting
  trade for a deep-dweller. Vesper still sells the human-tradition scrolls.
- **Two new Umbral accessories, sold by Mallki.** An **Umbral mind-charm**
  (`neck` slot, `+2 Intellect` → sharper spell power) and an **Umbral
  glimmer-ring** (`finger` slot, `+5 max Mana` → a deeper caster's well). Adds
  two new **equipment slots** (`neck`, `finger`), seeded empty on fresh
  characters, and a new `armour.maxMana` bonus (mirroring `armour.maxHp`):
  equipping grants the new capacity, unequipping clamps it. Validator now
  checks `armour.maxMana` and `armour.attrMod`.
- **Two silver attribute rings, crafted at the smithy.** A **Ring of Sight**
  (`+1 Perception` — sharper aim, crit, and now searching) and a **Ring of Wits**
  (`+1 Wits` — more Ward and evasion), each forged from **one silver bar**. Recipes
  are gated behind schematics sold by Vesper. `search` now reads **effective**
  Perception (so perception gear helps you spot hidden things, not just base
  attribute). Both use the `finger` slot — only one ring worn at a time for now.
- **Starsilver, a top-tier alloy.** Smelt **1 silver-bar + 1 glimmer-dust** into a
  **starsilver bar** (`alloy-starsilver`, smithing) — finer than glimmersteel and
  the first use for silver-bar. The recipe is gated behind a **starsilver
  schematic** sold by Vesper. (Flavour nods at the "frozen starlight" legend
  without asserting it — glimmer's nature stays a mystery.) Stock material for
  future gear; no starsilver gear yet.
- **Two glimmersteel craftables.** A **Glimmersteel Sword** (`+1 Might`,
  `1d8 + Might/2` — a per-weapon `scale` block) forged at the smithy, and a
  **Glimmersteel Staff** (`+1 Intellect`, `+5 max Mana` — a caster focus,
  `1d6 + Might/3`). Both are forged at the smithy and each costs **two
  glimmersteel bars**. The recipes are taught by schematics: the sword schematic
  is sold by **Tobin** at the Rim, the staff schematic by **Vesper**. First gear to carry both a
  `weapon` and an `armour` (bonus) block on one item.
- **Fishing.** A new `fish` (alias `angle`) gathering verb, a sibling of `mine`:
  work a baited line in a `fish` resource fixture. Each cast spends a **grub** as
  bait (lost to the water, catch or no) plus energy, and rolls the fixture's
  `catchChance` to land **a blind cave-fish** (a new raw, sellable food). Like ore
  veins, a pool holds a stock of catches that depletes and refills on a timer.
  New `fish` fixture block (`{ template, yield, charges, respawn, energy, bait,
  catchChance }`), validated and documented; `state._mineTick` now recovers
  fishing pools as well as ore veins.
- **The second abyss floor (depth 2), reached down from the Ore Drift.** Thirteen
  new rooms in three parts. A safe, prospector-trafficked **main road** runs
  east→west (`The Winch-Head` → `The Prospectors' Road` → `The Crossing` →
  `The Deep Stair`, the last a roped-off descent toward a future third floor).
  **South** lies a glow-cap-lit grazing range of stonebugs and thornbugs
  (`The Grazing Galleries`, `The Spine-Thicket`, `The Grinder's Hollow`,
  `The Skitter-Crack`), home to **the Old Grinder** — a huge, ancient stonebug
  miniboss (HP 60, armour 5; neutral until provoked) — and a venomous cave
  centipede. The Old Grinder drops chitin plate and bug-meat, a **slab of dense
  chitin** (a new deep-tier crafting material, also to be dropped by tougher
  beasts further down), and a glimmer crystal ground slow in its gut over decades
  of grazing ore-rich rock. **North** is a fully dark, five-room **mine** (`The Adit`,
  `The Black Drift`, `The Silver Cut`, `The Umbral Stope`, `The Sump`) with two
  iron veins, a new **silver vein**, an **Umbral pillar** marking older work, and
  the existing dark fauna joined by **a pallid hunter** — a big, light-pained
  blind predator that roams the workings, an early glimmer-mutated outlier
  carrying dormant crystal in its hide. New wander-zones (`second`,
  `second-graze`, `second-mine`) keep the grazers and hunter off the safe road.
  A **hidden flooded chamber** (`The Drowned Hollow`) lies below the Sump, found
  only by `search` (perception 4) and reached down a submerged tunnel: an
  untouched **glimmer crystal** set in a seam there, guarded by two pale
  salamanders. The pallid hunter, being glimmer-mutated, drops a glimmer crystal
  fairly often (60%).
  Three more `search`-gated secrets reward the perceptive: a lost climber's stash
  at the Deep Stair (shards + lamp-oil, perception 3), a venomous cave centipede
  lying in ambush in the Spine-Thicket (perception 3), and a concealed second
  silver vein behind a hairline crack in the Black Drift (perception 4).
- **Silver.** A new mundane metal deeper than iron: mine **silver ore** from the
  silver vein, smelt it to a **silver bar** (`smelt-silver`, known from the start)
  at the furnace. A high-value material/coin sink; no gear yet.
- **Five new spells.** **Candlelight** — a 3-mana cantrip that sheds 1 light for a
  minute (an `emit-light` weave; cast on self/ally/creature). **Mage Armour** —
  a shard-free wardweave granting `1 + Intellect/10` armour for 3 minutes
  (`protect`, renews on recast). **Sleep** — a non-damaging hex that drops a foe
  into slumber (sets posture `sleeping`, inert until any blow rouses it; resisted
  wholesale by Ward, draws no threat on success). **Bolt** — a 7-mana magical
  attack, `1d8 + Intellect/3`, stronger than Spark. **Glimmer Spike** — the
  heaviest single strike, `2d6 + Intellect/3` for 8 mana **and 3 shards** (glimmer
  burned in the cast). Each has a learnable scroll sold by Vesper the glimmer-mage.
  Adds a `sleep` spell-effect primitive and wires `shardCost` into hostile casts.
- **Command abbreviation (DikuMUD-style).** Any command can be shortened to an
  unambiguous prefix — `exa` → `examine`, `rec` → `recipes`, `cr` → `craft`,
  `lig` → `light`. Ambiguous prefixes resolve by a deliberate priority order (so
  `dr` → `drop`, `se` → `search`, `li` → `light`); the existing single-letter
  aliases (`l`, `i`, `k`, `c`, `x`) and direction shortcuts still win as exact
  matches. The priority list lives in `VERBS` in `server/commands.js`, ordered so
  `h` → `help` and `re` → `refuel`/`remove`/`recipes` (not `rest`, which is `res`).
- **`pickup` as a synonym for `get`.**
- **Console scrollback freeze + "new messages" pill.** Scrolling up to read
  history no longer yanks you back down when new lines arrive (MUD-style split
  scrollback). While you're reading backlog a floating `↓ N new messages` pill
  shows how many lines have arrived; click it (or scroll back to the bottom) to
  snap to the newest. Client-only (`client/app.js`, `client/styles.css`).
- **Room-change dividers in the console.** Moving to a new room inserts a muted
  hairline rule with the room name and depth (`Ossuary Stair · depth 3`), so the
  console reads as per-room chapters. Keyed on room-id change, so `look` and
  light flickers never spam dividers.

### Changed
- **Magic now has two named traditions in the lore** (`docs/lore.md`): **human**
  magic is standard fantasy paid for in mana alone, while **Umbral** glimmer-craft
  always **burns shards** alongside mana. Rule of thumb for authors: a spell with a
  `shardCost` is glimmer-craft; mana-only spells are human and keep glimmer out of
  their flavour. Reworded **Regeneration** and **Summon Wisp** (both mana-only) so
  their flavour no longer leans on glimmer-as-medium.
- **Standardised console message colours into a calm, semantic palette.** Warm
  tones are now earned by real game outcomes — **combat is soft rose**, **levelling
  stays gold**; the **gray family carries meta/plumbing** (your own commands, system
  notices, and errors); world narration stays white. Errors moved off red (they read
  as gray italics now, so a failed action still stands apart from your echoed command
  without shouting), and system notices moved off blue to gray. Combat is a new
  first-class message type: core combat lines (attacks, hits/misses, mob spells,
  deaths, ambush/aggro engagement) are tagged `combat` on the server rather than
  riding the generic white `log` channel.
- **Lighting is now equip-driven (DikuMUD-style).** Equipping a fuelled light
  source into the `light` slot **kindles it automatically** — no separate "light it"
  step. `use <source>` toggles a carried/equipped source between lit and doused (to
  conserve fuel), equipping it first if it's still in your pack. Works in the dark,
  since lighting a torch is how you escape it.
- **New characters start unequipped.** The starting short-sword now begins in the
  pack rather than wielded; all equipment slots (`hand`/`body`/`head`/`light`) are
  seeded empty so `unequip <slot>` works and gear can be equipped from a fresh
  character. (You spawn at the lit rim, so you can `equip`/light up before descending.)
- **Dropped the `hold` alias for `equip`.** Lumen's `equip` already routes an item
  to whatever slot it declares (incl. the `light` slot), so `hold` was pure
  duplication; `equip`/`wield`/`wear` remain.

### Removed
- **`light` / `ignite` / `douse` / `extinguish` commands** — folded into
  `equip` (kindles) and `use <source>` (toggles); see above.
- **`go` / `move` commands** — movement is direction words and `n/s/e/w/u/d`
  (DikuMUD has no `go`). Bonus: `g` now abbreviates to `get`, `m` to `make`.
- **Keyword targeting for items, mobs, spells & recipes.** Targets now match on
  any significant word in their name, not just a leading substring — so
  `kill innkeeper` hits *Maeve the innkeeper*, and `get glimmerstone` picks up
  *a sliver of glimmerstone*. Each query word may also be a prefix (`get torc`),
  and multi-word queries require all words present. An optional `keywords` array
  on any item/mob/spell/recipe template overrides the auto-derived words for
  synonyms (e.g. listing `"ore"` on a vein chunk); when absent, keywords are
  derived from the display name (articles like *a/the/of* dropped). Substring
  matching remains as a final fallback, so nothing that worked before breaks.
- **Teaching books (`teaches` item block).** An item with
  `teaches: { recipes?: [...], spells?: [...] }` is a book: `learn`/`study`
  teaches every listed recipe and spell the player doesn't already know, then
  consumes it (skipped if they already knew everything). The first one is
  **a book of cooking** — Maeve sells it at the Lantern's Rest for 8 shards, and
  it teaches the three cooking recipes (mushroom soup, bug-meat skewer, roasted
  grubs) that fresh delvers no longer start with.
- **Door fixtures (gated exits).** A new fixture `door` block (`{ dir, to, open }`)
  turns a fixture into an openable passage: while open the room gains an exit in the
  door's direction, while shut that way is closed. `use <door>` toggles it, and
  `open`/`close <door>` set it explicitly. The data validator counts a door as a
  graph edge, so rooms reachable only through one still validate. First use: a
  **trapdoor** in the Mage's Shed opening down into Vesper's practice cellar.
- **The Warded Cellar (`rim.training`).** A room beneath the Mage's Shed, reached by
  opening the trapdoor — Vesper's spell-drill room, where a hostile **wisp** is
  pinned inside a warding ring as a live casting target.
- **The Ore Drift (`abyss.drift`).** A new first-floor abyss room south off the
  Collapsed Gallery: a second **iron vein**, a glow-cap cluster that draws grazing
  **stonebugs** and a **thornbug** (the thornbug's first spawn home — its chitin
  spikes are now obtainable), and a lurking **cave-lurker** in ambush.
- **Bonus durability on armour (`armour.maxHp`).** Armour pieces can now grant bonus
  max HP while worn, folded into derived stats and refreshed on equip/unequip — heavy
  gear that adds raw toughness on top of Vitality.
- **Smithing gear & recipes.** Ten new forge items: iron **sword**, **mace**, and
  now-craftable **cuirass**/**helm** (standard kit); a tanky **chitin** line (helm,
  cuirass, heavy plate, maul) traded out of stonebug shell for armour on par with iron
  plus extra hit points; and two thornbug-spike pieces — a **barbed flail** that bleeds
  what it hits and **spiked chitin armour** that thorns back at melee.
- **Two smithing books, sold by Tobin** at the Craftsmen's Row. **A book of basic
  smithing** (12 shards) teaches the four iron recipes; **a book of chitin craft**
  (80 shards) teaches the four chitin recipes plus the two thornbug-spike ones. The
  smithing recipes are no longer start-known — these books are the path to them.
- **Content quick-reference (`docs/templates-quickref.md`).** One annotated
  "golden record" per world-data type (item, mob, spell, recipe, fixture, room,
  player), with every field's rule inline and derived from the validator. The
  fast path for drafting content — far cheaper to read than the full data-model.
- **Lumen-specific authoring subagents** (`.claude/agents/`): `lore-checker`
  (vets proposed content against canon, returns only conflicts), `content-drafter`
  (drafts valid JSON from the quickref; drafts only — never auto-approves names or
  writes world data), and `data-validator` (runs `npm run validate` and reports
  just the fixes). Each isolates heavy reading from the main session.
- **Assisting mobs (`helper` flag).** A mob marked `helper` piles into any fight a
  same-faction ally is already in — the moment an ally it can **see** is trading
  blows with an enemy, the helper engages that enemy too (and announces it with a
  "rushes to join the attack" line), instead of waiting to notice it on its own.
  Perception-gated like all aggro (it won't join a fight in the dark it can't see),
  and one-shot per enemy (no spam). **Giant rats** and **cave bats** become the
  first helpers, so vermin and a bat-roost now swarm rather than queue up — and
  **Gnaw's** summoned brood gangs up in kind.
- **Ambush predators (`ambush` mobs).** A new mob flag for creatures that lie in
  wait and strike the helpless. An ambush mob *hunts* (tracks enemies it can
  perceive) but holds its proactive blow until a delver is **sleeping**, then
  pounces — and if it was `hidden`, the strike itself **reveals it** (no `search`
  required) with an appearance line just before the blow. It fires no "spotted"
  tell (the ambush is the surprise) and, once blows are traded, fights on normally
  even after the victim wakes. The **cave lurker** becomes the first: it now
  realizes its own description — clinging unseen until you bed down near it, then
  dropping without a sound. (Resting in true darkness is still safe from a mob that
  needs light to see; the lurker, a cave-dweller, sees in the dark.)
- **Perception-gated aggro with a threat ramp.** A hostile mob no longer attacks
  anyone in its room the instant they arrive. Instead a *proactive hunter* (a
  hostile wild mob, or a player-faction ally) builds a **detection meter** on each
  enemy it can perceive, and commits only once that meter reaches a threshold:
  - **Visibility gates noticing.** A new `noticeChance` light curve mirrors combat
    accuracy but with a **hard zero below the mob's `blindBelow`** — in the dark a
    mob cannot notice an enemy at all (you can slip past), in dim/glare it builds
    slowly (~2× longer), in clear light it commits fast. Cadence rides the mob's
    action speed, so a sluggish creature notices more slowly.
  - **Being struck bypasses the ramp.** Trading blows still engages a mob outright
    in any light, so hitting a creature always provokes it.
  - **Detection decays.** A target a mob can no longer perceive (lights gone, or the
    mob itself blinded) is forgotten after a short grace — the hook future
    hide/invisibility skills will use. (Leaving the room still drops threat entirely.)
  - **Posture matters.** A **sleeping** mob perceives nothing and never proactively
    aggros (only rouses when struck); a **sitting** mob is alert-at-rest — it builds
    detection and **stands as it engages**.
  - **The "spotted" tell.** When a mob first commits to a delver it emits a single
    light-gated message ("…fixes its gaze onto you."), so engagement is readable.
  - Detection lives in a separate decaying `detect` table from combat `aggro`, so
    merely *being seen* never earns kill XP — only trading blows does, as before.
  - Folds in a fix: an un-alerted hostile mob now **wanders normally** while a player
    shares its room (it no longer freezes the instant anyone walks in).

  Note: against current content (every hostile sees in full dark, `blindBelow:0`)
  this reads as a brief telegraph before the first blow; the dark-blind creatures
  that make stealth meaningful are authored later.
- **Summoning.** A data-driven summon primitive: a player **Summon Wisp** spell
  (learned from a scroll sold by Vesper the glimmer-mage) conjures an allied Wisp
  for 3 minutes that fights autonomously and follows its summoner; **Gnaw, the
  Brood-Mother** now calls capped giant-rat reinforcements mid-fight. Summoned
  creatures drop no loot or XP and unravel on a timer, on their summoner's death,
  or on disconnect.
- **Combatant-agnostic threat + faction foundation (summoning groundwork).** The
  combat/threat model is generalized so non-player combatants can fight, without
  building summoning itself:
  - **Instance-level faction.** Every mob instance carries a `faction` (default
    `"wild"`; players are `"player"`) and an optional `ownerId`. Allegiance is per
    *instance*, not per template — the same `wisp`/`gloom-crawler` can spawn as an
    enemy or, later, an ally. Combatants of differing factions are enemies.
  - **Threat is combatant-keyed.** A mob's `aggro` table is now keyed by *any*
    combatant id (a player **or** a mob), so a creature can hold threat toward, and
    target, either. Player↔mob behaviour is preserved exactly.
  - **Mob-vs-mob combat.** An enemy mob can target and damage a player-allied mob
    and vice versa, reusing the shared `strike` / `applyHitOutcome` pipeline (so
    on-hit/on-damage/spikes triggers fire identically) for both melee and the
    `cast` action. A `"player"`-faction mob fights enemies on sight and credits its
    `ownerId` on a kill. Narrated to onlookers via the existing `attack`/`mob-cast`
    events (now tagged with `targetKind`).
  - **Support-spell threat.** Healing or buffing an ally now draws the caster
    threat on whatever is currently fighting that ally, mirroring the damage→threat
    convention (threat = HP/mana mended; a flat `1` for a pure buff).
  - **`@spawn` faction flag.** The admin `@spawn <mobId> [count] [wild|player]`
    gains an optional trailing faction; `player` marks the spawned instance allied
    (`faction:"player"` + `ownerId`) for live mob-vs-mob testing.

### Changed
- **Summon kills now share XP with the owner.** When an allied summon helps wear
  down a mob, its contribution credits its **owner** in the kill's participation
  share — so a delver whose pet did the work no longer misses out when something
  else lands the final blow. (The finisher case was already credited.) Owner is
  credited once, only if present and alive, like any participant; a wild mob's
  threat key still credits no one.
- **Ward is now a percent defence, not flat mitigation.** Ward's core role is a
  **percent chance to negate a hostile *spell* outright** (1 ward = 1%, **uncapped** —
  ward 100+ shrugs magic off entirely), shared by both directions via a single
  `wardNegates` helper: player→mob casts (existing) and the new mob→player casts.
  Magical-type **weapon** hits — which land via the normal to-hit roll, not a
  spell — are instead cut by a **percent damage reduction** (`damage × (1 −
  ward/100)`) in `strike()`, replacing the old flat ward subtraction (a leftover
  from an earlier stage). Physical damage is unchanged (flat Armour soak). Ward
  still comes from Wits (×2), gear, and Glimmerskin.

### Added
- **Mobs can cast hostile spells (`cast` action).** A mob action
  `{ "type": "cast", "weight": N, "spell": "<id>" }` lets a creature throw a
  hostile spell at its top-threat target, mirroring melee: the target's Ward gets
  the negation roll, a landed damage spell scales off the **mob's own**
  attributes, hostile status effects apply, and it triggers rouse/auto-retaliate.
  No mana bookkeeping for mobs — cadence is gated by action energy. Narrated via a
  new `mob-cast` event.
- **A `Wisp` creature (not yet placed) + admin `@spawn`.** Added **a Wisp** — a
  pure-magical creature that attacks only by casting Spark (Int 1, low damage),
  with **80% evasion** (physical blows mostly miss; spells ignore evasion, so it's
  killed with magic), `ward 10`, and a light-emitting glow. It is **not in any
  room's spawn list** — placement is deferred. To exercise it (and the
  defender-side player-Ward path), a new admin-only **`@spawn <mobId> [count]`**
  drops a mob into the admin's current room.
- **Glimmerskin spell + `protect` effect + spell material costs.** A new
  `protect` effect primitive grants timed, flat **armour and/or ward**, summed
  into `playerDefence` while active (so the player panel shows the boosted
  numbers live and a countdown for the buff). The first spell to use it,
  **Glimmerskin** (6 mana **+ 5 shards**), is beneficial — cast on yourself, an
  ally, or any visible creature; its armour/ward scale with the caster's
  **Intellect** (`armour = 1 + floor(Int/4)`, `ward = floor(Int)`), baked in at
  cast time, lasting **3 minutes**. This also adds two reusable pieces:
  **`spell.shardCost`** (a spell can now burn shards as a material component,
  validated and deducted alongside mana) and **`effect.refresh`** — an opt-in
  "renew, don't stack" flag on `applyEffect`, so re-casting a buff resets its
  timer instead of stacking a second instance (DoTs leave it unset and keep
  stacking as before). Learned from **a Scroll of Glimmerskin**, stocked by
  **Vesper** (75 shards).
- **Regeneration spell + heal-over-time effect.** A new `heal-over-time` effect
  primitive pulses healing on its own `interval` for a `duration`, clamped to the
  target's max HP. It works on **players and mobs alike** — so a mob can carry an
  innate regen (a "regenerating troll" is just data: an authored
  `heal-over-time` state with a fixed `magnitude`). The first spell to use it,
  **Regeneration** (8 mana), is *beneficial*: it cannot be hurled at a foe, only
  laid on the willing. `cast regeneration` (or `cast regeneration self`) mends the
  caster; `cast regeneration <ally>` mends a fellow delver in the room; it can
  also be cast on a creature you can see. The per-pulse heal scales with the
  caster's **Intellect** (`floor(Int/2)` every 2 ticks for 10 ticks), baked in at
  cast time. Beneficial casting has its own targeting path (`castBeneficial` in
  `state.js`) with a documented hook for future support-spell threat/aggro —
  healing draws **no threat yet**. Players learn it from **a Scroll of
  Regeneration**, now stocked by **Vesper the glimmer-mage** (60 shards).
- **Admin knows every recipe (testing aid)** — on login the auto-created `admin`
  is granted all recipes in the world (re-synced each login, so recipes added
  later are picked up automatically). Lets a maintainer exercise any `craft`
  without first hunting down the scroll. Non-admin players are unaffected.
- **Prospector gear at the quartermaster** — Garrick now stocks three basic
  pieces alongside the leather kit: **a prospector's hatchet** (a slow, heavy
  `1d8` axe that scales its bite with Might — `floor(Might/2)`, the first weapon
  to scale faster than the default `Might/4`), **an iron helm**, and **an iron
  cuirass** (both armour 2). The two iron pieces hit harder on protection than
  boiled leather but carry a new **`attrMod`** cost: each dulls **Wits −1**, and
  since Wits feeds Ward and evasion, heavy iron trades awareness for plate.
- **Gear can now modify attributes (`armour.attrMod`).** A general
  `{ "attrMod": { "wits": -1, … } }` block on armour shifts the wearer's
  effective attributes (floored at 0), flowing through to-hit, melee/spell
  damage, Ward and evasion via a single `effectiveAttributes` helper. Item
  examine shows the modifier, and weapons now display their damage `scale`.
- **Player levels & attribute training (`train`)** — XP is now spent, not just
  hoarded. `xp` is a lifetime total; reaching the next level costs
  `XP_BASE × XP_GROWTH^(level-1)` (defaults **100**, doubling each level — all in
  `config.js`). Each level grants **2 attribute points** (`POINTS_PER_LEVEL`),
  banked as `unspentPoints`. Spend them with **`train <attribute>`** (might,
  vitality, intellect, wits, perception); `train` with no argument shows your
  level, XP progress, and unspent points. Raising vitality/intellect lifts the
  HP/MP cap and grants that capacity immediately (current pools rise by the same
  delta — felt at once, but no free heal). A level-up hails the slayer in **gold**
  in the console and broadcasts the moment to the room. The player panel shows
  unspent points next to the level. Existing saves backfill `unspentPoints` to 0.
- **More ways to earn XP (kills aren't the only source).**
  - **Shared kill XP** — everyone who fought a mob now earns the **full** XP when it
    dies, not just whoever landed the killing blow. Participants are read from the
    mob's existing threat table — anyone who actually traded blows with it (dealt
    damage or was struck, i.e. threat > 0), plus the finisher; merely standing in
    the room with a hostile mob doesn't count. So grouping is rewarded rather than
    taxed, without letting a bystander leech. The finisher sees `(+N xp)` in
    the slay line; co-fighters get a "you help bring down …" assist note. Co-op,
    no division (Model A); threat-weighting can layer on later.
  - **Crafting XP** — a successful `craft` grants XP equal to the output's **sale
    value × quantity**, so the reward scales with what you made (and thus the
    rarity/cost of its inputs); spamming a cheap recipe pays almost nothing.
  - **Exploration XP** — the **first** time a delver enters a room they earn
    `EXPLORE_XP` (default **5**, in `config.js`), tracked per player in
    `visitedRooms`. Rewards descent into new ground; each room pays once. Existing
    saves seed `visitedRooms` with the current room (no retroactive windfall).
- **Cooking — the inn's hearth & three meals** — the Lantern's Rest gains a
  `hearth` crafting fixture (new `cooking` station), turning the inn's
  long-described hearth into a usable cook-pot. Every delver now starts knowing
  three cooking recipes: **Mushroom Soup** (`palecap-mushroom ×2`, finally making
  Maeve's signature craftable rather than buy-only), **Bug-Meat Skewer**
  (`bug-meat ×1` → a hearty `+8 HP` meal), and **Roasted Grubs** (`grub ×3` → a
  cheap `+4 HP` snack). Raw **grubs** are now edible too (`+1 HP`, "cheap food in a
  pinch"), keeping their bait identity reserved for a future fishing pass. **Maeve
  now sells all three cooked dishes** alongside the soup. Closes the
  farm → cook → heal loop entirely from the Rim's agricultural quarter.
- **Beer at the Lantern's Rest** — Maeve now sells a **mug of beer**, the Rim's
  own cellar-brewed small beer: a light refreshment (`+2 HP / +4 MP`) that steadies
  the nerves between descents. Groundwork for later brewing/cooking recipes that
  use it as an ingredient.
- **An "agricultural" quarter at the Rim** — two new rooms grow off the Lightbug
  Hatchery, turning it into the settlement's farming corner:
  - **The Stockpens** (`rim.corral`, north of the hatchery) — the Rim pens
    **stonebugs** here, fattened for meat, shell, and tallow, tended by **Bray the
    stockherd** (who also sells meat). The penned bugs are non-hostile, so a green
    delver can learn the melee + loot loop safely (auto-retaliation still makes
    them swing back when struck) before braving the descent. Bugs now yield a new
    **bug-meat** drop — from stonebugs (always) and thornbugs (sometimes) — a
    cheap, raw-edible food that mends a little HP.
  - **The Mushroom Beds** (`rim.mushroomfarm`, west of the hatchery) — lit by the
    hatchery's spillover bug-glow (fungus grows only under light), the beds yield a
    **regrowing crop of palecap mushrooms** (harvested off the floor, regrows on a
    tick) and a couple of grazing **grubs** for the picking.
- **Sit & sleep — rest & recovery (`sit` / `sleep` / `stand`)** — posture is now a
  first-class actor state and the **only** way to recover HP (mana still trickles
  while standing). `sit` (alias `rest`) mends **1 HP and 1 MP every 5 ticks**;
  `sleep` mends **1 HP and 1 MP every 2 ticks** but blinds you — while asleep your
  perception reads as 0 and the room as dark, so you can't see what's around you.
  Sitting has no effect on sight. Being struck (melee or hostile spell) instantly
  **rouses you to standing** and (via auto-retaliation) into the fight; moving,
  attacking, or casting also stands you first. Resting is barred mid-fight. Rest
  recovery *replaces* the standing mana trickle (no double-dipping). Posture is
  **shared with mobs**: a mob template may declare `"posture": "sitting" | "sleeping"`
  to author a dozing guardian or resting NPC — inert (no wander/attack/emote) until
  a blow wakes it, enabling ambush-style openings. Posture is broadcast to the room
  and tagged in others' views ("Bob (asleep)"); resets to standing on login.
- **Auto-retaliation on being hit** — when a player is struck by a mob or
  targeted by a hostile spell, they now automatically engage in combat without
  needing to manually type `attack <mob>`. If already in combat with another
  target, they stay focused on their current opponent. Eliminates input delay
  during multi-mob engagements, mirroring classic MUD behavior.
### Changed
- **One farmer for the Rim's farming quarter** — removed **Bray the stockherd**
  and re-cast **Wick** (formerly the lightbug-keeper) as **Wick the rim-farmer**,
  who now tends all three farming sheds — the hatchery, the stockpens, and the
  mushroom beds — single-handed from the hatchery hub. She inherits Bray's
  **bug-meat** trade, so the meat is still purchasable, and the stockpen/mushroom-
  bed room descriptions now name her as their keeper.
- **Spent torches crumble away** — when a non-refuellable light (a torch) burns
  its last fuel, it's now consumed entirely instead of lingering as a dead husk
  in the light slot ("gutters out, burns to ash, and crumbles away"). Refuellable
  lights (the lantern) still keep their shell so you can `refuel` them.
- **`buy` now Tab-completes** — the argument cycles through the wares of any
  trader in the room (the client now receives each shop's `sells` list), matching
  the existing completion for `get`/`sell`/etc.
- **Player panel header reflow** — shards moved to their own line below
  `Lv · pts · xp` (the four-part line no longer overflows narrow panels), and
  unspent training points now render in gold so they catch the eye and prompt a
  visit to `train`. Points still only appear when you actually have some.

### Fixed
- **Stackable loot now merges on the floor** — dead grubs, chitin, and other
  stackable drops were each pushed as a separate floor entry, so a cleared nest
  read as a wall of identical "a dead grub" lines instead of "a dead grub ×3".
  A new shared `addToFloor` helper merges into an existing stack (mirroring
  `addToInventory`), used by both mob loot drops and the `drop` command. (The
  items were already flagged `stackable`; only the floor side failed to merge.)
- **Death snuffs your lights and clears transient effects** — respawning at the
  rim now extinguishes every carried light (equipped or stowed) and ends any
  active status effects (potions, venom, bleeds, glows). Effects sustained by
  worn/carried gear (tagged `source: "item"`) persist, since the gear is still on
  you when you wake.
- **Tab completion now works for `craft`/`make`** — recipe names are multi-word
  ("Iron Dagger", "Minor Light Potion"), but the completion candidates were run
  through `lastWord`, collapsing them to just the trailing word ("dagger",
  "potion", "bar"). Typing `craft iron`+Tab matched nothing and did nothing. The
  argument now completes against the full lowercased recipe name — exactly what
  `learn` tells you to type and what the server's craft matcher accepts.
- **Mob status-effect expiry now announced** — when a status effect (venom,
  bleed, glow, …) wears off a mob, players in the room now see a message
  (e.g. "The venom drains from the cave bat."), gated by `canSeeMob` like other
  mob events. The `mob-effect-expired` event had no dispatch handler and was
  silently dropped; it mirrors the player-side `effect-expired`.
- **Tab key command completion** — autocompleted commands now include a trailing
  space, allowing players to immediately continue typing the argument without
  manually adding a space. Improves rapid command entry.
- **Grub corpse renamed to disambiguate from the live mob** — killing a grub
  dropped an item also called "a grub", so the living larva and its remains read
  identically in room and inventory listings. The dropped item is now **"a dead
  grub"** (`grub` template id unchanged, so recipes/`get grub` still work).
- **Mushroom Beds regrew too fast** — the farm's palecap mushrooms and grubs
  refilled on a 30-tick (30s) timer, trivializing the gather loop. Both now
  `respawn: 120` (2 minutes), matching the abyss palecap and giving the harvest
  a meaningful wait.
- **Tab cycling through multiple completions** — repeatedly pressing Tab now
  rotates through all matching proposals again. The trailing-space change broke
  cycling: the stored cycle-`base` wasn't updated after each rotation, and the
  `head` (text before the token) was recomputed from a value that now ended in a
  space — so the second Tab fell through and recompleted from scratch instead of
  advancing. The cycle now keeps the original `head` and refreshes its `base`.
### Added (continued)
- **Multiplayer test subagent** — a `multiplayer-tester` agent
  ([.claude/agents/multiplayer-tester.md](.claude/agents/multiplayer-tester.md),
  runs on Sonnet) that drives several browser clients at once to verify
  cross-player sync: item drop/pickup & inventory, light-level broadcasting,
  player movement/room-leaving, and combat/aggro/healing state. Reports pass/fail
  with concrete evidence (console broadcasts, light meter, room contents). Manually
  verified the first three scenarios pass against the current build.
- **Generalized defender-side triggers — `onDamage`** — the narrow reflect-only
  `spikes` is now a special case of a general **when-struck** trigger list,
  mirroring the attacker's `onHit` through the same `applyHitOutcome` dispatch. An
  `onDamage` entry is any effect spec (instant `damage`, `damage-over-time`,
  `restore`, `emit-light`) plus two axes the attacker side doesn't need: `target`
  (`"attacker"` to reflect/retaliate, `"self"` to e.g. draw mana off a blow;
  default `"attacker"`) and `on` (which damage sources fire it; default
  `["melee"]`, with `"spell"` reserved for a later `castSpell` wiring). A
  `target: "attacker"` DoT credits a defending player on the kill, mirroring
  `onHit`. **`spikes` is kept as terse sugar** for the commonest entry (a flat
  melee reflect), so existing data (the thornbug) is unchanged. Lives on a mob's
  `onDamage` and, identically, on an item's `armour.onDamage` — ready to power
  player gear (mana-leech mail, retaliatory plate) as pure data. Validator and
  [docs/data-model.md](docs/data-model.md) updated; verified by simulation.
- **Combat triggers — on-hit effects (`onHit`) & reflect (`spikes`)** — two
  symmetric, data-driven melee primitives wired through one shared strike-outcome
  path (`applyHitOutcome`) so player→mob and mob→player both get them. **`onHit`**
  (attacker side) lands a list of effect specs — e.g. a `damage-over-time` venom —
  on the defender when a blow connects; a player attacker is credited if the DoT
  lands the kill. **`spikes`** (defender side) reflects flat contact damage back at
  anyone who strikes it in melee. Both are melee-only (spells/ranged are exempt);
  DoT ticks bypass armour, reflect is small and flat. Lights up the two fauna that
  shipped flavour-only: the **cave centipede**'s bite now festers (venom DoT) and
  the **thornbug** now punishes handling (spikes). The same `weapon.onHit` /
  `armour.spikes` blocks are ready to power player gear in a later PR. `examine`
  telegraphs both ("Venomous — its bite festers." / "Spined — striking it draws
  blood."); validator and [docs/data-model.md](docs/data-model.md) updated.
- **Top-floor fauna (templates + materials + lore)** — ten new creature templates
  fleshing out the upper Abyss as a living, light-sorted ecosystem: the **feral
  mongrel** (surface dog gone wild), the **stonebug** and **thornbug** (armoured
  pillbug grazers that bite back), the **grub** (prey base), the **scour-slug**
  (light-vulnerable cleaner), the **cave centipede** (margin-hunter, deadly in dim
  light), the **pale salamander** and **tremor-mole** (light-fearing, flee), and the
  **pale crayfish** (aggressive) and **blind cave-fish** of the pools. Each yields a
  **material** — **chitin plate** (stonebug), **chitin spike** (thornbug), **slug
  slime** (scour-slug), **grub**, **venom gland** (centipede), **salamander tail** —
  the biological half of the crafting economy beside iron/glimmer. Grounded in a new
  **"Top-floor fauna & the lit food web"** section in [docs/lore.md](docs/lore.md):
  vegetation grows only in light, so grazers gather at lit patches and hunters work
  the dim margins. **These are dormant templates** — not yet spawned in any room, and
  with no recipes consuming the materials; both come in later PRs. (Thornbug spikes
  and centipede venom are flavour for now; the on-hit mechanics are future work.)
- **Light-roused aggression (`lightAggro`)** — a mob may now carry a
  `lightAggro: { above }` block: it stays calm in the dark but is provoked to
  attack once room light rises past `above` (the inverse of `flee`, which repels).
  This makes light a *risk* as well as a tool — you light a room to see and search
  it, but some creatures wake when you do. First user: the **gloom-crawler**, now
  a four-step light ladder — calm in darkness (0), deadly in dim light (1–2),
  enraged but glare-blinded in bright light (3, via its existing `harmedAbove`),
  and singed then fleeing above that (4+, `lightBane` + `flee`). It is now
  `hostile: false` by default; `examine` telegraphs "Calm in the dark — light
  rouses it." Once it lands a hit it holds its threat (dousing your light mid-fight
  won't instantly calm it) — full threat decay is future work.
- **The Mage's Shed + Vesper the glimmer-mage** — a new Rim room (east off the
  market) for a scholar-mage NPC (**Vesper**), a future trader and quest-giver
  (no stock yet — trades TBD). The **alchemist's bench** moves here from the
  Craftsmen's Row (alchemy recipes now craft at the Mage's Shed); the Row keeps the
  forge and smelter for metalwork. The **Scroll of Spark** moves to Vesper's stock
  (from Garrick), making her the Rim's source for spells.
- **The Lightbug Hatchery + Wick the keeper** — a new Rim room (north off the
  market) where lightbugs are farmed for portable light and luminous glands, tended
  by a passive keeper NPC (**Wick**). The wild lightbugs in the abyss are now framed
  as the source the Rim breeds from. An **Umbral relief** scenery fixture (a very old
  carving) appears in *The Collapsed Gallery*, the first hint of the Umbrals.
- **World & lore reference** ([docs/lore.md](docs/lore.md)) — canon for the Abyss,
  glimmer (the frozen light of the Dark Star), the Glimmer Rush, the Rim, the
  Umbrals (and their glimmer-mutated deep-dweller kin), the depth-scaled threat
  ladder, and consistency rules for authored/AI-generated content. Linked from
  `DESIGN.md` and `CLAUDE.md`.
- **`search` command + hidden features** — `search` combs the current room for
  concealed exits, objects, fixtures, and creatures, gated by your **effective
  Perception**: your Perception attribute scaled by how well you can see the room
  (the same light tiers combat uses — darkness ×0.05, dim/glare ×0.5, clear ×1.0).
  So you must bring light to find what's hidden. Searching costs a slice of energy.
  Features carry a `hidden: { perception }` requirement (on a room's groundItem,
  spawn, or fixture entry, or in a new `room.hiddenExits` map). Found exits,
  fixtures, and objects are remembered **per-player, permanently** (`player.discovered`,
  persisted); hidden **creatures** are revealed **ephemerally** (only for the current
  room visit). First secrets: a **worn maker's mark** in the Craftsmen's Row, a
  **15-shard cache** in the Collapsed Gallery, a **concealed crawlway** linking the
  Spore Vault and the Echoing Fissure, and **a cave lurker** in the Sunken Cut.
- **Neutral retaliation** — a non-hostile creature that gets attacked now fights
  back (it acts on the threat it gains), where before only `hostile` mobs ever
  struck. Gated on having an `attack` block, so friendly NPCs (shopkeepers) stay
  passive. This lets the new **cave lurker** be neutral until provoked: unseen and
  inert until you `search` it out, harmless once revealed, dangerous only if you
  strike first.
- **Mining** — a new `mine` (alias `dig`) command works ore loose from a resource
  vein in the room. Veins are data-driven fixtures (`type: "resource"` + a `mine`
  block: ore template, yield, charges, respawn, energy) that deplete as they're
  worked and refill on a timer, like spawners and harvesters. Mining is heavy
  work — each swing costs a large slice of energy, so a seam takes many ticks to
  clear. The first **iron vein** sits in *The Collapsed Gallery*. `examine` shows a
  vein's remaining yield.
- **Iron crafting loop** — `iron ore` → smelt to an `iron bar` at a new **smelting
  furnace** in *The Craftsmen's Row* (`smelting` station) → forge an `iron dagger`
  (1d4, faster than the short sword) at the existing forge anvil. Both are `craft`
  recipes (`craft iron bar`, `craft iron dagger`); new characters know both, so
  mined ore has somewhere to go.
- **Glimmer refining chain** — the old `crystal` is now a **glimmer crystal** (the
  rarer, combat/quest-locked form of glimmer; shards are its loose, spendable form).
  Either can be ground to **glimmer dust** — `craft glimmer dust` (1 crystal) or
  `craft pressed` (70 shards) — a reagent worth less than its inputs, so refining is
  a deliberate sink with no money loop. Dust + an iron bar smelts into a
  **glimmersteel bar** (`craft glimmersteel`), stock for finer gear to come.
- **Searing flare** — `craft flare` (1 glimmer dust + 1 luminescent gland, at the
  alchemist's bench) makes a one-use flare you `use` to flood the room with searing
  light (magnitude 10 for 30 ticks): it sears every light-bane creature present each
  tick, while the glare drops everyone's hit chance — yours included — to the
  "searing"-band penalty. A deliberate, double-edged tool. Its recipe isn't known by
  default: **Tobin the tinker-smith** now sells a **flare schematic** (5 shards) you
  `learn`/`study` to commit the method to memory.
- **Consume routing** — `use <item>` is now the catch-all activator for carried
  consumables (potions, flares), and `eat` joins `drink`/`quaff`; the verb you type
  shapes the flavour ("You use/eat/drink …"), with `use` still toggling fixtures.
- **Learn recipes from items** — `learn`/`study` now teaches **recipes** from a
  schematic, not just spells from scrolls; both consume the item and follow the same
  flow. New item `type: "recipe"` with a `recipe` field, validated against recipes.
- **Admin** — `@shards <amount>` sets the caller's purse, for testing.
- **Crystal** (placeholder name) — a sellable `treasure` item worth 45 shards.
  **Gnaw, the Brood-Mother** now drops one on death, giving her kill a payoff.
- **Leather helm** (+1 armour, new `head` slot), sold by Garrick alongside the
  **leather jerkin** (now also on his shelf). New characters start **without** the
  jerkin, and the `body`/`head` slots seed empty so `unequip` works from the start.

### Changed
- **Tick-loop scaling (no behaviour change)** — three hot paths that rescanned
  the whole world each tick are now index-backed, so cost tracks active rooms
  rather than total world size:
  - a **room→players occupancy index** (`playersByRoom`) makes `state.playersIn`
    O(occupants) instead of a full player scan; every `player.location` write now
    routes through `setPlayerLocation`/`admit`/`removePlayer` to keep it honest.
  - the **per-tick light recompute** skips rooms with no players and no mobs —
    their light can't change between the events that already recompute it.
  - **spawner population** is tracked with a running per-spawner count
    (`_countOwned` is now a map lookup) instead of rescanning every room's mobs
    for each spawner each tick.
- **Lore-consistency pass over the Rim and the abyss' first level** (against
  [docs/lore.md](docs/lore.md)): the Rim now reads as a recently-sprung **Glimmer
  Rush boomtown** rather than an old town, and names glimmer as the trade; Maeve's
  bio drops the (non-canon) "last great delve"; the Collapsed Gallery's ancient
  worked stone is now **Umbral** (not "old diggers"), while the Sunken Cut is plainly
  a **prospector's** recent dig; *The Glimmer Hollow* is renamed *The Lightbug
  Hollow* so the glimmer *mineral* and lightbug *bioluminescence* stop colliding.
  Lightbug spawns moved from the plaza to the new hatchery.

### Fixed
- **Tab key command completion** — autocompleted commands now include a trailing
  space, so players can immediately type the argument without manually adding a
  space. Improves rapid command entry.
- **Auto-retaliation events now reach the client** — `combat-auto-start` (and the
  new `player-woke` / `mob-woke`) had no handler in the tick-event dispatcher, so
  the "you fight back" line was silently dropped; all three are now narrated.
- Mob wandering no longer causes difficulty spikes: only **lightbugs** wander now.
  Gloom-crawlers, giant rats, and cave bats stay in their authored rooms (the
  crawler still *flees* a bright light), so hostiles no longer drift together into
  unexpected pile-ups.
- Command line keeps focus: clicking a chip/exit/action returns focus to the input,
  and typing a printable key anywhere snaps focus back to it (Ctrl/Cmd combos left
  alone so copying log text still works).
- Fixture examine hints use the readable name (`use iron lamp`) instead of the
  internal instance id (`use fixture.10`).

### Added
- **The Shallows** — a 10-room beginner area branching off the First Dark (same
  level, no new up/down). A fungal line (Dripping Tunnel → Fungal Grotto → Spore
  Vault) gated by gloom-crawlers, a vermin loop (Bat Roost ↔ Echoing Fissure ↔
  Collapsed Gallery → Rat Warren), and a southern descent (Glimmer Hollow →
  Sunken Cut → the Brood-Mother's Den). New mobs: **giant rat**, **cave bat**, and
  mini-boss **Gnaw, the Brood-Mother**. New scenery fixtures, two of which glow
  (witchglow cluster, narrow fissure) via a fixture-level `emitsLight`.
- **Renewable harvest nodes**: a `groundItem` may carry a `respawn` (ticks); a
  picked-up item regrows on a timer (tagged so dropping a like item won't block
  it). First nodes: **palecap mushrooms** (edible) and **witchglow caps** (glowing,
  poison) in the Shallows.
- **Pale mushroom soup**: a consumable that restores **+5 HP / +5 MP** (clamped),
  sold by Maeve at the inn for 5 shards. Introduces an instantaneous **`restore`**
  effect type (heal hp/mana) alongside the timed status effects.
- **`flee` behaviour**: a light-triggered mob action — when room light rises above
  its `lightAbove`, the mob bolts for a random exit, overriding all else (even
  combat). Gloom-crawlers flee light above 3.
- **Light as a weapon + general damage scaffolding**: all HP loss now flows through
  shared sinks (`_hurtMob`/`_hurtPlayer`), so deaths can come from the room or an
  effect, not just a blow — spoils drop where the victim falls; XP is credited only
  when a player is responsible. **Light-bane** (`lightBane: { above, damage }`) sears
  any mob standing in light above its threshold (deep-dweller, and the boss Gnaw),
  and a **`damage-over-time`** status primitive (bleed/poison) is ticked on both
  players and mobs (scaffolding; no bleed content authored yet).
- **`start-server.bat`**: double-click launcher at the repo root — checks for Node,
  installs deps on first run, and starts the server at http://localhost:3737.
- **Item values & data-driven trade**: every item carries a buy `value` (sell price
  defaults to 20%, overridable via `sellValue`). A trader sells its stock at value
  and **buys any valued item** at its sell value — pricing comes from item data, not
  a per-trader buy script (the `shop.buys` list is gone). Examine shows an item's
  value and sell price. Garrick now stocks torch, lantern, oil, and vials.
- **Refuellable lights**: a fuelled light may declare a `fuelItem` + `refuelPerUnit`;
  `refuel`/`fill <item>` tops it up from that item. The brass lantern burns
  **a flask of oil** (sold by Garrick) — so a lantern is a reusable investment, while
  the torch stays a disposable replace-it light. (Refuelling the fixed shaft *lamp*
  is deferred — it stays lit for now.)
- **Crafting loop**: `craft <recipe>` at a matching station fixture consumes the
  recipe's inputs (and an optional **shard cost**) and yields the output. Recipes
  are **learned** (`knownRecipes` on the character; `recipes` lists them). First
  recipe — Minor Light Potion (gland + vial + 5 shards) at the alchemist's bench.
- **Status-effect primitive**: actors carry timed effects (`player.states`) from a
  data-driven spec `{ type, magnitude, duration }`, reusable by potions and (later)
  spells. First primitive `emit-light` makes the actor radiate light (summed into
  room light, glows in the view, expires on its own countdown).
- **Potions**: `drink`/`quaff`/`use <potion>` applies its effect. Minor Light Potion
  (emit 1 light for 3 min) and a stronger Light Potion.
- **Switchable fixtures**: a fixture can carry a `switch` block; `use`/`switch`
  `<fixture>` toggles it. An iron **lamp** at the Mouth of the Shaft emits 3 light
  when on (dim → bright), and lit fixtures glow in the room view.
- **Shards drop on the floor** on a kill (a shared-world pile anyone can `get`,
  tallying to their balance) instead of auto-crediting the killer. Gloom-crawler
  drops 1d4 shards.
- **Ward** — a second defence channel parallel to Armour: physical damage is
  soaked by Armour, magical by Ward. Mobs gained an innate `ward` (deep-dweller 1).
  Armour and Ward are now shown in the player panel.

### Changed
- Removed the mechanically-inert `flint` (template, starting inventory, loot);
  `admit()` prunes orphaned-template items so older saves load cleanly.
- Moved the empty vial from The First Dark to The Craftsmen's Row.

### Added
- **The Rim — first authored zone**: a 7-room starting area (replacing the
  placeholder slice) — a lantern-lit village (plaza, inn, market, craftsmen's row,
  descent gate, shaft mouth) over the first dark abyss room. Light gradient
  bright→dim→dark from buildings to the descent.
- **Friendly NPCs** with personality emotes (low-chance, ~once/10s): Maeve the
  innkeeper, Garrick the quartermaster, Tobin the tinker-smith. Stationary,
  non-hostile, examinable.
- **Trading + shards currency**: a mob `shop` block (`sells`/`buys` at shard
  prices) plus `list`/`buy`/`sell` commands. `shards` is the player's abstract
  money (shown in the panel). Garrick buys luminous glands and sells torches —
  the first economic loop (harvest light → fund light).
- **Mob repop**: spawn rules take an optional `respawn` (ticks); a spawner below
  its `max` refills one mob per interval into its home room. The cap counts a
  spawner's mobs wherever they wandered, so roaming never multiplies them.
- **Zone-scoped wandering**: `wander` is now a data-driven mob action with a
  `scope` (`"zone"` confines a mob to its current zone, `"any"` crosses zones).
  Replaces the old `move` action. Mobs no longer wander out of their area.
- **Aggro/threat table** on mobs (`{ playerId: threat }`): attacking earns threat,
  hostile mobs engage delvers present, and a mob in combat won't wander and
  strikes its highest-threat target. Minimal seed for a fuller threat system.
- Light-emitting entities (lightbugs, future glowing NPCs) now **glow** in the
  room view via a generic `.chip.luminous` halo + pulse.

### Changed
- Persisted players with a now-missing `location` (e.g. after content rework) are
  clamped to the start room on login instead of crashing.

### Added
- **Context-aware TAB completion**: the first word completes commands; the
  argument completes from what that command can act on — `remove`→equipped gear,
  `get`→ground items, `drop`/`equip`→inventory (equip only equippable),
  `attack`→mobs here, `look`→everything examinable, `go`→exits, `light`→light
  sources. `examine`/`x` added as aliases for `look`.
- **Weighted mob AI**: each mob has an `actions` table and takes one weighted
  action per tick from those available — `attack`, `emote` (flavour lines),
  `move` (wander/flee to an adjacent room, carrying its light), or `idle`. Gives
  mobs fight/emote/flee personalities; unseen mob actions read as "Something …".

### Changed
- Mobs now have an innate `armour` value (symmetric with players) that reduces
  incoming physical damage: lightbug 0, gloom-crawler 1, deep-dweller 2.
- Leather jerkin armour lowered from 2 to 1.

### Added
- **Equipment management**: `equip`/`wield`/`wear <item>` equips from inventory and
  stows whatever was in that slot; `unequip`/`remove <item|slot>` returns gear to
  inventory. Fills the gap where a held item (e.g. a torch) couldn't be replaced.
- `light` now takes an optional `<item>` and **auto-swaps a spent light** for a
  fuelled one from inventory — so a dead torch is replaced and lit in one command.
### Added
- **Combat + Energy/action-point economy + mob AI**: tick-driven attacks gated by
  banked `speed` energy (`attack`/`kill`/`stop`); damage = weapon dice + (Might−5)
  − Armour. **Light-gated accuracy (four tiers)** via per-actor `blindBelow`/
  `dimBelow`/`harmedAbove`: can't-see 5% · partial/dim 50% · clear 100% · glare
  50% — so a torch lifts you from dim to clear *and* drops light-sensitive foes
  into glare.
  Hostile mobs attack players in their room. Death: mobs drop loot + grant XP;
  players respawn at the rim (no penalty, v1). Mobs gained attack stats + XP.
- Examine view shows an **Attack** action button for creatures (clicking it issues
  `attack <id>`); the target's HP bar updates live as you fight.
- Combat log hides the name of a creature you can't see: an unseen attacker reads
  as "**Something** hits you", not its name (computed per recipient; self-lit mobs
  are still named). Bystander lines hide unseen names too.
- `server/dice.js` dice roller; validator now checks mob attack dice notation.
- World-interaction commands: `get`/`take`, `drop`, `inventory` (stackables merge;
  picking up requires light). Social: `say`, `emote`.
- **Room-presence broadcasts**: other players in the room see speech, emotes,
  arrivals/departures, and pick-ups/drops, and their room view refreshes when
  contents change — the shared world now feels live with multiple delvers.

### Changed
- Raised the **searing** threshold to `10+` (bright now spans `3–9`) and the light
  clamp ceiling to `20`, so searing is exceptional — a torch plus a few lightbugs
  stays *bright*. Human harm threshold bumped to `9` to keep harm aligned with searing.

### Added
- **Examine view**: `look <target>` and clicking an entity now render its detail
  in the Inspect window (name, kind, description) with an extensible payload —
  HP bars for mobs/players, item spec lines (damage/armour/light), and
  interaction hints (e.g. crafting). A "↩ back to room" control and any room
  update return the window to the live room view.
- **Player accounts & persistence** (`server/accounts.js`): one JSON file per
  character under `data/runtime/players/` (gitignored), saved on disconnect and
  periodically; characters resume their saved state (location, hp, inventory…).
- **Name-only login flow**: on connect the client's first input is the delver
  name; the server loads that account or rejects unknown names.
- **Admin account**, auto-created on first boot, with `@`-prefixed admin commands
  (`@create-player <name>`, `@list-players`, `@help`). Account creation is
  admin-only for now (self-registration with rules comes later).
- Runtime id counter is seeded past loaded account ids to avoid collisions.
- Node + `ws` **server skeleton** (`server/`): loads static world into a frozen
  in-memory object, authoritative `GameState` (per-room mob/item instances,
  players), the light model (`bandOf`/`effectiveLight`/`canSee`/`isHarmedByLight`),
  a 1s living-world tick loop, and periodic JSON snapshots to `data/runtime/`.
- Single shared HTTP + WebSocket server on **port 3737** (test on **3738**),
  with a temporary dev console served at root until the real client lands.
- `package.json` (`npm start`, `npm run validate`) with `ws` dependency.
- **Browser client** (`client/`): four-pane UI (console / inspect / player panel /
  status strip / command line), WebSocket wiring, command history (↑/↓), TAB
  completion, and click-as-command on room entities/exits.
- **Light-reactive inspect window**: live atmospheric tint per band
  (darkness → near-black placeholder, dim → desaturated, bright → normal,
  searing → dark panel with shimmering blown-out white text/glow + harm warning).
- Structured `room`/`player` view protocol; server commands `look`, movement,
  `light`/`douse`, `help`; per-tick fuel burn that guts lit lights when spent.
- `.claude/launch.json` preview config.
- **Unique runtime ids** on every addressable entity (`player.N`/`mob.N`/`item.N`/
  `fixture.N`); targeted commands resolve by id first then name, and client
  clicks address entities by id (unambiguous even with duplicate names).
- `docs/data-model.md` — full JSON data-model spec (static vs. dynamic split,
  light scale, per-actor perception bands, room/item/mob/fixture/recipe/player schemas).
- `data/world/` — sample authored world: 6-room vertical slice (rim settlement →
  descent shaft → dark depths), 9 item templates, 3 mob templates, 2 fixtures, 1 recipe.
- Weapon damage uses **dice notation** (`"1d6"`, `"2d4+1"`); player starts with a short sword.
- `data/templates/player.json` — starting-character template.
- `tools/validate-data.js` — validates JSON, cross-references, and room reachability.

## [0.1.0] — 2026-05-31
### Added
- Initial project bootstrap.
- `DESIGN.md` — consolidated design document (draft v0.1): pillars, core loop,
  light system, attributes & combat, world model, interface spec, architecture.
- `VERSION`, `CHANGELOG.md`, `.gitignore`, `CONTRIBUTING.md`.

[Unreleased]: https://github.com/bluedragon-ctrl/Lumen/compare/v0.6.0...HEAD
[0.6.0]: https://github.com/bluedragon-ctrl/Lumen/compare/v0.1.0...v0.6.0
[0.1.0]: https://github.com/bluedragon-ctrl/Lumen/releases/tag/v0.1.0
