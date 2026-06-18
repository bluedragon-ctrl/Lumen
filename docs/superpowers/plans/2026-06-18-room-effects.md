# Room Effects Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a room act on the players standing in it — once on **enter** (e.g. a waterfall douses carried lights) or each **tick** while present (e.g. an inn mends HP/mana; a dark room drains warmth) — authored as JSON in `rooms.json`.

**Architecture:** A room gains an optional `effects` array. One central method `GameState.applyRoomEffect(player, roomId, effect, events)` evaluates a light-condition and runs a single action (`douse` / `restore` / `damage`), pushing the existing mechanical events (`vitals`, `player-hurt`). Tick effects are driven by a new `_roomEffectsTick` in the tick loop; enter effects are driven inside `move()`. Each caller renders the effect's flavour text in its own model (tick → a new `room-effect` event; `move()` → folded into the arrival message). A small `ctx.emit` primitive lets the command path dispatch the events that `applyRoomEffect` produces. Effects live on the room and never become carried `player.states`.

**Tech Stack:** Node ≥18 (`ws`), no build step. Tests use Node's built-in runner (`node:test` + `node:assert`, no new dependency), run with `node --test`. Content is gated by `node tools/validate-data.js`.

**Spec:** [docs/superpowers/specs/2026-06-18-room-effects-design.md](../specs/2026-06-18-room-effects-design.md)

**Branch:** work continues on the current feature branch. Commit per task with Conventional Commits. Do not commit to `main`; do not self-merge.

---

## File structure

- **`server/state.js`** (modify) — the engine. Adds the free function `roomEffectFires`, the methods `_douse` / `_drainMana` / `applyRoomEffect` / `_roomEffectsTick`, one call in `advance()`, and exports `roomEffectFires` for tests.
- **`server/commands.js`** (modify) — `move()` runs the destination's `enter` effects; `NOOP_CTX` gains an `emit` no-op.
- **`server/index.js`** (modify) — `roomCtx` gains `emit`; `dispatchEvent` gains `room-effect` and `room-effect-room` handlers; the `player-hurt` cause map gains `darkness`.
- **`tools/validate-data.js`** (modify) — validates each room's `effects`.
- **`data/world/rooms.json`** (modify) — POC effects on `third.cave`, `rim.inn`, `warren.throat`.
- **`package.json`** (modify) — add `"test": "node --test"`.
- **`test/room-effects.test.js`** (create) — all unit/integration tests + a shared `makeTestWorld()` helper.
- **`docs/data-model.md`** (modify) — document the room `effects` block.
- **`CHANGELOG.md`** (modify) — `[Unreleased]` entry.

### Event contract (new)

- `{ type: "room-effect", playerId, text, dimsRoom }` — flavour line to the affected player; handler logs `text`, rebuilds their player+room view, and (if `dimsRoom`) refreshes the room for everyone else.
- `{ type: "room-effect-room", roomId, exceptId, text, dimsRoom }` — bystander line / room refresh.

### `applyRoomEffect` contract (used by both paths)

`applyRoomEffect(player, roomId, effect, events)` → returns `{ fired, doused, died }`.
- `fired` — false if the `when` condition failed (nothing happened).
- `doused` — count of light sources extinguished (>0 means the room dimmed).
- `died` — true if HP damage killed the player (respawn already handled via `_hurtPlayer`).

It performs the mutation and pushes only **mechanical** events (`vitals`, and via `_hurtPlayer` the `player-hurt`/`death` events). **Flavour** (`effect.message` / `effect.roomMessage`) is rendered by the caller.

---

## Task 1: Light-condition predicate

**Files:**
- Modify: `server/state.js` (add free function near the other small helpers, e.g. after `pickWeighted` ~line 261; add to `module.exports` ~line 2722)
- Test: `test/room-effects.test.js` (create)
- Modify: `package.json`

- [ ] **Step 1: Add the `test` script**

In `package.json`, add to `"scripts"` (after `"validate"`):

```json
    "test": "node --test",
```

- [ ] **Step 2: Write the failing test (creates the test file + shared world helper)**

Create `test/room-effects.test.js`:

