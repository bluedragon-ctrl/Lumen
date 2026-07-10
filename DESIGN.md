# Lumen — Design Document

*A browser-based MUD of descent, light, and survival.*

> Status: **living design record.** This document holds design *intent* — the why
> behind each system and what is still open. The how-it-actually-works reference is
> [server/README.md](server/README.md); mechanics are documented there once, not here.
> Section markers: ✅ shipped · 🔶 partial · ⏳ not started.

> **World & lore:** the canon setting (the Abyss, glimmer, the Glimmer Rush, the
> Rim, the Umbrals, the threat ladder) lives in [docs/lore.md](docs/lore.md). This
> document covers *systems and mechanics*; that one covers *fiction*. Keep content
> consistent with it.

---

## 1. Pillars

1. **The Abyss & the descent.** Players begin at a human settlement at the top of a vast, deep, abyss-like structure and delve downward into the dark, meeting the inhabitants and monsters of the depths. The deeper you go, the more dangerous — and the harder it is to get back.
2. **Light is a resource.** Light is the signature system. It governs what can be seen, what can see *you*, and what gets hurt. The descent is a constant negotiation with darkness.
3. **Survival-exploration loop.** Explore, fight, and craft, with light RP. Open-ended sandbox — no win condition — directed by an optional quest layer.

**Tone:** oppressive, atmospheric, abyssal. Text-focused but allowed to use modern UI affordances.

---

## 2. Core Loop

> **Descend** into darkness → **discover** rooms, resources, threats → **fight or avoid** what guards them → **haul loot back up** → **craft** better light, gear, and tools → **descend deeper** than before.

The **fuel clock** (your light burning down) is the heartbeat: how deep can you go and still return before your light dies? This push-your-luck rhythm drives the whole experience.

---

## 3. Systems

### 3.1 Light ✅

- **Scalar per room.** Each room has a single effective light value on the band:
  `void → darkness → dim → bright → searing`
  (`void` is sub-zero deep dark — the mirror of searing, where even darkness-adapted
  sight fails; added with the deep-dark design, see `docs/superpowers/specs/`).
- **Effective light each tick** = base ambient (set by depth/room) + sum of active
  light sources currently in the room **+ the Tide's darkening offset** (§3.9),
  clamped to the band.
- **Per-actor perception bands.** Every actor (player *and* NPC/mob) has:
  - a **comfortable band** (where it sees and acts normally),
  - a **"blind below"** threshold (too dark → cannot see), and
  - a **"harmed above"** threshold (too bright/searing → blinded and/or damaged).
  - Example: humans need dim+ to see, fine in bright, harmed in searing. Deep-dwellers see in darkness but are blinded/harmed in bright.
- **Bidirectional visibility.** Light reveals the world to you *and* reveals you to others. Carrying light in the dark advertises your position to creatures that see in darkness.
- **Light as a weapon.** Flooding a room toward bright/searing can blind or harm darkness-adapted creatures — a reason to seek strong light, not just any light.
- **Player-carried light is a fuel/duration resource.** Torches/lanterns burn down per tick. Rationing fuel is core survival pressure.
- **Darkness denies everything:** room/object/enemy descriptions, and imposes mechanical penalties (accuracy, fumbling → effective slowdown). Applies to NPCs equally — darkness is a *mutual* condition you can exploit.

### 3.2 Attributes & Combat Stats ✅

**Primary attributes** (character-owned, grow via XP/level):

| Attribute | Governs |
|---|---|
| **Might** | Physical attack power (later: carry capacity) |
| **Vitality** | Max HP + innate physical resistance |
| **Intellect** | Magic attack power + max Mana |
| **Wits** | Innate magic resistance + action speed/initiative |
| **Perception** | Low-light sight, detection, accuracy/crit — the signature exploration stat |

**Gear-derived mitigations** (from equipment/enchant, *not* attributes):

