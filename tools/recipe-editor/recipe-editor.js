#!/usr/bin/env node
/**
 * Lumen recipe editor — a local, browser-based form for editing
 * `data/world/recipes.json` and opening a pull request with the result.
 *
 *   node tools/recipe-editor/recipe-editor.js   # serves http://localhost:3942
 *   RECIPE_EDITOR_PORT=4000 node ...             # override the port
 *
 * The page lets you tweak each recipe's fields (name, station, shards cost,
 * inputs, output) via form fields. Inputs are a repeatable list of
 * { template, qty } rows; the output is a single { template, qty }. Item
 * templates are picked from items.json and stations from the crafting fixtures,
 * so a recipe can only reference things that exist. Two actions back it:
 *
 *   • "Validate & preview"  — writes the file, runs `npm run validate`, shows
 *     the exact `git diff`, then RESTORES the file so your tree stays clean.
 *   • "Create pull request" — writes the file, validates, then branches,
 *     commits (Conventional Commit), pushes, and opens a PR via `gh`.
 *
 * Diff hygiene: the file is re-assembled by SPLICING — every recipe you did NOT
 * change keeps its exact original source text (byte for byte), so the PR diff
 * contains only the recipes you actually edited. Changed recipes are
 * re-serialised in the project's house style (each field on its own line,
 * `inputs` as a multi-line array, `output` inline).
 *
 * This mirrors tools/item-editor/item-editor.js — read that for the why.
 */
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..", ".."); // tools/recipe-editor/ -> repo root
const RECIPES_PATH = path.join(ROOT, "data", "world", "recipes.json");
const ITEMS_PATH = path.join(ROOT, "data", "world", "items.json");
const FIXTURES_PATH = path.join(ROOT, "data", "world", "fixtures.json");
const CHANGELOG_PATH = path.join(ROOT, "CHANGELOG.md");
const PAGE_PATH = path.join(__dirname, "recipe-editor.html");
const PORT = Number(process.env.RECIPE_EDITOR_PORT) || 3942;
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// ---------------------------------------------------------------------------
// Source-preserving (de)serialisation of recipes.json
// ---------------------------------------------------------------------------

// Scan a top-level JSON object and return its entries as { key, valueText },
// where valueText is the EXACT source substring of each value (whitespace and
// all). String-, brace-, and bracket-aware so it never trips on punctuation
// inside strings.
function topLevelEntries(raw) {
  const entries = [];
  const n = raw.length;
  let i = raw.indexOf("{");
  if (i < 0) return entries;
  i++; // past the opening brace
  while (i < n) {
    while (i < n && /[\s,]/.test(raw[i])) i++; // whitespace / separators
    if (i >= n || raw[i] === "}") break;
    if (raw[i] !== '"') break; // unexpected — bail out gracefully
    // --- key string ---
    i++; // past opening quote
    let key = "";
    while (i < n) {
      const c = raw[i];
      if (c === "\\") { key += raw[i + 1]; i += 2; continue; }
      if (c === '"') { i++; break; }
      key += c; i++;
    }
    while (i < n && /\s/.test(raw[i])) i++;
    i++; // past ':'
    while (i < n && /\s/.test(raw[i])) i++;
    // --- value ---
    const start = i;
    i = scanValue(raw, i);
    entries.push({ key, valueText: raw.slice(start, i) });
  }
  return entries;
}

// Return the index just past the JSON value beginning at `i`.
function scanValue(raw, i) {
  const n = raw.length;
  const c = raw[i];
  if (c === '"') return scanString(raw, i);
  if (c === "{" || c === "[") {
    const open = c, close = c === "{" ? "}" : "]";
    let depth = 0;
    while (i < n) {
      const ch = raw[i];
      if (ch === '"') { i = scanString(raw, i); continue; }
      if (ch === open) depth++;
      else if (ch === close) { depth--; if (depth === 0) return i + 1; }
      i++;
    }
    return i;
  }
  // primitive: read until a structural delimiter
  while (i < n && !/[,}\]\s]/.test(raw[i])) i++;
  return i;
}

function scanString(raw, i) {
  i++; // past opening quote
  while (i < raw.length) {
    if (raw[i] === "\\") { i += 2; continue; }
    if (raw[i] === '"') return i + 1;
    i++;
  }
  return i;
}

// Inline serialiser: objects -> `{ "k": v, … }`, arrays -> `[a, b]`. Used for
// the `output` block and `{ template, qty }` input rows, which the house style
// keeps on one line.
function serInline(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) {
    if (v.length === 0) return "[]";
    return "[" + v.map(serInline).join(", ") + "]";
  }
  if (typeof v === "object") {
    const keys = Object.keys(v);
    if (keys.length === 0) return "{}";
    return "{ " + keys.map((k) => `${JSON.stringify(k)}: ${serInline(v[k])}`).join(", ") + " }";
  }
  return JSON.stringify(v);
}

