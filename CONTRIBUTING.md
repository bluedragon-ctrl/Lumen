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
- The canonical version lives in **`VERSION`** (and `package.json` once Node is added).
- On release: bump `VERSION`, move `[Unreleased]` notes into a dated version
  section in `CHANGELOG.md`, and tag the commit (`git tag v0.1.0`).