| Stat | Reduces | Source |
|---|---|---|
| **Armour** | Physical damage | Worn gear |
| **Ward** | Magic damage | Enchanted gear / charms |

**The 2×2 symmetry:**

```
                 OFFENSE        DEFENSE (innate)   DEFENSE (gear)
   Physical      Might          Vitality           Armour
   Magical       Intellect      Wits               Ward
```

### 3.3 Resources ✅

- **HP** — health; death at 0 (see §3.5).
- **Mana** — magical fuel; spent to cast spells. Max scales with Intellect.
- **Energy (action points)** — NetHack-style speed/initiative economy (see below). **Not** a stamina pool.

### 3.4 Combat & Time (Energy/Speed model) ✅

- The world runs on a fixed real-time **tick (~1 second)**.
- Each actor has a **speed** (normal ≈ 12). **Every tick, the actor accrues action points equal to its speed.**
- When an actor has banked enough points to **afford an action**, it acts; the action **deducts its cost**. Cheap actions (dagger jab, step) cost little; heavy ones (maul swing, long incantation) cost a lot → "some weapons/spells take longer."
- **Faster actors act more often.** Haste raises speed; heavy armour, darkness-fumbling, and slow debuffs raise action cost or lower speed.
- No resting/refilling by pausing — it's a continuous initiative economy. The player manages *which* actions to commit to and *when*.
- **UI:** the "Energy" indicator reads as readiness/tempo — progress to next action + current effective speed (shows slowed/hasted).

### 3.5 Death (staged) ✅ *(v1 rules live)*

- **v1:** respawn at the top, **no penalty** beyond **lost progress** (the time/distance of the failed delve). Keep gear. (Shipped with a short "fall and lie dying" beat before waking at the rim, so the death registers.)
- **Later:** equipment loss / corpse-run mechanics. Death is implemented as a **clean, parameterized event** so harsher rules bolt on without restructuring.

### 3.6 Progression ✅

- **XP → character power** (levels/attributes).
- **Gear → equipment power** (crafted + looted).
- Two independent axes, both gating "delve deeper."

### 3.7 Crafting (station-based) ✅

- Crafting requires **room fixtures** (stations), not crafting-anywhere.
- `craft <recipe>` at a fixture whose station matches → product, consuming the recipe's inputs and any shard cost. Recipes must be **known** (`knownRecipes`); `recipes` lists them. E.g. at an alchemist's bench: gland + vial + shards → light potion.
- Stations mostly live at the **settlement up top** (reinforces descend-and-return); rare deep stations can be a risky shortcut.
- Gives rooms *functional* meaning beyond geography.

### 3.8 Quests ✅

- Optional direction layer in an open sandbox: **fetch X, kill Y, deliver Z**.
- Data-driven content system (`data/world/quests.json`), grown over time —
  DikuMUD-inspired ordered steps (kill / collect / deliver / use / enter / talk).

### 3.9 The Tide (world clock) ✅

- **The abyss breathes.** On a fixed cycle (`calm → stirring → tide → receding`)
  the dark floods in: every room's light drops by a **depth-scaled** offset — the
  rim barely dips, the deep plunges — then ebbs back to calm.
- **Why:** a shared, world-scale rhythm on top of the personal fuel clock. The
  Tide turns "how deep dare I go?" into "how deep dare I go *right now*?" —
  telegraphed (lamps gutter at *stirring*), survivable in prepared light, lethal
  in the unprepared dark (predators spawn beside delvers standing in failed light).
- Fully data-driven (`data/world/tide.json`): phases, darkening curve, lamp
  behaviour, world messages, predator roster. Predator content roster and safe-camp
  design are still open (§7).

### 3.10 Magic & Spells ✅

- **Spells are data** (`data/world/spells.json`) riding the same status-effect and
  light primitives as everything else — a spell is a mana cost plus effects, not code.
