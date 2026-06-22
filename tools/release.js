#!/usr/bin/env node
/**
 * Cuts a Lumen release: derives the next SemVer from the Conventional Commits
 * since the last tag, stamps the version into VERSION + package.json, dates the
 * hand-written CHANGELOG `[Unreleased]` section, and prepares a release branch +
 * commit for the normal PR review.
 *
 * The version *number* is automated; the changelog *prose* stays yours — this
 * never rewrites your notes, it only stamps them with a version and date.
 *
 * Usage:
 *   node tools/release.js                  # auto bump from commits, make release branch + commit
 *   node tools/release.js --dry-run        # show what would happen, touch nothing
 *   node tools/release.js --minor          # force a bump level (--major/--minor/--patch)
 *   node tools/release.js 1.0.0            # set an explicit version (e.g. the 1.0 cut)
 *   node tools/release.js --no-commit      # write the files but don't branch/commit
 *
 * Bump policy (CONTRIBUTING.md → Versioning):
 *   pre-1.0:  any feat (or breaking) since last tag → MINOR, else → PATCH.
 *   1.x+:     breaking → MAJOR, feat → MINOR, else → PATCH.
 *   1.0.0 (first stable) is always a deliberate explicit version, never automatic.
 *
 * Exits non-zero on any problem (dirty tree, bad version, nothing to release).
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const VERSION_FILE = path.join(ROOT, "VERSION");
const PKG_FILE = path.join(ROOT, "package.json");
const CHANGELOG_FILE = path.join(ROOT, "CHANGELOG.md");

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const DRY = has("--dry-run");
const NO_COMMIT = has("--no-commit");
const forced =
  (has("--major") && "major") || (has("--minor") && "minor") || (has("--patch") && "patch") || null;
const explicit = args.find((a) => /^v?\d+\.\d+\.\d+$/.test(a)) || null;

function git(...a) {
  return execFileSync("git", a, { cwd: ROOT, encoding: "utf8" }).trim();
}

function fail(msg) {
  console.error(`\x1b[31m✗ ${msg}\x1b[0m`);
  process.exit(1);
}

function parse(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
  if (!m) fail(`unparseable version: "${v}"`);
  return { major: +m[1], minor: +m[2], patch: +m[3] };
}

// Classify the bump from Conventional Commit subjects since the last tag.
function detectBump(commits, current) {
  const breaking = commits.some(
    (c) => /^[a-z]+(\(.+?\))?!:/.test(c) || /BREAKING[ -]CHANGE/.test(c)
  );
  const feat = commits.some((c) => /^feat(\(.+?\))?!?:/.test(c));
  if (current.major === 0) return feat || breaking ? "minor" : "patch"; // pre-1.0
  if (breaking) return "major";
  if (feat) return "minor";
  return "patch";
}

function applyBump(v, kind) {
  if (kind === "major") return { major: v.major + 1, minor: 0, patch: 0 };
  if (kind === "minor") return { major: v.major, minor: v.minor + 1, patch: 0 };
  return { major: v.major, minor: v.minor, patch: v.patch + 1 };
}

const fmt = (v) => `${v.major}.${v.minor}.${v.patch}`;

function today() {
  // Runs on the maintainer's machine at release time — local date is correct.
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function main() {
  // --- preflight ---------------------------------------------------------
  const branch = git("rev-parse", "--abbrev-ref", "HEAD");
  if (!DRY && git("status", "--porcelain")) {
    fail("working tree is dirty — commit or stash before cutting a release");
  }

  const current = parse(fs.readFileSync(VERSION_FILE, "utf8"));
  let lastTag = "";
  try {
    lastTag = git("describe", "--tags", "--abbrev=0");
  } catch {
    lastTag = ""; // no tags yet → consider all history
  }
  const range = lastTag ? `${lastTag}..HEAD` : "HEAD";
  const commits = git("log", range, "--pretty=%s").split("\n").filter(Boolean);

  if (!explicit && !forced && commits.length === 0) {
    fail(`no commits since ${lastTag || "the start"} — nothing to release`);
  }

  // --- decide the next version ------------------------------------------
  let next, kind;
  if (explicit) {
    next = parse(explicit);
    kind = "explicit";
  } else {
    kind = forced || detectBump(commits, current);
    next = applyBump(current, kind);
  }

  if (fmt(next) === fmt(current)) fail(`computed version ${fmt(next)} equals current — nothing to do`);

  // --- report ------------------------------------------------------------
  console.log(`\nLumen release\n  branch:   ${branch}`);
  console.log(`  current:  ${fmt(current)}   (last tag: ${lastTag || "none"})`);
  console.log(`  commits since: ${commits.length}`);
  for (const c of commits) console.log(`    • ${c}`);
  console.log(`  bump:     ${kind}`);
  console.log(`  next:     \x1b[32m${fmt(next)}\x1b[0m\n`);

  if (DRY) {
    console.log("(--dry-run) no files changed.");
    return;
  }

  // --- write VERSION + package.json -------------------------------------
  fs.writeFileSync(VERSION_FILE, fmt(next) + "\n");

  const pkgRaw = fs.readFileSync(PKG_FILE, "utf8");
  const pkgNext = pkgRaw.replace(/("version":\s*")[^"]+(")/, `$1${fmt(next)}$2`);
  if (pkgNext === pkgRaw) fail("could not find a version field to bump in package.json");
  fs.writeFileSync(PKG_FILE, pkgNext);

  // --- stamp the CHANGELOG ----------------------------------------------
  // Keep-a-changelog: leave an empty `[Unreleased]` on top and move the existing
  // hand-written notes under a new dated version header. Prose is untouched.
  const cl = fs.readFileSync(CHANGELOG_FILE, "utf8");
  if (!/##\s*\[Unreleased\]/.test(cl)) fail("no `## [Unreleased]` heading found in CHANGELOG.md");
  const stamped = cl.replace(
    /##\s*\[Unreleased\]/,
    `## [Unreleased]\n\n## [${fmt(next)}] - ${today()}`
  );
  fs.writeFileSync(CHANGELOG_FILE, stamped);

  console.log("Updated VERSION, package.json, and CHANGELOG.md.");

  // --- branch + commit ---------------------------------------------------
  if (NO_COMMIT) {
    console.log("\n(--no-commit) files written; review and commit yourself.");
    return;
  }

  const relBranch = `chore/release-${fmt(next)}`;
  git("checkout", "-b", relBranch);
  git("add", "VERSION", "package.json", "CHANGELOG.md");
  git("commit", "-m", `chore(release): v${fmt(next)}`);

  console.log(`\n\x1b[32m✓ committed on ${relBranch}\x1b[0m`);
  console.log("\nNext steps:");
  console.log(`  1. Push the branch and open a PR into main.`);
  console.log(`  2. After it merges, tag the merge commit on main:`);
  console.log(`       git checkout main && git pull`);
  console.log(`       git tag v${fmt(next)} && git push origin v${fmt(next)}`);
}

main();
