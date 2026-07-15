"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { mobStatusTag } = require("../server/render");

// The social tag shown after a visible mob's name — surfaces WHY a creature isn't
// attacking so a delver doesn't read a dazzled/lurking mob as a bug. Pure helper:
// (template, instance, roomLight) → label string | undefined. Placeholder wording.
const centipede = { perception: { blindBelow: 0, harmedAbove: 3, blindAbove: 6 } };

test("status tag: a dark-adapted mob past its blindAbove cap reads as dazzled", () => {
  assert.equal(mobStatusTag(centipede, { posture: "standing" }, 8), "dazzled");
});

test("status tag: harmed-but-not-blinded (glare) reads as reeling", () => {
  // light 4-6: above harmedAbove (3), below blindAbove (6) — still fighting, hurt.
  assert.equal(mobStatusTag(centipede, { posture: "standing" }, 5), "reeling");
});

test("status tag: within tolerance the mob carries no tag", () => {
  assert.equal(mobStatusTag(centipede, { posture: "standing" }, 2), undefined);
});

test("status tag: asleep wins over any light state (inert either way)", () => {
  assert.equal(mobStatusTag(centipede, { posture: "sleeping" }, 8), "asleep");
});

test("status tag: dazzled outranks reeling when both hold", () => {
  // A creature both harmed and blinded shows the blinding (the reason it's inert).
  assert.equal(mobStatusTag(centipede, { posture: "standing" }, 7), "dazzled");
});

test("status tag: a delver-facing mob with no perception band is never light-tagged", () => {
  assert.equal(mobStatusTag({}, { posture: "standing" }, 20), undefined);
});

test("status tag: an ambusher holding its strike reads as lying in wait", () => {
  const lurker = { ambush: true, perception: { blindBelow: -20, harmedAbove: 20 } };
  assert.equal(mobStatusTag(lurker, { posture: "standing" }, 1), "lying in wait");
});

test("status tag: once the ambusher trades blows the lurk tag drops (it's fighting)", () => {
  const lurker = { ambush: true, perception: { blindBelow: -20, harmedAbove: 20 } };
  assert.equal(mobStatusTag(lurker, { posture: "standing", aggro: { "player:1": 4 } }, 1), undefined);
});

test("status tag: sitting still surfaces as the plain posture label", () => {
  assert.equal(mobStatusTag(centipede, { posture: "sitting" }, 2), "sitting");
});
