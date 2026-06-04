# Summoning (Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a data-driven summon primitive that powers a player `Summon Wisp` spell (a 3-minute allied Wisp that fights autonomously and follows its owner) and Gnaw's capped rat reinforcements.

**Architecture:** One shared `_summon()` / `_dismissSummon()` pair plus an `advance()` lifetime tick in `server/state.js`, building on the Phase 1 faction/`ownerId` foundation. Summoned mobs are tagged instances (`summonerId` / `summonGroup` / `expiresIn` / `noSpoils`) — no parallel registry. The player spell routes through a new `cast` branch + `state.castSummon`; Gnaw uses a new `summon` mob action. Spoil-less, owner-bound, timer-or-owner-loss lifecycle.

**Tech Stack:** Node 18 (CommonJS), `ws`. No test framework — verification is `npm run validate` + headless `node`+`assert` harness scripts (scratch, under `tmp/`, never committed) + a live run on port 3738.

**Spec:** `docs/superpowers/specs/2026-06-04-summoning-design.md`

**Branch:** `feat/summoning` (already created off merged `main`; Phase 1 present).

**Locked balance values:** Summon Wisp `manaCost: 10` (no shardCost); `scroll-summon-wisp` `value: 90`; Wisp `duration: 180` ticks; Gnaw summon action `weight: 2, count: 2, max: 4`.

---

## Conventions for every task

- **Harness scripts** live in `tmp/` and are run with `node tmp/<name>.js`. They use `node:assert` and `process.exit(1)` on failure (so "FAIL" = non-zero exit). They are **never** `git add`-ed; delete them after the final task.
- Harness boilerplate (top of every harness file):

```js
const assert = require("node:assert");
const { loadWorld } = require("../server/world");
const { GameState } = require("../server/state");
function fresh() { return new GameState(loadWorld()); }
```

- A harness "spawns a player" by building one from the template and admitting it:

```js
function addPlayer(state, name, roomId) {
  const p = state.createCharacter(name, { isAdmin: false });
  if (roomId) p.location = roomId;
  return state.admit(p);
}
```

- Commits use **explicit paths** (never `git add -A`) so untracked `tmp/` harnesses stay out.
- Pick any existing room id for tests via `Object.keys(state.world.rooms)[0]`, or a known one like `"rim.plaza"`.

---

## Task 1: Summon primitive core (`_summon`, `_dismissSummon`, lifetime tick, `noSpoils`)

**Files:**
- Modify: `server/state.js` — `makeMobInstance` (~line 270), `_dropSpoils` (~1551), `_killMobAt` (~1583), `_hurtMob` (~1603), `advance` (~923); add new methods.
- Test: `tmp/t1-primitive.js`

- [ ] **Step 1: Write the failing harness**

Create `tmp/t1-primitive.js`:

```js
const assert = require("node:assert");
const { loadWorld } = require("../server/world");
const { GameState } = require("../server/state");
function fresh() { return new GameState(loadWorld()); }

const state = fresh();
const room = Object.keys(state.world.rooms)[0];
const before = state.rooms[room].mobs.length;

// _summon places tagged instances with no origin.
const events = [];
const made = state._summon(
  { roomId: room, mobId: "wisp", count: 2, faction: "player", ownerId: "player.test", summonerId: "player.test", group: "summon-wisp", lifetime: 3, by: "player", byName: "Test" },
  events
);
assert.strictEqual(made.length, 2, "summon returns the made mobs");
assert.strictEqual(state.rooms[room].mobs.length, before + 2, "mobs placed in room");
for (const m of made) {
  assert.strictEqual(m.faction, "player");
  assert.strictEqual(m.ownerId, "player.test");
  assert.strictEqual(m.summonerId, "player.test");
  assert.strictEqual(m.summonGroup, "summon-wisp");
  assert.strictEqual(m.expiresIn, 3);
  assert.strictEqual(m.noSpoils, true);
  assert.strictEqual(m.origin, undefined, "summons carry no spawner origin");
}
assert.ok(events.some((e) => e.type === "summon"), "pushes a summon event");

// Lifetime tick: counts down and winks out at 0 (no death/loot events).
const t = []; state._summonTick(t); // 3 -> 2
state._summonTick(t); // 2 -> 1
state._summonTick(t); // 1 -> 0 -> dismissed
assert.strictEqual(state.rooms[room].mobs.length, before, "both summons expired");
assert.ok(t.some((e) => e.type === "summon-end" && e.reason === "expired"), "summon-end on expiry");
assert.ok(!t.some((e) => e.type === "death"), "expiry is not a death");

// _dropSpoils honors noSpoils.
const m2 = state._summon({ roomId: room, mobId: "giant-rat", count: 1, faction: "wild", summonerId: "mob.x" }, [])[0];
assert.deepStrictEqual(state._dropSpoils(m2, room), [], "noSpoils -> no loot/shards");

// Killing a summon yields no XP (player kill path).
const room2 = Object.keys(state.world.rooms)[1] || room;
const wisp = state._summon({ roomId: room2, mobId: "wisp", count: 1, faction: "wild", summonerId: "mob.y" }, [])[0];
const killer = (function () { const p = state.createCharacter("Slayer", {}); p.location = room2; return state.admit(p); })();
const ke = [];
state._killMobAt(wisp, room2, killer, "hit");
const xpBefore = killer.xp;
assert.strictEqual(killer.xp, xpBefore, "no xp from a noSpoils kill");
console.log("T1 OK");
```

