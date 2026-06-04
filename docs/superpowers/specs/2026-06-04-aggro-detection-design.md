# Lumen — Aggro detection & threat-ramp design

Status: approved design, pending implementation plan.
Builds on: combatant-agnostic threat table + instance factions (Phase 1), posture
& resting mobs (sit/sleep), the light/perception model (`server/light.js`).

## Context

Today a hostile mob is a blunt switch: `t.hostile === true` → it attacks anyone in
its room, immediately, regardless of whether it can *see* them. The "threat" table
(`m.aggro`) exists but only sorts *which* present enemy to swing at — it never gates
*whether* to engage. Concretely, in `_mobAct`:

- `if (t.hostile) for (const c of enemies) this._addThreat(m, c.id, 0)` seeds a
  0-threat entry for everyone present, every tick.
- `aggressive = t.hostile || inCombat || lightProvoked || ally`, and attack is an
  option whenever `aggressive && t.attack && enemies.length > 0`.
- Targeting (`_topThreat`) returns an enemy even at threat 0, and `_mobAttack`
  falls back to a random present enemy anyway.

So: no visibility gate, no ramp, and — because `inCombat` counts any seeded key —
**a hostile mob never wanders while a player shares its room, even one it hasn't
"noticed."**

This phase turns threat into a real **detection meter**. An AI combatant accrues
threat only on enemies it can **perceive** (gated by its own sight in the room's
current light, and by posture), and engages only once that threat crosses a
threshold. The threshold gives a natural ramp; the perception gate makes darkness
and impairment matter; decay-on-loss-of-perception is the hook future hide/invis
skills hang off.

The model is squarely in the DikuMUD tradition — Circle/Diku's `AGGRESSIVE` is
defined as *"hit all players in the room **it can see**"* (visibility-gated aggro
is the genre default). What we add beyond vanilla Diku is the **ramp** (Diku
attacks instantly on its mob pulse) and a single **engage tell** using Diku's
`act()` two-audience message pattern.

### Decisions captured (from brainstorming)

- **Threat is the gate, not `hostile`.** An AI combatant attacks an enemy only once
  its threat on that enemy reaches `ENGAGE`. The `hostile` flag (and the
  player-faction ally relationship) instead decides *who proactively hunts* — i.e.
  who accrues detection threat at all.
- **Detection is perception-gated, per the light tiers.** Reuse the curve from
  `hitChance` but with a **hard 0 below `blindBelow`** (vanilla `hitChance` floors
  at 0.05 for in-combat flailing; detection must be a true 0 — you are not noticed
  at all in the dark):

  | Mob's sight of the room | noticeChance / action |
  |---|---|
  | `light < blindBelow` (blind) | **0** — undetected; can be passed |
  | impaired — dim tier, **or** glare above `harmedAbove` | **0.5** — builds slowly |
  | clear | **1.0** — noticed fast |

- **Sleeping perceives nothing; sitting is alert-at-rest (decision A).** Gate
  detection through `canPerceive(mob, light)`, which already returns `false` for a
  sleeping actor — so "blind from darkness" and "blind from sleep" collapse into
  one gate, no special case. A **sleeping** mob never accrues threat (you can
  tiptoe past it). A **sitting** mob *does* run detection (its sight band is real),
  and **stands as it engages**. Consequence to honor in content: anything meant to
  be safely passable must be authored *sleeping*, not sitting.
- **Ramp via accrual.** On each action, for every perceivable enemy:
  `threat += noticeChance × RATE`. Deterministic, so impaired sight literally takes
  longer to commit. (An equivalent probabilistic "notice roll" was considered;
  accrual chosen for predictability and tunability.)
- **Detection cadence rides mob energy/action speed.** Accrual happens inside
  `_mobAct` (already energy-gated), so a slower mob notices more slowly — accepted
  as thematically correct.
- **Being hit bypasses the ramp.** A struck combatant still gains `max(1, dmg)`
  threat directly, which crosses `ENGAGE` at once — striking a mob always provokes
  it, in any light. Preserves today's "if the player already hit it, there's
  threat."
