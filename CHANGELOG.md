# Changelog

All notable changes to **Lumen** are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]
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
