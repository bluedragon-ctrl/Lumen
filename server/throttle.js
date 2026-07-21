"use strict";
/**
 * Brute-force throttle for the unauthenticated login screen. Tracks failed
 * guesses per key — "name:<name>" for an account password, "invite" (one
 * shared bucket) for the registration key — and locks a key out for a short
 * spell after repeated failures. In-memory only (resets on restart) and
 * deliberately tiny: the goal is to make guessing cost time, not to be an
 * account-security boundary.
 *
 * Caller contract: check() BEFORE any scrypt work so a locked-out attempt
 * costs the server nothing; fail() only on a wrong secret (never on "no such
 * name" or validation errors — those aren't secret-guessing); clear() on
 * success so a legit user who mistypes twice never locks themselves out.
 * The clock is injectable so the tests never sleep.
 *
 * Known trade-offs, accepted at friends-scale: someone who knows a character's
 * name can lock its owner out for LOCK_MS at a time (kept short for exactly
 * that reason), and the key map is hard-capped so name-spam can't grow memory
 * unboundedly (overflow evicts oldest-first).
 */
const MAX_FAILS = 5; // failures within WINDOW_MS before a key locks
const WINDOW_MS = 15 * 60 * 1000;
const LOCK_MS = 60 * 1000;
const MAX_KEYS = 1000;

const attempts = new Map(); // key -> { fails, windowStart, lockedUntil }

// { ok: true } or { ok: false, retryMs } while the key is locked out.
function check(key, now = Date.now()) {
  const a = attempts.get(key);
  if (a && a.lockedUntil > now) return { ok: false, retryMs: a.lockedUntil - now };
  return { ok: true };
}

// Record a failed guess; MAX_FAILS inside one window locks the key.
function fail(key, now = Date.now()) {
  prune(now);
  let a = attempts.get(key);
  if (!a || (a.lockedUntil <= now && now - a.windowStart > WINDOW_MS)) {
    a = { fails: 0, windowStart: now, lockedUntil: 0 };
    attempts.set(key, a);
  }
  a.fails += 1;
  if (a.fails >= MAX_FAILS) {
    a.lockedUntil = now + LOCK_MS;
    a.fails = 0; // the lock resets the window — guessing again after it starts a fresh count
    a.windowStart = now;
  }
}

function clear(key) {
  attempts.delete(key);
}

// Drop entries that are neither locked nor inside their failure window, then
// enforce the hard cap (Map iterates in insertion order, so oldest-first).
function prune(now) {
  for (const [k, a] of attempts)
    if (a.lockedUntil <= now && now - a.windowStart > WINDOW_MS) attempts.delete(k);
  while (attempts.size > MAX_KEYS) attempts.delete(attempts.keys().next().value);
}

module.exports = { check, fail, clear, MAX_FAILS, WINDOW_MS, LOCK_MS, MAX_KEYS };
