"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { bfsNextDir, bfsDist } = require("../server/pathfinding");

// A small directed room graph:
//   a --east--> b --east--> c --east--> d
//   a --south-> e (dead end)
//   c --north-> f (one-way: f has no exit back to c)
//   x is an isolated room (no edges either way)
const rooms = {
  a: { exits: { east: "b", south: "e" } },
  b: { exits: { east: "c", west: "a" } },
  c: { exits: { east: "d", west: "b", north: "f" } },
  d: { exits: { west: "c" } },
  e: { exits: {} },
  f: { exits: {} }, // reachable from c, but no way back — tests directedness
  x: { exits: {} },
};

test("bfsNextDir: same room returns null", () => {
  assert.equal(bfsNextDir(rooms, "a", "a"), null);
});

test("bfsNextDir: adjacent room returns the connecting direction", () => {
  assert.equal(bfsNextDir(rooms, "a", "b"), "east");
  assert.equal(bfsNextDir(rooms, "a", "e"), "south");
});

test("bfsNextDir: distant room returns the first step of the shortest path", () => {
  assert.equal(bfsNextDir(rooms, "a", "d"), "east"); // a->b->c->d, first hop east
  assert.equal(bfsNextDir(rooms, "d", "a"), "west"); // d->c->b->a, first hop west
});

test("bfsNextDir: unreachable target returns null", () => {
  assert.equal(bfsNextDir(rooms, "a", "x"), null); // isolated
  assert.equal(bfsNextDir(rooms, "f", "c"), null); // one-way edge, no path back
});

test("bfsNextDir: a missing exit destination is skipped, not crashed", () => {
  const broken = { a: { exits: { east: "ghost", south: "b" } }, b: { exits: {} } };
  assert.equal(bfsNextDir(broken, "a", "b"), "south"); // "ghost" room doesn't exist → ignored
});

test("bfsNextDir: tolerates a room with no exits block", () => {
  assert.equal(bfsNextDir({ a: {}, b: { exits: {} } }, "a", "b"), null);
});

test("bfsDist: same room is distance 0", () => {
  assert.equal(bfsDist(rooms, "c", "c"), 0);
});

test("bfsDist: counts the shortest-path hops", () => {
  assert.equal(bfsDist(rooms, "a", "b"), 1);
  assert.equal(bfsDist(rooms, "a", "c"), 2);
  assert.equal(bfsDist(rooms, "a", "d"), 3);
  assert.equal(bfsDist(rooms, "a", "f"), 3); // a->b->c->f
});

test("bfsDist: unreachable target is Infinity", () => {
  assert.equal(bfsDist(rooms, "a", "x"), Infinity);
  assert.equal(bfsDist(rooms, "f", "a"), Infinity); // one-way edge
});

test("bfsDist: directed — distance can differ by direction", () => {
  assert.equal(bfsDist(rooms, "c", "f"), 1); // c->f exists
  assert.equal(bfsDist(rooms, "f", "c"), Infinity); // no edge back
});
