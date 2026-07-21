"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { strike } = require("../server/combat-math");

// A weapon's `pierce` ignores a flat slice of the defender's Armour before the
// physical soak (a mace's blunt head cracking shell). Determinism as in
// strike-overflow.test.js: a sure hit (raw to-hit >= 1), never-crit (crit 0),
// and an integer die ("10" → rollDice === 10, no RNG).
const band = { blindBelow: 1, dimBelow: 3, harmedAbove: 9 };
const CLEAR = 5; // clear tier, hitChance 1.0
const armoured = { armour: 4, ward: 0, evasion: 0 };

test("pierce reduces the flat Armour soak on a physical blow", () => {
  // armour 4: a plain blow soaks to 10 - 4 = 6; pierce 2 cracks two points → 10 - 2 = 8.
  const plain = strike({ band, hitBonus: 0, dmgBonus: 0, crit: 0, pierce: 0 }, armoured, CLEAR, "10");
  const mace = strike({ band, hitBonus: 0, dmgBonus: 0, crit: 0, pierce: 2 }, armoured, CLEAR, "10");
  assert.equal(plain.damage, 6);
  assert.equal(mace.damage, 8);
});

test("pierce past the defender's Armour just zeroes the soak (no negative armour)", () => {
  // pierce 5 vs armour 4 → effective armour 0, full damage; never wraps into a bonus.
  const r = strike({ band, hitBonus: 0, dmgBonus: 0, crit: 0, pierce: 5 }, armoured, CLEAR, "10");
  assert.equal(r.damage, 10);
});

test("pierce does nothing to a magical blow (Ward is a percent cut, not a plate)", () => {
  // Magical damage is cut by Ward %, untouched by pierce: ward 50 halves 10 → 5 either way.
  const warded = { armour: 0, ward: 50, evasion: 0 };
  const plain = strike({ band, hitBonus: 0, dmgBonus: 0, crit: 0, pierce: 0 }, warded, CLEAR, "10", "magical");
  const pierced = strike({ band, hitBonus: 0, dmgBonus: 0, crit: 0, pierce: 5 }, warded, CLEAR, "10", "magical");
  assert.equal(plain.damage, 5);
  assert.equal(pierced.damage, 5);
});
