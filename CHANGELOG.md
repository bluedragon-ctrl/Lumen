# Changelog

All notable changes to **Lumen** are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]
### Added
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
### Fixed
- **Mob status-effect expiry now announced** — when a status effect (venom,
  bleed, glow, …) wears off a mob, players in the room now see a message
  (e.g. "The venom drains from the cave bat."), gated by `canSeeMob` like other
  mob events. The `mob-effect-expired` event had no dispatch handler and was
  silently dropped; it mirrors the player-side `effect-expired`.
- **Tab key command completion** — autocompleted commands now include a trailing
  space, allowing players to immediately continue typing the argument without
  manually adding a space. Improves rapid command entry.
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

[Unreleased]: https://github.com/bluedragon-ctrl/Lumen/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/bluedragon-ctrl/Lumen/releases/tag/v0.1.0
