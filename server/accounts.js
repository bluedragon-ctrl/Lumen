"use strict";
/**
 * Player account persistence. Accounts are one JSON file per character under
 * data/runtime/players/ (gitignored). Name-only identity for now (no passwords);
 * admin-only creation. Self-registration with rules comes later.
 */
const fs = require("fs");
const path = require("path");
const { RUNTIME_DIR } = require("./config");

const PLAYERS_DIR = path.join(RUNTIME_DIR, "players");

// Names double as filenames, so the charset is deliberately strict: must start
// with a letter, 2–20 chars, letters/digits/_/- only. This also blocks path
// traversal (no '.', '/', '\').
const NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{1,19}$/;

function validateName(name) {
  if (typeof name !== "string" || !name.trim()) return { ok: false, reason: "Please enter a name." };
  const n = name.trim();
  if (!NAME_RE.test(n))
    return { ok: false, reason: "Names must be 2–20 chars: a letter first, then letters, digits, _ or -." };
  return { ok: true, name: n };
}

const keyOf = (name) => name.trim().toLowerCase();
const fileOf = (name) => path.join(PLAYERS_DIR, keyOf(name) + ".json");

function exists(name) {
  return fs.existsSync(fileOf(name));
}

function load(name) {
  return JSON.parse(fs.readFileSync(fileOf(name), "utf8"));
}

// The players dir is created once, lazily, rather than on every save.
let dirEnsured = false;
function ensureDir() {
  if (!dirEnsured) { fs.mkdirSync(PLAYERS_DIR, { recursive: true }); dirEnsured = true; }
}

// Last payload written per character, so periodic snapshots can skip a disk
// write when nothing has changed. Updated only after a write succeeds, so a
// failed write is retried on the next save rather than silently dropped.
const lastSaved = new Map();

// Synchronous, unconditional write. Use for must-complete paths (shutdown) and
// one-off writes (account creation) — NOT the per-tick snapshot.
function save(playerData) {
  ensureDir();
  const data = JSON.stringify(playerData, null, 2);
  fs.writeFileSync(fileOf(playerData.name), data);
  lastSaved.set(keyOf(playerData.name), data);
}

// Non-blocking write for hot/event paths (tick snapshots, disconnect). The
// snapshot is serialized synchronously at call time, so the write reflects
// state as of the call even though the disk I/O happens off the event loop.
// Resolves false (no write) when the payload is unchanged since the last save.
function saveAsync(playerData) {
  const key = keyOf(playerData.name);
  const data = JSON.stringify(playerData, null, 2);
  if (lastSaved.get(key) === data) return Promise.resolve(false);
  ensureDir();
  return fs.promises.writeFile(fileOf(playerData.name), data).then(() => {
    lastSaved.set(key, data);
    return true;
  });
}

function listNames() {
  if (!fs.existsSync(PLAYERS_DIR)) return [];
  return fs.readdirSync(PLAYERS_DIR).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5));
}

// Every account paired with its admin flag, so the login screen can offer
// admins as a separate (hideable) option and never list them among the
// pickable prospectors. Reads each file once — fine at dev scale (a handful of
// characters); a corrupt file is treated as a non-admin prospector rather than
// blocking the whole list.
function summaries() {
  return listNames().map((key) => {
    // Filenames are lowercased (see keyOf); prefer the character's stored display
    // name so the roster shows "Kara", not "kara". Falls back to the filename for
    // an unreadable file (treated as a non-admin prospector rather than blocking the
    // whole list).
    let name = key, isAdmin = false, level = 1;
    try {
      const data = load(key);
      if (data && typeof data.name === "string") name = data.name;
      isAdmin = !!data.isAdmin;
      if (Number.isFinite(data.level)) level = data.level;
    } catch {
      /* unreadable file — surface the filename, assume non-admin, level 1 */
    }
    return { name, isAdmin, level };
  });
}

// Permanently delete a character file (login-screen delete; dev affordance).
// Returns false if there was nothing to remove.
function remove(name) {
  const f = fileOf(name);
  if (!fs.existsSync(f)) return false;
  fs.unlinkSync(f);
  lastSaved.delete(keyOf(name));
  return true;
}

module.exports = { validateName, exists, load, save, saveAsync, listNames, summaries, remove, PLAYERS_DIR };