- [ ] **Step 2: Run to verify it fails**

Run: `node tmp/t1-primitive.js`
Expected: FAIL — `TypeError: state._summon is not a function`.

- [ ] **Step 3: Add instance fields to `makeMobInstance`**

In `server/state.js`, in the object returned by `makeMobInstance`, immediately after the `ownerId: null,` line, insert:

```js
    summonerId: null, // who conjured it (player or mob id); null if not summoned
    summonGroup: null, // per-owner recast-cap key (defaults to the source spell id)
    expiresIn: null, // ticks until it winks out; null = permanent
    noSpoils: false, // summoned creatures drop no loot/XP on any death
```

- [ ] **Step 4: Add `_summon` / `_dismissSummon` methods**

In `server/state.js`, immediately after the `_spawnMob(roomId, mobId, hidden) { ... }` method, add:

```js
  /**
   * The summon primitive. Conjures `count` instances of `mobId` into `roomId`,
   * stamped with faction/ownership/lifetime, and places them WITHOUT a spawner
   * `origin` (so they never respawn or count against a room's spawn cap). Used by
   * both the player Summon spell (faction "player", an ownerId, a lifetime) and a
   * mob `summon` action (faction "wild", a summonerId, permanent). Pushes one
   * `summon` event for narration. Returns the new instances.
   */
  _summon({ roomId, mobId, count = 1, faction = "wild", ownerId = null, summonerId = null, group = null, lifetime = null, by = "mob", byName = null, verb = null }, events = []) {
    const t = this.world.mobs[mobId];
    if (!t) throw new Error(`summon: unknown mob template ${mobId}`);
    const made = [];
    for (let i = 0; i < count; i++) {
      const m = makeMobInstance(mobId, this.world);
      m.faction = faction;
      m.ownerId = ownerId;
      m.summonerId = summonerId;
      m.summonGroup = group;
      m.expiresIn = lifetime;
      m.noSpoils = true;
      this.rooms[roomId].mobs.push(m);
      made.push(m);
    }
    this.rooms[roomId].light = this.computeRoomLight(roomId); // a glowing summon lights the room
    events.push({
      type: "summon", roomId, by, byId: by === "player" ? ownerId : summonerId, byName,
      mobTemplate: mobId, mobName: t.name, emitsLight: !!t.emitsLight,
      count: made.length, light: this.rooms[roomId].light, verb,
    });
    return made;
  }

  /** Remove a summoned mob from the world silently — no corpse, loot, XP, or death
   *  event, just a `summon-end`. Finds the mob's room by scan (few summons exist). */
  _dismissSummon(mob, reason, events = []) {
    for (const [roomId, rt] of Object.entries(this.rooms)) {
      const idx = rt.mobs.indexOf(mob);
      if (idx < 0) continue;
      rt.mobs.splice(idx, 1);
      mob.hp = 0; // mark gone for any lingering reference
      rt.light = this.computeRoomLight(roomId);
      const t = this.world.mobs[mob.template];
      events.push({ type: "summon-end", roomId, mobName: t.name, emitsLight: !!t.emitsLight, light: rt.light, reason });
      return;
    }
  }

  /** Dismiss every summon owned by `ownerId` (owner death/disconnect). */
  _dismissOwnedSummons(ownerId, reason, events = []) {
    const owned = [];
    for (const rt of Object.values(this.rooms)) for (const m of rt.mobs) if (m.ownerId === ownerId) owned.push(m);
    for (const m of owned) this._dismissSummon(m, reason, events);
    return events;
  }

  /** Count living summons sharing a `summonerId` (a mob's living brood). */
  _broodCount(summonerId) {
    let n = 0;
    for (const rt of Object.values(this.rooms)) for (const m of rt.mobs) if (m.summonerId === summonerId && m.hp > 0) n++;
    return n;
  }

  /** Tick summon lifetimes: decrement `expiresIn`, wink out at zero. */
  _summonTick(events) {
    for (const rt of Object.values(this.rooms)) {
      for (const m of [...rt.mobs]) {
        if (m.expiresIn == null) continue;
        m.expiresIn -= 1;
        if (m.expiresIn <= 0) this._dismissSummon(m, "expired", events);
      }
    }
  }
```

- [ ] **Step 5: Guard spoils on `noSpoils`**

In `_dropSpoils`, add as the **first** line of the method body (before `const t = ...`):

```js
    if (mob.noSpoils) return [];
```

In `_killMobAt`, replace the `participants`/return lines so XP is suppressed for a `noSpoils` victim. Change:

