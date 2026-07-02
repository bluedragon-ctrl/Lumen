# Lumen — working instructions for Claude

A browser-based MUD of descent, light, and survival. Node + `ws` server, vanilla
4-pane client, JSON-driven world data, no SQL.

## Workflow — READ THIS FIRST (non-negotiable)

**`main` is protected. NEVER commit directly to `main`.** Every change lands via
pull request:

1. Branch off `main`: `feat/…`, `fix/…`, `docs/…`, `refactor/…`, or `chore/…`.
2. Make the change on that branch.
3. **Run `npm run validate`** (`node tools/validate-data.js`) before committing —
   it checks JSON validity, cross-references, and room reachability. Must exit 0.
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

> **This is a small codebase** — the spine is `server/commands.js`, `server/state.js`,
> and `data/world/*.json` (each a few hundred lines). Read these directly rather than
> spawning search agents; don't re-read a file an agent already reported on. The command
> dispatcher is the `switch` in `commands.js`; the tick loop is `advance()` in `state.js`.

- `server/` — game server (tick loop, combat, light, commands, state). See
  [server/README.md](server/README.md).
- `data/world/*.json` — rooms, mobs, items, fixtures, recipes, spells.
  `data/templates/player.json` — new-player seed (inventory, `startEquipment`,
  known recipes). Data model: [docs/data-model.md](docs/data-model.md).
- `client/` — vanilla 4-pane browser client.
- `tools/validate-data.js` — pre-commit data validator.
- `tools/release.js` — release cutter (`npm run release`, or double-click
  `tools/release.bat`). Derives the next SemVer
  from the Conventional Commit history since the last tag, stamps `VERSION` /
  `package.json` / `CHANGELOG.md`, commits on a `chore/release-x.y.z` branch, and
  pushes + opens the PR via `gh` (compare-URL fallback if `gh` is absent). Tagging
  after merge stays manual. See [CONTRIBUTING.md](CONTRIBUTING.md) → *Cutting a release*.
- `tools/mob-editor/` — browser-based NPC stat editor (`npm run edit-mobs` or
  double-click `tools/mob-editor/start.bat`, port 3939). Edits
  `data/world/mobs.json`; validates and can open a PR via `gh`.
- `tools/item-editor/` — browser-based item editor (`npm run edit-items` or
  double-click `tools/item-editor/start.bat`, port 3941). Edits
  `data/world/items.json`; validates and can open a PR via `gh`.
- `tools/recipe-editor/` — browser-based crafting-recipe editor (`npm run
  edit-recipes` or double-click `tools/recipe-editor/start.bat`, port 3942).
  Edits `data/world/recipes.json` (name, station, shards, inputs, output);
  validates and can open a PR via `gh`.
- `tools/spawn-editor/` — browser-based room spawn & ground-item editor (`npm run
  edit-spawns` or `tools/spawn-editor/start.bat`, port 3940). Edits the
  per-room `spawns` (mob / max / respawn) and `groundItems` (template / qty /
  hidden / respawn) in `data/world/rooms.json`; validates and can open a PR via
  `gh`.
- `DESIGN.md` — pillars and design intent. `docs/lore.md` — **canon world & lore**;
  the reference for authored/AI-generated content (consistency rules included).
  `CHANGELOG.md` — keep-a-changelog.

## Conventions & gotchas

- **Data-driven first.** New content (items, mobs, spells, recipes) should be JSON
  edits, not new code, wherever the existing systems support it.
- **Equipment slots are dynamic** — a slot exists once an item declares it
  (`hand`, `body`, `head`, `light` currently). Seed empty slots in
  `startEquipment` so `unequip <slot>` works from a fresh character.
- **Trading is value-driven**: sell price = `sellValue` if set, else 20% of
  `value`; an item needs a truthy `value` to be sellable at all.
- **Shards** are the currency (drop on floor, anyone gathers). Crystals are a
  larger source they break from (name TBD).
- Match the style of surrounding code/data; keep comment density consistent.