- **Learning loop:** find a scroll → learn it → `cast` it. Casting costs Mana
  (Intellect-scaled); **Ward** gives resist chance against hostile magic.
- Light-touching spells are first-class (a darkness aura, snuffing a target's
  torch) — magic bends the signature system, it doesn't sit beside it.

### 3.11 Shards & Economy ✅

- **Shards are the currency, the crafting fuel, and the abyss's reason-for-being**
  (the Glimmer Rush — see `docs/lore.md`). Mobs drop them as floor piles anyone
  can gather; recipes and some spells spend them directly.
- **Trading is value-driven, not scripted:** any mob with a `shop` block trades;
  prices derive from item `value` (sell = `sellValue`, default 20% of `value`).
  One economy knob per item, no per-trader price lists.

### 3.12 Recovery & Posture ✅

- **HP does not regenerate while standing** — resting is the healing mechanic,
  and it trades safety for time: `sit` mends slowly; `sleep` mends fast **but
  blinds you** (perception 0, room view withheld) — the light game inverted:
  to recover you must surrender the very sense the game is about.
- Mobs share the posture field for encounter design (dozing guardians that rouse
  when struck).

### 3.13 Perception in Play: Search & Detection ✅

- **Hidden features** (items, mobs, exits, fixtures) gate on Perception;
  `search` effectiveness scales with **light** — you cannot search what you
  cannot see. Found exits stay found; stashed items must be re-found.
- **Detection-based aggro:** mobs *notice* enemies at a light-gated rate before
  committing to attack — and in light below their sight threshold, not at all.
  Darkness is stealth: an unlit delver can slip past what would kill them.
  (Spec: `docs/superpowers/specs/2026-06-04-aggro-detection-design.md`.)

### 3.14 Factions ✅

- Instance-level allegiance (`player`, `rim`, `fauna`, `wild`, `umbral`) with a
  symmetric ally/enemy/neutral table — one combat path resolves player↔mob *and*
  mob↔mob, so rim guards defend the town and allies assist. Groundwork for summons.

---

## 4. World Model

- **Living world.** The abyss ticks in real time regardless of who is watching — mobs wander, torches burn, effects expire.
- **Single shared persistent world.** All players inhabit the same abyss instance; they can meet, cooperate, and interfere. No PvP. Fully **solo-friendly**. Light RP supported (`say`/`emote`, good room presence) but not the focus.
- **Scale:** hundreds of rooms, **authored** (static) to start; **procedural expansions** possible later — generated rooms must slot into the *same* room data structure.

---

## 5. Interface

### 5.1 Layout

```
┌──────────────────────────────────────────────┬─────────────────────┐
│  CONSOLE  (scrolling event/history log)        │  PLAYER PANEL       │
│                                                │   Name/Level/XP     │
│  > look                                        │   Attributes        │
│  You light your torch. The dark recedes.       │   HP / Energy / Mana│
│  A lightbug drifts in from the east.           │   State chips       │
│                                                │   Equipment         │
│                                                │   Inventory         │
├────────────────────────────────────────────────┤                     │
│  INSPECT / VIEW  (current room — live, tinted) │                     │
│  "The Sunken Stair."  Light: dim ◐             │                     │
│  Exits: down, east                             │                     │
│  Here: a lightbug ·  a mossy chest ·  altar    │                     │
├────────────────────────────────────────────────┼─────────────────────┤
│  HP ███████░░ 12/18   Energy ████░░   Mana ██  │  (status strip)     │
├────────────────────────────────────────────────┴─────────────────────┤
│  > cast _                                              [command line] │
└──────────────────────────────────────────────────────────────────────┘
```

### 5.2 Input

- **Typed commands** are the source of truth.
- **TAB completion** cycles available commands/targets (e.g. `cast` + TAB).
- **Up/Down arrows** scroll command history.
- **Light mouse interaction** as sugar (see clickable entities below). No map planned.

### 5.3 Console (top-left)

