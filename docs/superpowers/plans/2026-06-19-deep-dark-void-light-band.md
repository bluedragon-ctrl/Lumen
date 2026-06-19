# Deep dark — the `void` light band — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a sub-zero `void` light band so negative-`ambientLight` rooms read as "deep dark" — distinct atmospheric client treatment (breathing vignette + faint shiver) and a `⚠ blind` meter — and turn `warren.throat` into the first such room.

**Architecture:** One engine change (let the light value go below zero in `server/light.js` and map `< 0` to a new `void` band). Everything downstream already handles "below `blindBelow`" correctly, so no other server logic changes. The client maps the new band name to a CSS class and meter marker. The first negative room is data-only.

**Tech Stack:** Node.js (CommonJS) + `ws` server; `node --test` (node:test/node:assert) for engine tests; vanilla JS/CSS browser client (verified via the preview tools, no client test framework).

**Spec:** [docs/superpowers/specs/2026-06-19-deep-dark-void-light-band-design.md](../specs/2026-06-19-deep-dark-void-light-band-design.md)

---

## File structure

| File | Responsibility | Change |
|------|----------------|--------|
| `server/light.js` | Light scale, bands, clamp | `LIGHT_MIN = -20`; add `void` band in `bandOf`. |
| `test/light.test.js` | Unit tests for the light model | **Create** — covers `bandOf` boundaries + `clampLight` floor. |
| `client/app.js` | Room render → meter + pane class | Append `⚠ blind` to the meter when band is `void`. |
| `client/styles.css` | Per-band atmospheric tint | Add `.light-void` block: breathing vignette + faint shiver + reduced-motion fallback. |
| `data/world/rooms.json` | World content | `warren.throat` `ambientLight: 0 → -1`. |
| `docs/data-model.md` | Data model reference | Note negative `ambientLight` + the `void` band. |
| `CHANGELOG.md` | Changelog | `[Unreleased]` entry. |

---

## Task 1: `void` band and sub-zero light floor (engine)

**Files:**
- Modify: `server/light.js` (`LIGHT_MIN` at line 7; `bandOf` at lines 11-16)
- Test: `test/light.test.js` (create)

- [ ] **Step 1: Write the failing test**

Create `test/light.test.js`:

```js
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `bandOf(-1)` returns `"darkness"` (not `"void"`) and `LIGHT_MIN` is `0` (not `-20`).

- [ ] **Step 3: Make the minimal change**

In `server/light.js`, change line 7:

```js
const LIGHT_MIN = -20;
```

And add the `void` case at the top of `bandOf` (lines 11-16 become):

```js
function bandOf(value) {
  if (value < 0) return "void";      // sub-zero: deep dark, the mirror of "searing"
  if (value <= 0) return "darkness";
  if (value <= 2) return "dim";
  if (value <= 9) return "bright";
  return "searing"; // exceptional — a torch + a few lightbugs stays "bright"
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS — the new `light.test.js` tests pass and the existing `room-effects`, `mob-combat`, and `pathfinding` suites still pass (no regression from the floor change).

- [ ] **Step 5: Commit**

```bash
git add server/light.js test/light.test.js
git commit -m "feat: add the void light band for sub-zero light"
```

---

## Task 2: `⚠ blind` meter marker (client)

**Files:**
- Modify: `client/app.js:201`

No client test framework exists; this is verified in the preview in Task 5.

- [ ] **Step 1: Make the change**

Replace `client/app.js:201`:

```js
  $("light-meter").textContent = `light: ${room.light.band} (${room.light.value})` + (room.harmed ? " ⚠ harsh" : "");
```

with:

```js
  $("light-meter").textContent =
    `light: ${room.light.band} (${room.light.value})` +
    (room.light.band === "void" ? " ⚠ blind" : "") +
    (room.harmed ? " ⚠ harsh" : "");
```

(`void` can never be `harmed` — `harmed` requires `light > harmedAbove` — so the two markers never both appear.)

- [ ] **Step 2: Commit**

```bash
git add client/app.js
git commit -m "feat: show the blind marker in the void band meter"
```

---

## Task 3: `.light-void` atmosphere (client CSS)

**Files:**
- Modify: `client/styles.css` (add after the `searing` block, ~line 191; extend the existing `prefers-reduced-motion` block at lines 196-199)

Visual target: PoC option "A" (breathing vignette + faint shiver). Verified in the preview in Task 5.

- [ ] **Step 1: Add the `.light-void` rules**

Insert after the `@keyframes searing-pulse` line (line 191), before `@keyframes lumin-glow`:

```css
/* void: light is below zero — a deep dark that ordinary light can't beat. The
   mirror of searing: a black vignette that breathes inward (the dark closing in)
   plus a faint shiver on the room text. */
.light-void { background: #040506; color: #5a6770; }
.light-void #room-name { color: #6b7882; }
.light-void #room-name, .light-void .room-desc {
  animation: void-shiver .45s steps(2, end) infinite;
}
.light-void::after {
  content: ""; position: absolute; inset: 0; pointer-events: none;
  animation: void-breathe 4.5s ease-in-out infinite;
}
@keyframes void-breathe {
  0%, 100% { background: radial-gradient(ellipse 80% 80% at 50% 45%,
              rgba(0,0,0,0) 0%, rgba(0,0,0,.45) 58%, rgba(0,0,0,.92) 100%); }
  50%      { background: radial-gradient(ellipse 44% 50% at 50% 45%,
              rgba(0,0,0,0) 0%, rgba(0,0,0,.7) 45%, rgba(0,0,0,.99) 90%); }
}
@keyframes void-shiver {
  0%   { transform: translate(0, 0); }
  25%  { transform: translate(.4px, -.3px); }
  50%  { transform: translate(-.3px, .4px); }
  75%  { transform: translate(.3px, .3px); }
  100% { transform: translate(-.4px, -.2px); }
}
```

- [ ] **Step 2: Extend the reduced-motion fallback**

Replace the existing block at lines 196-199:

```css
@media (prefers-reduced-motion: reduce) {
  .light-searing #room-name, .light-searing .room-desc, .light-searing::after { animation: none; }
  .chip.luminous { animation: none; }
}
```

with:

```css
@media (prefers-reduced-motion: reduce) {
  .light-searing #room-name, .light-searing .room-desc, .light-searing::after { animation: none; }
  .light-void #room-name, .light-void .room-desc { animation: none; }
  .light-void::after {
    animation: none;
    background: radial-gradient(ellipse 55% 58% at 50% 45%,
      rgba(0,0,0,0) 0%, rgba(0,0,0,.7) 50%, rgba(0,0,0,.96) 95%);
  }
  .chip.luminous { animation: none; }
}
```

- [ ] **Step 3: Commit**

```bash
git add client/styles.css
git commit -m "feat: add the void band breathing-vignette atmosphere"
```

---

## Task 4: First void room — `warren.throat` (data)

**Files:**
- Modify: `data/world/rooms.json` (the `warren.throat` object, `ambientLight` field, ~line 830)

- [ ] **Step 1: Make the change**

In the `warren.throat` room object, change:

```json
    "ambientLight": 0,
```

to:

```json
    "ambientLight": -1,
```

Leave the existing `effects` block (the `lightBelow: 1` creeping-dark damage) and everything else untouched.

- [ ] **Step 2: Validate the data**

Run: `npm run validate`
Expected: exits 0 (`ambientLight` is unconstrained, so no schema error; reachability is unaffected by the value change).

- [ ] **Step 3: Commit**

```bash
git add data/world/rooms.json
git commit -m "feat: make warren.throat a void room (ambientLight -1)"
```

---

## Task 5: Verify in the running client (manual / preview)

No code change — this is the end-to-end check of Tasks 2-4. The dev server does **not** hot-reload server code, so start (or restart) it first.

- [ ] **Step 1: Start the server and open the client**

Use the preview tools: `preview_start` (server on port 3737), then load the client. Log in as a fresh character.

- [ ] **Step 2: Walk to `warren.throat` with no lit light source**

Navigate to "Where the Dark Goes Bad". Confirm with `preview_snapshot` / `preview_screenshot`:
- Meter reads `light: void (-1) ⚠ blind`.
- The room pane shows the breathing-vignette + faint-shiver treatment (the `light-void` class on `#inspect`).
- The creeping-dark message ("The dark presses close and drinks the warmth from you.") ticks and HP/mana drop (`preview_console_logs` / vitals).

- [ ] **Step 3: Equip and light a torch (output 3)**

Confirm the value rises to `2` → band `dim`, the meter drops the `⚠ blind` marker, the void atmosphere clears, and the creeping-dark damage stops (light is now `≥ 1`, so the `lightBelow: 1` effect no longer fires).

- [ ] **Step 4: Check reduced motion**

In the preview, emulate `prefers-reduced-motion: reduce` (e.g. `preview_eval` to toggle, or device settings) and re-enter the room: the pane shows a static heavy vignette with no shiver and no breathing.

- [ ] **Step 5: Capture proof**

Take a `preview_screenshot` of the void room (default + reduced-motion) for the PR description. No commit (no code change in this task).

---

## Task 6: Docs + changelog

**Files:**
- Modify: `docs/data-model.md` (the `ambientLight` row, ~line 105, and the light formula note ~line 40-43)
- Modify: `CHANGELOG.md` (`[Unreleased]`)

- [ ] **Step 1: Update the data model**

In `docs/data-model.md`, fix the light formula floor (line ~40) — change:

```
effective = clamp( room.ambientLight + Σ(active light-source output in room), 0, 20 )
```

to:

```
effective = clamp( room.ambientLight + Σ(active light-source output in room), -20, 20 )
```

Then update the `ambientLight` description to note negatives. Change the table row (line ~105) from:

```
| `ambientLight` | integer           | Base light before sources (see light scale). |
```

to:

```
| `ambientLight` | integer           | Base light before sources (see light scale). May be **negative** for deep-dark rooms: the effective light can fall below 0, which reads as the `void` band (you need carried light just to reach a visible level). |
```

- [ ] **Step 2: Add the changelog entry**

Under `## [Unreleased]` in `CHANGELOG.md`, add to the `### Added` list (create the heading if absent):

```markdown
- **Void light band.** Rooms may now author a negative `ambientLight`; when the
  effective light falls below zero the room reads as the new `void` band — a
  distinct deep-dark client treatment (breathing vignette + faint shiver, a
  `⚠ blind` meter) requiring carried light to even see. `warren.throat`
  ("Where the Dark Goes Bad") is the first such room.
```

- [ ] **Step 3: Commit**

```bash
git add docs/data-model.md CHANGELOG.md
git commit -m "docs: document negative ambientLight and the void band"
```

---

## Final verification

- [ ] `npm test` — all suites pass (light, room-effects, mob-combat, pathfinding).
- [ ] `npm run validate` — exits 0.
- [ ] Preview checks from Task 5 captured (default + reduced-motion screenshots).
- [ ] Push the branch and open a PR into `main` (maintainer merges — do not self-merge).
