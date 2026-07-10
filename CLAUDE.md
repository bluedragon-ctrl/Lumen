# Lumen — working instructions for Claude

A browser-based MUD of descent, light, and survival. Node + `ws` server, vanilla
4-pane client, JSON-driven world data, no SQL.

## Workflow — READ THIS FIRST (non-negotiable)

**`main` is protected. NEVER commit directly to `main`.** Every change lands via
pull request:

1. Branch off `main`: `feat/…`, `fix/…`, `docs/…`, `refactor/…`, or `chore/…`.
2. Make the change on that branch.
3. **Run `npm run validate`** (`node tools/validate-data.js`) **and `npm test`**
   before committing — the validator checks JSON validity, cross-references, and
   room reachability; the tests cover light, combat, pathfinding, and the world
   clock. Both must exit 0.
4. Commit with [Conventional Commits](https://www.conventionalcommits.org/)
   (`feat:`, `fix:`, `docs:`, `refactor:`, `chore:`, `test:`, `perf:`).
5. Update `CHANGELOG.md` under `[Unreleased]` as part of the change.
6. Push the branch and open a PR into `main` with `gh`.
7. **The maintainer reviews and merges** (squash), then deletes the branch.
   Do not self-merge unless explicitly told to.

If you find yourself on `main` with uncommitted changes, stop and move them to a
branch before committing. Full conventions live in [CONTRIBUTING.md](CONTRIBUTING.md).

## Running it

- `npm start` — live server on port **3737**. Test instance uses **3738**.
- The preview/dev server does **not** hot-reload server code — restart it after
  changes to `server/` to see new behaviour. JSON data is re-read on restart too.
- Login is name-only. An auto-created `admin` can `@create-player`.

## Layout

> **This is a small codebase** — read files directly rather than spawning search
> agents, and don't re-read a file an agent already reported on. The spine:
> `server/commands.js` (dispatcher, delegating verbs to `server/commands/*.js`),
> `server/state.js` (`GameState` core; the tick loop is `advance()`) with its
> `server/state-*.js` mixins (mob AI, tide, spells, effects), and
> `data/world/*.json`. Systems-as-implemented reference: [server/README.md](server/README.md).

- `server/` — game server (tick loop, light, combat, factions, quests, tide,
  spells, commands, state). See [server/README.md](server/README.md).
- `data/world/*.json` — rooms, mobs, items, fixtures, recipes, spells, quests,
  tide. `data/templates/player.json` — new-player seed (inventory,
  `startEquipment`, known recipes).
- `client/` — vanilla 4-pane browser client.
- `test/` — `node --test` suite (`npm test`): light, combat, pathfinding, world clock.
- `docs/` — [data-model.md](docs/data-model.md) (JSON schemas),
  [templates-quickref.md](docs/templates-quickref.md) (**start here when authoring
  content** — condensed field reference), [lore.md](docs/lore.md) (**canon world &
  lore**, consistency rules included), [side-areas.md](docs/side-areas.md), and
  `docs/superpowers/specs/` + `plans/` — written designs for shipped and upcoming
  systems (aggro, summoning, room effects…). Read the spec before touching its system.
- `tools/validate-data.js` — pre-commit data validator.
- `tools/release.js` — release cutter (`npm run release`, or double-click
  `tools/release.bat`). Derives the next SemVer
  from the Conventional Commit history since the last tag, stamps `VERSION` /
  `package.json` / `CHANGELOG.md`, commits on a `chore/release-x.y.z` branch, and
  pushes + opens the PR via `gh` (compare-URL fallback if `gh` is absent). Tagging
  after merge stays manual. See [CONTRIBUTING.md](CONTRIBUTING.md) → *Cutting a release*.
- Browser-based world editors — each starts via its npm script or
  `tools/<name>/start.bat`, validates before saving, and can open a PR via `gh`:

  | Tool | Script | Port | Edits |
  |---|---|---|---|
  | `tools/mob-editor/` | `npm run edit-mobs` | 3939 | `mobs.json` NPC stats |
  | `tools/room-editor/` | `npm run edit-rooms` | 3940 | `rooms.json` `biome` / `spawns` / `groundItems` (was the spawn-editor) |
  | `tools/item-editor/` | `npm run edit-items` | 3941 | `items.json` |
  | `tools/recipe-editor/` | `npm run edit-recipes` | 3942 | `recipes.json` (name, station, shards, inputs, output) |
  | `tools/depth-viewer/` | `npm run view-depths` | 3942 (clashes with recipe-editor — override via `DEPTH_VIEWER_PORT`) | nothing — read-only depth map |
  | `tools/biome-preview/` | `npm run preview-biomes` | 3943 | nothing — read-only colour lab; links live `client/styles.css`, emits CSS to paste into `styles.css` + `validate-data.js` (`BIOMES`) |

- `DESIGN.md` — pillars and design intent (living record with shipped/deferred
  markers; mechanics detail lives in `server/README.md`).
  `CHANGELOG.md` — keep-a-changelog.

## Conventions & gotchas

- **Data-driven first.** New content (items, mobs, spells, recipes) should be JSON
  edits, not new code, wherever the existing systems support it.
- **No content without approval.** Build mechanics freely, but names, lore,
  items, mobs, and placement need the maintainer's explicit yes *before* they are
  written into `data/world/*` or `docs/lore.md`. Draft and propose; don't land.
- **Equipment slots are dynamic** — a slot exists once an item declares it
  (`hand`, `body`, `head`, `light` currently). Seed empty slots in
  `startEquipment` so `unequip <slot>` works from a fresh character.
- **Trading is value-driven**: sell price = `sellValue` if set, else 20% of
  `value`; an item needs a truthy `value` to be sellable at all.
- **Shards** are the currency (drop on floor, anyone gathers). Crystals are a
  larger source they break from (name TBD).
- Match the style of surrounding code/data; keep comment density consistent.