```js
    const participants = this._awardKillXp(mob, killerPlayer, xp, roomId); // shared credit (Model A)
    this.rooms[roomId].light = this.computeRoomLight(roomId); // a luminous mob dying changes the room
    return { type: "death", victimKind: "mob", victimId: mob.id, victimName: t.name, roomId, killerId: killerPlayer ? killerPlayer.id : null, loot, xp: participants.length ? xp : 0, cause, participants };
```

to:

```js
    const participants = mob.noSpoils ? [] : this._awardKillXp(mob, killerPlayer, xp, roomId); // shared credit (Model A); summons award nothing
    this.rooms[roomId].light = this.computeRoomLight(roomId); // a luminous mob dying changes the room
    return { type: "death", victimKind: "mob", victimId: mob.id, victimName: t.name, roomId, killerId: killerPlayer ? killerPlayer.id : null, loot, xp: participants.length ? xp : 0, cause, participants };
```

In `_hurtMob`, change:

```js
    const participants = killer ? this._awardKillXp(mob, killer, xp, roomId) : []; // shared credit (Model A)
```

to:

```js
    const participants = (killer && !mob.noSpoils) ? this._awardKillXp(mob, killer, xp, roomId) : []; // shared credit; summons award nothing
```

- [ ] **Step 6: Wire the lifetime tick into `advance()`**

In `advance()`, after the `this._harvestTick(events);` line, add:

```js
    this._summonTick(events);
```

- [ ] **Step 7: Run to verify it passes**

Run: `node tmp/t1-primitive.js`
Expected: `T1 OK` (exit 0).

- [ ] **Step 8: Commit**

```bash
git add server/state.js
git commit -m "feat: summon primitive — _summon/_dismissSummon, lifetime tick, noSpoils"
```

---

## Task 2: Player `Summon Wisp` spell (state + command + data + validator)

**Files:**
- Modify: `server/state.js` — add `castSummon` method (near `castBeneficial`, ~line 1133+).
- Modify: `server/commands.js` — `cast` routing (~line 740) + new `castSummon` handler.
- Modify: `tools/validate-data.js` — accept the `summon` spell effect type (~line 251, ~272).
- Modify: `data/world/spells.json` — add `summon-wisp`.
- Modify: `data/world/items.json` — add `scroll-summon-wisp`.
- Modify: `data/world/mobs.json` — add the scroll to Vesper (`rim-mage`) `shop.sells`.
- Test: `tmp/t2-cast.js`

- [ ] **Step 1: Teach the validator the `summon` spell effect**

In `tools/validate-data.js`, change the spell effect type list (~line 251) from:

```js
  const SPELL_EFFECT_TYPES = ["damage", "emit-light", "heal-over-time", "protect"];
```

to:

```js
  const SPELL_EFFECT_TYPES = ["damage", "emit-light", "heal-over-time", "protect", "summon"];
```

Then, inside the `for (const [id, sp] of Object.entries(spells))` loop, add a `summon` branch to the effect `else if` chain (after the `protect` branch, before its closing `}`):

```js
    } else if (eff.type === "summon") {
      if (!eff.mob || !has(mobs, eff.mob)) errs.push(`spell ${id}: summon effect references missing mob ${eff.mob}`);
      if (eff.count != null && (typeof eff.count !== "number" || eff.count <= 0)) errs.push(`spell ${id}: summon count must be a positive number`);
      if (eff.duration != null && (typeof eff.duration !== "number" || eff.duration <= 0)) errs.push(`spell ${id}: summon duration must be a positive number (ticks)`);
      if (eff.group != null && typeof eff.group !== "string") errs.push(`spell ${id}: summon group must be a string`);
    }
```

- [ ] **Step 2: Add the spell, scroll, and shop entry (data)**

In `data/world/spells.json`, add a new entry (mind the trailing comma on the prior entry):

```json
  "summon-wisp": {
    "id": "summon-wisp",
    "name": "Summon Wisp",
    "description": "A weave that coaxes a knot of loose glimmer into a biddable shape and binds it to your will for a time. The conjured wisp drifts at your heel and spits its cold light at your foes, but the binding frays — in a few minutes the glimmer slips free and the wisp unravels. Cast it and a Wisp answers; cast it again and the old one lets go as the new takes shape.",
    "manaCost": 10,
    "effect": { "type": "summon", "mob": "wisp", "count": 1, "duration": 180, "group": "summon-wisp" }
  }
```

In `data/world/items.json`, add (matching the existing `scroll-*` shape — `type: "scroll"`, `stackable: true`, a `scroll.spell`):

```json
  "scroll-summon-wisp": {
    "id": "scroll-summon-wisp",
    "name": "a Scroll of Summon Wisp",
    "description": "Heavy vellum inked with a coiling binding-glyph that seems to tug faintly at the glimmer in the air. Study it to learn the Summon Wisp weave — a conjured mote of captive light that fights at your side — and the scroll crumbles to ash in the learning.",
    "type": "scroll",
    "weight": 0,
    "value": 90,
    "stackable": true,
    "scroll": { "spell": "summon-wisp" }
  }
```

In `data/world/mobs.json`, in `rim-mage`'s `shop.sells` array, append `{ "template": "scroll-summon-wisp" }`:

