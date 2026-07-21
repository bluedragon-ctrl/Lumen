"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const throttle = require("../server/throttle");
const { MAX_FAILS, WINDOW_MS, LOCK_MS, MAX_KEYS } = throttle;

// The throttle keeps one module-level map, so every test uses its own key(s)
// and an injected clock — no cross-test state, no sleeping.
const T0 = 1_000_000;

test("a fresh key is not throttled", () => {
  assert.deepEqual(throttle.check("t-fresh", T0), { ok: true });
});

test("locks after MAX_FAILS failures inside the window", () => {
  const key = "t-lock";
  for (let i = 0; i < MAX_FAILS - 1; i++) throttle.fail(key, T0 + i);
  assert.equal(throttle.check(key, T0 + MAX_FAILS).ok, true, "one short of the limit still passes");
  throttle.fail(key, T0 + MAX_FAILS);
  const r = throttle.check(key, T0 + MAX_FAILS + 1);
  assert.equal(r.ok, false);
  assert.ok(r.retryMs > 0 && r.retryMs <= LOCK_MS, "reports how long until retry");
});

test("the lock expires after LOCK_MS", () => {
  const key = "t-expire";
  for (let i = 0; i < MAX_FAILS; i++) throttle.fail(key, T0);
  assert.equal(throttle.check(key, T0 + LOCK_MS - 1).ok, false, "still locked just before expiry");
  assert.equal(throttle.check(key, T0 + LOCK_MS).ok, true, "free again at expiry");
});

test("failures outside the window start a fresh count", () => {
  const key = "t-window";
  for (let i = 0; i < MAX_FAILS - 1; i++) throttle.fail(key, T0);
  // The window has passed — this failure must not be the locking fifth.
  throttle.fail(key, T0 + WINDOW_MS + 1);
  assert.equal(throttle.check(key, T0 + WINDOW_MS + 2).ok, true);
});

test("clear (a successful login) resets the count", () => {
  const key = "t-clear";
  for (let i = 0; i < MAX_FAILS - 1; i++) throttle.fail(key, T0);
  throttle.clear(key);
  for (let i = 0; i < MAX_FAILS - 1; i++) throttle.fail(key, T0 + 10);
  assert.equal(throttle.check(key, T0 + 11).ok, true, "old failures don't carry past a success");
});

test("the key map is hard-capped: overflow evicts oldest-first", () => {
  const victim = "t-cap-victim";
  for (let i = 0; i < MAX_FAILS; i++) throttle.fail(victim, T0);
  assert.equal(throttle.check(victim, T0 + 1).ok, false, "victim starts locked");
  // Name-spam MAX_KEYS fresh keys; the victim (oldest) gets evicted, its lock with it.
  for (let i = 0; i < MAX_KEYS + 1; i++) throttle.fail(`t-cap-${i}`, T0 + 2);
  assert.equal(throttle.check(victim, T0 + 3).ok, true, "evicted — memory stays bounded");
  for (let i = 0; i < MAX_KEYS + 1; i++) throttle.clear(`t-cap-${i}`); // tidy up for other tests
});
