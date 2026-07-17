"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { playerDefence, EVASION_PER_WITS } = require("../server/combat-math");

// Evasion now comes from BOTH Wits (EVASION_PER_WITS per point) and directly from
// gear (`armour.evasion`, e.g. a light buckler/targe). playerDefence sums the two,
// so a dodge-shield stacks on a nimble delver's own reflexes — and because the
// Wits part is read effective, a heavy shield's Wits penalty pays its block back
// in lost dodge. playerDefence is a pure read, so these build a minimal {world,
// player} and assert the returned profile directly.
const world = (items) => ({ items });
const near = (a, b) => Math.abs(a - b) < 1e-9;

test("playerDefence: gear evasion stacks on top of the Wits-derived part", () => {
  const w = world({ buckler: { armour: { ward: 1, evasion: 0.05 } } });
  const player = { attributes: { wits: 3 }, equipment: { shield: { template: "buckler" } } };
  const def = playerDefence(w, player);
  // wits 3 → 3*0.02 = 0.06 innate, + 0.05 from the buckler = 0.11
  assert.ok(near(def.evasion, 3 * EVASION_PER_WITS + 0.05), `got ${def.evasion}`);
});

test("playerDefence: a heavy shield's Wits penalty trades dodge for block", () => {
  const w = world({ tower: { armour: { armour: 2, attrMod: { wits: -2 } } } });
  const player = { attributes: { wits: 3 }, equipment: { shield: { template: "tower" } } };
  const def = playerDefence(w, player);
  // effective wits 3-2 = 1 → 0.02 evasion; the armour block itself grants none
  assert.ok(near(def.evasion, 1 * EVASION_PER_WITS), `got ${def.evasion}`);
  assert.equal(def.armour, 2);
});

test("playerDefence: no gear evasion falls back to the Wits-only value", () => {
  const def = playerDefence(world({}), { attributes: { wits: 4 }, equipment: {} });
  assert.ok(near(def.evasion, 4 * EVASION_PER_WITS), `got ${def.evasion}`);
});
