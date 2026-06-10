# NPC Targeted Reactions (`react` action) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Maeve the innkeeper occasionally singles out one player in her room and addresses them directly — quest-delivery nudge, low-HP fuss, equipment comment, or small talk — via a new data-driven `react` mob action, extensible to any NPC by JSON edit.

**Architecture:** A new action type in the existing weighted mob `actions` table. When the per-tick roll picks it, the NPC filters players it can see whose per-player cooldown lapsed, walks the authored `reactions` list in priority order, and pushes a `mob-react` event; the dispatcher renders second person to the target and third person (`{name}`-substituted) to bystanders, light-gated like `mob-emote`. Quest check lives in `quests.js`, lazy-required from `state.js` to avoid the existing `quests → state` require cycle.

**Tech Stack:** Node 18+ CommonJS, no test framework (verification = `npm run validate`, `node -e` smoke checks, manual two-client play). Spec: `docs/superpowers/specs/2026-06-10-npc-targeted-reactions-design.md`.

**Reference facts (verified):**
- Maeve = mob template `rim-innkeeper`, spawned in room `rim.inn` (ambientLight 5 → her perception band `{blindBelow:1, dimBelow:3}` sees clearly).
- Mob action filter + dispatch: `server/state.js` `_mobAct` (~lines 1648–1681).
- Event dispatcher: `server/index.js` `dispatchEvent`, `mob-emote` branch at ~line 439.
- Validator action checks: `tools/validate-data.js` ~lines 249–277.
- Quest pending-delivery logic to mirror: `server/quests.js` `handleTalk` (~lines 260–268).
- `canSee` is already imported at the top of `state.js`.

---

### Task 1: `hasPendingDelivery` helper in quests.js

**Files:**
- Modify: `server/quests.js` (add function before `module.exports`, extend exports at line 320)

- [ ] **Step 1: Add the helper**

Insert above the `module.exports` line:

```js
/** True if any of `player`'s active quests is sitting on a `deliver` step aimed
 *  at `npcTemplate` — the "you owe me something" check NPC reactions use.
 *  Read-only; mirrors the delivery scan in handleTalk. */
function hasPendingDelivery(state, player, npcTemplate) {
  const q = ensure(player);
  for (const [qid, entry] of Object.entries(q.active)) {
    const quest = state.world.quests[qid];
    if (!quest) continue;
    const step = quest.steps[entry.step];
    if (step && objectiveOf(step) === "deliver" && step.npc === npcTemplate) return true;
  }
  return false;
}
```

Change the exports line to:

```js
module.exports = { offer, noteKill, noteAcquire, noteUse, noteEnter, handleTalk, handleGive, hasPendingDelivery, log };
```

- [ ] **Step 2: Smoke-check it**

Run (repo root):

```bash
node -e "
const { loadWorld } = require('./server/world');
const { GameState } = require('./server/state');
const quests = require('./server/quests');
const s = new GameState(loadWorld());
const p = s.createCharacter('t1'); s.admit(p);
console.log('no quest:', quests.hasPendingDelivery(s, p, 'rim-innkeeper') === false);
p.quests.active['warrens-thinning'] = { step: 1, progress: 0 }; // step 1 = deliver rat-meat to rim-innkeeper
console.log('pending:', quests.hasPendingDelivery(s, p, 'rim-innkeeper') === true);
console.log('other npc:', quests.hasPendingDelivery(s, p, 'rim-mage') === false);
"
```

Expected output: `no quest: true`, `pending: true`, `other npc: false`.

- [ ] **Step 3: Commit**

```bash
git add server/quests.js
git commit -m "feat: add quests.hasPendingDelivery helper for NPC reactions"
```

---

### Task 2: `react` action in state.js

**Files:**
- Modify: `server/state.js` — `_mobAct` options filter (~line 1662), `_mobAct` dispatch (~line 1675), new methods after `_mobAct` (before `_zoneExits`, ~line 1683)

- [ ] **Step 1: Add the filter clause**

In the `t.actions.filter` callback in `_mobAct`, after the `wander` line (`if (a.type === "wander") …`), add:

```js
        if (a.type === "react") return Array.isArray(a.reactions) && a.reactions.length > 0 && this.playersIn(roomId).length > 0;
```

- [ ] **Step 2: Add the dispatch clause**

In the `choice.type` dispatch at the bottom of `_mobAct`, after the `summon` line, add:

```js
    if (choice.type === "react") return this._mobReact(m, t, roomId, choice, events);
```

- [ ] **Step 3: Add the methods**

Insert after the closing brace of `_mobAct`, before `_zoneExits`:

