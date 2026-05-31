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

function save(playerData) {
  fs.mkdirSync(PLAYERS_DIR, { recursive: true });
  fs.writeFileSync(fileOf(playerData.name), JSON.stringify(playerData, null, 2));
}

function listNames() {
  if (!fs.existsSync(PLAYERS_DIR)) return [];
  return fs.readdirSync(PLAYERS_DIR).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5));
}

module.exports = { validateName, exists, load, save, listNames, PLAYERS_DIR };
