# Lumen — Design Document

*A browser-based MUD of descent, light, and survival.*

> Status: **draft (v0.1.0)** — living document, refined collaboratively before implementation.

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

### 3.1 Light

- **Scalar per room.** Each room has a single effective light value on the band:
  `darkness → dim → bright → searing`
- **Effective light each tick** = base ambient (set by depth/room) + sum of active light sources currently in the room, clamped to the band.
- **Per-actor perception bands.** Every actor (player *and* NPC/mob) has:
  - a **comfortable band** (where it sees and acts normally),
  - a **"blind below"** threshold (too dark → cannot see), and
  - a **"harmed above"** threshold (too bright/searing → blinded and/or damaged).
  - Example: humans need dim+ to see, fine in bright, harmed in searing. Deep-dwellers see in darkness but are blinded/harmed in bright.
- **Bidirectional visibility.** Light reveals the world to you *and* reveals you to others. Carrying light in the dark advertises your position to creatures that see in darkness.
- **Light as a weapon.** Flooding a room toward bright/searing can blind or harm darkness-adapted creatures — a reason to seek strong light, not just any light.
- **Player-carried light is a fuel/duration resource.** Torches/lanterns burn down per tick. Rationing fuel is core survival pressure.
- **Darkness denies everything:** room/object/enemy descriptions, and imposes mechanical penalties (accuracy, fumbling → effective slowdown). Applies to NPCs equally — darkness is a *mutual* condition you can exploit.

### 3.2 Attributes & Combat Stats

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

### 3.3 Resources

- **HP** — health; death at 0 (see §3.5).
- **Mana** — magical fuel; spent to cast spells. Max scales with Intellect.
- **Energy (action points)** — NetHack-style speed/initiative economy (see below). **Not** a stamina pool.

### 3.4 Combat & Time (Energy/Speed model)

- The world runs on a fixed real-time **tick (~1 second)**.
- Each actor has a **speed** (normal ≈ 12). **Every tick, the actor accrues action points equal to its speed.**
- When an actor has banked enough points to **afford an action**, it acts; the action **deducts its cost**. Cheap actions (dagger jab, step) cost little; heavy ones (maul swing, long incantation) cost a lot → "some weapons/spells take longer."
- **Faster actors act more often.** Haste raises speed; heavy armour, darkness-fumbling, and slow debuffs raise action cost or lower speed.
- No resting/refilling by pausing — it's a continuous initiative economy. The player manages *which* actions to commit to and *when*.
- **UI:** the "Energy" indicator reads as readiness/tempo — progress to next action + current effective speed (shows slowed/hasted).

### 3.5 Death (staged)

- **v1:** respawn at the top, **no penalty** beyond **lost progress** (the time/distance of the failed delve). Keep gear.
- **Later:** equipment loss / corpse-run mechanics. Death is implemented as a **clean, parameterized event** so harsher rules bolt on without restructuring.

### 3.6 Progression

- **XP → character power** (levels/attributes).
- **Gear → equipment power** (crafted + looted).
- Two independent axes, both gating "delve deeper."

### 3.7 Crafting (station-based)

- Crafting requires **room fixtures** (stations), not crafting-anywhere.
- `use <components> on <fixture>` → product, per recipe. E.g. components on an alchemist bench → potion.
- Stations mostly live at the **settlement up top** (reinforces descend-and-return); rare deep stations can be a risky shortcut.
- Gives rooms *functional* meaning beyond geography.

### 3.8 Quests

- Optional direction layer in an open sandbox: **fetch X, kill Y, deliver Z**.
- Data-driven content system, grown over time.

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

**Effective room light per tick** = base ambient (by depth/room) + Σ(active source contributions in room), clamped to band. This value touches visibility, combat, stealth, and harm for every actor — it must stay trivial to compute.

---

## 7. Open / Deferred

- Procedural room generation (post-authored-world).
- Harsher death (equipment loss / corpse runs).
- Exact numeric tuning: band thresholds, speed/action costs, attribute→derived-stat formulas, fuel burn rates.
- Carry capacity (Might), ranged combat, detailed spell list.
- Auth & internet deployment.
- Whether deep crafting stations exist and how rare.

---

*End of draft v0.1.*
