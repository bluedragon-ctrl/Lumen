#!/usr/bin/env node
/**
 * Lumen room spawn-rule editor — a local, browser-based form for editing the
 * `spawns` rules (mob / max / respawn) on each room in `data/world/rooms.json`,
 * and opening a pull request with the result.
 *
 *   node tools/spawn-editor/spawn-editor.js   # serves http://localhost:3940
 *   MOB_EDITOR_PORT / SPAWN_EDITOR_PORT       # override the port
 *
 * Spawn rules live on the ROOM, not the mob (one mob template is spawned in
 * many rooms, each with its own population cap and respawn cadence) — so this
 * is a sibling of the mob stat editor (`tools/mob-editor/`).
 *
 *   • "Validate & preview"  — writes the file, runs `npm run validate`, shows
 *     the exact `git diff`, then RESTORES the file so your tree stays clean.
 *   • "Create pull request" — writes, validates, then branches, commits
 *     (Conventional Commit), pushes, and opens a PR via `gh`.
 *
 * Diff hygiene: this edits ONLY the `spawns` field of each room. A changed
 * room keeps every other field's source text byte-for-byte; only its `spawns`
 * value is re-serialised (1 rule inline, 2+ one-per-line, matching the file).
 */
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..", ".."); // tools/spawn-editor/ -> repo root
const ROOMS_PATH = path.join(ROOT, "data", "world", "rooms.json");
const MOBS_PATH = path.join(ROOT, "data", "world", "mobs.json");
const CHANGELOG_PATH = path.join(ROOT, "CHANGELOG.md");
const PAGE_PATH = path.join(__dirname, "spawn-editor.html");
const PORT = Number(process.env.SPAWN_EDITOR_PORT) || 3940;
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// ---------------------------------------------------------------------------
// Source-preserving (de)serialisation of rooms.json
// ---------------------------------------------------------------------------

// Scan a top-level JSON object and return its entries as { key, valueText },
// where valueText is the EXACT source substring of each value. String-, brace-,
// and bracket-aware so it never trips on punctuation inside strings.
function topLevelEntries(raw) {
  const entries = [];
  const n = raw.length;
  let i = raw.indexOf("{");
  if (i < 0) return entries;
  i++;
  while (i < n) {
    while (i < n && /[\s,]/.test(raw[i])) i++;
    if (i >= n || raw[i] === "}") break;
    if (raw[i] !== '"') break;
    i++;
    let key = "";
    while (i < n) {
      const c = raw[i];
      if (c === "\\") { key += raw[i + 1]; i += 2; continue; }
      if (c === '"') { i++; break; }
      key += c; i++;
    }
    while (i < n && /\s/.test(raw[i])) i++;
    i++; // ':'
    while (i < n && /\s/.test(raw[i])) i++;
    const start = i;
    i = scanValue(raw, i);
    entries.push({ key, valueText: raw.slice(start, i) });
  }
  return entries;
}

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
  while (i < n && !/[,}\]\s]/.test(raw[i])) i++;
  return i;
}

function scanString(raw, i) {
  i++;
  while (i < raw.length) {
    if (raw[i] === "\\") { i += 2; continue; }
    if (raw[i] === '"') return i + 1;
    i++;
  }
  return i;
}

// Locate one field's value span within an object's source text (text starts
// with "{"). Returns { start, end } or null.
function fieldValueSpan(text, key) {
  const n = text.length;
  let i = text.indexOf("{") + 1;
  while (i < n) {
    while (i < n && /[\s,]/.test(text[i])) i++;
    if (i >= n || text[i] === "}") break;
    if (text[i] !== '"') break;
    i++;
    let k = "";
    while (i < n) {
      const c = text[i];
      if (c === "\\") { k += text[i + 1]; i += 2; continue; }
      if (c === '"') { i++; break; }
      k += c; i++;
    }
    while (i < n && /\s/.test(text[i])) i++;
    i++; // ':'
    while (i < n && /\s/.test(text[i])) i++;
    const start = i;
    i = scanValue(text, i);
    if (k === key) return { start, end: i };
  }
  return null;
}

