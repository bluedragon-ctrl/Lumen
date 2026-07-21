"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");
const accounts = require("../server/accounts");

// The auth paths are exercised through the pure helpers in accounts.js —
// index.js's login/create/delete/claim all funnel their password decision
// through checkPassword, so these cover the same logic without spinning a
// server or touching the runtime players dir (except the two file-backed
// round-trips at the bottom).

// Build the two on-disk formats a live server can encounter, without going
// through the public API: the legacy field pair (first password era, Node's
// default scrypt params) and a current-format string with explicit params.
function legacyPair(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const passwordHash = crypto.scryptSync(password, salt, 64).toString("hex");
  return { salt, passwordHash };
}
function formatWithParams(password, { N, r, p }) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64, { N, r, p }).toString("hex");
  return `scrypt:${N}:${r}:${p}:${salt}:${hash}`;
}

// --- Hashing round-trip ----------------------------------------------------

test("hashPassword: produces a self-describing hash that verifies", async () => {
  const { passwordHash } = await accounts.hashPassword("correct horse");
  assert.match(passwordHash, /^scrypt:16384:8:1:[0-9a-f]+:[0-9a-f]+$/, "current params ride the hash");
  const chk = await accounts.checkPassword({ name: "T", passwordHash }, "correct horse");
  assert.equal(chk.ok, true);
  assert.equal(chk.rehash, undefined, "a current-format hash needs no re-stamp");
});

test("hashPasswordSync: same format, same verification path", async () => {
  const { passwordHash } = accounts.hashPasswordSync("boot-time-admin");
  assert.ok(accounts.parseHash(passwordHash), "parses as the current format");
  assert.equal((await accounts.checkPassword({ passwordHash }, "boot-time-admin")).ok, true);
});

test("hashPassword: a fresh salt each time, and both hashes still verify", async () => {
  const a = await accounts.hashPassword("same-password");
  const b = await accounts.hashPassword("same-password");
  assert.notEqual(a.passwordHash, b.passwordHash, "salts are random per call");
  assert.equal((await accounts.checkPassword({ passwordHash: a.passwordHash }, "same-password")).ok, true);
  assert.equal((await accounts.checkPassword({ passwordHash: b.passwordHash }, "same-password")).ok, true);
});

// --- Wrong-password rejection ----------------------------------------------

test("checkPassword: the wrong password is rejected", async () => {
  const data = { passwordHash: (await accounts.hashPassword("hunter2")).passwordHash };
  assert.equal((await accounts.checkPassword(data, "hunter3")).reason, "bad-password");
  assert.equal((await accounts.checkPassword(data, "")).reason, "bad-password");
  assert.equal((await accounts.checkPassword(data, undefined)).reason, "bad-password");
});

test("checkPassword: a corrupt stored hash fails closed (bad-password, not claimable)", async () => {
  // Unparseable string, no legacy pair to fall back to: the account stays
  // locked (admin @reset-password recovers it) rather than claimable-by-anyone.
  const data = { name: "X", passwordHash: "scrypt:16384:8:1:zz:not-hex" };
  assert.equal(accounts.hasPassword(data), true, "a set-but-corrupt hash still counts as set");
  const chk = await accounts.checkPassword(data, "anything");
  assert.equal(chk.ok, false);
  assert.equal(chk.reason, "bad-password");
});

// --- Stored-format parsing (parameters are executed, so bounds matter) ------

test("parseHash: accepts the current format, rejects malformed or abusive params", async () => {
  const good = (await accounts.hashPassword("pw")).passwordHash;
  assert.ok(accounts.parseHash(good));
  assert.equal(accounts.parseHash(undefined), null);
  assert.equal(accounts.parseHash("salt:hash"), null, "legacy pair is not this format");
  assert.equal(accounts.parseHash("bcrypt:16384:8:1:ab:cd12"), null, "unknown algorithm");
  assert.equal(accounts.parseHash("scrypt:12345:8:1:ab:cd12"), null, "N must be a power of two");
  assert.equal(accounts.parseHash("scrypt:1048576:8:1:ab:cd12"), null, "memory demand over the ceiling");
  assert.equal(accounts.parseHash("scrypt:16384:0:1:ab:cd12"), null, "r must be >= 1");
  assert.equal(accounts.parseHash("scrypt:16384:8:17:ab:cd12"), null, "p over the ceiling");
  assert.equal(accounts.parseHash("scrypt:16384:8:1:ZZ:cd12"), null, "salt must be hex");
  assert.equal(accounts.parseHash("scrypt:16384:8:1:ab:cd1"), null, "hash must be whole hex bytes");
});

// --- Password policy -------------------------------------------------------

test("validatePassword: enforces a minimum length", () => {
  assert.equal(accounts.validatePassword("short").ok, false); // 5 chars
  assert.equal(accounts.validatePassword("enough").ok, true); // 6 chars
  assert.equal(accounts.validatePassword("x".repeat(201)).ok, false);
  assert.equal(accounts.validatePassword(123).ok, false); // non-string
});

