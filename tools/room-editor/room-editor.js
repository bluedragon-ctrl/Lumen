#!/usr/bin/env node
/**
 * Lumen room editor — a local, browser-based form for editing, per room in
 * `data/world/rooms.json`, the `spawns` rules (mob / max / respawn), the
 * `groundItems` list (template / qty / hidden / respawn), and the cosmetic
 * `biome` tag — then opening a pull request with the result.
 *
 *   node tools/room-editor/room-editor.js   # serves http://localhost:3940
 *   ROOM_EDITOR_PORT / SPAWN_EDITOR_PORT    # override the port
 *
 * These fields live on the ROOM, not the mob/item template (one template can be
 * placed in many rooms, each with its own cap/qty/cadence) — so this is a
 * sibling of the mob stat editor (`tools/mob-editor/`) and the item template
 * editor (`tools/item-editor/`).
 *
 *   • "Validate & preview"  — writes the file, runs `npm run validate`, shows
 *     the exact `git diff`, then RESTORES the file so your tree stays clean.
 *   • "Create pull request" — writes, validates, then branches, commits
 *     (Conventional Commit), pushes, and opens a PR via `gh`.
 *
 * Diff hygiene: this edits ONLY the `spawns`, `groundItems`, and `biome` fields
 * of each room. A changed room keeps every other field's source text
 * byte-for-byte; only the field(s) that actually changed are re-serialised
 * (arrays: 1 entry inline, 2+ one-per-line, matching the file's house style;
 * `biome`: a one-line field inserted after `zone`, or removed when cleared).
 */
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..", ".."); // tools/room-editor/ -> repo root
const ROOMS_PATH = path.join(ROOT, "data", "world", "rooms.json");
const MOBS_PATH = path.join(ROOT, "data", "world", "mobs.json");
const ITEMS_PATH = path.join(ROOT, "data", "world", "items.json");
const CHANGELOG_PATH = path.join(ROOT, "CHANGELOG.md");
const PAGE_PATH = path.join(__dirname, "room-editor.html");
const PORT = Number(process.env.ROOM_EDITOR_PORT || process.env.SPAWN_EDITOR_PORT) || 3940;
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const ROOM_ARRAY_FIELDS = ["spawns", "groundItems"]; // room array fields this editor may re-serialise
const ROOM_SCALAR_FIELDS = ["biome"];                // optional scalar room fields it may set/clear
// Cosmetic biome tags offered in the UI. Keep in sync with BIOMES in
// tools/validate-data.js (the validator is the source of truth).
const BIOMES = ["umbral", "wraith", "gloaming", "slime", "mutant", "water", "rim", "ember"];

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
  const span = fieldSpan(text, key);
  return span ? { start: span.valueStart, end: span.valueEnd } : null;
}