// Inline serialiser: `{ "k": v, … }` / `[a, b]` — one line.
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

// Serialise a `spawns` array in the house style: [] / one rule inline /
// 2+ rules one-per-line at 6-space indent (closing bracket at 4).
function serSpawns(arr, nl = "\n") {
  if (!Array.isArray(arr) || arr.length === 0) return "[]";
  if (arr.length === 1) return "[" + serInline(arr[0]) + "]";
  return "[" + nl + arr.map((e) => "      " + serInline(e)).join("," + nl) + nl + "    ]";
}

// Full room serialiser (only used for brand-new rooms, which this UI doesn't
// create — every field inline except `spawns`).
function serRoomValue(room, nl = "\n") {
  const field = (k, v) => (k === "spawns" ? serSpawns(v, nl) : serInline(v));
  const lines = Object.keys(room).map((k) => `    ${JSON.stringify(k)}: ${field(k, room[k])}`);
  return "{" + nl + lines.join("," + nl) + nl + "  }";
}

// Replace just the `spawns` value inside a room's source text, preserving every
// other byte. Inserts a `spawns` field if the room somehow lacks one.
function spliceSpawns(roomText, spawns, nl) {
  const val = serSpawns(spawns, nl);
  const span = fieldValueSpan(roomText, "spawns");
  if (span) return roomText.slice(0, span.start) + val + roomText.slice(span.end);
  const close = roomText.lastIndexOf("}");
  const before = roomText.slice(0, close).replace(/\s*$/, "");
  return before + "," + nl + '    "spawns": ' + val + nl + "  }";
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

// Re-assemble rooms.json: unchanged rooms keep exact source text; rooms whose
// spawns changed get only their `spawns` value re-serialised.
function buildFile(newRooms, origRaw) {
  const nl = origRaw.includes("\r\n") ? "\r\n" : "\n";
  const entries = topLevelEntries(origRaw);
  const orig = JSON.parse(origRaw);
  const order = entries.map((e) => e.key);
  const rawByKey = new Map(entries.map((e) => [e.key, e.valueText]));
  const outKeys = [
    ...order.filter((k) => has(newRooms, k)),
    ...Object.keys(newRooms).filter((k) => !order.includes(k)),
  ];
  const parts = outKeys.map((k) => {
    let valueText;
    if (has(orig, k) && deepEqual(orig[k], newRooms[k])) valueText = rawByKey.get(k);
    else if (rawByKey.has(k)) valueText = spliceSpawns(rawByKey.get(k), newRooms[k].spawns || [], nl);
    else valueText = serRoomValue(newRooms[k], nl);
    return `  ${JSON.stringify(k)}: ${valueText}`;
  });
  const eofNL = origRaw.endsWith(nl) ? nl : origRaw.endsWith("\n") ? "\n" : "";
  return "{" + nl + parts.join("," + nl) + nl + "}" + eofNL;
}

// Which room ids have changed spawns?
function changedRooms(orig, next) {
  const ids = new Set([...Object.keys(orig), ...Object.keys(next)]);
  const out = [];
  for (const id of ids) {
    if (!has(next, id) || !has(orig, id)) continue;
    if (!deepEqual(orig[id].spawns || [], next[id].spawns || [])) out.push(id);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Git / validation helpers
// ---------------------------------------------------------------------------
function git(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
}

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
  return (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "spawns";
}

// Insert a bullet under `## [Unreleased]` › `### Changed` (created after the
// `### Added` block if absent), respecting keep-a-changelog order.
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
  let end = lines.length;
  for (let i = unrel + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) { end = i; break; }
  }
  const entry = `- ${bullet}`;
  const changed = lines.findIndex((l, i) => i > unrel && i < end && /^###\s+Changed\s*$/.test(l));
  if (changed >= 0) {
    lines.splice(changed + 1, 0, entry);
  } else {
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
function handleValidate(newRooms) {
  const origRaw = fs.readFileSync(ROOMS_PATH, "utf8");
  const orig = JSON.parse(origRaw);
  const changed = changedRooms(orig, newRooms);
  const nextRaw = buildFile(newRooms, origRaw);
  if (nextRaw === origRaw) return { ok: true, changed: [], diff: "", validate: "(no changes)" };
  fs.writeFileSync(ROOMS_PATH, nextRaw);
  try {
    const diff = git(["diff", "--", "data/world/rooms.json"]);
    const val = run("node", ["tools/validate-data.js"]);
    return { ok: val.ok, changed, diff, validate: val.output.trim() || (val.ok ? "OK" : "(no output)") };
  } finally {
    fs.writeFileSync(ROOMS_PATH, origRaw);
  }
}

function handlePR(newRooms, summary, type) {
  const origRaw = fs.readFileSync(ROOMS_PATH, "utf8");
  const orig = JSON.parse(origRaw);
  const changed = changedRooms(orig, newRooms);
  if (!changed.length) return { ok: false, error: "No spawn changes to commit." };

  const owned = new Set(["data/world/rooms.json", "CHANGELOG.md"]);
  const dirty = git(["status", "--porcelain"]) // "XY path"
    .split("\n").filter(Boolean)
    .map((l) => l.slice(3).trim())
    .filter((p) => !owned.has(p));
  if (dirty.length) {
    return { ok: false, error: `Working tree has unrelated changes — commit or stash first:\n${dirty.join("\n")}` };
  }

  const nextRaw = buildFile(newRooms, origRaw);
  fs.writeFileSync(ROOMS_PATH, nextRaw);

  const val = run("node", ["tools/validate-data.js"]);
  if (!val.ok) {
    fs.writeFileSync(ROOMS_PATH, origRaw);
    return { ok: false, error: "Validation failed — file restored, no PR created.", validate: val.output.trim() };
  }

  const subject = `${type}: ${summary}`;
  const branch = `${type}/${slugify(summary)}-${Date.now().toString(36)}`;
  const changelogLine = `**Spawn rules** — ${summary} (${changed.join(", ")}).`;

  try {
    git(["checkout", "-b", branch]);
    updateChangelog(changelogLine);
    git(["add", "data/world/rooms.json", "CHANGELOG.md"]);
    const body = `Edited via the spawn-rule editor (\`tools/spawn-editor/\`).\n\n**Rooms changed:** ${changed.join(", ")}\n\n${summary}`;
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
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => { data += c; if (data.length > 5e6) reject(new Error("body too large")); });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return void res.end(fs.readFileSync(PAGE_PATH, "utf8"));
    }
    if (req.method === "GET" && req.url === "/api/rooms") {
      const rooms = JSON.parse(fs.readFileSync(ROOMS_PATH, "utf8"));
      const mobIds = Object.keys(JSON.parse(fs.readFileSync(MOBS_PATH, "utf8")));
      return void sendJSON(res, 200, { ok: true, rooms, mobIds });
    }
    if (req.method === "POST" && req.url === "/api/save") {
      const body = JSON.parse(await readBody(req));
      const { rooms, mode, summary, type } = body;
      if (!rooms || typeof rooms !== "object") return void sendJSON(res, 400, { ok: false, error: "missing rooms object" });
      if (mode === "pr") {
        if (!summary || !String(summary).trim()) return void sendJSON(res, 400, { ok: false, error: "A commit summary is required to open a PR." });
        const t = ["chore", "fix", "feat"].includes(type) ? type : "chore";
        return void sendJSON(res, 200, handlePR(rooms, String(summary).trim(), t));
      }
      return void sendJSON(res, 200, handleValidate(rooms));
    }
    res.writeHead(404).end("Not found");
  } catch (e) {
    sendJSON(res, 500, { ok: false, error: e.message });
  }
});

// Exposed for require()-ing / tests; the server only listens when run directly.
module.exports = { topLevelEntries, fieldValueSpan, serSpawns, spliceSpawns, deepEqual, buildFile, changedRooms };

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`[spawn-editor] editing ${path.relative(ROOT, ROOMS_PATH)}`);
    console.log(`[spawn-editor] open  http://localhost:${PORT}`);
  });
}