- **Append-only history/transcript.** Never re-rendered.
- **Light encoded per-line at write-time** (locked forever, since it's historically accurate): entering darkness writes muted/greyed lines; new lines reflect current conditions. The console stays readable — never globally tinted.

### 5.4 Inspect / View (bottom-left)

- **Live view of the current room**, replaced each tick: description, light level + meter (`◐ dim`), exits, and contents (actors, objects, fixtures).
- **Strong atmospheric light tint** (safe because it always represents *now*):
  - **darkness:** near-black; contents hidden **except** self-illuminating things (lightbug, glowing rune). Shows an informative placeholder, e.g. *"It is too dark to see — a light source would help."*
  - **dim:** desaturated, low-contrast grey, muted text.
  - **bright:** full colour, crisp.
  - **searing:** harsh white-out / bloom, subtle glare; text washed to convey discomfort.
- **Biome tint:** a room may carry a purely cosmetic `biome` (umbral, gloaming,
  water, rim…) that colours the Inspect window *under* the light-band treatment —
  place identity without gameplay effect; darkness and searing still win.
- **Clickable entities:** clicking an actor/object/fixture injects the equivalent typed command (`look lightbug`, later `attack`/`get` via context menu). Mouse path == command path; one source of truth.

### 5.5 Player Panel (right)

- Always visible: **Name / Level / XP**, **Attributes**, **HP / Energy / Mana**, **state/effect chips** (poisoned, blinded, hasted, light-harmed…), **Equipment**, **Inventory**.
- Chips double as teaching tools and live feedback.

### 5.6 Event routing

- Most events → **console**.
- State changes (HP/Mana/Energy, effects gained/lost) → mirrored in the **player panel** and/or **inspect window** where relevant.

### 5.7 Aesthetic

- Text-focused, but modern features welcome: bars, frames, entity/enemy chips, text formatting.

---

## 6. Architecture & Data (implied)

> Lean by design: small player count, no SQL — JSON on disk, authoritative in-memory world.

### 6.1 Server

- **Stateful WebSocket server** (**Node.js** — confirmed; shares a language with the browser client) pushing text/structured updates to a thin browser client.
- **Authoritative in-memory world**; server owns all state and the tick loop.
- **Fixed tick loop (~1s):** accrue action points, resolve ready actions, burn light/fuel, expire effects, move wandering mobs, recompute room light.
- **Periodic JSON snapshots** to disk for persistence; load on boot.
- Internet extension later is primarily a **deployment + auth** concern, not a rewrite.

### 6.2 The critical data split

Keep these strictly separate (most common cause of painful rewrites if mixed):

- **Static world data** — hand-authored, rarely changes: room definitions, item templates, mob templates, recipes, quest definitions. Treated as read-only content.
- **Dynamic state** — changes constantly: player characters, inventories, current HP/Mana/Energy, who/what is in which room, active effects, fuel remaining, mob instances.

### 6.3 Core calculation to keep dead-simple

**Effective room light per tick** = base ambient (by depth/room) + Σ(active source contributions in room) + the Tide's phase offset (§3.9), clamped to band. This value touches visibility, combat, stealth, and harm for every actor — it must stay trivial to compute.

---

## 7. Open / Deferred

> Written designs for several of these live in `docs/superpowers/specs/` — check
> there before re-deriving one.

- Procedural room generation (post-authored-world).
- Harsher death (equipment loss / corpse runs).
- Numeric tuning is ongoing: band thresholds, speed/action costs, fuel burn rates.
- Carry capacity (Might), ranged combat.
- Cross-room mob pursuit; threat decay beyond the current grace window.
- Tide predator roster & safe-camp content (engine shipped, §3.9).
- Summons riding the faction groundwork (§3.14); `onSpell`/`onDeath` combat triggers.
- Auth & internet deployment.
- Whether deep crafting stations exist and how rare.

---

*Living document — update the section markers as systems land.*
