# The Graveworker's Den Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the area approved in `docs/superpowers/specs/2026-07-07-graveworker-den-design.md` — 8 rooms west of Thornreach descending to a d5 necromancer mini-dungeon, 4 new outlaw mobs, a den door, and a new mana-only `leech` drain spell (one server addition: the `drain` effect type).

**Architecture:** Everything is JSON world data except Task 1, which adds one spell-effect kind (`drain`) to the shared hostile-spell core in `server/state.js` and threads the caster-heal through both cast directions (player→mob in `castSpell`, mob→anyone in `_resolveSpellPayload`), plus narration and the two whitelists. Data tasks are ordered so `npm run validate` exits 0 after every commit: server+validator first, then spell, then mobs (they reference the spell), then fixtures+rooms together (they reference each other circularly).

**Tech Stack:** Node 18+ (CommonJS), `node --test` for tests, `node tools/validate-data.js` for data validation. No new dependencies.

**Branch:** work continues on the current worktree branch (already off `main`); PR at the end via compare URL (no `gh` on this machine).

**Names are provisional** (rooms, mobs, the spell, "the Graveworker") pending maintainer sign-off per `docs/lore.md`.

---

### Task 1: The `drain` spell-effect type (server, TDD)

A drain lands exactly like a non-physical `damage` spell (Ward already had its wholesale negate roll in both callers), then heals the **caster** by `healFactor` of the rolled damage, capped at max hp. The shared core returns the damage plus a `drainFactor`; each direction-specific caller applies the heal after it deals the damage.

**Files:**
- Modify: `test/mob-combat.test.js` (add a `leech` test spell + 3 tests)
- Modify: `server/state.js` (`_applyHostileSpellEffect` ~line 1490: new case; `castSpell` ~line 1580: player-side heal)
- Modify: `server/state-mobai.js` (`_resolveSpellPayload` ~lines 833–874: mob-side heal + `drained` event field)
- Modify: `server/index.js` (`"mob-cast"` handler ~lines 441–475: narrate the feed)
- Modify: `server/commands/magic.js` (line 18: `HOSTILE_EFFECTS`)
- Modify: `tools/validate-data.js` (line 343 `MOB_CASTABLE`, line 492 `PLAYER_HOSTILE_EFFECTS`, line 541 single-target list)

- [ ] **Step 1: Write the failing tests**

In `test/mob-combat.test.js`, add to the `spells` block of `makeCombatWorld()` (after the `snuff` entry, line 32):

```js
      leech: { id: "leech", name: "Leech", hostile: true, effect: { type: "drain", damage: "6", healFactor: 0.5 } },
```

Append these tests at the end of the file (damage is a plain integer and the test player has wits 0, so outcomes are deterministic — same convention as the existing cast tests):

```js
// --- Drain (Leech) ------------------------------------------------------------

test("drain: a mob's leech damages the player and heals the caster, capped at maxHp", () => {
  const state = setup();
  const p = addPlayer(state);
  const caster = addMob(state, "caster"); // maxHp 50
  caster.hp = 40;
  p.hp = 100;
  const events = [];
  state._mobCast(caster, state.world.mobs.caster, "arena", events, [pdesc(p)], "leech");
  assert.equal(p.hp, 94, "player lost the rolled 6");
  assert.equal(caster.hp, 43, "caster healed floor(6 * 0.5) = 3");
  const ev = events.find((e) => e.type === "mob-cast");
  assert.equal(ev.drained, 3, "mob-cast event carries the drained amount");
});

test("drain: the heal never overfills the caster", () => {
  const state = setup();
  const p = addPlayer(state);
  const caster = addMob(state, "caster");
  caster.hp = 49; // room for only 1 of the 3
  const events = [];
  state._mobCast(caster, state.world.mobs.caster, "arena", events, [pdesc(p)], "leech");
  assert.equal(caster.hp, 50, "capped at maxHp");
});

test("drain: a player-cast drain heals the player (engine path for a future scroll)", () => {
  const state = setup();
  const p = addPlayer(state);
  const mob = addMob(state, "biter"); // 5 hp — the 6 kills it
  p.hp = p.maxHp - 10;
  const events = [];
  const result = state.castSpell(p, state.world.spells.leech, mob, events);
  assert.equal(result.damage, 6);
  assert.ok(result.killed, "the drain still kills");
  assert.equal(p.hp, p.maxHp - 10 + 3, "player healed floor(6 * 0.5) = 3");
  assert.equal(result.drained, 3, "result reports the heal for narration");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: the three new tests FAIL (drain falls into the hostile-status `default:` case — no damage is dealt, no heal happens); every pre-existing test still passes.

- [ ] **Step 3: Implement `drain` in the shared core (`server/state.js`)**

In `_applyHostileSpellEffect`, insert a new case directly after the closing brace of `case "damage"` (~line 1500):

```js
      case "drain": {
        // A necromantic siphon (Leech): lands like a non-physical damage weave
        // — Ward's wholesale negate already ran in the caller — and hands the
        // caller a drainFactor so it can heal the CASTER from the damage it
        // deals. The heal stays caller-side: only the caller knows the caster
        // and applies the rolled damage.
        const damage = Math.max(1, rollDice(eff.damage) + spellScaleBonus(attrs, eff.scale));
        return { kind: "damage", damage, drainFactor: eff.healFactor || 0.5 };
      }
