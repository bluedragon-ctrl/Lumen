"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { bandOf, clampLight, LIGHT_MIN, LIGHT_MAX } = require("../server/light");

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