- **Decay on loss of perception.** If a combatant *cannot perceive* a target it
  holds threat on (target unlit below `blindBelow`, or the holder put to sleep) for
  `GRACE` consecutive actions, that threat decays by `RATE`/action to 0; at 0 the
  entry is removed (the mob forgets and may wander again). Impaired (0.5) still
  *perceives* — it builds slower but never decays; only a true 0 triggers decay.
- **Unified across factions.** Wild mobs **and** player-faction summons use the
  same perception-gated accrual. This replaces both the standalone `t.hostile`
  attack trigger and the `self.faction === "player" && enemies` immediate-ally
  clause. A combatant **proactively hunts** (accrues detection threat) iff
  `t.hostile || self.faction === "player"`. Wild-vs-wild never engages (same
  faction → not enemies) — unchanged. Summons get onto a wild mob's table the same
  way a player does.
- **One engage tell.** When an enemy's threat first crosses `ENGAGE`, emit a single
  light-gated message (Diku `act()` two-audience): one line to the victim, one to
  the room. No softer "first-notice" tell while still building — that would leak
  stealth state and read as noise.

### Scope note — the data lever

The mechanic is inert against the **current** mob data, which gives every hostile
`blindBelow: 0` (perfect dark-vision) — they will simply ramp over a couple of
actions instead of swinging instantly, but can't be sneaked past. That is fine: the
**dark-blind mobs that make stealth real don't exist in the world yet and will be
authored later** (with `blindBelow >= 1`). v1 ships the *mechanic*; per-mob vision
tuning lands with those mobs. Existing low-`harmedAbove` mobs (e.g. deep-dweller,
gloom-crawler at `harmedAbove: 2`) already get the glare-impaired slow-ramp for
free in bright rooms.

### Out of scope (v1)

- **Lurker / ambush** behavior (delayed commit + first-strike bonus) — deliberately
  deferred; this phase is the substrate it will build on.
- **Player stealth** (a sneak posture / stealth attribute that lowers how well a mob
  perceives the *player*). The decay hook is laid for it, but no player-side stealth
  ships here. Posture hides the *perceiver*, not the perceived — a sleeping/sitting
  *player* is exactly as visible to a mob as a standing one.
- **Cross-room memory / pursuit** (Diku `MEMORY`): leaving a room still fully prunes
  you from a mob's table (`_pruneAggro`), so stepping out and back resets detection.
  In-room decay only matters while you stay put. A persistent-memory / hunting mob
  is a separate future feature.
- **Pack alerting** (Diku `HELPER`): one mob noticing you does not alert its
  neighbours. Each mob detects independently.

### Future Diku hooks (logged, not built)

- **`MEMORY`** — mob remembers attackers, re-aggros on sight across rooms. The
  persistent counterpart to in-room decay; the cross-room pursuit feature.
- **`WIMPY` + `AGGRESSIVE`** — attack only the helpless (sleeping/incapacitated).
  A ready-made *ambush-on-the-helpless* primitive for the lurker work.
- **`HELPER`** — assist any ally already fighting in the room (pack aggro).

### Open balance values (owner to set before/at implementation)

| Value | Symbol | Starting guess | Note |
|---|---|---|---|
| Threat per action at clear sight | `RATE` | 1 | accrual unit |
| Engage threshold | `ENGAGE` | 2 | ticks-to-commit at clear sight ≈ `ENGAGE/RATE` |
| Impaired multiplier | — | 0.5 | dim/glare; halves accrual → ~2× slower |
| Decay grace (actions unperceived before fade) | `GRACE` | 3 | |
| Decay rate per action | — | `RATE` (1) | symmetric fade to 0 |

With the guesses: clear sight commits in ~2 actions, impaired in ~4, dark never;
losing a target takes ~`GRACE` + `ENGAGE/RATE` actions to fully forget.

---

## Architecture (`server/state.js` + `server/light.js`)

### New: `noticeChance(perception, light)` (`light.js`)

A sibling of `hitChance`, identical tiers **except** it returns a hard `0` below
`blindBelow` (no flailing floor):

```js
function noticeChance(perception, light) {
  const blindBelow = perception ? perception.blindBelow : 1;
  const dimBelow = perception && perception.dimBelow != null ? perception.dimBelow : blindBelow;
  if (light < blindBelow) return 0;                 // unseen — true zero
  if (isHarmedByLight(perception, light)) return 0.5; // glare
  if (light < dimBelow) return 0.5;                 // dim
  return 1.0;                                        // clear
}
```