```js
  // --- Targeted NPC reactions (the `react` action) ---------------------------
  // A social mob singles out one player it can see and addresses them directly —
  // a quest-delivery nudge, a comment on their wounds or gear, or plain small
  // talk. Reactions are authored on the template (`reactions`, ordered: first
  // entry with a matching player wins); a per-player cooldown on the instance
  // keeps the NPC from pestering anyone and rotates it between players.

  /** Does `player` match a reaction's `if` conditions? All keys must hold (AND);
   *  no `if` at all is the unconditional small-talk fallback. */
  _reactMatches(player, cond, npcTemplateId) {
    if (!cond) return true;
    // Lazy require: quests.js requires state.js at load time, so a top-level
    // require back would leave one side half-initialised. By call time both are loaded.
    if (cond.delivery && !require("./quests").hasPendingDelivery(this, player, npcTemplateId)) return false;
    if (cond.hpBelow != null && !(player.hp < player.maxHp * cond.hpBelow)) return false;
    if (cond.slotEmpty && player.equipment && player.equipment[cond.slotEmpty]) return false;
    if (cond.equipped && !Object.values(player.equipment || {}).some((i) => i && i.template === cond.equipped)) return false;
    return true;
  }

  /** Resolve one `react` action: pick a visible, off-cooldown player matching the
   *  highest-priority reaction and push a `mob-react` event. Silently degrades to
   *  idle when nobody qualifies. Cooldowns live on the instance (`reactCd`,
   *  playerId -> lapse tick), in-memory only, pruned of absent/expired entries. */
  _mobReact(m, t, roomId, action, events) {
    const rt = this.rooms[roomId];
    if (!canSee(t.perception, rt.light)) return; // too dark for the NPC to make anyone out
    if (!m.reactCd) m.reactCd = {};
    const present = this.playersIn(roomId).filter((p) => p.hp > 0);
    for (const id of Object.keys(m.reactCd))
      if (m.reactCd[id] <= this.tick || !present.some((p) => p.id === id)) delete m.reactCd[id];
    const ready = present.filter((p) => m.reactCd[p.id] == null);
    if (!ready.length) return;
    for (const r of action.reactions || []) {
      const matches = ready.filter((p) => this._reactMatches(p, r.if, m.template));
      if (!matches.length) continue;
      const target = matches[Math.floor(Math.random() * matches.length)];
      const msg = r.messages[Math.floor(Math.random() * r.messages.length)];
      m.reactCd[target.id] = this.tick + (action.cooldown || 120);
      events.push({
        type: "mob-react", roomId, mobId: m.id, mobName: t.name, emitsLight: !!t.emitsLight,
        light: rt.light, targetId: target.id, targetName: target.name,
        textTarget: msg.target, textRoom: msg.room,
      });
      return;
    }
  }
```

- [ ] **Step 4: Smoke-check selection, priority, and cooldown (data-independent)**

Run:

```bash
node -e "
const { loadWorld } = require('./server/world');
const { GameState } = require('./server/state');
const s = new GameState(loadWorld());
const p = s.createCharacter('t1'); s.admit(p); s.setPlayerLocation(p, 'rim.inn');
p.hp = 1; // wounded
const m = s.rooms['rim.inn'].mobs.find(x => x.template === 'rim-innkeeper');
const t = s.world.mobs['rim-innkeeper'];
const action = { type: 'react', cooldown: 50, reactions: [
  { if: { delivery: true }, messages: [{ target: 'D', room: 'D {name}' }] },
  { if: { hpBelow: 0.4 },   messages: [{ target: 'H', room: 'H {name}' }] },
  { messages: [{ target: 'F', room: 'F {name}' }] },
]};
let ev = []; s._mobReact(m, t, 'rim.inn', action, ev);
console.log('wounded line wins:', ev.length === 1 && ev[0].textTarget === 'H' && ev[0].targetId === p.id);
ev = []; s._mobReact(m, t, 'rim.inn', action, ev);
console.log('cooldown suppresses:', ev.length === 0);
m.reactCd = {}; p.hp = p.maxHp;
ev = []; s._mobReact(m, t, 'rim.inn', action, ev);
console.log('falls back to small talk:', ev.length === 1 && ev[0].textTarget === 'F');
"
```

Expected output: three `true` lines.

- [ ] **Step 5: Commit**

```bash
git add server/state.js
git commit -m "feat: data-driven react mob action (player-targeted NPC emotes)"
```

---

### Task 3: `mob-react` rendering in index.js

**Files:**
- Modify: `server/index.js` — add a branch in `dispatchEvent` directly after the `mob-emote` block (~line 445)

- [ ] **Step 1: Add the dispatcher branch**