```js
"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { GameState, roomEffectFires } = require("../server/state");

// A small, mutable world so tests can set room.effects directly (loadWorld() is
// frozen). Two rooms, a torch with a light block, a player template that starts
// with a lit-capable torch and a `light` equip slot.
function makeTestWorld() {
  return {
    rooms: {
      "test.bright": { id: "test.bright", name: "Bright Room", description: "", depth: 0, ambientLight: 5, exits: { north: "test.dark" } },
      "test.dark": { id: "test.dark", name: "Dark Room", description: "", depth: 1, ambientLight: 0, exits: { south: "test.bright" } },
    },
    items: {
      torch: { id: "torch", name: "a torch", description: "", type: "light", slot: "light", weight: 1, value: 1, light: { output: 3, fuelMax: 200, burnPerTick: 1 } },
    },
    mobs: {},
    fixtures: {},
    recipes: {},
    spells: {},
    quests: {},
    playerTemplate: {
      level: 1, xp: 0, shards: 0,
      attributes: { might: 5, vitality: 5, intellect: 5, wits: 5, perception: 5 },
      manaRegen: 0, speed: 12,
      perception: { blindBelow: 1, dimBelow: 3, harmedAbove: 9 },
      startLocation: "test.bright",
      startInventory: [{ template: "torch", fuel: 200 }],
      startEquipment: { light: null },
      knownRecipes: [], knownSpells: [],
    },
  };
}

// Build a GameState with one admitted player standing in `roomId`.
function gsWithPlayer(roomId = "test.bright") {
  const state = new GameState(makeTestWorld());
  const player = state.createCharacter("Tester");
  state.admit(player);
  state.setPlayerLocation(player, roomId);
  return { state, player };
}

test("roomEffectFires: no condition always fires", () => {
  assert.equal(roomEffectFires({}, 0), true);
  assert.equal(roomEffectFires({ when: undefined }, 9), true);
});

test("roomEffectFires: lightBelow fires only under the threshold", () => {
  assert.equal(roomEffectFires({ when: { lightBelow: 1 } }, 0), true);
  assert.equal(roomEffectFires({ when: { lightBelow: 1 } }, 1), false);
  assert.equal(roomEffectFires({ when: { lightBelow: 3 } }, 2), true);
});

test("roomEffectFires: lightAbove fires only over the threshold", () => {
  assert.equal(roomEffectFires({ when: { lightAbove: 9 } }, 10), true);
  assert.equal(roomEffectFires({ when: { lightAbove: 9 } }, 9), false);
});

module.exports = { makeTestWorld, gsWithPlayer };
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `roomEffectFires` is `undefined` (not yet exported), the `roomEffectFires:` tests throw.

- [ ] **Step 4: Implement `roomEffectFires`**

In `server/state.js`, after `pickWeighted` (~line 261), add:

```js
/** Whether a room effect's optional light condition is met at `light`. The only
 *  v1 condition axis: `when.lightBelow` (fires when room light < N; lightBelow:1
 *  means total darkness) or `when.lightAbove` (fires when light > N, mirroring
 *  lightBane.above). No `when` → always fires. */