Exported and unit-coverable in isolation.

### Detection in `_mobAct` (replaces the 0-threat seeding block)

Delete `if (t.hostile) for (const c of enemies) this._addThreat(m, c.id, 0)`.
Replace with a detection + decay pass:

```
hunts = t.hostile || self.faction === "player"   // proactive detector?
for each enemy c in enemies:
    if hunts AND c is perceivable by m:           // canPerceive(m, light) && noticeChance>0
        gain = noticeChance(m.perception, light) * RATE
        wasBelow = (threatOn(c) < ENGAGE)
        _addThreat(m, c.id, gain)
        if wasBelow AND threatOn(c) >= ENGAGE:     // first crossing
            engageTell(m, c)                       // stand-if-sitting + act() message
for each existing threat key k on m:
    if target k still present but NOT perceivable for >= GRACE actions:
        decay threat by RATE; remove entry at <= 0
    if target k absent: (pruned by _pruneAggro as today)
```

Notes:

- "Perceivable by `m`" = `canPerceive(m, rt.light)` **and** `noticeChance > 0`.
  `canPerceive` already encodes sleeping = false, so a sleeping mob's `hunts`
  branch produces no gain — sleeping never aggros, with no extra check.
- The per-target "unperceived actions" counter is small per-instance bookkeeping
  (e.g. `m._unseen = { [id]: n }`), reset whenever the target is perceived again.
- Entries are now **created only on first accrual** — no more 0-seeding. So
  `inCombat = Object.keys(m.aggro).length > 0` becomes a true "is alerted" signal:
  an un-alerted hostile mob wanders normally (the bug fix), and only locks down
  once it has actually noticed someone.

### `aggressive` / action gating, redefined

```
engaged      = topThreat(perceivable enemies) >= ENGAGE
lightProvoked = t.lightAggro && rt.light > (t.lightAggro.above || 0)
aggressive   = engaged || lightProvoked
```

- The standalone `t.hostile` and `self.faction === "player"` triggers are **gone**
  from `aggressive` — they now feed `hunts` (detection), and detection feeds
  `engaged`. A hostile mob that hasn't built `ENGAGE` yet is alerted but not
  attacking.
- Provocation still works: being hit injects `max(1, dmg)` ≥ `ENGAGE` → `engaged`
  true → fights back, even for neutral (`hostile:false`) mobs and in the dark.
- `lightAggro` neutrals are unchanged (orthogonal provocation path).
- `attack`/`cast`/`summon` action options keep their existing
  `aggressive && … && enemies.length > 0` filters — `aggressive` just has new
  (stricter) meaning. Targeting (`_topThreat`/`_mobAttack`) is unchanged; with the
  ramp it will only ever fire once a real target sits at/above `ENGAGE`.

### Posture: sitting detects & stands; sleeping inert

`resolveMobAI` today does `if (RESTING(m)) continue;`, skipping **both** sitting and
sleeping. Change so **sitting mobs run `_mobAct`** (detection + engage), while
**sleeping mobs stay skipped** (inert until struck via `_rouse`):

```js
if (m.posture === "sleeping") continue;   // perceives nothing; rouse-on-hit only
// sitting and standing both proceed
```

Within `_mobAct`, a **sitting** mob:

- runs detection/decay normally (its sight band is real);
- does **not** wander/emote/idle-roam while seated (filter those options out for a
  seated posture — it is at rest);