```json
      "sells": [{ "template": "scroll-spark" }, { "template": "scroll-regeneration" }, { "template": "scroll-glimmerskin" }, { "template": "scroll-summon-wisp" }]
```

- [ ] **Step 3: Add `state.castSummon`**

In `server/state.js`, immediately after the `castBeneficial(...)` method, add:

```js
  /**
   * Resolve a player summon spell (effect.type "summon"). Spends mana/shards,
   * dismisses this caster's existing summons of the same `group` (recast replaces,
   * resetting the timer), then conjures the new one(s) via `_summon`. The per-owner
   * cap of one-per-group is enforced purely by the dismiss step. Returns
   * { mob, count, replaced } for the caller to narrate.
   */
  castSummon(player, spell, events = []) {
    const eff = spell.effect || {};
    player.mana = Math.max(0, (player.mana || 0) - (spell.manaCost || 0));
    if (spell.shardCost) player.shards = Math.max(0, (player.shards || 0) - spell.shardCost);
    const group = eff.group || spell.id;
    const existing = [];
    for (const rt of Object.values(this.rooms))
      for (const m of rt.mobs) if (m.ownerId === player.id && m.summonGroup === group) existing.push(m);
    for (const m of existing) this._dismissSummon(m, "recast", events);
    const made = this._summon({
      roomId: player.location, mobId: eff.mob, count: eff.count || 1,
      faction: "player", ownerId: player.id, summonerId: player.id, group,
      lifetime: eff.duration != null ? eff.duration : null, by: "player", byName: player.name,
    }, events);
    return { mob: this.world.mobs[eff.mob], count: made.length, replaced: existing.length };
  }
```

- [ ] **Step 4: Route `cast` to the summon handler**

In `server/commands.js`, in `cast(...)`, immediately after `autoStand(player);` and before the `if (!spell.hostile) return castSupport(...)` line, add:

```js
  // Summon spells are self-centred (no creature target) — conjure at the caster.
  if (spell.effect && spell.effect.type === "summon") return castSummon(state, player, spell, ctx);
```

- [ ] **Step 5: Add the `castSummon` command handler**

In `server/commands.js`, immediately after the `castSupport(...)` function, add:

```js
// Cast a summon spell. Resolution (mana, recast-replace, conjuring) lives in
// state.castSummon; this narrates. The summon is self-centred — it appears in the
// caster's room and fights autonomously via the faction AI.
function castSummon(state, player, spell, ctx) {
  const events = [];
  const res = state.castSummon(player, spell, events);
  const name = res.mob.name;
  const Name = name.charAt(0).toUpperCase() + name.slice(1);
  ctx.toRoom(player.location, { type: "log", text: `${player.name} traces a binding-glyph, and ${name} coalesces from the gloom.` }, player.id);
  ctx.refreshRoom(player.location, player.id);
  const replaced = res.replaced ? ` Your previous ${name} unravels into motes.` : "";
  return selfAndViews(state, player, `You weave the glimmer into shape, and ${name} answers your call.${replaced}`);
}
```

- [ ] **Step 6: Write the harness**

Create `tmp/t2-cast.js`:

```js
const assert = require("node:assert");
const { loadWorld } = require("../server/world");
const { GameState } = require("../server/state");
const state = new GameState(loadWorld());
const room = "rim.plaza";
const p = state.createCharacter("Caster", {}); p.location = room; state.admit(p);
p.mana = 50;

const spell = state.world.spells["summon-wisp"];
assert.ok(spell, "summon-wisp spell exists");
const before = state.rooms[room].mobs.length;

const e1 = [];
const r1 = state.castSummon(p, spell, e1);
assert.strictEqual(r1.count, 1, "one wisp summoned");
assert.strictEqual(p.mana, 40, "mana spent (50 - 10)");
const wisps = () => state.rooms[room].mobs.filter((m) => m.ownerId === p.id && m.summonGroup === "summon-wisp");
assert.strictEqual(wisps().length, 1, "exactly one owned wisp");
assert.strictEqual(wisps()[0].faction, "player");
assert.strictEqual(wisps()[0].expiresIn, 180);

// Recast replaces — still exactly one.
const e2 = [];
const r2 = state.castSummon(p, spell, e2);
assert.strictEqual(r2.replaced, 1, "recast reported a replacement");
assert.strictEqual(wisps().length, 1, "still exactly one owned wisp after recast");
assert.ok(e2.some((x) => x.type === "summon-end" && x.reason === "recast"), "old wisp dismissed on recast");
console.log("T2 OK");
```

- [ ] **Step 7: Run validate + harness**

Run: `npm run validate`
Expected: `OK: ... spells.` (exit 0).

Run: `node tmp/t2-cast.js`
Expected: `T2 OK` (exit 0).

- [ ] **Step 8: Commit**

```bash
git add server/state.js server/commands.js tools/validate-data.js data/world/spells.json data/world/items.json data/world/mobs.json
git commit -m "feat: Summon Wisp player spell + scroll (sold by Vesper)"
```

---

