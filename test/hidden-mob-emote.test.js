"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { createDispatcher } = require("../server/events");

// A hidden mob (a lurking ambusher) must not leak ambient narration — an emote,
// a targeted reaction — to a delver who hasn't found it yet: a stray line gives
// the ambush away. Reveal is per-player (search / an ambush strike populate
// state.revealedMobs), so the gate is per observer: revealers still read the
// line, the unaware get nothing. See broadcastRoom in server/events.js.

// Minimal fake state: two players in one room, one mob instance in it.
function makeHarness({ mobHidden }) {
  const captured = new Map(); // playerId -> [texts]
  const record = (id, text) => {
    if (!captured.has(id)) captured.set(id, []);
    captured.get(id).push(text);
  };
  const seer = { blindBelow: 0 }; // can see at any positive light
  const players = [
    { id: "unaware", perception: seer },
    { id: "revealer", perception: seer },
  ];
  const mob = { id: "m1", template: "crypt-lurker", hidden: mobHidden ? { perception: 6 } : undefined };
  const state = {
    players: new Map(players.map((p) => [p.id, p])),
    revealedMobs: new Map([["revealer", new Set(["m1"])]]), // only the revealer has found it
    rooms: { room1: { mobs: [mob], light: 3 } },
    playersIn: () => players,
  };
  const noop = () => {};
  const dispatch = createDispatcher({
    state,
    world: {},
    roomCtx: { toRoom: noop, refreshRoom: noop },
    sendToPlayer: (id, msg) => record(id, msg.text),
    sendRawToPlayer: (id, raw) => record(id, JSON.parse(raw).text),
    broadcastTide: noop,
    markRoomView: noop,
    markPlayerView: noop,
    markViews: noop,
  });
  return { dispatch, captured };
}

const EMOTE = {
  type: "mob-emote",
  roomId: "room1",
  mobId: "m1",
  mobName: "a crypt-lurker",
  emitsLight: false,
  light: 3,
  text: "unfolds a length of shadow-sinew, then stills",
};

test("hidden mob: its emote reaches the delver who revealed it", () => {
  const { dispatch, captured } = makeHarness({ mobHidden: true });
  dispatch(EMOTE);
  assert.deepEqual(captured.get("revealer"), [
    "A crypt-lurker unfolds a length of shadow-sinew, then stills.",
  ]);
});

test("hidden mob: its emote does NOT leak to an unaware delver (the ambush stays hidden)", () => {
  const { dispatch, captured } = makeHarness({ mobHidden: true });
  dispatch(EMOTE);
  assert.equal(captured.get("unaware"), undefined);
});

test("non-hidden mob: its emote reaches everyone in the room (control)", () => {
  const { dispatch, captured } = makeHarness({ mobHidden: false });
  dispatch(EMOTE);
  const line = "A crypt-lurker unfolds a length of shadow-sinew, then stills.";
  assert.deepEqual(captured.get("unaware"), [line]);
  assert.deepEqual(captured.get("revealer"), [line]);
});