```js
  if (ev.type === "mob-react") {
    // An NPC singled out one player (the `react` action): the target reads the
    // second-person line, bystanders the third-person one, both light-gated.
    for (const o of state.playersIn(ev.roomId)) {
      const n = canSeeMob(o, ev.light, ev.emitsLight) ? ev.mobName : "something";
      const text = o.id === ev.targetId
        ? `${cap(n)} ${ev.textTarget}.`
        : `${cap(n)} ${ev.textRoom.replace(/\{name\}/g, ev.targetName)}.`;
      sendToPlayer(o.id, { type: "log", text });
    }
    return;
  }
```

- [ ] **Step 2: Syntax check**

Run: `node --check server/index.js`
Expected: no output, exit 0.

- [ ] **Step 3: Commit**

```bash
git add server/index.js
git commit -m "feat: render mob-react events (second person to target, third to room)"
```

---

### Task 4: Validator support for `react`

**Files:**
- Modify: `tools/validate-data.js` — action checks (~lines 249–277)

- [ ] **Step 1: Allow the type**

Change the allowed-types line to:

```js
      if (!["attack", "cast", "emote", "wander", "idle", "flee", "summon", "react"].includes(a.type))
```

- [ ] **Step 2: Add shape checks**

After the `summon` validation block, add:

```js
      if (a.type === "react") {
        // Player-targeted NPC reactions: ordered conditions + {target, room} line pairs.
        if (!Array.isArray(a.reactions) || !a.reactions.length)
          errs.push(`mob ${id}: react action needs a non-empty reactions array`);
        if (a.cooldown != null && (typeof a.cooldown !== "number" || a.cooldown <= 0))
          errs.push(`mob ${id}: react cooldown must be a positive number`);
        for (const r of a.reactions || []) {
          if (!Array.isArray(r.messages) || !r.messages.length || r.messages.some((p) => !p || typeof p.target !== "string" || typeof p.room !== "string"))
            errs.push(`mob ${id}: react reaction needs non-empty messages of { target, room } string pairs`);
          const c = r.if;
          if (!c) continue;
          if (c.delivery != null && c.delivery !== true)
            errs.push(`mob ${id}: react if.delivery must be true`);
          if (c.hpBelow != null && (typeof c.hpBelow !== "number" || c.hpBelow <= 0 || c.hpBelow > 1))
            errs.push(`mob ${id}: react if.hpBelow must be a number in (0, 1]`);
          if (c.slotEmpty != null && typeof c.slotEmpty !== "string")
            errs.push(`mob ${id}: react if.slotEmpty must be a slot name string`);
          if (c.equipped != null && !has(items, c.equipped))
            errs.push(`mob ${id}: react if.equipped references missing item ${c.equipped}`);
        }
      }
```

- [ ] **Step 3: Verify validator still passes (no react data yet) and catches bad data**

Run: `npm run validate` — expected exit 0.
Then temporarily add `{ "type": "react", "weight": 1, "reactions": [] }` to any mob's actions, run `npm run validate`, expect the "non-empty reactions array" error, then revert the temporary edit.

- [ ] **Step 4: Commit**

```bash
git add tools/validate-data.js
git commit -m "feat: validate the react mob action shape"
```

---

### Task 5: Maeve's reactions content

**Files:**
- Modify: `data/world/mobs.json` — `rim-innkeeper.actions`

- [ ] **Step 1: Add the react action**

In `rim-innkeeper`, change `actions` to (idle/emote unchanged, react appended):

```json
    "actions": [
      { "type": "idle", "weight": 12 },
      { "type": "emote", "weight": 1, "messages": ["hums a wandering old lullaby", "wipes the bar down with a worn grey cloth", "ladles steaming broth into a chipped bowl", "smiles warmly and pats an empty stool", "stokes the hearth until it pops and crackles"] },
      { "type": "react", "weight": 3, "cooldown": 120, "reactions": [
        { "if": { "delivery": true }, "messages": [
          { "target": "catches your eye: \"Those for my pot, love? Hand them over while they're fresh.\"", "room": "catches {name}'s eye and nods at their pack." },
          { "target": "wipes her hands on her apron: \"Don't keep an old woman waiting on her stores, dear.\"", "room": "wipes her hands on her apron and beckons {name} over to the bar." }
        ] },
        { "if": { "hpBelow": 0.4 }, "messages": [
          { "target": "clucks her tongue at your wounds: \"Sit down by the hearth before you fall down, love.\"", "room": "clucks her tongue at {name}'s wounds and points them to the hearth." },
          { "target": "pushes a bowl of broth at you: \"You're white as a palecap. Eat.\"", "room": "pushes a bowl of broth across the bar at {name}." }
        ] },
        { "if": { "slotEmpty": "body" }, "messages": [
          { "target": "looks you up and down: \"Going below in your shirtsleeves? Garrick sells jerkins, dear.\"", "room": "looks {name} up and down and shakes her head." }
        ] },
        { "if": { "equipped": "torch" }, "messages": [
          { "target": "nods at your torch: \"Keep it dry and keep it lit — the dark down there drinks them fast.\"", "room": "nods at {name}'s torch approvingly." }
        ] },
        { "messages": [
          { "target": "smiles your way: \"Broth's hot, stool's free, and the dark will keep, love.\"", "room": "says a warm word to {name} across the bar." },
          { "target": "asks after you: \"Still in one piece, then? Good. Stay that way.\"", "room": "asks {name} how the delving's been." }
        ] }
      ] }
    ],
```