// Locate one field within an object's source text. Returns
// { keyStart, valueStart, valueEnd } or null.
function fieldSpan(text, key) {
  const n = text.length;
  let i = text.indexOf("{") + 1;
  while (i < n) {
    while (i < n && /[\s,]/.test(text[i])) i++;
    if (i >= n || text[i] === "}") break;
    if (text[i] !== '"') break;
    const keyStart = i;
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
    const valueStart = i;
    i = scanValue(text, i);
    if (k === key) return { keyStart, valueStart, valueEnd: i };
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

// Serialise a room array field (`spawns` or `groundItems`) in the house
// style: [] / one entry inline / 2+ entries one-per-line at 6-space indent
// (closing bracket at 4).
function serArray(arr, nl = "\n") {
  if (!Array.isArray(arr) || arr.length === 0) return "[]";
  if (arr.length === 1) return "[" + serInline(arr[0]) + "]";
  return "[" + nl + arr.map((e) => "      " + serInline(e)).join("," + nl) + nl + "    ]";
}

// Full room serialiser (only used for brand-new rooms, which this UI doesn't
// create — every field inline except the ones in ROOM_ARRAY_FIELDS).
function serRoomValue(room, nl = "\n") {
  const field = (k, v) => (ROOM_ARRAY_FIELDS.includes(k) ? serArray(v, nl) : serInline(v));
  const lines = Object.keys(room).map((k) => `    ${JSON.stringify(k)}: ${field(k, room[k])}`);
  return "{" + nl + lines.join("," + nl) + nl + "  }";
}

// Replace just one array field's value inside a room's source text, preserving
// every other byte. Inserts the field if the room somehow lacks one.
function spliceField(roomText, key, arr, nl) {
  const val = serArray(arr, nl);
  const span = fieldValueSpan(roomText, key);
  if (span) return roomText.slice(0, span.start) + val + roomText.slice(span.end);
  const close = roomText.lastIndexOf("}");
  const before = roomText.slice(0, close).replace(/\s*$/, "");
  return before + "," + nl + `    ${JSON.stringify(key)}: ` + val + nl + "  }";
}

// Set / replace / insert / remove a scalar field (e.g. `biome`), preserving
// every other byte. A falsy value clears the field (removing its whole line);
// a new value is inserted as its own line right after `zone` (or `id`), so it
// lands where the existing biome tags already sit.
function spliceScalar(roomText, key, value, nl) {
  const span = fieldSpan(roomText, key);
  const clear = value === undefined || value === null || value === "";
  if (clear) {
    if (!span) return roomText;
    let s = span.keyStart, e = span.valueEnd;
    if (roomText[e] === ",") {
      // trailing comma → remove this field's whole line. Back `s` over the line's
      // own indentation only (NOT the preceding newline — that terminates the line
      // above and must stay), and `e` past the comma and this line's newline.
      e++;
      while (e < roomText.length && roomText[e] !== "\n") e++;
      if (roomText[e] === "\n") e++;
      while (s > 0 && (roomText[s - 1] === " " || roomText[s - 1] === "\t")) s--;
      return roomText.slice(0, s) + roomText.slice(e);
    }
    // no trailing comma → field is last; drop the preceding comma too
    let p = s;
    while (p > 0 && /\s/.test(roomText[p - 1])) p--;
    if (roomText[p - 1] === ",") p--;
    return roomText.slice(0, p) + roomText.slice(e);
  }
  const val = JSON.stringify(value);
  if (span) return roomText.slice(0, span.valueStart) + val + roomText.slice(span.valueEnd);
  const anchor = fieldSpan(roomText, "zone") || fieldSpan(roomText, "id");
  if (!anchor) {
    const close = roomText.lastIndexOf("}");
    const before = roomText.slice(0, close).replace(/\s*$/, "");
    return before + "," + nl + `    ${JSON.stringify(key)}: ${val}` + nl + "  }";
  }
  let p = anchor.valueEnd;
  if (roomText[p] === ",") p++;
  while (p < roomText.length && roomText[p] !== "\n") p++;
  if (roomText[p] === "\n") p++;
  return roomText.slice(0, p) + `    ${JSON.stringify(key)}: ${val},` + nl + roomText.slice(p);
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

const scalarEq = (a, b) => (a ?? "") === (b ?? "");

// Re-assemble rooms.json: unchanged rooms keep exact source text; rooms whose
// spawns / groundItems / biome changed get only those field(s) re-serialised.
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
    else if (rawByKey.has(k)) {
      valueText = rawByKey.get(k);
      for (const field of ROOM_ARRAY_FIELDS) {
        if (!deepEqual((orig[k] || {})[field] || [], newRooms[k][field] || [])) {
          valueText = spliceField(valueText, field, newRooms[k][field] || [], nl);
        }
      }
      for (const field of ROOM_SCALAR_FIELDS) {
        if (!scalarEq((orig[k] || {})[field], newRooms[k][field])) {
          valueText = spliceScalar(valueText, field, newRooms[k][field], nl);
        }
      }
    } else valueText = serRoomValue(newRooms[k], nl);
    return `  ${JSON.stringify(k)}: ${valueText}`;
  });
  const eofNL = origRaw.endsWith(nl) ? nl : origRaw.endsWith("\n") ? "\n" : "";
  return "{" + nl + parts.join("," + nl) + nl + "}" + eofNL;
}

// Which room ids have a changed `spawns`, `groundItems`, and/or `biome`?
function changedRooms(orig, next) {
  const ids = new Set([...Object.keys(orig), ...Object.keys(next)]);
  const out = [];
  for (const id of ids) {
    if (!has(next, id) || !has(orig, id)) continue;
    const changed =
      ROOM_ARRAY_FIELDS.some((f) => !deepEqual(orig[id][f] || [], next[id][f] || [])) ||
      ROOM_SCALAR_FIELDS.some((f) => !scalarEq(orig[id][f], next[id][f]));
    if (changed) out.push(id);
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
  return (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "rooms";
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
  if (!changed.length) return { ok: false, error: "No room changes to commit." };

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
  const changelogLine = `**Room edits** — ${summary} (${changed.join(", ")}).`;

  try {
    git(["checkout", "-b", branch]);
    updateChangelog(changelogLine);
    git(["add", "data/world/rooms.json", "CHANGELOG.md"]);
    const body = `Edited via the room editor (\`tools/room-editor/\`).\n\n**Rooms changed:** ${changed.join(", ")}\n\n${summary}`;
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
      const itemIds = Object.keys(JSON.parse(fs.readFileSync(ITEMS_PATH, "utf8")));
      return void sendJSON(res, 200, { ok: true, rooms, mobIds, itemIds, biomes: BIOMES });
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
module.exports = { topLevelEntries, fieldValueSpan, fieldSpan, serArray, spliceField, spliceScalar, deepEqual, buildFile, changedRooms };

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`[room-editor] editing ${path.relative(ROOT, ROOMS_PATH)}`);
    console.log(`[room-editor] open  http://localhost:${PORT}`);
  });
}