// Serialise one recipe's value text in the house style: each field on its own
// line at 4-space indent; `inputs` as a multi-line array (one `{ template, qty }`
// per line at 6-space indent); everything else (output, scalars) inline. `nl`
// is the file's newline style.
function serRecipeValue(recipe, nl = "\n") {
  const lines = Object.keys(recipe).map((k) => {
    const v = recipe[k];
    if (k === "inputs" && Array.isArray(v)) {
      if (v.length === 0) return `    ${JSON.stringify(k)}: []`;
      const rows = v.map((row) => `      ${serInline(row)}`);
      return `    ${JSON.stringify(k)}: [${nl}${rows.join("," + nl)}${nl}    ]`;
    }
    return `    ${JSON.stringify(k)}: ${serInline(v)}`;
  });
  return "{" + nl + lines.join("," + nl) + nl + "  }";
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    return a.every((x, i) => deepEqual(x, b[i]));
  }
  const ak = Object.keys(a), bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  return ak.every((k) => has(b, k) && deepEqual(a[k], b[k]));
}

// Re-assemble recipes.json: unchanged recipes keep their exact source text;
// changed or new recipes are serialised; original ordering is preserved, new
// keys append.
function buildFile(newRecipes, origRaw) {
  const nl = origRaw.includes("\r\n") ? "\r\n" : "\n";
  const entries = topLevelEntries(origRaw);
  const orig = JSON.parse(origRaw);
  const order = entries.map((e) => e.key);
  const rawByKey = new Map(entries.map((e) => [e.key, e.valueText]));
  const outKeys = [
    ...order.filter((k) => has(newRecipes, k)), // kept (in original order)
    ...Object.keys(newRecipes).filter((k) => !order.includes(k)), // newly added
  ];
  const parts = outKeys.map((k) => {
    const valueText =
      has(orig, k) && deepEqual(orig[k], newRecipes[k]) ? rawByKey.get(k) : serRecipeValue(newRecipes[k], nl);
    return `  ${JSON.stringify(k)}: ${valueText}`;
  });
  const eofNL = origRaw.endsWith(nl) ? nl : origRaw.endsWith("\n") ? "\n" : "";
  return "{" + nl + parts.join("," + nl) + nl + "}" + eofNL;
}