- [ ] **Step 2: Validate**

Run: `npm run validate`
Expected: exit 0.

- [ ] **Step 3: End-to-end smoke with real data**

Run:

```bash
node -e "
const { loadWorld } = require('./server/world');
const { GameState } = require('./server/state');
const s = new GameState(loadWorld());
const a = s.createCharacter('alia'); s.admit(a); s.setPlayerLocation(a, 'rim.inn');
const b = s.createCharacter('borin'); s.admit(b); s.setPlayerLocation(b, 'rim.inn');
a.quests.active['warrens-thinning'] = { step: 1, progress: 0 }; // owes Maeve rat meat
const m = s.rooms['rim.inn'].mobs.find(x => x.template === 'rim-innkeeper');
const t = s.world.mobs['rim-innkeeper'];
const action = t.actions.find(x => x.type === 'react');
let ev = []; s._mobReact(m, t, 'rim.inn', action, ev);
console.log('1st targets the deliverer:', ev[0].targetId === a.id, '|', ev[0].textTarget);
ev = []; s._mobReact(m, t, 'rim.inn', action, ev);
console.log('2nd rotates to the other player:', ev[0].targetId === b.id, '|', ev[0].textTarget);
ev = []; s._mobReact(m, t, 'rim.inn', action, ev);
console.log('3rd suppressed by cooldowns:', ev.length === 0);
"
```

Expected: first line `true` with a delivery nudge, second `true` with a fallback/equipment line, third `true`.

- [ ] **Step 4: Commit**

```bash
git add data/world/mobs.json
git commit -m "feat: Maeve addresses players directly (react PoC content)"
```

---

### Task 6: Docs + changelog

**Files:**
- Modify: `docs/data-model.md` — actions table (~line 262) and example
- Modify: `CHANGELOG.md` — `[Unreleased]`

- [ ] **Step 1: Document the action**

Add a row to the actions table after `summon` (keep the stray `loot` row below it as-is):

```markdown
| `react` | Single out **one visible player** and address them directly (quest delivery owed, wounds, gear, small talk). Walks `reactions` in authored order — first entry with a matching player wins, random player among matches, random message pair. A per-player `cooldown` (ticks, default 120) rotates targets and stops pestering; in-memory only. The target reads `target` (second person); bystanders read `room` with `{name}` replaced by the target's name. Both render as `"<Mob name> <text>."`, light-gated like `emote`. | `reactions: [{ if?, messages: [{target, room}] }]`, `cooldown?`. `if` keys (all must match): `delivery: true` (active deliver step aimed at this NPC), `hpBelow: 0..1` (fraction of maxHp), `slotEmpty: "<slot>"`, `equipped: "<itemId>"`. No `if` = unconditional fallback. |
```

- [ ] **Step 2: Changelog**

Under `[Unreleased]` → `### Added` (create the heading if missing):

```markdown
- NPCs can address players directly: new data-driven `react` mob action
  (conditions: pending quest delivery, low HP, equipment, fallback small talk)
  with per-player cooldowns; Maeve the innkeeper is the first to use it.
```

- [ ] **Step 3: Validate & commit**

```bash
npm run validate
git add docs/data-model.md CHANGELOG.md
git commit -m "docs: document the react mob action; changelog"
```

---

### Task 7: Live multiplayer verification + PR

- [ ] **Step 1: Run a test server** on port 3738 (`$env:PORT` is read from `server/config.js` — check how PORT is set; if hardcoded, run the default 3737 instance briefly). Start with `npm start` in the background.

- [ ] **Step 2: Two-client check.** Connect two websocket clients (or two browser tabs), log in as two players (admin + one `@create-player`-created delver), stand both in the inn (`rim.inn` is the room south/adjacent of the start plaza — use `look`/exits to navigate). Wound one (or use a fresh unarmoured character) and give the other the rat-meat delivery (take Maeve's quest with `talk maeve`, kill rats, return). Observe over a few minutes:
  - Target reads second person, bystander reads the `{name}` line.
  - Maeve alternates between players (cooldown rotation).
  - No reactions fire in an empty room (check server doesn't error overnight via log).

- [ ] **Step 3: Stop the server, push, open PR**

```bash
git push -u origin claude/heuristic-germain-5da76e
gh pr create --base main --title "feat: NPCs address players directly (react action, Maeve PoC)" --body "…summary, spec link, test evidence…

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```