function roomEffectFires(effect, light) {
  const w = effect.when;
  if (!w) return true;
  if (w.lightBelow != null) return light < w.lightBelow;
  if (w.lightAbove != null) return light > w.lightAbove;
  return true;
}
```

Add `roomEffectFires` to the `module.exports` object at the bottom of the file (append to the existing list).

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test`
Expected: PASS — the three `roomEffectFires` tests pass (later-task tests don't exist yet).

- [ ] **Step 6: Commit**

```bash
git add server/state.js test/room-effects.test.js package.json
git commit -m "feat: add room-effect light-condition predicate"
```

---

## Task 2: Douse and mana-drain mutators

**Files:**
- Modify: `server/state.js` (add two methods to the `GameState` class, near `_heal` ~line 909)
- Test: `test/room-effects.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `test/room-effects.test.js`:

```js
test("_douse extinguishes every lit source the player carries", () => {
  const { state, player } = gsWithPlayer();
  // Equip and light a torch; also carry a second lit torch in the pack.
  const { makeItemInstance } = require("../server/state");
  player.equipment.light = makeItemInstance({ template: "torch", fuel: 200 }, state.world);
  player.equipment.light.lit = true;
  player.inventory[0].lit = true; // the starting torch
  const n = state._douse(player);
  assert.equal(n, 2);
  assert.equal(player.equipment.light.lit, false);
  assert.equal(player.inventory[0].lit, false);
});

test("_douse returns 0 when nothing is lit", () => {
  const { state, player } = gsWithPlayer();
  assert.equal(state._douse(player), 0);
});

test("_drainMana clamps at zero and reports the amount drained", () => {
  const { state, player } = gsWithPlayer();
  player.mana = 3;
  assert.equal(state._drainMana(player, 2), 2);
  assert.equal(player.mana, 1);
  assert.equal(state._drainMana(player, 5), 1); // only 1 left to take
  assert.equal(player.mana, 0);
  assert.equal(state._drainMana(player, 0), 0); // no-op
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `state._douse is not a function`.

- [ ] **Step 3: Implement the two methods**

In `server/state.js`, inside the `GameState` class near `_heal` (~line 909), add:

```js
  /** Snuff every lit light source a player carries (equipped or in the pack) —
   *  the waterfall douse. Mirrors the death-snuff loop in _respawn. Returns the
   *  count extinguished; the caller recomputes room light when it's > 0. A spent
   *  husk is left in place (not consumed — unlike burning out). */
  _douse(player) {
    let n = 0;
    for (const inst of [...Object.values(player.equipment || {}), ...(player.inventory || [])])
      if (inst && inst.lit) { inst.lit = false; n++; }
    return n;
  }

  /** Drain up to `amount` mana from an actor, clamped at 0 (the mana mirror of
   *  _heal / the mana side of applyRestore). Returns the mana actually taken. */
  _drainMana(actor, amount) {
    if (!amount) return 0;
    const before = actor.mana || 0;
    actor.mana = Math.max(0, before - amount);
    return before - actor.mana;
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS — all Task 1 + Task 2 tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/state.js test/room-effects.test.js
git commit -m "feat: add douse and mana-drain mutators for room effects"
```

---

## Task 3: The `applyRoomEffect` core

**Files:**
- Modify: `server/state.js` (add method to `GameState`, after `_drainMana`)
- Test: `test/room-effects.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `test/room-effects.test.js`:

```js
test("applyRoomEffect: restore mends hp/mana and pushes vitals", () => {
  const { state, player } = gsWithPlayer();
  player.hp = 1; player.mana = 0;
  const events = [];
  const r = state.applyRoomEffect(player, "test.bright", { trigger: "tick", action: { restore: { hp: 1, mana: 2 } } }, events);
  assert.deepEqual(r, { fired: true, doused: 0, died: false });
  assert.equal(player.hp, 2);
  assert.equal(player.mana, 2);
  assert.ok(events.some((e) => e.type === "vitals" && e.playerId === player.id));
});

test("applyRoomEffect: damage hurts hp (player-hurt) and drains mana", () => {
  const { state, player } = gsWithPlayer();
  player.hp = 20; player.mana = 10;
  const events = [];
  const r = state.applyRoomEffect(player, "test.bright", { trigger: "tick", action: { damage: { hp: "2", mana: "3" } } }, events);
  assert.equal(r.fired, true);
  assert.equal(r.died, false);
  assert.equal(player.hp, 18);
  assert.equal(player.mana, 7);
  assert.ok(events.some((e) => e.type === "player-hurt" && e.cause === "darkness"));
});

test("applyRoomEffect: a killing hp blow returns died and skips mana drain", () => {
  const { state, player } = gsWithPlayer("test.dark");
  player.hp = 1; player.mana = 10;
  const events = [];
  const r = state.applyRoomEffect(player, "test.dark", { trigger: "tick", action: { damage: { hp: "50", mana: "5" } } }, events);
  assert.equal(r.died, true);
  assert.equal(player.mana, 10); // mana drain skipped once dead
  assert.ok(events.some((e) => e.type === "death"));
});

test("applyRoomEffect: douse extinguishes and reports the dim, recomputes light", () => {
  const { state, player } = gsWithPlayer("test.dark");
  const { makeItemInstance } = require("../server/state");
  player.equipment.light = makeItemInstance({ template: "torch", fuel: 200 }, state.world);
  player.equipment.light.lit = true;
  state.rooms["test.dark"].light = state.computeRoomLight("test.dark"); // bright from the torch
  assert.ok(state.rooms["test.dark"].light > 0);
  const r = state.applyRoomEffect(player, "test.dark", { trigger: "enter", action: { douse: true } }, []);
  assert.equal(r.doused, 1);
  assert.equal(player.equipment.light.lit, false);
  assert.equal(state.rooms["test.dark"].light, 0); // ambient 0, torch out
});

test("applyRoomEffect: a failed condition fires nothing", () => {
  const { state, player } = gsWithPlayer("test.bright"); // light 5
  player.hp = 1;
  const r = state.applyRoomEffect(player, "test.bright", { trigger: "tick", when: { lightBelow: 1 }, action: { damage: { hp: "5" } } }, []);
  assert.equal(r.fired, false);
  assert.equal(player.hp, 1); // untouched
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `state.applyRoomEffect is not a function`.

- [ ] **Step 3: Implement `applyRoomEffect`**

In `server/state.js`, in the `GameState` class right after `_drainMana`, add:

```js
  /** Run one room effect against a player standing in `roomId`, if its light
   *  condition is met. Performs the single action and pushes the MECHANICAL
   *  events (`vitals`, and via _hurtPlayer the `player-hurt`/`death` events);
   *  the caller renders the effect's flavour (`message`/`roomMessage`). Returns
   *  `{ fired, doused, died }` — see the plan's contract. Shared by the tick
   *  driver (_roomEffectsTick) and the enter driver (move() in commands.js). */
  applyRoomEffect(player, roomId, effect, events) {
    if (!roomEffectFires(effect, this.rooms[roomId].light)) return { fired: false, doused: 0, died: false };
    const a = effect.action || {};
    let doused = 0;
    let died = false;
    if (a.douse) {
      doused = this._douse(player);
      if (doused) this.rooms[roomId].light = this.computeRoomLight(roomId);
    } else if (a.restore) {
      const got = this.applyRestore(player, a.restore);
      if (got.hp || got.mana) events.push({ type: "vitals", playerId: player.id });
    } else if (a.damage) {
      if (a.damage.hp != null && this._hurtPlayer(player, Math.max(1, rollDice(a.damage.hp)), events, { cause: "darkness" })) died = true;
      if (!died && a.damage.mana != null && this._drainMana(player, Math.max(1, rollDice(a.damage.mana)))) events.push({ type: "vitals", playerId: player.id });
    }
    return { fired: true, doused, died };
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS — all tests through Task 3.

- [ ] **Step 5: Commit**

```bash
git add server/state.js test/room-effects.test.js
git commit -m "feat: add applyRoomEffect core (douse/restore/damage)"
```

---

## Task 4: Per-tick room effects in the tick loop

**Files:**
- Modify: `server/state.js` (add `_roomEffectsTick`; call it in `advance()` right after `_environmentTick`, ~line 1253)
- Test: `test/room-effects.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `test/room-effects.test.js`:

```js
test("_roomEffectsTick: tick restore heals a present player and emits room-effect", () => {
  const { state, player } = gsWithPlayer("test.bright");
  state.world.rooms["test.bright"].effects = [
    { trigger: "tick", action: { restore: { mana: 2 } }, message: "The air hums with power." },
  ];
  player.mana = 0;
  const events = [];
  state._roomEffectsTick(events);
  assert.equal(player.mana, 2);
  assert.ok(events.some((e) => e.type === "room-effect" && e.playerId === player.id && e.text === "The air hums with power."));
});

test("_roomEffectsTick: interval gates how often a tick effect fires", () => {
  const { state, player } = gsWithPlayer("test.bright");
  state.world.rooms["test.bright"].effects = [{ trigger: "tick", interval: 3, action: { restore: { mana: 1 } } }];
  player.mana = 0;
  for (state.tick = 1; state.tick <= 6; state.tick++) state._roomEffectsTick([]);
  // tick % 3 === 0 at ticks 3 and 6 → fires twice.
  assert.equal(player.mana, 2);
});

test("_roomEffectsTick: light-gated damage only fires in the dark", () => {
  const { state, player } = gsWithPlayer("test.dark"); // ambient 0
  state.rooms["test.dark"].light = state.computeRoomLight("test.dark"); // 0
  state.world.rooms["test.dark"].effects = [
    { trigger: "tick", when: { lightBelow: 1 }, action: { damage: { hp: "1" } } },
  ];
  state.world.rooms["test.bright"].effects = [
    { trigger: "tick", when: { lightBelow: 1 }, action: { damage: { hp: "1" } } },
  ];
  player.hp = 10;
  state._roomEffectsTick([]);
  assert.equal(player.hp, 9); // dark room bites
  state.setPlayerLocation(player, "test.bright");
  state._roomEffectsTick([]);
  assert.equal(player.hp, 9); // bright room (light 5) does not
});

test("_roomEffectsTick: enter effects are ignored by the tick driver", () => {
  const { state, player } = gsWithPlayer("test.bright");
  state.world.rooms["test.bright"].effects = [{ trigger: "enter", action: { restore: { mana: 5 } } }];
  player.mana = 0;
  state._roomEffectsTick([]);
  assert.equal(player.mana, 0);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `state._roomEffectsTick is not a function`.

- [ ] **Step 3: Implement `_roomEffectsTick` and wire it into `advance()`**

In `server/state.js`, add the method (near `_environmentTick`, ~line 2689):

```js
  /** Per-tick room effects: for every room that authors `trigger:"tick"` effects,
   *  run each due effect against every living player present. `interval` gates the
   *  cadence via the global tick counter (no per-player state). Runs AFTER
   *  _environmentTick so it reads freshly recomputed light (a dark-room drain bites
   *  the same tick lightBane would). Pushes a `room-effect`/`room-effect-room`
   *  flavour event when the effect authored a message or dimmed the room. */
  _roomEffectsTick(events) {
    for (const [roomId, room] of Object.entries(this.world.rooms)) {
      const effects = room.effects;
      if (!effects || !effects.length) continue;
      const tickEffects = effects.filter((e) => e.trigger === "tick");
      if (!tickEffects.length) continue;
      const players = this.playersIn(roomId).filter((p) => p.hp > 0);
      if (!players.length) continue;
      for (const eff of tickEffects) {
        if (eff.interval && eff.interval > 1 && this.tick % eff.interval !== 0) continue;
        for (const p of players) {
          const r = this.applyRoomEffect(p, roomId, eff, events);
          if (!r.fired) continue;
          if (eff.message) events.push({ type: "room-effect", playerId: p.id, text: eff.message, dimsRoom: r.doused > 0 });
          else if (r.doused) events.push({ type: "room-effect", playerId: p.id, text: "Your light is snuffed out.", dimsRoom: true });
          if (eff.roomMessage || r.doused) events.push({ type: "room-effect-room", roomId, exceptId: p.id, text: eff.roomMessage || "", dimsRoom: r.doused > 0 });
        }
      }
    }
  }
```

In `advance()` (~line 1253), add the call immediately after the `_environmentTick(events)` line:

```js
    this._environmentTick(events); // light-bane and other room hazards, on fresh light
    this._roomEffectsTick(events); // per-tick room effects (regen, darkness drain), same fresh light
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS — all tests through Task 4.

- [ ] **Step 5: Commit**

```bash
git add server/state.js test/room-effects.test.js
git commit -m "feat: run per-tick room effects in the tick loop"
```

---

## Task 5: Enter effects in `move()` + `ctx.emit`

**Files:**
- Modify: `server/commands.js` (`move()` ~line 372–404; `NOOP_CTX` ~line 34)
- Test: `test/room-effects.test.js`

- [ ] **Step 1: Write the failing integration test**

Append to `test/room-effects.test.js`:

```js
const { execute } = require("../server/commands");

// A ctx that records bystander sends and dispatched events (the server's roomCtx
// shape: toRoom / refreshRoom / emit).
function recordingCtx() {
  const emitted = [];
  return { emitted, toRoom() {}, refreshRoom() {}, emit(ev) { emitted.push(ev); } };
}

test("move(): an enter douse snuffs the player's light and folds in the message", () => {
  const { state, player } = gsWithPlayer("test.bright");
  player.equipment.light = require("../server/state").makeItemInstance({ template: "torch", fuel: 200 }, state.world);
  player.equipment.light.lit = true;
  state.world.rooms["test.dark"].effects = [
    { trigger: "enter", action: { douse: true }, message: "Cold spray drowns your flame." },
  ];
  const ctx = recordingCtx();
  const msgs = execute(state, player, "north", ctx);
  assert.equal(player.location, "test.dark");
  assert.equal(player.equipment.light.lit, false); // doused on arrival
  assert.ok(msgs.some((m) => m.text && m.text.includes("Cold spray drowns your flame.")));
});

test("move(): an enter restore mends the arriving player and emits vitals", () => {
  const { state, player } = gsWithPlayer("test.bright");
  state.world.rooms["test.dark"].effects = [{ trigger: "enter", action: { restore: { hp: 3 } } }];
  player.hp = 1;
  const ctx = recordingCtx();
  execute(state, player, "north", ctx);
  assert.equal(player.hp, 4);
  assert.ok(ctx.emitted.some((e) => e.type === "vitals" && e.playerId === player.id));
});

test("move(): a room without enter effects is unaffected", () => {
  const { state, player } = gsWithPlayer("test.bright");
  player.hp = 5;
  const ctx = recordingCtx();
  execute(state, player, "north", ctx);
  assert.equal(player.hp, 5);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — the douse/restore-on-enter assertions fail (no enter handling in `move()` yet).

- [ ] **Step 3: Add `emit` to `NOOP_CTX`**

In `server/commands.js` (~line 34), change:

```js
const NOOP_CTX = { toRoom() {}, refreshRoom() {} };
```

to:

```js
const NOOP_CTX = { toRoom() {}, refreshRoom() {}, emit() {} };
```

- [ ] **Step 4: Run enter effects inside `move()`**

In `server/commands.js`, in `move()`, locate the block that builds the arrival output (the `let tail = "";` / `selfAndViews` region, ~line 387–400). Insert the enter-effects handling **immediately before** `const msgs = selfAndViews(...)`:

```js
  // Room effects that fire on entering (a waterfall douses your flame, a ward
  // mends or saps you). Mutate before building the view so it reflects the result
  // (e.g. a doused room reads dark). Mechanical events go out via ctx.emit; the
  // flavour line is folded into the arrival message; bystanders see roomMessage
  // and any dimming.
  let effectTail = "";
  let enterDied = false;
  for (const eff of state.world.rooms[dest].effects || []) {
    if (eff.trigger !== "enter") continue;
    const evs = [];
    const r = state.applyRoomEffect(player, dest, eff, evs);
    evs.forEach(ctx.emit);
    if (!r.fired) continue;
    if (eff.message) effectTail += ` ${eff.message}`;
    if (eff.roomMessage) ctx.toRoom(dest, { type: "log", text: eff.roomMessage }, player.id);
    if (r.doused) ctx.refreshRoom(dest, player.id); // others see the room dim
    if (r.died) { enterDied = true; break; } // _respawn already moved + re-rendered them
  }
  if (enterDied) return []; // death views were emitted; suppress the normal arrival output
```

Then fold `effectTail` into the arrival message by changing:

```js
  const msgs = selfAndViews(state, player, `You go ${dir}.${tail}${followTail}`);
```

to:

```js
  const msgs = selfAndViews(state, player, `You go ${dir}.${tail}${followTail}${effectTail}`);
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS — all tests through Task 5.

- [ ] **Step 6: Commit**

```bash
git add server/commands.js test/room-effects.test.js
git commit -m "feat: run enter room effects in move()"
```

---

## Task 6: Client dispatch for room-effect events

**Files:**
- Modify: `server/index.js` (`roomCtx` ~line 48; `dispatchEvent` chain ~line 157; `player-hurt` cause map ~line 585)

This wires the new events to the client. There is no automated test for the `ws` layer; verify by reading the code and by the runtime check in Task 8.

- [ ] **Step 1: Add `emit` to `roomCtx`**

In `server/index.js` (~line 48), extend `roomCtx`:

```js
const roomCtx = {
  toRoom(roomId, msg, exceptId) {
    for (const p of state.playersIn(roomId)) if (p.id !== exceptId) sendToPlayer(p.id, msg);
  },
  refreshRoom(roomId, exceptId) {
    for (const p of state.playersIn(roomId)) if (p.id !== exceptId) sendToPlayer(p.id, buildRoomView(state, p));
  },
  emit(ev) { dispatchEvent(ev); },
};
```

(`dispatchEvent` is a hoisted function declaration, so referencing it here is fine.)

- [ ] **Step 2: Add a `darkness` label to the player-hurt cause map**

In `server/index.js` (~line 585), add the `darkness` key to the `src` map:

```js
    const src = { light: "the searing light", spikes: "the spines", venom: "venom", bleed: "your wounds", darkness: "the creeping dark" }[ev.cause] || ev.cause || "an unseen hurt";
```

- [ ] **Step 3: Add the `room-effect` and `room-effect-room` handlers**

In `server/index.js`, add two handler blocks to `dispatchEvent` (place them after the `effect-applied` block, ~line 216):

```js
  if (ev.type === "room-effect") {
    // A room acted on a player (douse / regen / drain). Show the flavour line and
    // refresh their views; if the room dimmed (a douse), refresh it for others too.
    const player = state.players.get(ev.playerId);
    if (!player) return;
    if (ev.text) sendToPlayer(ev.playerId, { type: "log", text: ev.text });
    sendToPlayer(ev.playerId, buildRoomView(state, player));
    sendToPlayer(ev.playerId, buildPlayerView(state, player));
    if (ev.dimsRoom) roomCtx.refreshRoom(player.location, ev.playerId);
    return;
  }

  if (ev.type === "room-effect-room") {
    // The bystander side of a room effect: an optional line to the others present,
    // plus a room refresh when the effect dimmed the room.
    if (ev.text) roomCtx.toRoom(ev.roomId, { type: "log", text: ev.text }, ev.exceptId);
    if (ev.dimsRoom) roomCtx.refreshRoom(ev.roomId, ev.exceptId);
    return;
  }
```

- [ ] **Step 4: Verify the server starts cleanly**

Run: `node -e "require('./server/index.js')"` then stop it (Ctrl-C), OR run `npm start` briefly.
Expected: `[lumen] listening on http://localhost:3737` with no exceptions. (Stop the server after confirming.)

- [ ] **Step 5: Commit**

```bash
git add server/index.js
git commit -m "feat: dispatch room-effect events to the client"
```

---

## Task 7: Validate room effects in the data validator

**Files:**
- Modify: `tools/validate-data.js`
- Test: manual negative + positive runs of `npm run validate`

- [ ] **Step 1: Read the validator's room-checking section**

Open `tools/validate-data.js`. Confirm these (already verified): errors are collected with `errs.push(...)` (there is no `err()` helper); the room loop is `for (const [id, r] of Object.entries(rooms))` (loop var `r`, not `room`); and a dice-string regex `DICE_RE` already exists (`/^\d+d\d+([+-]\d+)?$|^\d+$/`, accepts `"1d2"`, `"2d4+1"`, `"3"`). The new checks reuse `DICE_RE` and `errs.push`.

- [ ] **Step 2: Add `effects` validation inside the per-room loop**

Within the existing `for (const [id, r] of Object.entries(rooms))` room loop, add:

```js
    if (r.effects !== undefined) {
      if (!Array.isArray(r.effects)) {
        errs.push(`room ${id}: "effects" must be an array`);
      } else {
        r.effects.forEach((eff, i) => {
          const where = `room ${id} effects[${i}]`;
          if (eff.trigger !== "enter" && eff.trigger !== "tick")
            errs.push(`${where}: "trigger" must be "enter" or "tick"`);
          if (eff.when !== undefined) {
            const keys = ["lightBelow", "lightAbove"].filter((k) => eff.when[k] !== undefined);
            if (keys.length !== 1) errs.push(`${where}: "when" needs exactly one of lightBelow/lightAbove`);
            else if (!Number.isInteger(eff.when[keys[0]])) errs.push(`${where}: when.${keys[0]} must be an integer`);
          }
          if (eff.interval !== undefined && (!Number.isInteger(eff.interval) || eff.interval < 1))
            errs.push(`${where}: "interval" must be a positive integer`);
          const a = eff.action;
          if (!a || typeof a !== "object") { errs.push(`${where}: missing "action"`); return; }
          const actionKeys = ["douse", "restore", "damage"].filter((k) => a[k] !== undefined);
          if (actionKeys.length !== 1) { errs.push(`${where}: "action" needs exactly one of douse/restore/damage`); return; }
          if (a.restore) {
            for (const k of ["hp", "mana"]) if (a.restore[k] !== undefined && !Number.isInteger(a.restore[k]))
              errs.push(`${where}: restore.${k} must be an integer`);
          }
          if (a.damage) {
            for (const k of ["hp", "mana"]) if (a.damage[k] !== undefined && !(typeof a.damage[k] === "string" && DICE_RE.test(a.damage[k])))
              errs.push(`${where}: damage.${k} must be dice notation (e.g. "1d2")`);
          }
        });
      }
    }
```

(Reuses the existing `DICE_RE` — do not add a new dice helper.)

- [ ] **Step 3: Negative check — a malformed effect fails**

Temporarily add a bad effect to any room in `data/world/rooms.json`, e.g. on `rim.plaza` add `"effects": [{ "trigger": "tick", "action": { "restore": {}, "douse": true } }]` (two action keys, bad trigger value would also do).

Run: `npm run validate`
Expected: non-zero exit; an error line naming `room rim.plaza effects[0]: "action" needs exactly one of douse/restore/damage`.

Then **remove** the temporary bad effect.

- [ ] **Step 4: Positive check — clean data passes**

Run: `npm run validate`
Expected: exit 0 (no `effects` in the data yet, so nothing to flag).

- [ ] **Step 5: Commit**

```bash
git add tools/validate-data.js
git commit -m "feat: validate room effects in the data validator"
```

---

## Task 8: POC content, docs, changelog, and runtime verification

**Files:**
- Modify: `data/world/rooms.json` (`third.cave`, `rim.inn`, `warren.throat`)
- Modify: `docs/data-model.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add the douse effect to `third.cave`**

In `data/world/rooms.json`, add an `effects` key to the `third.cave` object (alongside its existing fields):

```json
    "effects": [
      { "trigger": "enter", "action": { "douse": true },
        "message": "Cold spray off the plunge-pool drowns your flame in a hiss of steam." }
    ]
```

- [ ] **Step 2: Add the regen effect to `rim.inn`**

In the `rim.inn` object, add:

```json
    "effects": [
      { "trigger": "tick", "interval": 3, "action": { "restore": { "hp": 1, "mana": 1 } },
        "message": "The hearth's warmth eases your hurts." }
    ]
```

- [ ] **Step 3: Add the malign-darkness effect to `warren.throat`**

In the `warren.throat` object, add:

```json
    "effects": [
      { "trigger": "tick", "when": { "lightBelow": 1 },
        "action": { "damage": { "hp": "1d2", "mana": "1d2" } },
        "message": "The dark presses close and drinks the warmth from you." }
    ]
```

- [ ] **Step 4: Validate the content**

Run: `npm run validate`
Expected: exit 0.

- [ ] **Step 5: Document the room `effects` block in the data model**

In `docs/data-model.md`, in the **Room (static)** section, add an `effects` row to the room field table (after the `spawns` row):

```markdown
| `effects`      | RoomEffect[]?     | Effects the room applies to players: each `{ trigger: "enter"|"tick", when?: { lightBelow|lightAbove: N }, interval?, action, message?, roomMessage? }`. `action` is exactly one of `douse: true` (snuff carried lights), `restore: { hp?, mana? }` (flat ints), or `damage: { hp?, mana? }` (dice). `enter` fires on arrival; `tick` fires every `interval` ticks while present (default 1), gated by the optional light `when`. Players only. |
```

- [ ] **Step 6: Add a CHANGELOG entry**

In `CHANGELOG.md`, under `## [Unreleased]`, add to the `### Added` list (create the heading if absent):

```markdown
- **Room effects** — rooms can act on players on enter or each tick: a light-condition
  gate plus a `douse` / `restore` / `damage` action, authored as `effects` in
  `rooms.json`. Seeded on the Plunge Cave (spray douses your flame), the Lantern's Rest
  (the hearth mends you), and Where the Dark Goes Bad (the dark drains you unless lit).
```

- [ ] **Step 7: Full test + validate pass**

Run: `npm test`
Expected: PASS — all room-effect tests.
Run: `npm run validate`
Expected: exit 0.

- [ ] **Step 8: Runtime verification (manual)**

Start the server (`npm start`), connect a client (http://localhost:3737), log in as `admin`, and confirm each POC room. Use `@teleport`/`@goto` if available, or walk there.

- **Inn (`rim.inn`):** take damage first (spar a mob), then stand in the inn → HP and mana climb 1 every ~3s, with "The hearth's warmth eases your hurts." Stops at full.
- **Plunge Cave (`third.cave`):** enter with a lit torch → torch goes out, room reads dark, "Cold spray … drowns your flame." appears.
- **Where the Dark Goes Bad (`warren.throat`):** stand with no light → HP/mana tick down with "The dark presses close…". Light a torch so room light ≥ 1 → the drain stops.

Note any discrepancy; fix source and re-verify before committing.

- [ ] **Step 9: Commit**

```bash
git add data/world/rooms.json docs/data-model.md CHANGELOG.md
git commit -m "feat: seed room effects on the cave, inn, and gloom-warren"
```

---

## Final review checklist (run after all tasks)

- [ ] `npm test` passes; `npm run validate` exits 0.
- [ ] No effect leaks into `player.states` (room effects are stateless on the player) — confirmed by design: `applyRoomEffect` never calls `applyEffect`.
- [ ] `git log` shows one focused commit per task, Conventional Commits style.
- [ ] Push the branch and open a PR into `main` (the maintainer reviews/merges; do not self-merge). Per memory: no `gh` CLI — after pushing, provide the compare URL plus a title/body for the PR.
