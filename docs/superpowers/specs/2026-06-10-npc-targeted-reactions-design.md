# NPC targeted reactions (`react` action) — design

Date: 2026-06-10
Status: approved (PoC scope)

## Goal

Trader NPCs occasionally address a specific player directly — greet them,
comment on their state (wounds), their equipment, or a quest delivery they owe —
instead of only emoting generically at the room. Proof of concept on **Maeve the
innkeeper** (`rim-innkeeper`), authored so any NPC can gain the behaviour with a
pure JSON edit later. Must behave sensibly with multiple players in the room.

## Decisions taken

- **PoC NPC:** Maeve — highest traffic (starting village) and owns the
  `warrens-thinning` quest, so all four reaction types are testable on one NPC.
- **Visibility:** whole room, MUD-style. The target reads second person
  ("Maeve eyes your bruises…"); bystanders read third person with the target's
  name ("Maeve eyes Alia's bruises…").
- **Trigger:** tick-driven only, via the existing weighted `actions` roll. No
  on-entry greeting hook in this PoC.
- **Mechanism:** a new data-driven action type `react` (Approach A). Rejected:
  overloading the existing `emote` type (muddies a trivial type), and hardcoded
  per-NPC logic (violates data-driven-first).

## Data model

A new action type in a mob template's `actions` list:

```json
{ "type": "react", "weight": 3, "cooldown": 120,
  "reactions": [
    { "if": { "delivery": true },  "messages": [ { "target": "…", "room": "…" } ] },
    { "if": { "hpBelow": 0.4 },    "messages": [ … ] },
    { "if": { "slotEmpty": "body" }, "messages": [ … ] },
    { "if": { "equipped": "torch" }, "messages": [ … ] },
    { "messages": [ … ] }
  ] }
```

- `weight` — as for every action, its share of the per-tick roll.
- `cooldown` — ticks before the same NPC instance addresses the same player
  again (any reaction). Default 120 if omitted.
- `reactions` — ordered list; **authored order is priority**. Each entry:
  - `if` — optional condition object (omitted = unconditional fallback,
    e.g. small talk). Exactly the supported keys below; all keys present must
    match (AND).
  - `messages` — non-empty list of `{ target, room }` pairs, picked at random.
    `target` is second person, `room` is third person with a `{name}`
    placeholder for the target's name. Both are rendered as
    `"<NPC name> <text>."` exactly like `mob-emote` lines. Authored pairs
    (rather than mechanical you/your substitution) because possessives don't
    substitute cleanly.

### Conditions (PoC set)

| Key         | Value      | Matches a player who…                                        |
|-------------|------------|--------------------------------------------------------------|
| `delivery`  | `true`     | has an active quest step delivering to *this* NPC's template |
| `hpBelow`   | fraction   | has `hp < maxHp * value`                                     |
| `slotEmpty` | slot name  | has nothing equipped in that slot                            |
| `equipped`  | item id    | has that item template equipped in any slot                  |

The set is intentionally small and easy to extend (e.g. `inDark`, `levelBelow`).

## Selection logic (server/state.js, `_mobAct`)

When the weighted roll picks a `react` action:

1. Candidates = players in the room who are alive, whom the NPC can perceive
   (existing `canSee(t.perception, rt.light)` check — a blind/dark room mutes
   reactions), and whose per-player cooldown has lapsed.
2. Walk `reactions` in authored order; the first reaction with ≥1 matching
   candidate wins. Pick a random player among its matches; pick a random
   message pair.
3. Stamp the cooldown (`mob.reactCd[playerId] = state.tick + cooldown`) and push
   a `mob-react` event.
4. No candidates / no match → the action degrades to idle (no event).

The `react` action's filter in the options pass requires a non-empty `reactions`
list and at least one present player, so it never wins the roll in an empty room.

Cooldown state is **in-memory, per mob instance** (`reactCd: { playerId: tick }`),
lazily created, and pruned of absent players when the action runs — no
persistence, no leak. Cooldown covers all reactions, so with several players
present the NPC rotates between them rather than pestering one.

## Event & rendering

New event, mirroring `mob-emote`:

```js
{ type: "mob-react", roomId, mobId, mobName, emitsLight, light,
  targetId, targetName, textTarget, textRoom }
```

Dispatcher in `server/index.js`: the target gets
`"<Mob name> <textTarget>."` (type `log`); every other player in the room gets
`"<Mob name> <textRoom with {name} → targetName>."`, with the same
`canSeeMob` light-gating as `mob-emote` (an unseen NPC reads as "something").

## Quest hook

`server/quests.js` exports a small read-only helper
`hasPendingDelivery(state, player, npcTemplate)` — true if any active quest's
current step is a `deliver` step with `npc === npcTemplate`. Reuses the exact
logic `handleTalk` already applies; mutates nothing.

## Content (Maeve)

`rim-innkeeper` gains one `react` action (weight ~3 next to her `idle` 12 /
`emote` 1) with, in priority order: a delivery nudge, a low-HP fuss, a bare-body
("going down in your shirtsleeves?") comment, a lit-torch/torch comment, and an
unconditional small-talk fallback — 2–3 message pairs each, in her established
warm-innkeeper voice (flour, hearth, broth; consistent with docs/lore.md).

## Validation & docs

- `tools/validate-data.js` learns the `react` shape: `reactions` is a non-empty
  array; every entry has non-empty `messages` of `{ target, room }` string
  pairs; `equipped` references an existing item template; `slotEmpty` is a
  string; `hpBelow` is a number in (0, 1]; `cooldown` a positive integer.
- `docs/data-model.md` documents the action type and condition table.
- `CHANGELOG.md` under `[Unreleased]`.

## Testing

- `npm run validate` exits 0.
- Manual multiplayer check (two clients, port 3738): one wounded/unarmoured
  player and one with pending rat-meat delivery in Maeve's room — verify
  correct targeting, both text variants, name substitution, cooldown rotation
  between players, and no reactions toward players she can't see.

## Out of scope (future)

On-entry greetings, reactions on other NPCs, `inDark`/level conditions,
per-reaction cooldowns, persistence of cooldowns across restarts.
