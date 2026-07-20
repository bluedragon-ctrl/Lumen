"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const accounts = require("../server/accounts");

// The auth paths are exercised through the pure helpers in accounts.js —
// index.js's login/create/delete/claim all funnel their password decision
// through checkPassword, so these cover the same logic without spinning a
// server or touching the runtime players dir.

// --- Hashing round-trip ----------------------------------------------------

test("hashPassword/verifyPassword: the right password verifies", () => {
  const { salt, passwordHash } = accounts.hashPassword("correct horse");
  assert.ok(salt && passwordHash, "hash produces a salt and a hash");
  assert.equal(accounts.verifyPassword("correct horse", salt, passwordHash), true);
});

test("hashPassword: a fresh salt each time, and both hashes still verify", () => {
  const a = accounts.hashPassword("same-password");
  const b = accounts.hashPassword("same-password");
  assert.notEqual(a.salt, b.salt, "salts are random per call");
  assert.notEqual(a.passwordHash, b.passwordHash, "so the stored hashes differ too");
  assert.equal(accounts.verifyPassword("same-password", a.salt, a.passwordHash), true);
  assert.equal(accounts.verifyPassword("same-password", b.salt, b.passwordHash), true);
});

// --- Wrong-password rejection ----------------------------------------------

test("verifyPassword: the wrong password is rejected", () => {
  const { salt, passwordHash } = accounts.hashPassword("hunter2");
  assert.equal(accounts.verifyPassword("hunter3", salt, passwordHash), false);
  assert.equal(accounts.verifyPassword("", salt, passwordHash), false);
});

test("verifyPassword: missing/garbage salt or hash returns false, never throws", () => {
  const { salt, passwordHash } = accounts.hashPassword("pw");
  assert.equal(accounts.verifyPassword("pw", undefined, passwordHash), false);
  assert.equal(accounts.verifyPassword("pw", salt, undefined), false);
  assert.equal(accounts.verifyPassword("pw", "zz", "not-hex-and-wrong-length"), false);
});

// --- Password policy -------------------------------------------------------

test("validatePassword: enforces a minimum length", () => {
  assert.equal(accounts.validatePassword("short").ok, false); // 5 chars
  assert.equal(accounts.validatePassword("enough").ok, true); // 6 chars
  assert.equal(accounts.validatePassword("x".repeat(201)).ok, false);
  assert.equal(accounts.validatePassword(123).ok, false); // non-string
});

// --- hasPassword / claim-on-first-login ------------------------------------

test("hasPassword: false for a pre-password account, true once claimed", () => {
  const legacy = { name: "Kara", level: 3 }; // no salt/hash — an un-migrated save
  assert.equal(accounts.hasPassword(legacy), false);

  // Claim: stamp a password in, as claimPassword does on first login.
  Object.assign(legacy, accounts.hashPassword("newly-set"));
  assert.equal(accounts.hasPassword(legacy), true);
  assert.equal(accounts.verifyPassword("newly-set", legacy.salt, legacy.passwordHash), true);
});

// --- checkPassword: the shared login/delete gate ---------------------------

test("checkPassword: an unclaimed account must be claimed, not entered/deleted", () => {
  const legacy = { name: "Bram" }; // no password yet
  const r = accounts.checkPassword(legacy, "anything");
  assert.equal(r.ok, false);
  assert.equal(r.reason, "needs-claim");
});

test("checkPassword: right password passes, wrong password is bad-password", () => {
  const data = { name: "Ines" };
  Object.assign(data, accounts.hashPassword("open-sesame"));
  assert.equal(accounts.checkPassword(data, "open-sesame").ok, true);
  const bad = accounts.checkPassword(data, "open-barley");
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, "bad-password");
});

// --- Invitation key (new-player registration gate) -------------------------

test("invite key: the right key verifies against its salt:hash", () => {
  const stored = accounts.hashInviteKey("let-me-in-2026");
  assert.match(stored, /^[0-9a-f]+:[0-9a-f]+$/, "stored as salt:hash hex");
  assert.equal(accounts.verifyInviteKey("let-me-in-2026", stored), true);
});

test("invite key: the wrong key is rejected", () => {
  const stored = accounts.hashInviteKey("correct-key");
  assert.equal(accounts.verifyInviteKey("wrong-key", stored), false);
  assert.equal(accounts.verifyInviteKey("", stored), false);
});

test("invite key: missing/malformed stored value returns false, never throws", () => {
  assert.equal(accounts.verifyInviteKey("key", undefined), false);
  assert.equal(accounts.verifyInviteKey("key", "no-colon-here"), false);
  assert.equal(accounts.verifyInviteKey("key", ":onlyhash"), false);
  assert.equal(accounts.verifyInviteKey(undefined, "salt:hash"), false);
});