// Which recipe ids differ between two parsed objects (changed, added, or removed)?
function changedRecipes(orig, next) {
  const ids = new Set([...Object.keys(orig), ...Object.keys(next)]);
  const out = [];
  for (const id of ids) {
    if (!has(next, id)) out.push(id + " (removed)");
    else if (!has(orig, id)) out.push(id + " (added)");
    else if (!deepEqual(orig[id], next[id])) out.push(id);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Git / validation helpers
// ---------------------------------------------------------------------------
function git(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
}

// Run a command, returning { ok, output } instead of throwing.
function run(cmd, args) {
  try {
    const out = execFileSync(cmd, args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true, output: out };
  } catch (e) {
    const output = [e.stdout, e.stderr].filter(Boolean).join("\n") || e.message;
    return { ok: false, output };
  }
}

function slugify(s) {
  return (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "recipes";
}

// Insert a bullet under `## [Unreleased]` › `### Changed` (creating the
// subsection after `### Added` if absent), respecting keep-a-changelog order.
function updateChangelog(bullet) {
  let text;
  try {
    text = fs.readFileSync(CHANGELOG_PATH, "utf8");
  } catch {
    return false;
  }
  const lines = text.split("\n");
  const unrel = lines.findIndex((l) => /^##\s+\[Unreleased\]/i.test(l));
  if (unrel < 0) return false;
  // bounds of the Unreleased section (until the next "## " heading)
  let end = lines.length;
  for (let i = unrel + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) { end = i; break; }
  }
  const entry = `- ${bullet}`;
  const changed = lines.findIndex((l, i) => i > unrel && i < end && /^###\s+Changed\s*$/.test(l));
  if (changed >= 0) {
    lines.splice(changed + 1, 0, entry);
  } else {
    // place a new "### Changed" after the "### Added" block, else right under
    // the Unreleased heading.
    const added = lines.findIndex((l, i) => i > unrel && i < end && /^###\s+Added\s*$/.test(l));
    let at = unrel + 1;
    if (added >= 0) {
      at = added + 1;
      while (at < end && !/^###\s+/.test(lines[at])) at++;
    }
    lines.splice(at, 0, "### Changed", entry, "");
  }
  fs.writeFileSync(CHANGELOG_PATH, lines.join("\n"));
  return true;
}

// ---------------------------------------------------------------------------
// Save handlers
// ---------------------------------------------------------------------------

// Validate-only: write, capture diff, run validator, then RESTORE the file.
function handleValidate(newRecipes) {
  const origRaw = fs.readFileSync(RECIPES_PATH, "utf8");
  const orig = JSON.parse(origRaw);
  const changed = changedRecipes(orig, newRecipes);
  const nextRaw = buildFile(newRecipes, origRaw);
  if (nextRaw === origRaw) return { ok: true, changed: [], diff: "", validate: "(no changes)" };
  fs.writeFileSync(RECIPES_PATH, nextRaw);
  try {
    const diff = git(["diff", "--", "data/world/recipes.json"]);
    const val = run("node", ["tools/validate-data.js"]);
    return { ok: val.ok, changed, diff, validate: val.output.trim() || (val.ok ? "OK" : "(no output)") };
  } finally {
    fs.writeFileSync(RECIPES_PATH, origRaw); // always restore — validate never mutates the tree
  }
}

// Create the PR: write, validate, then branch + commit + push + gh pr create.
function handlePR(newRecipes, summary, type) {
  const origRaw = fs.readFileSync(RECIPES_PATH, "utf8");
  const orig = JSON.parse(origRaw);
  const changed = changedRecipes(orig, newRecipes);
  if (!changed.length) return { ok: false, error: "No changes to commit." };

  // Pre-flight: the working tree must be clean apart from files we own.
  const owned = new Set(["data/world/recipes.json", "CHANGELOG.md"]);
  const dirty = git(["status", "--porcelain"]) // "XY path"
    .split("\n").filter(Boolean)
    .map((l) => l.slice(3).trim())
    .filter((p) => !owned.has(p));
  if (dirty.length) {
    return { ok: false, error: `Working tree has unrelated changes — commit or stash first:\n${dirty.join("\n")}` };
  }

  const nextRaw = buildFile(newRecipes, origRaw);
  fs.writeFileSync(RECIPES_PATH, nextRaw);

  // Validate before we touch git; restore + bail on failure.
  const val = run("node", ["tools/validate-data.js"]);
  if (!val.ok) {
    fs.writeFileSync(RECIPES_PATH, origRaw);
    return { ok: false, error: "Validation failed — file restored, no PR created.", validate: val.output.trim() };
  }

  const subject = `${type}: ${summary}`;
  const branch = `${type}/${slugify(summary)}-${Date.now().toString(36)}`;
  const changelogLine = `**Recipes** — ${summary} (${changed.join(", ")}).`;

  try {
    git(["checkout", "-b", branch]);
    updateChangelog(changelogLine);
    git(["add", "data/world/recipes.json", "CHANGELOG.md"]);
    const body = `Edited via the recipe editor (\`tools/recipe-editor/recipe-editor.js\`).\n\n**Recipes changed:** ${changed.join(", ")}\n\n${summary}`;
    git(["commit", "-m", subject, "-m", body]);
    git(["push", "-u", "origin", branch]);
    const pr = run("gh", ["pr", "create", "--base", "main", "--head", branch, "--title", subject, "--body", body]);
    if (!pr.ok) return { ok: false, error: `Branch pushed (${branch}) but \`gh pr create\` failed:\n${pr.output}`, branch };
    const url = (pr.output.match(/https?:\/\/\S+/) || [pr.output.trim()])[0];
    return { ok: true, branch, url, changed };
  } catch (e) {
    return { ok: false, error: `Git step failed: ${e.stderr || e.message}`, branch };
  }
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------
function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 5e6) reject(new Error("body too large"));
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

// Item template ids (for input/output pickers) and the set of crafting stations
// (a recipe's station must match a fixture's `station`). Fed to the form so it
// can only reference things that exist.
function loadRefs() {
  let items = {}, fixtures = {};
  try { items = JSON.parse(fs.readFileSync(ITEMS_PATH, "utf8")); } catch { /* leave empty */ }
  try { fixtures = JSON.parse(fs.readFileSync(FIXTURES_PATH, "utf8")); } catch { /* leave empty */ }
  const itemIds = Object.keys(items).sort();
  const stations = [...new Set(Object.values(fixtures).map((f) => f && f.station).filter(Boolean))].sort();
  return { itemIds, stations };
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return void res.end(fs.readFileSync(PAGE_PATH, "utf8"));
    }
    if (req.method === "GET" && req.url === "/api/recipes") {
      const recipes = JSON.parse(fs.readFileSync(RECIPES_PATH, "utf8"));
      const { itemIds, stations } = loadRefs();
      return void sendJSON(res, 200, { ok: true, recipes, itemIds, stations });
    }
    if (req.method === "POST" && req.url === "/api/save") {
      const body = JSON.parse(await readBody(req));
      const { recipes, mode, summary, type } = body;
      if (!recipes || typeof recipes !== "object") return void sendJSON(res, 400, { ok: false, error: "missing recipes object" });
      if (mode === "pr") {
        if (!summary || !String(summary).trim()) return void sendJSON(res, 400, { ok: false, error: "A commit summary is required to open a PR." });
        const t = ["chore", "fix", "feat"].includes(type) ? type : "chore";
        return void sendJSON(res, 200, handlePR(recipes, String(summary).trim(), t));
      }
      return void sendJSON(res, 200, handleValidate(recipes));
    }
    res.writeHead(404).end("Not found");
  } catch (e) {
    sendJSON(res, 500, { ok: false, error: e.message });
  }
});

// Exposed for unit tests / require()-ing; the server only listens
// when this file is run directly.
module.exports = { topLevelEntries, serRecipeValue, serInline, deepEqual, buildFile, changedRecipes };

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`[recipe-editor] editing ${path.relative(ROOT, RECIPES_PATH)}`);
    console.log(`[recipe-editor] open  http://localhost:${PORT}`);
  });
}
