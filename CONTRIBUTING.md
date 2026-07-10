# Contributing to Lumen

This documents the working conventions for the project. Branch protection is
enforced via GitHub settings: `main` accepts only pull requests (admins
included), and force-pushes and deletion are blocked.

## Branching

- **`main`** is the protected, always-working branch. **No direct commits** after
  the initial bootstrap — all changes land via pull request.
- Create a **feature branch** per change, named by type:
  - `feat/<short-name>` — new feature/system
  - `fix/<short-name>` — bug fix
  - `docs/<short-name>` — documentation only
  - `refactor/<short-name>` — internal change, no behaviour change
  - `chore/<short-name>` — tooling, deps, housekeeping

## Pull requests

1. Branch off `main`, make the change, push the branch.
2. Open a PR into `main`.
3. **Review before merge.** The maintainer reviews each PR. Automated tests are
   deferred for now.
4. Squash or merge into `main`; delete the branch.
5. Update `CHANGELOG.md` under `[Unreleased]` **and bump the PATCH version** in
   `VERSION` + `package.json` as part of the PR (see *Versioning*).

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>: <short summary>

<optional body>
```

Types: `feat`, `fix`, `docs`, `refactor`, `chore`, `test`, `perf`.

## Versioning

- [Semantic Versioning](https://semver.org/): **MAJOR.MINOR.PATCH**. The
  canonical version lives in **`VERSION`** (kept in lockstep with `package.json`).
- **Every PR bumps the PATCH** in `VERSION` + `package.json` as part of the
  change — same rule as the changelog. The version on `main` always identifies
  the current build. (If a parallel PR takes the number first, rebase and
  re-bump — the conflict is one line in each file.)
- **MINOR is a milestone**, the maintainer's call — cut when the game feels a
  real step closer to done, not per feature. Milestones are cut with
  `npm run release` (below) and are the only versions that get git tags.
- **`1.0.0`** is the deliberate first stable, complete, playable release —
  never chosen automatically.

### Cutting a milestone — `npm run release`

Patch versions land continuously per-PR; a release batches the accumulated
`[Unreleased]` notes into a **milestone MINOR** (`0.6.14 → 0.7.0`).

`tools/release.js` (`npm run release`, or double-click `tools/release.bat` — which
previews the bump and asks before committing) automates the version *number* while
leaving your hand-written changelog *prose* untouched. It:

1. bumps the MINOR (pre-1.0 a milestone is always a MINOR; post-1.0 the level is
   detected from the Conventional Commits since the last tag);
2. writes the new version to `VERSION` and `package.json`;
3. stamps `CHANGELOG.md` — leaves a fresh empty `[Unreleased]` on top and moves your
   existing notes under a new `## [x.y.z] - YYYY-MM-DD` header (prose unchanged);
4. creates a `chore/release-x.y.z` branch + `chore(release): vx.y.z` commit, then
   **pushes and opens a PR into `main`** via `gh` (falling back to printing a
   ready-to-click compare URL if `gh` isn't installed).

Review and merge the PR as usual, then **tag the merge commit** (`git tag v0.7.0
&& git push origin v0.7.0`) — the milestone is the tag; patch versions are not
tagged. (The script can't tag for you because a squash-merge changes the commit
SHA.)

Useful flags: `--dry-run` (preview, touch nothing), `--major`/`--minor`/`--patch`
(override the level), an explicit `1.0.0` (the deliberate first-stable cut),
`--no-pr` (branch + commit but don't push/open a PR), `--no-commit` (write files
only). `1.0.0` is never chosen automatically.
