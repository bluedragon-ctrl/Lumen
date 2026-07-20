"use strict";
/**
 * Player account persistence. Accounts are one JSON file per character under
 * data/runtime/players/ (gitignored). Each account is password-protected: a
 * per-account random salt and a scrypt-derived `passwordHash` (both hex) are
 * stored on the character JSON. Anyone may register — passwords protect account
 * *identity* (only the owner logs in as, or deletes, a character), not server
 * access. Accounts written before passwords existed carry neither field and are
 * claimed by setting a password on first login (see `hasPassword`).
 */
const crypto = require("crypto");
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

// --- Passwords -------------------------------------------------------------
// Hashing uses Node's built-in scrypt only — the repo deliberately ships one
// dependency (`ws`), so no bcrypt/argon2. Each account gets a fresh random salt;
// verification is constant-time (timingSafeEqual) to avoid leaking via timing.
const SCRYPT_KEYLEN = 64;
const PW_MIN = 6;
const PW_MAX = 200; // scrypt cost scales with input; cap to keep it cheap.

function validatePassword(pw) {
  if (typeof pw !== "string" || pw.length < PW_MIN)
    return { ok: false, reason: `Passwords must be at least ${PW_MIN} characters.` };
  if (pw.length > PW_MAX)
    return { ok: false, reason: `Passwords must be at most ${PW_MAX} characters.` };
  return { ok: true };
}

// Derive a fresh { salt, passwordHash } (both hex) for a plaintext password.
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const passwordHash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN).toString("hex");
  return { salt, passwordHash };
}

// Constant-time check of a plaintext password against a stored salt+hash.
// Returns false (never throws) on any missing/mismatched/garbage input.
function verifyPassword(password, salt, passwordHash) {
  if (typeof password !== "string" || typeof salt !== "string" || typeof passwordHash !== "string")
    return false;
  let derived, stored;
  try {
    derived = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
    stored = Buffer.from(passwordHash, "hex");
  } catch {
    return false;
  }
  return stored.length === derived.length && crypto.timingSafeEqual(stored, derived);
}

// Whether an account has a password set. Pre-password saves have neither field
// and must claim a password on first login (claim-on-first-login migration).
function hasPassword(data) {
  return !!(data && typeof data.salt === "string" && typeof data.passwordHash === "string");
}

// Pure auth decision for a login/delete attempt against loaded account data, so
// index.js and the tests share one rule. An account with no password yet can't
// be entered or deleted — it must be claimed first (reason "needs-claim");
// a set password must match (reason "bad-password"); otherwise { ok: true }.
function checkPassword(data, password) {
  if (!hasPassword(data)) return { ok: false, reason: "needs-claim" };
  if (!verifyPassword(password, data.salt, data.passwordHash)) return { ok: false, reason: "bad-password" };
  return { ok: true };
}

// Admin password reset: strip an account's password so it reverts to claimable
// and the owner sets a fresh one on next login (claim-on-first-login). We never
// hand a password back — the player picks their own. Returns false if there was
// no password to clear. Caller must ensure the account isn't currently logged in
// (a live snapshot would otherwise rewrite the hash back).
function clearPassword(name) {
  const data = load(name);
  if (!hasPassword(data)) return false;
  delete data.salt;
  delete data.passwordHash;
  save(data);
  return true;
}

// --- Invitation key --------------------------------------------------------
// The new-player registration gate (server/config.js `INVITE_KEY_HASH`). Unlike
// account passwords this is one shared secret, not per-character, and is never
// stored per-player. The configured value is a "salt:hash" string produced by
// tools/hash-invite-key.js; a submitted key is hashed with the stored salt and
// compared constant-time (via verifyPassword). Plaintext never touches disk.
function hashInviteKey(key) {
  const { salt, passwordHash } = hashPassword(key);
  return `${salt}:${passwordHash}`;
}

function verifyInviteKey(key, saltHash) {
  if (typeof key !== "string" || typeof saltHash !== "string") return false;
  const sep = saltHash.indexOf(":");
  if (sep < 0) return false;
  return verifyPassword(key, saltHash.slice(0, sep), saltHash.slice(sep + 1));
}

// Runtime override for the invitation key, set live by an admin (`@invite-key`)
// rather than the boot-time INVITE_KEY_HASH env var — handy where the env is
// awkward to change (e.g. a Fly.io deploy). Stored as one small file on the same
// gitignored runtime tree as player saves; only the hash is written, never the
// plaintext. When present it takes precedence over the env default (the
// precedence itself lives in server/index.js). NOTE: like player saves, this
// only survives a redeploy if data/runtime/ is on a persistent volume; otherwise
// it resets and the env default (if any) takes back over.
const INVITE_FILE = path.join(RUNTIME_DIR, "invite.json");

function loadInviteHash() {
  try {
    const data = JSON.parse(fs.readFileSync(INVITE_FILE, "utf8"));
    return typeof data.inviteKeyHash === "string" ? data.inviteKeyHash : null;
  } catch {
    return null; // missing or unreadable → no runtime override
  }
}

function writeInviteHash(saltHash) {
  ensureDir();
  fs.writeFileSync(INVITE_FILE, JSON.stringify({ inviteKeyHash: saltHash }, null, 2));
}

// Remove the runtime override. Returns false if there was nothing to clear.
function clearInviteHash() {
  if (!fs.existsSync(INVITE_FILE)) return false;
  fs.unlinkSync(INVITE_FILE);
  return true;
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
    let name = key, isAdmin = false, level = 1, needsPassword = false;
    try {
      const data = load(key);
      if (data && typeof data.name === "string") name = data.name;
      isAdmin = !!data.isAdmin;
      if (Number.isFinite(data.level)) level = data.level;
      needsPassword = !hasPassword(data); // no hash yet → claimable on first login
    } catch {
      /* unreadable file — surface the filename, assume non-admin, level 1, not claimable */
    }
    return { name, isAdmin, level, needsPassword };
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

module.exports = {
  validateName, exists, load, save, saveAsync, listNames, summaries, remove, PLAYERS_DIR,
  validatePassword, hashPassword, verifyPassword, hasPassword, checkPassword, clearPassword,
  hashInviteKey, verifyInviteKey, loadInviteHash, writeInviteHash, clearInviteHash,
};
