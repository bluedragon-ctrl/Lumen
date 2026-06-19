# Deep dark — the `void` light band

**Date:** 2026-06-19
**Status:** Approved design, ready for implementation plan

## Summary

Introduce **negative-light rooms** for the deep abyss: rooms whose authored
`ambientLight` is below zero, so a delver must bring carried light just to claw
the room back up to a visible level. To make this legible, add a new light band —
**`void`** — for any effective light value `< 0`, with its own atmospheric
treatment in the client (the dark-side mirror of `searing`): a **breathing
vignette** that swells inward, plus a **faint shiver** on the room text.

The room-effects framework that powers "darkness creeps in" already exists and is
unchanged by this work. The negative-ambient mechanic itself already works in the
engine; the only mechanical change is **unclamping the light floor** so the value
can go (and be reported) below zero, and **mapping that to the new band**.

## Background — what already exists

- Light is a single integer per room:
  `effective = clamp(ambientLight + Σ(active source outputs), 0, 20)`
  ([server/light.js](../../../server/light.js)).
  The clamp is applied to the **final sum**, not to `ambientLight` — so a negative
  ambient already subtracts correctly; only the `0` floor hides it today.
- Bands map from the integer: `≤0` darkness, `≤2` dim, `≤9` bright, else searing
  (`bandOf`, [server/light.js:11](../../../server/light.js)).
- Seeing/combat math keys off `blindBelow` (default `1`): `canSee`, `hitChance`,
  `noticeChance` all treat anything below `blindBelow` as "can't see / flailing /
  unnoticed." Sub-zero values fall in this range and need **no special-casing** —
  they are simply "even more can't-see."
- The **room-effects** framework is live: `room.effects[]`, each
  `{ trigger: "enter"|"tick", when?: { lightBelow|lightAbove }, interval?, action,
  message?, roomMessage? }` with `action` one of `douse` / `restore` / `damage`
  ([server/state.js applyRoomEffect / _roomEffectsTick](../../../server/state.js),
  [server/combat-math.js roomEffectFires](../../../server/combat-math.js)). This is
  the "darkness creeps in" effect; it is reused, not changed.
- Bands reach the client as `light: { value, band }` ([server/render.js:121](../../../server/render.js));
  the client sets `class="pane light-<band>"` and renders a meter
  `light: <band> (<value>)` plus `⚠ harsh` when `harmed` ([client/app.js:199-201](../../../client/app.js)).
  `searing` already has bespoke CSS — animated text + a pulsing `::after` overlay,
  disabled under `prefers-reduced-motion` ([client/styles.css:176-198](../../../client/styles.css)).

## Goals

1. A room authored with negative `ambientLight` behaves as a "you need extra light
   to see anything" room.
2. When effective light is below zero, the client shows a distinct, atmospheric
   **deep-dark** treatment instead of the generic `darkness` tint — so the player
   understands *this* dark is unnaturally deep, not an ordinary unlit room.
3. The first such room is the already-themed `warren.throat`, used as the worked
   example / manual test case.

## Non-goals

- No change to the room-effects framework, combat math, or seeing rules.
- No new validator guardrails for negative ambient (deferred; could be a follow-up).
- No new server-authored "you stepped into deep dark" entry event (deferred polish —
  the band change is already visible). Noted under Future polish.

## Design

### 1. Engine — let light go below zero (`server/light.js`)

- Lower `LIGHT_MIN` from `0` to `-20` (symmetric with `LIGHT_MAX = 20`). This is the
  only change to the clamp; `effectiveLight` now reports the true sub-zero value.
- Add the `void` band at the **bottom** of `bandOf`, before the `darkness` case:

  ```js
  function bandOf(value) {
    if (value < 0) return "void";     // sub-zero: deep dark, the searing mirror
    if (value <= 0) return "darkness"; // exactly 0 — ordinary unlit
    if (value <= 2) return "dim";
    if (value <= 9) return "bright";
    return "searing";
  }
  ```

  A `void` value can only arise when `ambientLight` is negative and carried light
  has not yet overcome it, so the band is a precise signal.

No other engine file changes: `canSee`/`hitChance`/`noticeChance` already return the
"can't see" results for sub-zero light, and the light-bane / room-effect comparisons
(`light <= harmedAbove`, `light < lightBelow`) behave correctly with negatives.

### 2. Client meter — `⚠ blind` (`client/app.js`)

In the meter line, when the band is `void`, append `⚠ blind` (mirroring the
existing `⚠ harsh` for `searing`/`harmed`). Example: `light: void (-1) ⚠ blind`.
The negative value tells the player how deep the hole is and how much light they
must out-muscle. Implementation: extend the meter string at
[client/app.js:201](../../../client/app.js) to add the `blind` marker for
`room.light.band === "void"` (independent of the existing `harmed` marker).

### 3. Client atmosphere — `.light-void` (`client/styles.css`)

Add a `.light-void` block mirroring the structure of `.light-searing`, with the
**breathing vignette + faint shiver** treatment (PoC option "A"):

- **Panel base:** very dark (`background: #040506`), text a cold gray
  (`color: #5a6770`), room name slightly lighter (`#6b7882`) — matching/just below
  the existing `darkness` palette.