// --- hasPassword / claim-on-first-login ------------------------------------

test("hasPassword: false for a pre-password account, true once claimed", async () => {
  const legacy = { name: "Kara", level: 3 }; // no passwordHash — an un-migrated save
  assert.equal(accounts.hasPassword(legacy), false);

  // Claim: stamp a password in, as claimPassword does on first login.
  Object.assign(legacy, await accounts.hashPassword("newly-set"));
  assert.equal(accounts.hasPassword(legacy), true);
  assert.equal((await accounts.checkPassword(legacy, "newly-set")).ok, true);
});

// --- checkPassword: the shared login/delete gate ---------------------------

test("checkPassword: an unclaimed account must be claimed, not entered/deleted", async () => {
  const legacy = { name: "Bram" }; // no password yet
  const r = await accounts.checkPassword(legacy, "anything");
  assert.equal(r.ok, false);
  assert.equal(r.reason, "needs-claim");
});

// --- Lazy migration: legacy and stale-params hashes verify, then re-stamp ---

test("checkPassword: a legacy salt+hash pair verifies and asks for a rehash", async () => {
  const data = { name: "Ines", ...legacyPair("open-sesame") };
  const ok = await accounts.checkPassword(data, "open-sesame");
  assert.equal(ok.ok, true);
  assert.equal(ok.rehash, true, "legacy format → re-stamp on login");
  const bad = await accounts.checkPassword(data, "open-barley");
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, "bad-password");
});

test("checkPassword: stale cost params verify and ask for a rehash", async () => {
  const data = { passwordHash: formatWithParams("keep-me", { N: 8192, r: 8, p: 1 }) };
  const chk = await accounts.checkPassword(data, "keep-me");
  assert.equal(chk.ok, true);
  assert.equal(chk.rehash, true, "params below the pinned SCRYPT cost → re-stamp on login");
});

// --- Admin password reset (clear → claimable again) ------------------------

test("clearPassword: reverts a claimed account to claimable (admin @reset-password)", async () => {
  const name = "verify-reset-tmp"; // a throwaway account file
  if (accounts.exists(name)) return; // never clobber a real account
  const data = { name, level: 1 };
  Object.assign(data, await accounts.hashPassword("forgotten"));
  accounts.save(data);
  try {
    assert.equal(accounts.hasPassword(accounts.load(name)), true);
    assert.equal(accounts.clearPassword(name), true);
    assert.equal(accounts.hasPassword(accounts.load(name)), false, "now claimable again");
    assert.equal(accounts.clearPassword(name), false, "nothing left to clear");
  } finally {
    accounts.remove(name);
  }
});

// --- Invitation key (new-player registration gate) -------------------------

test("invite key: the right key verifies against its stored hash", async () => {
  const stored = accounts.hashInviteKey("let-me-in-2026");
  assert.ok(accounts.parseHash(stored), "stored in the same self-describing format as passwords");
  assert.equal(await accounts.verifyInviteKey("let-me-in-2026", stored), true);
});

test("invite key: the wrong key is rejected", async () => {
  const stored = accounts.hashInviteKey("correct-key");
  assert.equal(await accounts.verifyInviteKey("wrong-key", stored), false);
  assert.equal(await accounts.verifyInviteKey("", stored), false);
});

test("invite key: a legacy salt:hash env value still verifies", async () => {
  const { salt, passwordHash } = legacyPair("old-deploy-key");
  const stored = `${salt}:${passwordHash}`;
  assert.equal(await accounts.verifyInviteKey("old-deploy-key", stored), true);
  assert.equal(await accounts.verifyInviteKey("wrong", stored), false);
});

test("invite key: missing/malformed stored value returns false, never throws", async () => {
  assert.equal(await accounts.verifyInviteKey("key", undefined), false);
  assert.equal(await accounts.verifyInviteKey("key", "no-colon-here"), false);
  assert.equal(await accounts.verifyInviteKey("key", ":onlyhash"), false);
  assert.equal(await accounts.verifyInviteKey(undefined, "salt:hash"), false);
});

test("invite key runtime store: write → load → clear round-trips (admin @invite-key)", () => {
  const prior = accounts.loadInviteHash(); // usually null; restored in finally
  try {
    assert.equal(accounts.clearInviteHash(), prior != null ? true : false); // start clean
    assert.equal(accounts.loadInviteHash(), null);
    const stored = accounts.hashInviteKey("runtime-rotated");
    accounts.writeInviteHash(stored);
    assert.equal(accounts.loadInviteHash(), stored);
    assert.equal(accounts.clearInviteHash(), true);
    assert.equal(accounts.loadInviteHash(), null);
    assert.equal(accounts.clearInviteHash(), false); // nothing left to clear
  } finally {
    if (prior) accounts.writeInviteHash(prior);
    else accounts.clearInviteHash();
  }
});
