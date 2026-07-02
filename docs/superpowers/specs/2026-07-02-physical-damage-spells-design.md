# Physical-damage spells — a shared mitigation seam

**Date:** 2026-07-02
**Status:** Design approved, pending implementation plan

## Problem

Spell damage and melee damage are resolved by two completely separate code
paths, and only melee understands damage *types*:

- **Melee** (`strike()` in `server/combat-math.js`) already splits on
  `damageType`: a `physical` blow is soaked flat by the defender's **Armour**;
  a `magical` blow is cut by **Ward** as a percentage. This math is inlined in
  `strike()`.
- **Spell casts** (`castSpell`, `detonateRoom` in `server/state.js`) never
  consult Armour and never split on type. A hostile spell rolls the target's
  Ward *once* as an all-or-nothing negation (`wardNegates` — "does the cast
  fizzle entirely"); if it doesn't fizzle, the full rolled damage lands.

So `damageType: "physical"` on a spell today is an inert label — it renders in
narration but changes nothing mechanically. We want a spell to be able to deal
genuine physical damage (a hurled rock, shrapnel-hot iron): mitigated by Armour,
unaffected by Ward. We also want the door open to more damage types later
(light, fire) for **both** spells and weapons, without a rewrite each time.

## Design decisions (settled)

1. **Physical spells always land, Armour-soaked.** A physical-type spell skips
   the Ward fizzle-roll entirely (Ward never stops it) and has its rolled damage
   reduced by the target's Armour (floor 1). No accuracy/evasion roll is added
   to the spell path — spells still don't "miss."
2. **Unknown/future types default to the magical rule.** Anything whose
   `damageType` isn't `"physical"` keeps today's behavior (Ward percent cut for
   weapons; Ward wholesale-fizzle for spell casts). A future `"fire"`/`"light"`
   string is accepted as a label and behaves like magical until it earns its own
   mitigation rule. **No enum registry, no `validate-data.js` change.**
3. **One shared mitigation function.** Extract the physical-soak / magical-cut
   arithmetic out of `strike()` into a helper both melee and the spell paths
   call. This is the single seam where a new damage type's rule is added later.
4. **Melee gains type extensibility for free.** Because `strike()` routes
   through the same seam, a weapon can carry any `damageType` (e.g. a future
   "sword of light"). It works immediately, behaving like magical until "light"
   gets its own stat + branch — a small, well-scoped follow-up, **not** part of
   this change.
5. **Scope: the seam + physical only.** No concrete third type (light/fire with
   its own resist stat) is built now. YAGNI — added when real content needs it.

## Architecture

### The shared helper (`server/combat-math.js`)

Extract the damage-reduction branch currently inlined at the end of `strike()`:

```js
// How much of a landed blow survives the defender's mitigation, by damage type.
// `physical` is soaked flat by Armour; every other type (magical, and any future
// label until it earns its own rule) is cut by Ward as a PERCENT (ward 50 → halved).
// This is the reduction step ONLY — whether the blow lands at all is decided by the
// caller (melee accuracy roll; spell-cast Ward fizzle). Floor of 1 so any landed
// blow stings.
function mitigate(base, damageType, defence) {
  return damageType === "physical"
    ? Math.max(1, base - (defence.armour || 0))
    : Math.max(1, Math.round(base * (1 - (defence.ward || 0) / 100)));
}
```

`strike()` replaces its inline ternary with `const damage = mitigate(base, damageType, defender);`
— behavior is byte-identical for today's physical and magical weapons.

### Two orthogonal gates, kept separate

Every hit answers two questions; `mitigate()` is only the second:

| Question | Melee (`strike`) | Spell cast (`castSpell`/`detonateRoom`) |
|----------|------------------|------------------------------------------|
| Does it land? | accuracy vs. evasion + light band | Ward fizzle roll (`wardNegates`) |
| How much survives? | `mitigate()` | `mitigate()` **for physical only** |

### Spell-path changes (`server/state.js`)

**`castSpell`** (single-target). The pre-damage fizzle gate becomes conditional:

```js
const ward = mobDefence(w.mobs[mob.template], mob).ward || 0;
if (spell.hostile && (eff.damageType !== "physical") && wardNegates(ward)) {
  this._addThreat(mob, player.id, 1);
  return { resisted: true };
}
```

This is correct for every existing spell: Sleep, Witchfire (DoT), Bolt, Spark
etc. are all non-physical, so they keep the fizzle. Only a physical damage spell
skips it. Then in the `eff.type === "damage"` branch, soak physical damage:

```js
let damage = Math.max(1, rollDice(eff.damage) + spellScaleBonus(effectiveAttributes(w, player), eff.scale));
if (eff.damageType === "physical")
  damage = mitigate(damage, "physical", mobDefence(w.mobs[mob.template], mob));
```

**Non-physical damage spells are applied at full damage exactly as today** — the
fizzle roll was already their defense. They must NOT also be run through
`mitigate` (that would apply a Ward percent cut *on top of* the fizzle and
silently nerf every existing spell — Spark, Bolt, Arc Flash, Flame Burst…).

**`detonateRoom`** (room spells + thrown bombs — serves Arc Flash, Glimmer
Storm, Flame Burst, and consumable bombs). Same two edits:

```js
// landing gate — physical bursts skip the per-target Ward negation
if (wardCheck && (spec.damageType !== "physical") && wardNegates(mobDefence(t, mob).ward || 0)) { ... resisted ... }

// damage — physical bursts soak Armour
if (spec.damage != null) {
  damage = Math.max(1, rollDice(spec.damage) + bonus);
  if (spec.damageType === "physical") damage = mitigate(damage, "physical", mobDefence(t, mob));
  ...
}
```

### Backward-compatibility (by construction)

Only content that **opts in** with `damageType: "physical"` changes behavior.
Existing spells and thrown bombs that omit `damageType`, or set anything else,
are treated as non-physical → full damage / existing fizzle → **untouched**.
Thrown bombs today generally omit `damageType`, so they are unaffected unless
deliberately marked physical later.

## Content: Iron Blast

The concrete physical spell that both ships as real content and serves as the
live test vehicle for the seam (replacing any throwaway test flag).

### Spell (`data/world/spells.json`)

```json
"iron-blast": {
  "id": "iron-blast",
  "name": "Iron Blast",
  "description": "<flavour: a smelted iron bar dragged up and burst apart into a hail of shrapnel-hot iron that tears every foe sharing the dark; heavy, physical, and stopped by armour rather than ward>",
  "manaCost": 16,
  "itemCost": [{ "template": "iron-bar", "qty": 1 }],
  "hostile": true,
  "target": "room",
  "effect": {
    "type": "damage-room",
    "damageType": "physical",
    "damage": "4d8",
    "cause": "iron-blast",
    "scale": { "attr": "intellect", "per": 3 }
  }
}
```

- **Pure heavy burst, no DoT** — the clean contrast to Flame Burst (burst + burn
  + light). Keeps us out of out-of-scope physical-DoT territory.
- Base damage is set higher than Flame Burst's `3d6` because Iron Blast is soaked
  by Armour (Flame Burst only faces the fizzle gate) and has no follow-up burn.
  `4d8 + intellect/3` is the starting point; **tune during live testing.**
- Still an Intellect-scaled mana spell like every spell — only its damage *type*
  is physical.

### Scroll (`data/world/items.json`)

`scroll-iron-blast` — `type: "scroll"`, `scroll: { spell: "iron-blast" }`,
`stackable`, `value ~100` (advanced, in line with Glimmer Spike/Storm scrolls).
Flavour: an iron-grey vellum, glyphs stamped like cold rivet-heads.

### Vendor (`data/world/mobs.json`)

Added to **Vesper the glimmer-mage** (`rim-mage`) `shop.sells`, alongside the
other combat scrolls (consistent with Flame Burst and Cleanse).

### Narration (`server/commands/magic.js`)

`castBurst` already branches fire vs. non-fire (from Flame Burst). Add a physical
branch so Iron Blast reads as iron shrapnel / a hail of hot iron rather than
falling through to the default "white light" wording. The `spells` listing tail
for `damage-room` already prints `damageType`, so it will show "physical"
correctly with no change.

## Documentation (`docs/data-model.md`)

Extend the existing `damage-room` / damage-type notes to document:

- `damageType` on a `damage`/`damage-room` effect selects a mitigation rule:
  `physical` → soaked by Armour and **immune to the Ward fizzle** (always lands);
  anything else → the magical rule (spell casts: Ward wholesale-fizzle; weapons:
  Ward percent cut).
- Only `physical` is a concrete non-default rule today; other strings are
  accepted as labels and behave like magical until given their own rule.

## Out of scope (deliberate)

- **Physical damage-over-time** (a physical bleed) — a different mechanism
  (`_tickEffects`), not needed for anything requested yet.
- **A concrete third type** (light/fire with its own resist stat) — the seam
  makes this a small later addition; not built now.
- **Accuracy/evasion on spells** — spells still never "miss"; physical spells
  land and are soaked, they don't roll to-hit.
- **`validate-data.js` enum for `damageType`** — new type strings stay valid
  labels by design.

## Testing plan (live, in-browser)

1. **Physical soak + no fizzle.** `@give` the Iron Blast scroll and iron bars,
   study it, spawn `camp-warder`s (and ideally a higher-Armour mob). Cast and
   confirm: damage reduced by exactly the target's Armour (floor 1), and it
   **never** fizzles regardless of the target's Ward.
2. **Reagent gate.** Confirm one iron bar is consumed per cast and the cost
   shortfall guard refuses the cast (mana kept, bar kept) with none in the pack.
3. **Regression — magical unchanged.** Cast a magical spell (Bolt / Arc Flash)
   at the same armoured mob: confirm it still ignores Armour and still
   fizzle-or-full on Ward (behavior identical to before this change).
4. **Melee unchanged.** Confirm a normal physical and a magical weapon still
   deal the same damage they did before the `strike()` refactor (spot-check).
5. `npm run validate` exits 0; `CHANGELOG.md` updated under `[Unreleased]`.