```

In `castSpell`, extend the `applied.kind === "damage"` branch (~line 1580) — after `if (result.death) result.killed = true;` add:

```js
      // A drain heals the caster from the blow it just dealt (capped at max).
      if (applied.drainFactor) {
        const heal = Math.min(player.maxHp - player.hp, Math.floor(applied.damage * applied.drainFactor));
        if (heal > 0) { player.hp += heal; result.drained = heal; }
      }
```

- [ ] **Step 4: Implement the mob-side heal (`server/state-mobai.js`)**

In `_resolveSpellPayload`:

1. Change the declaration line (~838) from
   `let damage = 0, effectName = null, doused = false;` to
   `let damage = 0, effectName = null, doused = false, drainFactor = 0;`
2. In the `applied.kind === "damage"` branch (~line 843), after
   `damage = applied.damage;` add:
   ```js
        drainFactor = applied.drainFactor || 0;
   ```
3. Directly after the `const killed = ...` line (~860), compute the heal so the
   event can carry it (the event goes out before the damage lands, same as the
   blow itself):
   ```js
    // A drain feeds the caster from the blow — computed here so the event
    // narrates it, applied after the damage lands below.
    const drained = damage > 0 && drainFactor ? Math.min(t.maxHp - m.hp, Math.floor(damage * drainFactor)) : 0;
   ```
4. Add `drained,` to the pushed `mob-cast` event object (after `doused, killed,`).
5. After the `if (damage > 0) { ... }` block that deals the damage (~line 872), add:
   ```js
    if (drained > 0) m.hp += drained;
   ```

- [ ] **Step 5: Narrate the feed (`server/index.js`)**

In the `"mob-cast"` handler, player-target branch: after the `else youLine = ...` line (~464) add a drain suffix so the victim feels the theft:

```js
    if (ev.drained > 0) youLine += ` Your stolen warmth closes ${seen ? "its" : "their"} wounds.`;
```

(The mob-vs-mob branch stays as-is — onlooker narration for a mob draining a mob isn't worth a special line.)

- [ ] **Step 6: Open the whitelists**

- `server/commands/magic.js` line 18:
  ```js
  const HOSTILE_EFFECTS = ["damage", "damage-over-time", "sleep", "damage-room", "drain"];
  ```
- `tools/validate-data.js` line 343:
  ```js
          const MOB_CASTABLE = ["damage", "douse", "damage-over-time", "drain"];
  ```
- `tools/validate-data.js` line 492:
  ```js
  const PLAYER_HOSTILE_EFFECTS = ["damage", "damage-over-time", "sleep", "damage-room", "drain"];
  ```
- `tools/validate-data.js` line 541 (drain is single-target):
  ```js
      if (sp.hostile && ["damage", "damage-over-time", "sleep", "douse", "drain"].includes(t) && sp.target !== "creature")
  ```

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: all tests PASS (the three new ones included).
Run: `npm run validate`
Expected: exit 0 (no data touched yet).

- [ ] **Step 8: Commit**

```bash
git add test/mob-combat.test.js server/state.js server/state-mobai.js server/index.js server/commands/magic.js tools/validate-data.js
git commit -m "feat: add drain spell-effect type (damage that heals the caster)"
```

---

### Task 2: The `leech` spell (data)

**Files:**
- Modify: `data/world/spells.json` (insert after the `witchfire` entry, ~line 175)

- [ ] **Step 1: Add the spell**

Insert as a new top-level key after `"witchfire"`:

```json
  "leech": {
    "id": "leech",
    "name": "Leech",
    "description": "Hedge-craft turned to its oldest forbidden use: the caster hooks a thread of will into a living body and pulls, and what keeps it warm comes away down the line. No glimmer moves in this weave — it is human work, mana and nerve and a bad conscience — and what it takes the caster keeps, stolen warmth closing their own wounds as the mark's blood runs cold. A creature's Ward can shrug the hook off whole. Cast it at any foe you can see.",
    "manaCost": 7,
    "hostile": true,
    "target": "creature",
    "messages": {
      "self": "You hook {spell} into {target} and pull — {damage} of their life comes away down the thread.",
      "room": "{caster} hooks a pale thread into {target} and pulls."
    },
    "effect": { "type": "drain", "damageType": "magical", "damage": "2d6", "scale": { "attr": "intellect", "per": 3 }, "healFactor": 0.5 }
  },
