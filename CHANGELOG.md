# Changelog

All notable changes to **Lumen** are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]
### Added
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