- on `engageTell` (first `ENGAGE` crossing), transitions `posture → "standing"`
  and the rise is folded into the tell (one message, e.g. *"The cave lurker stirs,
  its eyes locking onto you."*). Once standing it follows the normal aggressive
  action path the same and subsequent ticks.

### `engageTell(m, target)` — the Diku two-audience message

Pushes one `aggro-engage` event (light-gated like other mob events), carrying both
audiences and a `rose` flag if the mob just stood:

- to victim: *"The giant rat's gaze locks onto you."* (or with rise prefix)
- to room: *"The giant rat's gaze locks onto <targetName>."*

Fired exactly once per target, on the `< ENGAGE → >= ENGAGE` transition. If threat
later decays away and re-crosses, it fires again (re-acquisition).

---

## Rendering (`server/index.js`)

One new event handler, following existing mob-event light-gating (`canSeeMob`):

- `aggro-engage` — print the victim line to the target player (if it can see the
  mob), the room line to other seers. Suppressed for those who can't see the mob
  (consistent with attack/spawn lines). Include the rise wording when `rose`.

No client changes required beyond the standard message rendering.

---

## Edge cases

- **All-current-mobs (blindBelow 0):** never decay, never sneakable; only visible
  change is the ~`ENGAGE/RATE`-action telegraph before the first swing, plus the
  engage tell. Acceptable/intended.
- **Glare-impaired existing mobs** (low `harmedAbove`): slow-ramp in bright rooms
  for free — emergent, no data change.
- **Multiple players / summons:** each enemy accrues independently; the mob commits
  to whoever crosses `ENGAGE` first, then `_topThreat` arbitrates as today.
- **Neutral mobs** (`hostile:false`, not player-faction): `hunts` is false → no
  proactive threat. They engage only when struck (provocation) or via `lightAggro`.
  Matches current passive-until-hit creatures (stonebug, scour-slug, cave-lurker).
- **Hidden mobs:** the existing reveal-on-find filter still strips unrevealed
  players from `enemies` *before* detection, so an un-searched hidden mob accrues
  nothing on them — untouched this phase.
- **Sitting player / sleeping player:** still fully visible to mobs (posture gates
  the perceiver). A mob detects and engages them normally; the existing
  rouse-on-hit wakes a sleeping player on the first blow.
- **Leaving the room:** `_pruneAggro` removes absent combatants as today, so
  cross-room reset is unchanged; in-room decay is the only persistence.
- **Summon in the dark:** below its own `blindBelow` a player-faction summon can't
  perceive wild enemies → won't engage (idle until struck). Intended — summons obey
  their own vision rules; light management matters for companions too.

---

## Verification

1. **`npm run validate`** exits 0 (pure-logic change; no new cross-references, but
   confirm nothing regresses).
2. **Headless harness** (scratch, not committed), loading the real world, with a
   test mob given `blindBelow: 1` to exercise the gate:
   - **Dark room (`light < blindBelow`):** player present for many ticks → mob never
     accrues threat, never attacks, **wanders normally** (the `inCombat` fix); no
     `aggro-engage` event.
   - **Dim/glare (impaired):** threat builds at ~`0.5 × RATE`/action; engage takes
     ~2× the clear-sight ticks; exactly one `aggro-engage` fires at the crossing.
   - **Clear:** engage in ~`ENGAGE/RATE` actions; one tell; then normal combat.
   - **Provocation in the dark:** player strikes the mob → `max(1,dmg)` threat →
     immediate engage despite `noticeChance 0`.
   - **Decay:** build threat in light, then drop light below `blindBelow` → after
     `GRACE` actions threat fades to 0, entry removed, mob resumes wandering.
   - **Sleeping mob:** never accrues, never engages, until struck (`_rouse`).
   - **Sitting mob:** accrues; on engage transitions to `standing` (posture check)
     and the `aggro-engage` carries `rose: true`; does not wander while seated.
   - **Summon:** a `faction:"player"` summon accrues on a wild mob (perception-gated)
     and a wild mob accrues on the summon — both land on each other's tables; in a
     dark room below the summon's `blindBelow`, the summon stays idle.
3. **Live run** (`npm start` on **3738**; restart after server edits — no hot
   reload): `@spawn` a hostile mob, observe the ramp + "gaze locks onto you" tell;
   manipulate room light (douse/raise the torch) to watch impaired vs clear commit
   speed and dark non-detection; sit/sleep a mob (or spawn one) to compare; capture
   the log pane.

## Workflow / deliverable

Branch `feat/aggro-detection` off `main`. Touches `server/light.js` (new
`noticeChance`), `server/state.js` (`_mobAct` detection/decay, `aggressive`
redefinition, posture handling, `engageTell`), `server/index.js` (`aggro-engage`
rendering). Update `CHANGELOG.md` under `[Unreleased]` and `docs/data-model.md`
(document the `noticeChance` tiers, the threat-as-meter / `ENGAGE` model, and the
`blindBelow`-drives-stealth note for future mob authoring). Conventional commits;
PR into `main`; maintainer merges (no self-merge).
