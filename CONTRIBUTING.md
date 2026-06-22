# Contributing to Lumen

This documents the working conventions for the project. (Branch protection is
not yet enforced via GitHub settings — these are the agreed conventions we
follow by hand.)

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
5. Update `CHANGELOG.md` under `[Unreleased]` as part of the PR.

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>: <short summary>

<optional body>
```

Types: `feat`, `fix`, `docs`, `refactor`, `chore`, `test`, `perf`.

## Versioning

- [Semantic Versioning](https://semver.org/): **MAJOR.MINOR.PATCH**, starting at `0.1.0`.
- Pre-1.0 — design and APIs may change between minor versions.
  - **PATCH** — fixes/small tweaks.
  - **MINOR** — new systems/features.
  - **MAJOR** — first stable, complete, playable release (`1.0.0`).
- The canonical version lives in **`VERSION`** (kept in lockstep with `package.json`).

### Cutting a release — `npm run release`

Versions are cut from the **Conventional Commit history**, not bumped per-PR.
`[Unreleased]` accumulates merged PRs; a release batches them into one version.

`tools/release.js` (`npm run release`, or double-click `tools/release.bat` — which
previews the bump and asks before committing) automates the version *number* while
leaving your hand-written changelog *prose* untouched. It:

1. reads the commits since the last `v*` tag and picks the bump per the policy above
   (pre-1.0: any `feat` → MINOR, else PATCH);
2. writes the new version to `VERSION` and `package.json`;
3. stamps `CHANGELOG.md` — leaves a fresh empty `[Unreleased]` on top and moves your
   existing notes under a new `## [x.y.z] - YYYY-MM-DD` header (prose unchanged);
4. creates a `chore/release-x.y.z` branch and a `chore(release): vx.y.z` commit.

Then push the branch, open a PR into `main`, and **after it merges, tag the merge
commit** (`git tag v0.2.0 && git push origin v0.2.0`). The release is the tag.

Useful flags: `--dry-run` (preview, touch nothing), `--major`/`--minor`/`--patch`
(override the detected level), an explicit `1.0.0` (the deliberate first-stable cut),
`--no-commit` (write files only). `1.0.0` is never chosen automatically.
