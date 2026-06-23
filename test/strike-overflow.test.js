"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { strike } = require("../server/combat-math");

// strike() resolves one swing. We make outcomes deterministic without stubbing
// Math.random() by pinning the *chance* to a certainty:
//   - a sure hit:  raw to-hit >= 1  → Math.random() >= 1 is always false (always hits)
//   - a sure crit: overflowCrit >= 1 → Math.random() < (>=1) is always true (always crits)
//   - never crit:  crit chance 0     → Math.random() < 0 is always false (never crits)
// Damage dice are authored as a plain integer ("10" → rollDice === 10, no RNG).
const band = { blindBelow: 1, dimBelow: 3, harmedAbove: 9 };
const CLEAR = 5; // ambient light at/above dimBelow → clear tier, hitChance 1.0
const noDefence = { armour: 0, ward: 0, evasion: 0 };

test("accuracy past 100% converts 1:1 into bonus crit (doubles the roll)", () => {
  // raw = 1.0 (clear) + 1.0 (hit bonus) = 2.0 → overflowCrit 1.0 → always crits.
  const r = strike({ band, hitBonus: 1.0, dmgBonus: 0, crit: 0 }, noDefence, CLEAR, "10");
  assert.equal(r.hit, true);
  assert.equal(r.crit, true);
  assert.equal(r.damage, 20); // 10 doubled by the overflow-fed crit
});

test("at exactly 100% to-hit there is no overflow, so no bonus crit", () => {
  // raw = 1.0 (clear) + 0 hit bonus = 1.0 → overflowCrit 0, base crit 0 → never crits.
  const r = strike({ band, hitBonus: 0, dmgBonus: 0, crit: 0 }, noDefence, CLEAR, "10");
  assert.equal(r.hit, true);
  assert.equal(r.crit, false);
  assert.equal(r.damage, 10);
});

test("evasion is paid down before any surplus spills into crit", () => {
  // raw = 1.0 + 0.5 hit bonus - 0.5 evasion = 1.0 → no overflow, so no crit.
  const r = strike({ band, hitBonus: 0.5, dmgBonus: 0, crit: 0 }, { ...noDefence, evasion: 0.5 }, CLEAR, "10");
  assert.equal(r.hit, true);
  assert.equal(r.crit, false);
  assert.equal(r.damage, 10);
});
