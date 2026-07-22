"use strict";
/**
 * Player account persistence. Accounts are one JSON file per character under
 * data/runtime/players/ (gitignored). Each account is password-protected: a
 * self-describing scrypt hash string (`passwordHash`, format under
 * "Passwords" below) is stored on the character JSON. Anyone may register —
 * passwords protect account *identity* (only the owner logs in as, or deletes,
 * a character), not server access. Accounts written before passwords existed
 * carry no `passwordHash` and are claimed by setting a password on first login
 * (see `hasPassword`); accounts from the first password era store a legacy
 * salt+hash field pair, verified as such and re-stamped on login.
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { promisify } = require("util");
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
//
// A stored hash is one self-describing string, "scrypt:N:r:p:<salt>:<hash>"
// (salt/hash hex), so the cost parameters ride with the hash: SCRYPT below can
// be raised at any time and every old hash still verifies with the params it
// was made with (a successful login re-stamps it — see checkPassword's
// `rehash`). Colons rather than PHC-style '$' because the same format is pasted
// into .env files, and '$' gets interpolated by docker-compose and some shells.
// Accounts from before this format (separate hex `salt` + `passwordHash`
// fields, Node's default params) still verify via the legacy path.
const SCRYPT = { N: 16384, r: 8, p: 1 }; // Node's current defaults, pinned explicitly
const SCRYPT_KEYLEN = 64;
// Ceiling on the memory a *stored* hash may demand at verify time (scrypt needs
// 128·N·r bytes) — a hand-edited player file must fail closed, not allocate GBs.
const MAX_MEM = 64 * 1024 * 1024;
const PW_MIN = 6;
const PW_MAX = 200; // scrypt cost scales with input; cap to keep it cheap.

const scryptAsync = promisify(crypto.scrypt);
const scryptOpts = ({ N, r, p }) => ({ N, r, p, maxmem: MAX_MEM * 2 });

function validatePassword(pw) {
  if (typeof pw !== "string" || pw.length < PW_MIN)
    return { ok: false, reason: `Passwords must be at least ${PW_MIN} characters.` };
  if (pw.length > PW_MAX)
    return { ok: false, reason: `Passwords must be at most ${PW_MAX} characters.` };
  return { ok: true };
}

const formatHash = (salt, hash, { N, r, p }) => `scrypt:${N}:${r}:${p}:${salt}:${hash}`;

// Parse a stored "scrypt:N:r:p:salt:hash" string; null for anything malformed
// or demanding absurd parameters (verification executes what's stored, so a
// tampered file must be rejected here, before it can cost memory or time).
function parseHash(stored) {
  if (typeof stored !== "string") return null;
  const parts = stored.split(":");
  if (parts.length !== 6 || parts[0] !== "scrypt") return null;
  const [N, r, p] = parts.slice(1, 4).map(Number);
  const [salt, hash] = parts.slice(4);
  if (!Number.isInteger(N) || N < 2 || (N & (N - 1)) !== 0) return null; // power of two
  if (!Number.isInteger(r) || r < 1 || !Number.isInteger(p) || p < 1 || p > 16) return null;
  if (128 * N * r > MAX_MEM) return null;
  if (!/^[0-9a-f]{2,}$/.test(salt) || !/^(?:[0-9a-f]{2})+$/.test(hash)) return null;
  return { N, r, p, salt, hash };
}

// Derive a fresh { passwordHash } (self-describing string, see above) for a
// plaintext password. Async — scrypt runs on the thread pool, so a login never
// stalls the tick loop.
async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const buf = await scryptAsync(password, salt, SCRYPT_KEYLEN, scryptOpts(SCRYPT));
  return { passwordHash: formatHash(salt, buf.toString("hex"), SCRYPT) };
}

// Sync twin for the few places where blocking is correct: the boot-time
// ADMIN_PASSWORD stamp (runs before listen()), the @invite-key admin command,
// and tools/hash-invite-key.js. Never call this on a socket-driven path.
function hashPasswordSync(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN, scryptOpts(SCRYPT)).toString("hex");
  return { passwordHash: formatHash(salt, hash, SCRYPT) };
}

// Constant-time check of a plaintext password against a parsed stored hash.
// Returns false (never throws) on any garbage input.
async function verifyParsed(password, { N, r, p, salt, hash }) {
  if (typeof password !== "string") return false;
  let derived, stored;
  try {
    stored = Buffer.from(hash, "hex");
    derived = await scryptAsync(password, salt, stored.length, scryptOpts({ N, r, p }));
  } catch {
    return false;
  }
  return stored.length === derived.length && crypto.timingSafeEqual(stored, derived);
}

// Legacy pre-format hashes: separate hex `salt` + `passwordHash` fields, made
// with Node's default scrypt params (exactly what SCRYPT pins today). Verified
// so existing accounts keep working; a successful login re-stamps them into the
// current format (checkPassword's `rehash`).
async function verifyLegacy(password, salt, hexHash) {
  if (typeof password !== "string" || typeof salt !== "string" || typeof hexHash !== "string") return false;
  let derived, stored;
  try {
    stored = Buffer.from(hexHash, "hex");
    derived = await scryptAsync(password, salt, SCRYPT_KEYLEN, scryptOpts(SCRYPT));
  } catch {
    return false;
  }
  return stored.length === derived.length && crypto.timingSafeEqual(stored, derived);
}

// Whether an account has a password set — any stored `passwordHash` string
// counts (current format or the legacy pair), so an unreadable/corrupt hash
// locks the account (admin @reset-password recovers it) rather than leaving it
// claimable by anyone. Pre-password saves carry no `passwordHash` at all and
// must claim one on first login (claim-on-first-login migration).
function hasPassword(data) {
  return !!(data && typeof data.passwordHash === "string");
}

// Pure auth decision for a login/delete attempt against loaded account data, so
// index.js and the tests share one rule. An account with no password yet can't
// be entered or deleted — it must be claimed first (reason "needs-claim");
// a set password must match (reason "bad-password"); otherwise { ok: true }.
// A success may carry `rehash: true` — verified, but stored in the legacy
// format or with stale cost params — telling the caller to re-stamp via
// hashPassword now, while it still holds the plaintext (lazy migration).
async function checkPassword(data, password) {
  if (!hasPassword(data)) return { ok: false, reason: "needs-claim" };
  const parsed = parseHash(data.passwordHash);
  if (parsed) {
    if (!(await verifyParsed(password, parsed))) return { ok: false, reason: "bad-password" };
    const stale = parsed.N !== SCRYPT.N || parsed.r !== SCRYPT.r || parsed.p !== SCRYPT.p;
    return stale ? { ok: true, rehash: true } : { ok: true };
  }
  if (!(await verifyLegacy(password, data.salt, data.passwordHash))) return { ok: false, reason: "bad-password" };
  return { ok: true, rehash: true };
}

// The dev passwordless-admin affordance (server/config.js DEV_ADMIN_NO_PASSWORD).
// Pure so index.js's login path and the tests share one rule. The mode is in
// force only when the dev flag is on AND no ADMIN_PASSWORD is configured — a
// real admin password ALWAYS wins, so the flag can never downgrade a deployment
// that set one. index.js then grants a name-only login only to `admin` accounts.
function devAdminActive({ devFlag, adminPasswordSet }) {
  return !!devFlag && !adminPasswordSet;
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
// stored per-player. The configured value is the same self-describing
// "scrypt:N:r:p:salt:hash" string as account passwords, produced by
// tools/hash-invite-key.js or `@invite-key`; pre-format "salt:hash" values from
// older deployments still verify. Plaintext never touches disk. Hashing is sync
// (it runs inside the @invite-key admin command and the CLI tool — rare,
// admin-gated paths); verification is async (it runs on account creation).
function hashInviteKey(key) {
  return hashPasswordSync(key).passwordHash;
}

async function verifyInviteKey(key, stored) {
  if (typeof key !== "string" || typeof stored !== "string") return false;
  const parsed = parseHash(stored);
  if (parsed) return verifyParsed(key, parsed);
  const sep = stored.indexOf(":"); // legacy "salt:hash"
  if (sep < 0) return false;
  return verifyLegacy(key, stored.slice(0, sep), stored.slice(sep + 1));
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
  validatePassword, hashPassword, hashPasswordSync, parseHash, hasPassword, checkPassword, clearPassword, devAdminActive,
  hashInviteKey, verifyInviteKey, loadInviteHash, writeInviteHash, clearInviteHash,
};