```

Not learnable anywhere (no scroll, no trainer) — mob-only until the follow-up loot pass.

- [ ] **Step 2: Validate**

Run: `npm run validate`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add data/world/spells.json
git commit -m "feat: add Leech, a mana-only life-drain spell (name provisional)"
```

---

### Task 3: The four den mobs (data)

**Files:**
- Modify: `data/world/mobs.json` (insert all four after the `"camp-warder"` entry, ~line 703, keeping the outlaw crew grouped)

All four are `faction: "outlaw"` + `helper: true` — the den fights as one crew.
The three risen are **light-indifferent** (`blindBelow: 0`, no flee, no
lightBane): nothing natural at this depth ignores light, which is the tell.
Their emotes are pure puppetry — never habit-mimicry, which is Hollowing
vocabulary and stays out (see the spec's lore-compliance section).

- [ ] **Step 1: Add the mobs**

```json
  "risen-thornbug": {
    "id": "risen-thornbug",
    "faction": "outlaw",
    "name": "a risen thornbug",
    "keywords": ["risen", "thornbug", "bug", "carcass", "dead"],
    "description": "A thornbug carcass a long way past its death — spines dulled, shell sunken — moving anyway. Fine glimmer shard-wire is threaded through every joint, and a cold blue light pulses in the seams where the wire runs, tightening and slackening like breath in a thing that has none. It does not graze. It does not do anything at all until the wire pulls, and then it comes on with no fear in it, because there is nothing in it.",
    "spawnMessage": "{Name} rights itself with a dry click of shard-wire.",
    "maxHp": 14,
    "speed": 9,
    "armour": 3,
    "ward": 1,
    "attributes": { "might": 5, "vitality": 5, "intellect": 0, "wits": 2, "perception": 3 },
    "perception": { "blindBelow": 0, "dimBelow": 0, "harmedAbove": 9 },
    "behavior": "guard",
    "hostile": true,
    "helper": true,
    "pursues": true,
    "pursueRange": 2,
    "attack": { "damage": "1d4", "actionCost": 13 },
    "spikes": { "damage": "1d2", "chance": 1 },
    "xp": 10,
    "shards": "1d3",
    "actions": [
      { "type": "attack", "weight": 6 },
      { "type": "idle", "weight": 4 },
      { "type": "emote", "weight": 2, "messages": ["hangs slack until the wire pulls it taut", "twitches in time with no heartbeat", "scrapes a dulled spine across the floor, aimless"] }
    ],
    "loot": [{ "template": "chitin-spike", "chance": 0.5 }]
  },
  "stitched-prospector": {
    "id": "stitched-prospector",
    "faction": "outlaw",
    "name": "a stitched prospector",
    "keywords": ["stitched", "prospector", "corpse", "dead"],
    "description": "A dead man in a dead man's mining kit, stitched shut along every seam with glimmer shard-wire that glows a faint cold blue through the cloth. He was somebody once — the calluses are real, the boots are worn to his gait — but what moves him now runs along the wire, hauling the big frame about like a marionette worked by a patient hand. He swings his own pick, slow and terrible, and does not tire, and does not bleed.",
    "spawnMessage": "{Name} lurches upright, the wire in his seams pulling taut.",
    "maxHp": 34,
    "speed": 9,
    "armour": 2,
    "ward": 1,
    "attributes": { "might": 9, "vitality": 10, "intellect": 0, "wits": 2, "perception": 3 },
    "perception": { "blindBelow": 0, "dimBelow": 0, "harmedAbove": 9 },
    "behavior": "guard",
    "hostile": true,
    "helper": true,
    "pursues": true,
    "pursueRange": 2,
    "attack": { "damage": "1d8", "actionCost": 15, "bonus": 1 },
    "xp": 24,
    "shards": "1d6",
    "actions": [
      { "type": "attack", "weight": 6 },
      { "type": "idle", "weight": 3 },
      { "type": "emote", "weight": 2, "messages": ["stands utterly still, the wire ticking softly in his seams", "turns his head in a slow, wrong arc", "shoulders his pick with hands that no longer feel it"] }
    ],
    "loot": [
      { "template": "prospectors-hatchet", "chance": 0.1 },
      { "template": "lamp-oil", "chance": 0.15 }
    ]
  },
  "wired-skeleton": {
    "id": "wired-skeleton",
    "faction": "outlaw",
    "name": "a wired skeleton",
    "keywords": ["skeleton", "bones", "wired"],
    "description": "A human skeleton strung together on bright glimmer shard-wire — the flesh long since limed away, every joint rebuilt in neat glowing coils. This is finished work, and it shows: it moves quick and sure, nothing left on it to slow it down, the wire singing faintly as it comes. Its jaw is bound shut with a single tidy loop. Somehow that is the worst of it.",
    "spawnMessage": "{Name} pulls upright, shard-wire singing through its joints.",
    "maxHp": 16,
    "speed": 11,
    "armour": 1,
    "ward": 1,
    "attributes": { "might": 6, "vitality": 5, "intellect": 0, "wits": 4, "perception": 4 },
    "perception": { "blindBelow": 0, "dimBelow": 0, "harmedAbove": 9 },
    "behavior": "guard",
    "hostile": true,
    "helper": true,
    "pursues": true,
    "pursueRange": 2,
    "attack": { "damage": "1d6", "actionCost": 12 },
    "xp": 12,
    "shards": "1d3",
    "actions": [
      { "type": "attack", "weight": 7 },
      { "type": "idle", "weight": 2 },
      { "type": "emote", "weight": 2, "messages": ["stands wire-taut, waiting on the next pull", "clicks through a slow turn of the skull", "flexes a hand of bone and bright wire"] }
    ],
    "loot": []
  },
  "graveworker": {
    "id": "graveworker",
    "faction": "outlaw",
    "name": "the Graveworker",
    "keywords": ["graveworker", "necromancer", "outlaw", "man", "worker"],
    "description": "A gaunt, steady-handed man in a stained leather apron, spools of glimmer shard-wire hung at his belt and a stitching-hook resting in his fist. He is no dark-touched thing — the eyes that lift from the bench are sane, mild, and faintly annoyed at the interruption. He found what the wire could do and followed it down here, past every law the Rim would hang him under, because the work was interesting and the dead don't complain. They also don't stay down.",
    "spawnMessage": "{Name} looks up from the bench and sets his work aside, unhurried.",
    "emitsLight": 1,
    "maxHp": 55,
    "speed": 11,
    "armour": 1,
    "ward": 4,
    "attributes": { "might": 4, "vitality": 7, "intellect": 8, "wits": 6, "perception": 7 },
    "perception": { "blindBelow": 1, "dimBelow": 3, "harmedAbove": 9 },
    "behavior": "guard",
    "hostile": true,
    "helper": true,
    "pursues": true,
    "pursueRange": 2,
    "attack": { "damage": "1d4", "actionCost": 12 },
    "xp": 48,
    "shards": "3d6",
    "actions": [
      { "type": "summon", "weight": 3, "mob": "wired-skeleton", "count": 2, "max": 2, "verb": "snaps his fingers, and shard-wire hauls the dead upright" },
      { "type": "cast", "weight": 4, "spell": "leech" },
      { "type": "cast", "weight": 2, "spell": "mage-armour" },
      { "type": "attack", "weight": 1 },
      { "type": "emote", "weight": 2, "messages": ["says, without looking up: \"You're interrupting delicate work.\"", "winds a length of shard-wire off the spool, unhurried", "studies you the way a man studies materials", "says, mild: \"Do stop bleeding on my floor.\""] }
    ],
    "loot": []
  },
```

Notes for the implementer:
- `summon` count 2 / max 2 = he raises the pair, and re-raises replacements as
  they fall, never more than two standing (`_broodCount` handles the cap).
- `mage-armour` is `effect.type: "protect"` → passes the validator's
  `SELF_CASTABLE` list; the AI won't recast it while the buff is up
  (`_mobHasState` gate, warder precedent).
- `leech` needs Task 1's `MOB_CASTABLE` change or the validator fails —
  that's why Task 1 lands first.
- Boss `loot: []` is deliberate (spec: loot deferred); xp/shards still pay.

- [ ] **Step 2: Validate**

Run: `npm run validate`
Expected: exit 0. If it errors on `leech`/`drain`, Task 1 Step 6 was skipped.

- [ ] **Step 3: Commit**

```bash
git add data/world/mobs.json
git commit -m "feat: add the Graveworker and his wired dead (4 outlaw mobs, names provisional)"
```

---

### Task 4: Fixtures + rooms (data — one commit, they cross-reference)

The `den-door` fixture points at `d5.den.porch` and the gallery room lists
`den-door`; the validator resolves both directions, so these two files must
land together. The validator treats a door fixture as a graph edge
(`server/README.md` → *Doors*), so the den passes reachability through the
closed door, and the porch's plain `north` exit is the way back out
(trapdoor/`d0.training` precedent).

**Files:**
- Modify: `data/world/fixtures.json` (append 4 fixtures at the end, before the closing `}`)
- Modify: `data/world/rooms.json` (add `west` to `d4.thornreach.approach` ~line 1301; insert 8 rooms after `d4.thornreach.deep`, ~line 1359)

- [ ] **Step 1: Add the fixtures**

```json
  "verge-niche": {
    "id": "verge-niche",
    "name": "a cut lamp-shelf",
    "keywords": ["niche", "shelf", "lamp-shelf", "stake", "chalk"],
    "description": "A niche cut square into the cave wall at shoulder height — not worn, cut, the chisel-strokes still crisp — its ceiling smoke-blacked where a lamp has sat and burned. Below it the rusted stub of an iron stake juts from the rock, and beside that a chalk blaze has faded to a ghost. Someone works this edge of the browse, and has for a long time; whatever they carry, they carry it down.",
    "type": "scenery"
  },
  "gallery-sealed-face": {
    "id": "gallery-sealed-face",
    "name": "the sealed west face",
    "keywords": ["face", "rubble", "timber", "west", "seal", "collapse"],
    "description": "A few paces on west the gallery simply stops: a fall of rock brought down across the full bore, shored with squared timber so that no more of it can move. Whoever drove this tunnel meant to go further — the dressed walls run right up to the rubble and vanish into it — and someone, later, made very sure nothing would come of it. The timbers are newer than the fall.",
    "type": "scenery"
  },
  "den-door": {
    "id": "den-door",
    "name": "a heavy plank door",
    "keywords": ["door", "plank", "south"],
    "description": "A door of heavy squared planks set into a dressed frame in the gallery's south wall, hung on leather hinges kept supple with lamp-oil. There is no lock and no bar — down past the browse and the squeeze and a tunnel no natural force made, whoever hung it plainly reckons the dark does the gatekeeping. A faint warmth of lamplight breathes through the seams.",
    "type": "door",
    "door": { "dir": "south", "to": "d5.den.porch", "open": false }
  },
  "graveworker-journal": {
    "id": "graveworker-journal",
    "name": "a working journal",
    "keywords": ["journal", "notes", "book", "ledger"],
    "description": "A thick journal lies open on the bench, written in a small, steady hand — no ravings, just work: wire gauges and joint diagrams, tallies of shard spent per subject, a thornbug's leg sketched rebuilt in coil. One margin, underlined twice: 'the wire does not tire. neither do they.' A later page, calmer still: 'flesh is scaffolding. bone is the instrument.' The most recent entry is a shopping list.",
    "type": "scenery"
  }
```

- [ ] **Step 2: Open the west exit from the Capwalk**

In `d4.thornreach.approach` (~line 1301), change:

```json
    "exits": { "north": "d4.lake.strand", "south": "d4.thornreach.hollow", "east": "d4.thornreach.terrace" },
```

to:

```json
    "exits": { "north": "d4.lake.strand", "south": "d4.thornreach.hollow", "east": "d4.thornreach.terrace", "west": "d4.thornreach.verge" },
```

- [ ] **Step 3: Add the 8 rooms**

Insert after the `d4.thornreach.deep` entry (keep the thornreach zone grouped, then the new zones):

```json
  "d4.thornreach.verge": {
    "id": "d4.thornreach.verge",
    "zone": "fourth-thornreach",
    "tags": ["grazing"],
    "name": "The Far Verge",
    "depth": 4,
    "ambientLight": 1,
    "description": "The browse gives out here at its western edge: the luminous caps grow small and scattered, the moss thins to a grey lace over bare rock, and the herd's trodden lanes fade into untracked floor. The glow behind is a soft wall of blue-white; ahead the dark leans in. In the cave wall a lamp-shelf has been cut square at shoulder height — the one human mark on the whole browse — and near it the floor drops away into a shaft, its lip worn smooth. The caps and the herd lie back east.",
    "exits": { "east": "d4.thornreach.approach", "down": "d5.underway.stair" },
    "fixtures": ["verge-niche"],
    "groundItems": [
      { "template": "palecap-mushroom", "qty": 2, "respawn": 150 }
    ],
    "spawns": [
      { "mob": "thornbug", "max": 1, "respawn": 120 }
    ]
  },
  "d5.underway.stair": {
    "id": "d5.underway.stair",
    "zone": "fifth-underway",
    "name": "The Cut Descent",
    "depth": 5,
    "ambientLight": 0,
    "description": "The shaft drops in rough natural shelves that a chisel has quietly improved — a notch here, a squared step there, a rusted spike near the top with the stub of a knotted rope still made fast to it. The browse's glow dies within the first few steps and does not come back; from here there is only what light you carry. Long smooth drag-marks score the dust down every ledge, all of them running one way: down. The verge is back up; at the bottom the way on is a squeeze to the west.",
    "exits": { "up": "d4.thornreach.verge", "west": "d5.underway.pinch" },
    "fixtures": [],
    "groundItems": [],
    "spawns": []
  },
  "d5.underway.pinch": {
    "id": "d5.underway.pinch",
    "zone": "fifth-underway",
    "name": "The Pinch",
    "depth": 5,
    "ambientLight": 0,
    "description": "The way west closes to a sideways squeeze between two leaning slabs, tight enough that a laden delver must breathe out to pass. The rock is polished smooth at hip height — years of loads hauled through, and none of them gently — and a scrap of coarse sacking has snagged on a spur and bleached there. Whoever uses this way is stronger than they are careful. East the descent climbs back toward the browse; west, beyond the squeeze, the dark opens out again.",
    "exits": { "east": "d5.underway.stair", "west": "d5.underway.gallery" },
    "fixtures": [],
    "groundItems": [],
    "spawns": []
  },
  "d5.underway.gallery": {
    "id": "d5.underway.gallery",
    "zone": "fifth-underway",
    "name": "The Straight Gallery",
    "depth": 5,
    "ambientLight": 0,
    "description": "You come out of the squeeze into a tunnel no water and no shifting of the earth ever made: dead level, dead straight, the walls dressed in even chisel-courses and squared timber sets standing at measured intervals. After the browse's soft chaos and the crawl of the natural stone, the competence of it is somehow worse than any lair — someone drove this gallery, alone, in the dark, and took their time about it. A few paces west it ends in a fall of rock shored with deliberate timber; in the south wall hangs a heavy plank door, and lamplight breathes faintly through its seams.",
    "exits": { "east": "d5.underway.pinch" },
    "fixtures": ["den-door", "gallery-sealed-face"],
    "groundItems": [
      { "template": "lamp-oil", "qty": 1, "respawn": 600 }
    ],
    "spawns": []
  },
  "d5.den.porch": {
    "id": "d5.den.porch",
    "zone": "graveworker-den",
    "name": "The Cold Porch",
    "depth": 5,
    "ambientLight": 3,
    "description": "The door opens on lamplight — real, generous, working light, the kind nothing natural burns this deep. A row of iron hooks runs along one wall hung with oiled aprons and a coil of fine wire; a barrel of quicklime stands by a broom worn to the knot; the floor has been swept, and recently. It is a tradesman's porch, tidy and airless and cold, and every homely thing in it is answering a question you have not asked yet. The door back to the gallery is north; the work goes on south.",
    "exits": { "north": "d5.underway.gallery", "south": "d5.den.work" },
    "fixtures": [],
    "groundItems": [],
    "spawns": [
      { "mob": "risen-thornbug", "max": 2, "respawn": 240 }
    ]
  },
  "d5.den.work": {
    "id": "d5.den.work",
    "zone": "graveworker-den",
    "name": "The Workroom",
    "depth": 5,
    "ambientLight": 3,
    "description": "Benches line the walls under bright, well-trimmed lamps: spools of glimmer shard-wire glowing their faint cold blue, pliers and fine hooks laid out in graded rows, and the work itself — thornbug carcasses in every stage of rewiring, some half-threaded, one spread open like a watch under repair. The finished ones stand along the wall, slack on their feet, waiting. There is no smell of rot; the quicklime and the cold see to that. The porch is back north; a colder room opens west, and the best light of all burns south.",
    "exits": { "north": "d5.den.porch", "west": "d5.den.store", "south": "d5.den.sanctum" },
    "fixtures": [],
    "groundItems": [],
    "spawns": [
      { "mob": "risen-thornbug", "max": 3, "respawn": 240 }
    ]
  },
  "d5.den.store": {
    "id": "d5.den.store",
    "zone": "graveworker-den",
    "name": "The Still Store",
    "depth": 5,
    "ambientLight": 3,
    "description": "A cold room cut low behind the workroom, a seep in the far corner ticking into a stone basin and the air off it barely above freezing. Shelves run the length of it, and what lies on the shelves lies very still, wrapped neat in sacking and dusted with lime — the Graveworker's materials, laid in like a winter larder. One of the big ones isn't wrapped, and isn't on a shelf: it stands by the door in a dead man's mining kit, and its seams glow. The workroom is back east.",
    "exits": { "east": "d5.den.work" },
    "fixtures": [],
    "groundItems": [
      { "template": "shards", "qty": 8, "respawn": 1200 },
      { "template": "crystal", "qty": 1, "respawn": 1200, "hidden": { "perception": 4 } }
    ],
    "spawns": [
      { "mob": "stitched-prospector", "max": 1, "respawn": 600 },
      { "mob": "risen-thornbug", "max": 1, "respawn": 240 }
    ]
  },
  "d5.den.sanctum": {
    "id": "d5.den.sanctum",
    "zone": "graveworker-den",
    "name": "The Grafting Room",
    "depth": 5,
    "ambientLight": 3,
    "description": "The heart of the den, and the brightest room this side of the surface: lamps ranked on brackets, a mirror of polished tin throwing their light down onto a long bench where the fine work happens. Wire so thin it is only a glitter lies coiled beside instruments a surgeon would not blush at, and a journal sits open where the hand left off. The man himself works with his back half-turned, unhurried — he heard the door, he heard the porch, and he has not stopped stitching. The workroom is back north.",
    "exits": { "north": "d5.den.work" },
    "fixtures": ["graveworker-journal"],
    "groundItems": [],
    "spawns": [
      { "mob": "graveworker", "max": 1, "respawn": 900 }
    ]
  },
```

- [ ] **Step 4: Validate**

Run: `npm run validate`
Expected: exit 0 — in particular no reachability errors (the den hangs off the
gallery through the door edge, the underway hangs off the verge, the verge off
the approach).

- [ ] **Step 5: Commit**

```bash
git add data/world/fixtures.json data/world/rooms.json
git commit -m "feat: add the Far Verge descent and the Graveworker's den (8 rooms, names provisional)"
```

---

### Task 5: Faction comment + CHANGELOG

**Files:**
- Modify: `server/factions.js` (~line 24, the `outlaw` comment)
- Modify: `CHANGELOG.md` (under `[Unreleased]`)

- [ ] **Step 1: Note the wired dead in the outlaw faction comment**

In `server/factions.js`, change the comment lines (~24–27):

```js
//   outlaw — living, hostile humans (claim-jumpers/deserters preying on delvers).
//            A sane, coordinated enemy class, `enemy` to both `player` and the
//            `rim` watch that would clear them; `neutral` to the deep's own things
//            (fauna/wild/umbral) — the camp squats among the vermin, not against it.
```

to:

```js
//   outlaw — living, hostile humans (claim-jumpers/deserters preying on delvers)
//            and their wired dead (the Graveworker's shard-wire risen, which ride
//            the same faction so his den fights as one crew). A sane, coordinated
//            enemy class, `enemy` to both `player` and the `rim` watch that would
//            clear them; `neutral` to the deep's own things (fauna/wild/umbral) —
//            the camp squats among the vermin, not against it.
```

No logic change — comment only.

- [ ] **Step 2: CHANGELOG entry**

Under `[Unreleased]` (create an `### Added` section if absent), add:

```markdown
- **The Graveworker's den (d5 mini-dungeon, names provisional).** West of the
  Thornreach browse a new grazing-edge room (The Far Verge) drops down a
  human-improved descent to depth 5, through a squeeze into a human-made tunnel,
  and behind an unlocked plank door: a four-room den where an outlaw necromancer
  wires the dead back onto their feet with glimmer shard-wire. Four new `outlaw`
  mobs (risen thornbug, stitched prospector, summon-only wired skeleton, and the
  Graveworker — summons skeleton pairs, casts Mage Armour and the new Leech),
  four fixtures (including the den door and his journal), and a sealed west face
  reserved for future content. Boss item loot deferred to a follow-up pass.
- **New spell-effect type `drain` + spell: Leech (mana-only life drain).** A
  hostile drain lands like a damage weave and heals the caster for half the
  damage dealt (capped at max hp), in both cast directions. Mob-castable and
  player-ready (`HOSTILE_EFFECTS`/`MOB_CASTABLE`/validator updated); not yet
  learnable by players.
```

- [ ] **Step 3: Final gates**

Run: `npm test`
Expected: all pass.
Run: `npm run validate`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add server/factions.js CHANGELOG.md
git commit -m "docs: note the wired dead under the outlaw faction; changelog for the Graveworker's den"
```

---

### Task 6: Manual smoke test (test instance, port 3738)

- [ ] **Step 1: Start the test server** (`server/` changes need a restart to be picked up)

Run: `$env:PORT = '3738'; npm start` (`server/config.js` reads `PORT`, default 3737 is the live instance — do not use it).

- [ ] **Step 2: Walk the route** (login is name-only; an `admin` account exists)

Checklist:
1. From `d4.thornreach.approach`, `west` → The Far Verge renders, niche fixture examinable, a thornbug may wander in.
2. `down`, `west`, `west` → descent/pinch/gallery in the dark (carry a light); `look` shows the plank door and the sealed face.
3. `open door`, `south` → The Cold Porch is **bright** (ambient 3) and the risen thornbugs engage and ignore your light level.
4. `south` then `west` → the stitched prospector guards the store; hidden crystal found with `search` at perception 4+.
5. `south` from the workroom → the Graveworker: watch for the skeleton-pair summon, a Leech cast (your hp down, his up, the "stolen warmth" line), and a Mage Armour self-cast.
6. Kill him: xp/shards pay out, **no item drops** (deferred by design).

- [ ] **Step 3: Stop the test server.**

---

### Task 7: Push + PR

- [ ] **Step 1: Push the branch**

```bash
git push -u origin HEAD
```

- [ ] **Step 2: Open the PR via compare URL** (no `gh` on this machine)

Give the maintainer the compare URL
`https://github.com/<owner>/<repo>/compare/main...<branch>` (fill in from
`git remote get-url origin`) with:

- **Title:** `feat: the Graveworker's den — d5 necromancer mini-dungeon west of Thornreach`
- **Body:** summary of the area (8 rooms, 4 mobs, Leech/drain, door + sealed
  face), a note that **all names are provisional pending sign-off**, the
  deferred items (boss loot, quest hook, west face), and links to the spec
  (`docs/superpowers/specs/2026-07-07-graveworker-den-design.md`) and plan.
  End with: 🤖 Generated with [Claude Code](https://claude.com/claude-code)

Maintainer reviews and squash-merges; do not self-merge.