## Task 3: Gnaw's `summon` reinforcement action (state + data + validator)

**Files:**
- Modify: `server/state.js` — `_mobAct` option filter + dispatch (~line 1251), add `_mobSummon`.
- Modify: `tools/validate-data.js` — accept the `summon` mob action type (~line 196).
- Modify: `data/world/mobs.json` — add the `summon` action to `gnaw`.
- Test: `tmp/t3-gnaw.js`

- [ ] **Step 1: Teach the validator the `summon` mob action**

In `tools/validate-data.js`, change the action type list (~line 196) from:

```js
      if (!["attack", "cast", "emote", "wander", "idle", "flee"].includes(a.type))
```

to:

```js
      if (!["attack", "cast", "emote", "wander", "idle", "flee", "summon"].includes(a.type))
```

Then, inside the same `for (const a of m.actions || [])` loop, add validation for the new type (after the `cast` block):

```js
      if (a.type === "summon") {
        if (!a.mob || !has(mobs, a.mob)) errs.push(`mob ${id}: summon action references missing mob ${a.mob}`);
        if (a.count != null && (typeof a.count !== "number" || a.count <= 0)) errs.push(`mob ${id}: summon count must be a positive number`);
        if (a.max != null && (typeof a.max !== "number" || a.max <= 0)) errs.push(`mob ${id}: summon max must be a positive number`);
      }
```

- [ ] **Step 2: Add Gnaw's summon action (data)**

In `data/world/mobs.json`, in `gnaw`'s `actions` array, append:

```json
      { "type": "summon", "weight": 2, "mob": "giant-rat", "count": 2, "max": 4, "verb": "throws back her head and shrieks; vermin boil out of the dark" }
```