- **Breathing vignette:** a `::after` overlay (`inset: 0; pointer-events: none`)
  drawing a radial black gradient that animates between a wide, soft edge and a
  tight, near-opaque one — the readable center shrinks and swells. Mirror of
  `searing`'s pulsing `::after`, inverted (dark closing in vs. light blooming out).
- **Faint shiver:** a sub-pixel positional jitter (`transform: translate` on the
  order of ±0.4px) on the room name and description, fast and low-amplitude — a
  held-breath tremble that does not impede reading.
- **Reduced motion:** under `prefers-reduced-motion: reduce`, drop both animations
  and render a **static heavy vignette** (no shiver, no breathing) — same pattern as
  the existing `searing` reduced-motion rule.

Reference CSS (final values to be tuned during implementation against the live
client; the approved PoC is the visual target):

```css
.light-void { background: #040506; color: #5a6770; }
.light-void #room-name { color: #6b7882; }
.light-void #room-name, .light-void .room-desc {
  animation: void-shiver 0.45s steps(2, end) infinite;
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
  0%{transform:translate(0,0)} 25%{transform:translate(.4px,-.3px)}
  50%{transform:translate(-.3px,.4px)} 75%{transform:translate(.3px,.3px)}
  100%{transform:translate(-.4px,-.2px)}
}
@media (prefers-reduced-motion: reduce) {
  .light-void #room-name, .light-void .room-desc { animation: none; }
  .light-void::after {
    animation: none;
    background: radial-gradient(ellipse 55% 58% at 50% 45%,
      rgba(0,0,0,0) 0%, rgba(0,0,0,.7) 50%, rgba(0,0,0,.96) 95%);
  }
}
```

Note: the vignette `::after` sits above the text (peripheral text is swallowed by
the closing dark, center stays readable). The meter is pinned bottom-left and is
not shivered. Confirm the room pane is `position: relative` (the existing
`searing::after` relies on the same, so it already is).

### 4. Content — the first void room (`data/world/rooms.json`)

Change `warren.throat` ("Where the Dark Goes Bad", depth 7) from
`"ambientLight": 0` to `"ambientLight": -1`. Its existing tick effect
(`when.lightBelow: 1` → `damage 1d2 hp/mana`, "The dark presses close and drinks
the warmth from you.") is unchanged and now composes with the band:

- No light: value `-1` → `void`, blind, taking creeping-dark damage each tick.
- Output 1 (e.g. a guttering ember): value `0` → still `darkness`, still blind and
  bleeding (effect fires while `light < 1`).
- Output ≥ 2 (a real torch, output 3 → value 2): `dim`, can see, safe from the effect.

This is deliberately a *mild* introduction (threshold of just `-1`); deeper rooms
later in the abyss can author larger negatives (`-5`, `-8`) for a harsher gate.

## Data-flow summary

```
ambientLight (−1, authored)  ─┐
active source outputs       ─┼─►  computeRoomLight ─► effectiveLight(clamp −20..20)
                              ┘         (state.js)         (light.js)
                                                              │  value (may be < 0)
                                                              ▼
                                              bandOf(value) → "void"   (light.js)
                                                              │
                                              render: { value, band } (render.js)
                                                              │
                          client: class "pane light-void" + meter "void (−1) ⚠ blind"
                                              + breathing-vignette/shiver CSS  (app.js/styles.css)
```

## Testing / verification

- **Engine unit-level reasoning:** `bandOf(-1)` → `"void"`, `bandOf(0)` →
  `"darkness"`, `bandOf(1)` → `"dim"` (boundaries unchanged above zero);
  `clampLight(-30)` → `-20`.
- **Data validator:** `npm run validate` must exit 0 after the `warren.throat` edit
  (it does not constrain `ambientLight`, so this confirms no regression).
- **Manual / preview:** enter `warren.throat` with no light → meter reads
  `void (-1) ⚠ blind`, pane shows the breathing-vignette + shiver, creeping-dark
  damage ticks. Equip a torch → value rises to `dim`, treatment clears, damage stops.
  Verify `prefers-reduced-motion` shows the static heavy vignette.
- **Multiplayer:** light-level broadcast already covers band changes; a second
  player in the room should see the same band transitions when light sources change.

## Files touched

| File | Change |
|------|--------|
| `server/light.js` | `LIGHT_MIN = -20`; add `void` band in `bandOf`. |
| `client/app.js` | Meter shows `⚠ blind` when band is `void`. |
| `client/styles.css` | `.light-void` block: breathing vignette + faint shiver + reduced-motion fallback. |
| `data/world/rooms.json` | `warren.throat` `ambientLight: 0 → -1`. |
| `docs/data-model.md` | Note that `ambientLight` may be negative and what the `void` band means. |
| `CHANGELOG.md` | `[Unreleased]` entry. |

## Future polish (out of scope)

- One-time entry line when stepping into a sub-zero room without enough light
  (distinct from the per-tick creeping-dark message).
- Scale vignette intensity / breathing speed with how negative the value is, so the
  player feels the gradient (`-1` vs `-12`). The PoC demonstrated this; deferred to
  keep the first cut simple.
- Validator guardrail: warn on a negative-ambient room with no nearby light source
  or no reachable lit path.
- A deep-abyss room cluster authored around larger negatives once the band proves out.
