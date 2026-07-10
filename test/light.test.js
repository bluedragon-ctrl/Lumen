"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const {
  bandOf, clampLight, LIGHT_MIN, LIGHT_MAX,
  canSee, hitChance, noticeChance,
} = require("../server/light");

test("bandOf: sub-zero light is the void band", () => {
  assert.equal(bandOf(-1), "void");
  assert.equal(bandOf(-12), "void");
});

test("bandOf: zero and positive bands are unchanged", () => {
  assert.equal(bandOf(0), "darkness");
  assert.equal(bandOf(1), "dim");
  assert.equal(bandOf(2), "dim");
  assert.equal(bandOf(3), "bright");
  assert.equal(bandOf(9), "bright");
  assert.equal(bandOf(10), "searing");
});

test("clampLight: floor is LIGHT_MIN, ceiling is LIGHT_MAX", () => {
  assert.equal(LIGHT_MIN, -20);
  assert.equal(LIGHT_MAX, 20);
  assert.equal(clampLight(-30), -20);
  assert.equal(clampLight(-5), -5);
  assert.equal(clampLight(30), 20);
});

// --- blindAbove: the bright-side stealth cap for dark-adapted hunters ----------
// A pallid-hunter-like band: dark-vision, glare above 2, dazzled blind above 5.
const DARK_ADAPTED = { blindBelow: 0, dimBelow: 0, harmedAbove: 2, blindAbove: 5 };

test("blindAbove: a dark-adapted hunter sees in the dark but is dazzled by strong light", () => {
  assert.equal(canSee(DARK_ADAPTED, 0), true);   // darkvision — the deep is its element
  assert.equal(canSee(DARK_ADAPTED, 5), true);   // still sees at the cap
  assert.equal(canSee(DARK_ADAPTED, 6), false);  // past blindAbove → dazzled blind
});

test("blindAbove: detection drops to zero past the cap (stealth in glare)", () => {
  assert.equal(noticeChance(DARK_ADAPTED, 0), 1);    // noticed instantly in the dark
  assert.equal(noticeChance(DARK_ADAPTED, 3), 0.5);  // glare above harmedAbove — impaired
  assert.equal(noticeChance(DARK_ADAPTED, 6), 0);    // dazzled — cannot notice, can be passed
});

test("blindAbove: a dazzled hunter flails in combat (5%, mirror of the dark)", () => {
  assert.equal(hitChance(DARK_ADAPTED, 2), 1);     // clear sight at the comfortable ceiling
  assert.equal(hitChance(DARK_ADAPTED, 3), 0.5);   // glare
  assert.equal(hitChance(DARK_ADAPTED, 6), 0.05);  // dazzled flailing
});

test("blindAbove: a delver (no blindAbove) is never dazzled by bright light", () => {
  const human = { blindBelow: 1, dimBelow: 3, harmedAbove: 9 };
  assert.equal(canSee(human, 15), true);
  assert.equal(noticeChance(human, 6), 1);   // clear — bright light does not blind a player
  assert.equal(hitChance(human, 6), 1);
});

// --- negative light: darkvision pierces darkness (0); the void (<0) is different -
test("void light: a plain darkvision creature (blindBelow 0) is blind in the void", () => {
  const natural = { blindBelow: 0, dimBelow: 0, harmedAbove: 9 };
  assert.equal(canSee(natural, 0), true);    // pitch darkness — sees fine
  assert.equal(canSee(natural, -1), false);  // the void is anti-light: blind (e.g. a Tide-flood)
  assert.equal(noticeChance(natural, -1), 0);
});

test("void light: a void-native creature (blindBelow -20) sees clearly in the deepest dark", () => {
  const voidborn = { blindBelow: -20, dimBelow: -20, harmedAbove: 3 };
  assert.equal(canSee(voidborn, -6), true);      // deep Tide in its own crypt — still sees
  assert.equal(noticeChance(voidborn, -6), 1);   // clearly, not dimly (dimBelow -20)
  assert.equal(hitChance(voidborn, -6), 1);
});