(So Gnaw's `actions` become attack/idle/emote/summon.)

- [ ] **Step 3: Add the `summon` option gate + dispatch in `_mobAct`**

In `server/state.js`, in `_mobAct`, inside the `options = t.actions.filter((a) => { ... })` block, add a line (after the `cast` line):

```js
        if (a.type === "summon") return aggressive && a.mob && this.world.mobs[a.mob] && enemies.length > 0 && this._broodCount(m.id) < (a.max != null ? a.max : Infinity);
```

Then, in the dispatch chain at the end of `_mobAct` (after the `if (choice.type === "cast") ...` line), add:

```js
    if (choice.type === "summon") return this._mobSummon(m, t, roomId, events, choice);
```

- [ ] **Step 4: Add `_mobSummon`**

In `server/state.js`, immediately after the `_mobAttack(...)` method (or any sibling mob-action method), add:

```js
  /** A mob summons reinforcements (the `summon` action). Conjures up to its
   *  `count`, never exceeding the living-brood `max`, on the mob's own faction
   *  (allies that fight alongside it, not each other). Permanent, spoil-less. */
  _mobSummon(m, t, roomId, events, action) {
    const max = action.max != null ? action.max : Infinity;
    const room = this._broodCount(m.id);
    const count = Math.min(action.count || 1, max - room);
    if (count <= 0) return;
    this._summon({
      roomId, mobId: action.mob, count, faction: m.faction || "wild",
      ownerId: null, summonerId: m.id, group: null, lifetime: null,
      by: "mob", byName: t.name, verb: action.verb || null,
    }, events);
  }
```

- [ ] **Step 5: Write the harness**

Create `tmp/t3-gnaw.js`:

```js
const assert = require("node:assert");
const { loadWorld } = require("../server/world");
const { GameState } = require("../server/state");
const state = new GameState(loadWorld());
const room = "rim.plaza";

// Build Gnaw via the real spawn path so she has full template behaviour, and a
// player so the brood has someone to (eventually) fight.
const gMob = state._spawnMob(room, "gnaw");
const p = state.createCharacter("Bait", {}); p.location = room; state.admit(p);

const t = state.world.mobs["gnaw"];
const action = (t.actions || []).find((a) => a.type === "summon");
assert.ok(action, "gnaw has a summon action");
assert.strictEqual(action.max, 4);

// Drive the summon directly (deterministic — _mobAct's choice is weighted/random).
state._mobSummon(gMob, t, room, [], action); // +2 (brood 0 -> 2)
assert.strictEqual(state._broodCount(gMob.id), 2, "summoned 2 rats");
state._mobSummon(gMob, t, room, [], action); // +2 (brood 2 -> 4)
assert.strictEqual(state._broodCount(gMob.id), 4, "brood at cap 4");
state._mobSummon(gMob, t, room, [], action); // capped — no more
assert.strictEqual(state._broodCount(gMob.id), 4, "does not exceed max");

// Rats are wild (Gnaw's side) and spoil-less.
const rat = state.rooms[room].mobs.find((mm) => mm.summonerId === gMob.id);
assert.strictEqual(rat.faction, "wild");
assert.strictEqual(rat.noSpoils, true);
assert.strictEqual(rat.expiresIn, null, "reinforcements are permanent");

// Killing a rat frees a brood slot.
state._killMobAt(rat, room, p, "hit");
assert.strictEqual(state._broodCount(gMob.id), 3, "killing a rat lowers the brood");
state._mobSummon(gMob, t, room, [], action); // can summon 1 to refill to 4
assert.strictEqual(state._broodCount(gMob.id), 4, "refills after a death");
console.log("T3 OK");
```

- [ ] **Step 6: Run validate + harness**

Run: `npm run validate`
Expected: exit 0.

Run: `node tmp/t3-gnaw.js`
Expected: `T3 OK` (exit 0).

- [ ] **Step 7: Commit**

```bash
git add server/state.js tools/validate-data.js data/world/mobs.json
git commit -m "feat: Gnaw summons capped giant-rat reinforcements"
```

---

## Task 4: Follow + owner-loss / disconnect dismissal

**Files:**
- Modify: `server/state.js` — `_moveSummonsWith` (new), `_respawn` (~1653) dismiss owned summons, `removePlayer` (~773) dismiss + return events.
- Modify: `server/commands.js` — `move` (~166) follow hook.
- Modify: `server/index.js` — `ws.on("close")` dispatch removePlayer's events (~147).
- Test: `tmp/t4-follow.js`

- [ ] **Step 1: Add `_moveSummonsWith` and owner-loss hooks (state)**

In `server/state.js`, add a new method (near `_dismissOwnedSummons`):

```js
  /** Relocate a player's owned summons from `from` to `dest` (follow on move).
   *  Returns [{ mobName, emitsLight }] for the caller to narrate. Recomputes light
   *  in both rooms if anything moved. Wild (ownerless) summons never follow. */
  _moveSummonsWith(player, from, dest) {
    const rtFrom = this.rooms[from], rtDest = this.rooms[dest];
    const moved = [];
    for (const m of [...rtFrom.mobs]) {
      if (m.ownerId !== player.id) continue;
      const idx = rtFrom.mobs.indexOf(m);
      if (idx >= 0) rtFrom.mobs.splice(idx, 1);
      rtDest.mobs.push(m);
      const t = this.world.mobs[m.template];
      moved.push({ mobName: t.name, emitsLight: !!t.emitsLight });
    }
    if (moved.length) {
      rtFrom.light = this.computeRoomLight(from);
      rtDest.light = this.computeRoomLight(dest);
    }
    return moved;
  }
```

In `_respawn`, change the signature to accept an events array and dismiss the player's summons. Change:

```js
  _respawn(player, deathRoom) {
```

to:

```js
  _respawn(player, deathRoom, events = []) {
```

and, immediately before its `return { type: "death", victimKind: "player", ... }` line, add:

```js
    this._dismissOwnedSummons(player.id, "owner-gone", events); // a falling delver's summons unravel
```

Update the three `_respawn` call sites to pass their `events` array:
- In the player-defender `deal` sink (~line 1410): `const d = this._respawn(player, roomId, events); events.push(d);`
- In `_hurtPlayer` (~line 1630): `const death = this._respawn(player, player.location, events); events.push(death);`
- In `_mobCast` (the player-death branch, ~line where `this._respawn(target, roomId)` appears): `death = this._respawn(target, roomId, events);`

(Note: the `summon-end` events are appended to `events` *before* the player's `death` event, which is fine — they render independently.)

Change `removePlayer` to dismiss owned summons and return the events:

```js
  removePlayer(playerId) {
    const player = this.players.get(playerId);
    const events = [];
    if (player) {
      this._dismissOwnedSummons(player.id, "owner-gone", events); // disconnect unravels summons
      this._deindexPlayer(player);
    }
    this.players.delete(playerId);
    this.revealedMobs.delete(playerId); // drop ephemeral hidden-mob reveals on disconnect
    return events;
  }
```

- [ ] **Step 2: Follow hook in `move` (commands)**

In `server/commands.js`, in `move(...)`, immediately after the two `state.rooms[...].light = state.computeRoomLight(...)` lines (after `setPlayerLocation`), add:

```js
  // Owned summons follow their delver between rooms (wild summons stay put).
  const followed = state._moveSummonsWith(player, from, dest);
  for (const f of followed) {
    const Name = f.mobName.charAt(0).toUpperCase() + f.mobName.slice(1);
    ctx.toRoom(from, { type: "log", text: `${Name} slips away after ${player.name}.` }, player.id);
    ctx.toRoom(dest, { type: "log", text: `${Name} drifts in at ${player.name}'s heel.` }, player.id);
  }
  if (followed.length) { ctx.refreshRoom(from, player.id); ctx.refreshRoom(dest, player.id); }
```

Then append a follow note to the mover's own line — change the final:

```js
  const msgs = selfAndViews(state, player, `You go ${dir}.${tail}`);
```

to:

```js
  const followTail = followed.length ? ` Your ${followed.map((f) => f.mobName).join(", ")} follows.` : "";
  const msgs = selfAndViews(state, player, `You go ${dir}.${tail}${followTail}`);
```

- [ ] **Step 3: Dispatch removePlayer's events on disconnect (index.js)**

In `server/index.js`, in the `ws.on("close", ...)` handler, change:

```js
      state.removePlayer(ws.playerId);
      connections.delete(ws.playerId);
```

to:

```js
      for (const ev of state.removePlayer(ws.playerId)) dispatchEvent(ev);
      connections.delete(ws.playerId);
```

- [ ] **Step 4: Write the harness**

Create `tmp/t4-follow.js`:

```js
const assert = require("node:assert");
const { loadWorld } = require("../server/world");
const { GameState } = require("../server/state");
const state = new GameState(loadWorld());

// Pick a room with an exit and its destination.
let from, dir, dest;
for (const [id, r] of Object.entries(state.world.rooms)) {
  const ex = Object.entries(r.exits || {})[0];
  if (ex) { from = id; dir = ex[0]; dest = ex[1]; break; }
}
assert.ok(from && dest, "found a room with an exit");

const p = state.createCharacter("Walker", {}); p.location = from; state.admit(p); p.mana = 50;
// Summon an owned wisp + a wild rat in the same room.
const wisp = state._summon({ roomId: from, mobId: "wisp", count: 1, faction: "player", ownerId: p.id, summonerId: p.id, group: "summon-wisp", lifetime: 180 }, [])[0];
const rat = state._summon({ roomId: from, mobId: "giant-rat", count: 1, faction: "wild", summonerId: "mob.z" }, [])[0];

const moved = state._moveSummonsWith(p, from, dest);
assert.strictEqual(moved.length, 1, "only the owned wisp follows");
assert.ok(state.rooms[dest].mobs.includes(wisp), "wisp relocated to dest");
assert.ok(state.rooms[from].mobs.includes(rat), "wild rat stayed put");

// Owner death dismisses the summon.
const de = [];
state._respawn(p, dest, de);
assert.ok(!state.rooms[dest].mobs.includes(wisp), "wisp dismissed on owner death");
assert.ok(de.some((e) => e.type === "summon-end"), "death emitted summon-end");

// Disconnect dismisses summons and returns events.
const w2 = state._summon({ roomId: p.location, mobId: "wisp", count: 1, faction: "player", ownerId: p.id, summonerId: p.id, group: "summon-wisp", lifetime: 180 }, [])[0];
const evs = state.removePlayer(p.id);
assert.ok(Array.isArray(evs) && evs.some((e) => e.type === "summon-end"), "disconnect dismissed + returned events");
console.log("T4 OK");
```

- [ ] **Step 5: Run validate + harness**

Run: `npm run validate`
Expected: exit 0.

Run: `node tmp/t4-follow.js`
Expected: `T4 OK` (exit 0).

- [ ] **Step 6: Commit**

```bash
git add server/state.js server/commands.js server/index.js
git commit -m "feat: summons follow their owner; dismiss on death/disconnect"
```

---

## Task 5: Rendering (index.js summon / summon-end events)

**Files:**
- Modify: `server/index.js` — add `summon` and `summon-end` handlers to `dispatchEvent` (alongside `mob-spawn`/`mob-move`, ~line 370).
- Verify: a short live smoke (covered fully in Task 7).

- [ ] **Step 1: Add the event handlers**

In `server/index.js`, in `dispatchEvent`, immediately before the `if (ev.type === "mob-spawn")` block, add:

```js
  if (ev.type === "summon") {
    // A creature was conjured into the room (player Summon spell or a mob's
    // reinforcement action). A mob summoner narrates its `verb`; a player summon
    // is narrated by the cast command, so the tick path here only fires for mobs.
    for (const o of state.playersIn(ev.roomId)) {
      const n = canSeeMob(o, ev.light, ev.emitsLight) ? ev.mobName : "something";
      const line = ev.verb && ev.byName
        ? `${cap(ev.byName)} ${ev.verb}.`
        : `${cap(n)} coalesces from the gloom.`;
      sendToPlayer(o.id, { type: "log", text: line });
      sendToPlayer(o.id, buildRoomView(state, o));
    }
    return;
  }

  if (ev.type === "summon-end") {
    // A summon unravelled (timer expired, recast, or owner gone) — no corpse/loot.
    for (const o of state.playersIn(ev.roomId)) {
      const n = canSeeMob(o, ev.light, ev.emitsLight) ? ev.mobName : "something";
      sendToPlayer(o.id, { type: "log", text: `${cap(n)} unravels into motes and is gone.` });
      sendToPlayer(o.id, buildRoomView(state, o));
    }
    return;
  }
```

- [ ] **Step 2: Smoke-check the server boots**

Run: `node -e "require('./server/index.js')"` then stop it (Ctrl-C), OR rely on the Task 7 live run.
Expected: no syntax/throw at load (it will start listening; that's fine — kill it).

- [ ] **Step 3: Commit**

```bash
git add server/index.js
git commit -m "feat: render summon / summon-end events"
```

---

## Task 6: Docs (data-model + CHANGELOG)

**Files:**
- Modify: `docs/data-model.md` — document the `summon` spell effect, the `summon` mob action, and the instance fields.
- Modify: `CHANGELOG.md` — `[Unreleased]`.

- [ ] **Step 1: Document the summon mechanics in `docs/data-model.md`**

In the **Spell** / effect area, add the `summon` effect to the documented effect types, e.g. a row/paragraph:

> `summon` — conjures `count` instances of `mob` for `duration` ticks (omit for permanent), tagged to the caster. `group` (defaults to the spell id) scopes the recast cap: recasting the same group dismisses the caster's previous summon of that group.

In the **Mob actions (weighted)** table, add a row:

> `summon` | Conjure reinforcements of the mob's own faction, up to a living-brood `max`. | `mob` (template), `count` (per cast), `max` (living cap), `verb` (display) |

In the **Mob template (dynamic)** / runtime instance notes, document the summon instance fields:

> Summoned instances also carry `summonerId` (conjurer), `summonGroup` (recast-cap key), `expiresIn` (ticks to wink-out; null = permanent), and `noSpoils: true` (no loot/XP on death). They carry no spawner `origin`, so they never respawn or count against room spawn caps. Instance `faction`/`ownerId` (Phase 1) decide allegiance.

- [ ] **Step 2: Update `CHANGELOG.md`**

Under `## [Unreleased]` (in the appropriate `Added` subsection), add:

```markdown
### Added
- **Summoning.** A data-driven summon primitive: a player **Summon Wisp** spell
  (learned from a scroll sold by Vesper the glimmer-mage) conjures an allied Wisp
  for 3 minutes that fights autonomously and follows its summoner; **Gnaw, the
  Brood-Mother** now calls capped giant-rat reinforcements mid-fight. Summoned
  creatures drop no loot or XP and unravel on a timer, on their summoner's death,
  or on disconnect.
```

- [ ] **Step 3: Validate (docs don't affect data, but confirm clean)**

Run: `npm run validate`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add docs/data-model.md CHANGELOG.md
git commit -m "docs: document summon spell effect, mob action, and instance fields"
```

---

## Task 7: Full verification + live run + PR

**Files:** none (verification + cleanup).

- [ ] **Step 1: Run the full harness suite + validate**

```bash
npm run validate
node tmp/t1-primitive.js
node tmp/t2-cast.js
node tmp/t3-gnaw.js
node tmp/t4-follow.js
```
Expected: `OK: ...` from validate and `T1 OK` / `T2 OK` / `T3 OK` / `T4 OK`.

- [ ] **Step 2: Live run (test instance on 3738)**

Start: `PORT=3738 npm start` (restart after any server edit — no hot reload).
In the browser client (or a ws client) as `admin`:
- `@shards 500` then buy + study the scroll: walk to Vesper, `buy scroll-summon-wisp`, `study scroll of summon wisp` (or `study scroll-summon-wisp`).
- `cast summon-wisp` → a Wisp appears; confirm the room view shows it and the player view shows mana spent.
- Walk one room (`east`/`west`/…) → confirm "Your a Wisp follows." and the Wisp is in the new room view.
- `@spawn gloom-crawler` (a wild enemy) → confirm the Wisp casts Spark / fights it (mob-vs-mob from Phase 1).
- Wait ~3 min (or temporarily set `duration` low in a scratch test) → confirm the Wisp "unravels into motes and is gone." with no loot.
- `@spawn gnaw`, attack her → confirm she shrieks and rats appear, capped at 4 alive; kill a rat → she can summon again; killing rats yields no XP.

Capture the relevant log-pane lines as evidence.

- [ ] **Step 3: Remove scratch harnesses**

```bash
rm -f tmp/t1-primitive.js tmp/t2-cast.js tmp/t3-gnaw.js tmp/t4-follow.js
```
(They were never committed; this just tidies the working tree.)

- [ ] **Step 4: Push and open the PR**

```bash
git push -u origin feat/summoning
```
Then open a PR into `main` titled `feat: summoning — Summon Wisp spell + Gnaw reinforcements`, body summarizing the spec + verification evidence. (If `gh` is unavailable, use the compare URL git prints.) Maintainer merges — do not self-merge.

---

## Self-review notes (author check)

- **Spec coverage:** primitive (T1), player spell + scroll + Vesper (T2), Gnaw action (T3), follow + owner-loss/disconnect (T4), rendering (T5), docs (T6), verification (T7) — all spec sections mapped.
- **Validator:** both new types (`summon` spell effect *and* `summon` mob action) are taught before data using them is added (T2 step 1 / T3 step 1 precede their data steps), so `npm run validate` never sees an unknown type.
- **Type/name consistency:** `_summon`, `_dismissSummon`, `_dismissOwnedSummons`, `_broodCount`, `_summonTick`, `_moveSummonsWith`, `state.castSummon` (state) and `castSummon` (command handler) are used consistently across tasks. Instance fields `summonerId`/`summonGroup`/`expiresIn`/`noSpoils` match T1's definitions everywhere.
- **`_respawn` signature change** (adds `events`) is paired with all three call-site updates in T4 step 1.
- **noSpoils** is enforced in `_dropSpoils` (covers every death path) plus XP suppression in `_killMobAt` and `_hurtMob`.
```