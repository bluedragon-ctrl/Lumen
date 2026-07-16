"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { mitigate, wardPoolFor } = require("../server/combat-math");

// Voidward is the first damage type after physical to earn its own mitigation
// rule: void is cut as a PERCENT by the defender's `voidWard` pool ONLY — Ward
// (spellward) no longer touches it — while every other non-physical type is still
// cut by Ward. mitigate() is pure, so these assert the branch directly.

test("mitigate: void is cut by voidWard as a percent, not by Ward", () => {
  // 50 voidward halves a 20 void blow; the defender's Ward is irrelevant to it.
  assert.equal(mitigate(20, "void", { armour: 99, ward: 90, voidWard: 50 }), 10);
});

test("mitigate: Ward gives no protection against void", () => {
  // High Ward, zero voidward → void lands in full (only the floor-of-1 applies).
  assert.equal(mitigate(20, "void", { armour: 99, ward: 90, voidWard: 0 }), 20);
});

test("mitigate: voidWard does not touch magical or physical", () => {
  // A magical blow is still cut by Ward; voidWard is inert against it.
  assert.equal(mitigate(20, "magical", { armour: 99, ward: 50, voidWard: 90 }), 10);
  // A physical blow is still soaked flat by Armour; voidWard is inert against it.
  assert.equal(mitigate(20, "physical", { armour: 5, ward: 0, voidWard: 90 }), 15);
});

test("mitigate: a landed void blow always stings (floor of 1)", () => {
  assert.equal(mitigate(3, "void", { voidWard: 100 }), 1);
});

test("wardPoolFor: void casts consult voidWard, other casts consult Ward", () => {
  const def = { ward: 30, voidWard: 70 };
  assert.equal(wardPoolFor("void", def), 70);
  assert.equal(wardPoolFor("magical", def), 30);
  assert.equal(wardPoolFor(undefined, def), 30); // untyped cast → Ward
  assert.equal(wardPoolFor("void", {}), 0); // no pool → no fizzle chance
});
