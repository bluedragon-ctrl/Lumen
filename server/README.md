# Lumen Server

Authoritative, in-memory game server for Lumen. Loads the static world
(`data/world/`) into memory, runs the living-world tick loop, and serves both
the browser client and the live WebSocket on a single port.

## Running

```sh
# Live server (default port 3737)
npm start
#   → http://localhost:3737

# Test server (adjacent port, throwaway world)
PORT=3738 node server/index.js          # macOS / Linux
$env:PORT=3738; node server\index.js     # Windows PowerShell
```

| Instance | Port | Purpose |
|----------|------|---------|
| Main     | 3737 | Live shared world |
| Test     | 3738 | Throwaway / dev instance |

The port is overridable via the `PORT` environment variable.

Until the real client lands (PR #3), opening the root URL serves a **temporary
dev console** — a bare WebSocket tester so the server is previewable.

## Architecture

- **`config.js`** — ports, tick interval, paths, version.
- **`light.js`** — the light model: `bandOf`, `effectiveLight`, `canSee`,
  `isHarmedByLight`, and `playerLightContribution` (diminishing returns on
  stacked delver light so a crowd can't trivially reach `searing`).
- **`world.js`** — `loadWorld()`: reads static content into a frozen object.
- **`state.js`** — `GameState`: authoritative dynamic state (players, per-room
  mob/item instances), light computation, tick advance, snapshotting.
- **`events.js`** — event rendering: turns engine events (tick + command) into
  client messages, one handler per event type.
- **`index.js`** — HTTP + WebSocket server, connection handling, tick loop.

Dynamic state is snapshotted to `data/runtime/` (gitignored) every
`SNAPSHOT_EVERY_TICKS` ticks.

## WebSocket message protocol (v0)

JSON messages over a single socket per player.

### Login

On connect (and after every create/delete) the server sends the login-screen
roster; the client renders it as a pick / create / claim / delete screen. Every
account is **password-protected** — a password guards account *identity* (only
the owner logs in as, or deletes, a character), not server access:

```json
// server → client: the roster. `needsPassword` marks an account with no
// password yet — claimed by setting one on first login (see below).
{ "type": "accounts",
  "accounts": [{ "name": "Bob", "level": 3, "needsPassword": false },
               { "name": "Kara", "level": 1, "needsPassword": true }],
  "showAdmin": true, "adminName": "admin", "adminNeedsPassword": false,
  "requireInvite": false, "notice": null }

// client → server: log in, claim (set a first password), create, or delete.
{ "type": "login", "name": "Bob", "password": "…" }
{ "type": "claim-password", "name": "Kara", "password": "…" }   // migration first login
{ "type": "create-account", "name": "Zed", "password": "…", "inviteKey": "…" }  // auto-logs in
{ "type": "delete-account", "name": "Kara", "password": "…" }

// server → client: on a successful login / create / claim
{ "type": "authenticated", "name": "Bob", "admin": false }
```

Passwords are hashed with Node's built-in `crypto` (scrypt + a random per-account
salt, constant-time verify — no third-party dep); `salt` + `passwordHash` live on
the per-character JSON. Wrong password → a clear error, no login. **Claim-on-first-
login:** an account written before passwords existed has no hash; setting one via
`claim-password` locks it in. Wrong-password, missing-password (claim needed), and
already-logged-in are all reported as `error` frames.

**Registration gate.** Creating a prospector is open by default. Set the
**`INVITE_KEY_HASH`** environment variable and `create-account` then requires a
matching `inviteKey`; the roster's `requireInvite` flag tells the client to show
the field. The configured value is a hashed `salt:hash` string (the plaintext key
never touches disk) — generate it with `npm run hash-invite-key -- <key>` (→
`tools/hash-invite-key.js`) and share the plaintext with invitees. It's one shared
secret, not per-character. A light gate for now; a fuller invite/registration
system is deferred to a later security-hardening pass. See `.env.example` for all
server env vars.

Admin accounts never appear in `accounts` — they're offered separately via
`adminName`, and the whole admin option is hidden (and admin logins refused)
when `SHOW_ADMIN_LOGIN` is off in `server/config.js` (env: `SHOW_ADMIN_LOGIN=0`).
The `admin` account is auto-created on first boot and reads its password from the
**`ADMIN_PASSWORD`** environment variable, stamped on each boot so an operator can
set or rotate it without editing the account file — set it before a public deploy
so the first visitor can't claim admin. Left unset in local dev, admin claims a
password on first login like any other account (the server logs a warning while
it's unclaimed). Admins can also create prospectors in-game with `@create-player
<name>`. Delete is refused for admin accounts and for any prospector currently
logged in. Accounts persist as one JSON file per character under
`data/runtime/players/` (gitignored), saved on disconnect and periodically.

### Commands

**Client → Server**

```json
{ "type": "command", "text": "look" }
```

Admin commands are prefixed with `@` (`@create-player`, `@list-players`,
`@shards <n>`, `@attr <attribute> <value>`, `@help`).

**Server → Client**

```json
{ "type": "system", "text": "Welcome to Lumen…" }     // session/world notices
{ "type": "log",    "text": "A lightbug drifts in." }  // event feed
{ "type": "error",  "text": "malformed message" }      // problems

{ "type": "player", "player": { "name", "level", "xp", "shards", "hp", "maxHp",
  "mana", "maxMana", "energy", "speed", "armour", "ward", "evasion", "crit",
  "attributes", "perception", "equipment", "inventory", "states", "recipes" } }  // always full truth

{ "type": "room", "room": { "id", "name", "depth",
  "light": { "value", "band" }, "canSee", "harmed",
  "description",                                        // null when canSee=false
  "exits": ["down", "east"],
  "contents": { "players", "mobs", "items", "fixtures" } } }  // filtered by light
```

```json
{ "type": "examine", "entity": { "kind": "mob|item|fixture|player", "id", "name",
  "description", "bars": [{ "label", "value", "max", "kind" }],
  "lines": ["type: weapon", "damage: 1d6 physical"], "hints": ["…"] } }
```

**Inline colour markup.** Any console `text` (`system` / `log` / `error` /
`combat` / `gold`) may contain `<#name>` tags: the named colour tints the rest
of that line and resets at the next newline. The palette is small and themed
(`gray`, `red`, `green`, `gold`, `blue`, `cyan`, `magenta`, `rainbow`) and maps
to the same CSS variables as the semantic `line-*` classes — unknown names are
dropped. This is for *authored* emphasis within a line (e.g. greying recipes you
can't afford, a `<#rainbow>` boss name); the message `type` still carries the
line's *meaning* and base colour. Player-typed text (`say`/`emote`) has these
tags stripped server-side (`stripMarkup`), so markup stays trusted styling.

`look <target>` (and clicking an entity) returns an `examine` view rendered in
the Inspect window. The payload is generic — `bars` (e.g. HP), `lines` (specs),
`hints` (interactions) — so it extends without protocol churn. A subsequent
`room` message (move / `look` with no arg) returns the Inspect window to the
live room.

The `room` view is filtered by what the viewer can perceive: in darkness the
description and most contents are withheld, but self-illuminating things (a
lightbug) still appear. Commands handled today: `look [target]`, movement
(`n/s/e/w/u/d`, `go <dir>`), `get`/`take`, `drop`, `inventory`, `say`, `emote`,
`attack`/`kill`/`stop`, `search` (find hidden features), `equip`/`wield`/`wear`,
`unequip`/`remove`, `light [item]`/`douse`, `list`/`buy`/`sell`, `recipes`/`craft`,
`drink`/`quaff`,
`use`/`switch` (operate a fixture here, else drink), `open`/`close` (a door fixture),
`refuel`/`fill`, `help`, and admin
`@`-commands. (`light` auto-swaps a spent source for a fuelled one.) Effects
visible to other players in the room (speech, arrivals/departures, picking
things up, combat) are broadcast to them.

### Combat

Tick-driven, Energy-gated. Each tick every actor banks `speed` action points
(capped); an attack fires when banked ≥ the weapon's `actionCost`, then deducts
it — faster actors/weapons act more often. `attack <target>` sets a pending
attack that resolves on subsequent ticks until the target dies, you `stop`, or
you move.

Accuracy is **light-gated**, in four tiers by how well the attacker sees the
target (per-actor thresholds `blindBelow`/`dimBelow`/`harmedAbove`):
**can't see** (below `blindBelow`) → 5% flailing; **partial/dim**
(`blindBelow`…below `dimBelow`) → 50%; **clear** (`dimBelow`…`harmedAbove`) →
100%; **glare** (above `harmedAbove`) → 50%. So lighting a torch lifts you from
dim/partial to clear *and* drops a light-sensitive deep-dweller into glare — a
mutual, exploitable condition. The light tier is then nudged by the attacker's
**Perception** (`+2%`/pt to hit) and the defender's **Wits** (`−2%`/pt evasion),
clamped to `[5%, 100%]` — so accuracy can compensate for darkness, and a dodgy
defender slips blows (mobs carry an optional `attack.hitBonus` / `evasion`).

Damage = `roll(dice) + floor(Might/4) − mitigation` (min 1), where the Might bonus
comes from the weapon's `scale` (default `{might,4}`) and mitigation is the
defender's **Armour** for physical damage or **Ward** for magical — every attack
carries a damage type (physical today; Ward is groundwork for spells). A
**critical hit** (`Perception×1%`, or a mob's `attack.crit`) doubles the offensive
roll before mitigation. Players sum Armour/Ward from gear plus innate Ward from
**Wits** (`×2`); mobs have innate `armour`/`ward`. Mob HP≤0 → death, loot
dropped to the room, **shards dropped as a floor pile anyone can `get`**, XP to the
killer. Player HP≤0 → the delver **falls and lies dying where they died** for
`DEATH_DELAY_TICKS` (a beat so the death registers, not an instant teleport), then
**wakes at the rim**, full HP, no penalty beyond lost progress (DESIGN v1). The fall
is `_beginDeath` (sets `player.dying`); `_dyingTick` counts it down each tick and
`_wakeAtRim` relocates and restores at zero. A delver who disconnects mid-fall wakes
whole on next login (see `admit`).

**Damage isn't only direct hits.** All HP loss flows through shared sinks
(`_hurtMob` / `_hurtPlayer`) so a death can come from the room or an effect, not
just a blow — spoils still drop where the victim stands, but XP is credited only
when a player is clearly responsible (else the kill is pure environment).
- **Light-bane** (`lightBane: { above, damage }` on a mob): each tick a mob in
  room light *above* its threshold is seared for `roll(damage)` — light as a
  weapon. Credited to the top-threat player if one is mid-fight. Carried by the
  deep-dweller (sears above 2) and the mini-boss Gnaw (above 3): bring a bright
  enough light and you can burn down a creature that won't flee it.
- **Damage-over-time** (`damage-over-time` status effect, `{ damage, duration,
  sourceId }`): a bleed/poison primitive ticked on **both players and mobs** by
  `_tickEffects`; a DoT kill credits its recorded `sourceId`. The scaffolding is
  in place; no bleed-inflicting content is authored yet.

**Repop** is data-driven per spawn rule: `{ mob, max, respawn }`. Each tick a
spawner below its `max` counts down `respawn` ticks and then puts one mob back in
its home room (a `mob-spawn` event). The cap counts a spawner's mobs wherever they
have since wandered, so roaming never multiplies the population. Omit `respawn`
for a static one-time spawn. Cadence stays on the single tick — cheap integer
countdowns, no separate timer. Timed events that aren't tied to a home-room cap
(an NPC that visits and leaves) live on the **Scheduler** instead (see below).

### The Scheduler (timed events)

Separate from repop and the Tide, the **Scheduler** (`state-scheduler.js`, config
`data/world/schedule.json`) runs data-driven timed events. Each entry fires on its
own `everyTicks` cadence and delegates the effect to an **action-type handler**
(`schedule-actions.js`); the engine owns only the timers, so new timed behaviours
are added by writing a handler, not by touching the loop. An entry:
`{ id, everyTicks, firstTicks?, action: { type, … } }` — `firstTicks` phases the
first fire (default `everyTicks`). A handler's `fire` may return a duration in
ticks to become a **duration action** (the engine calls its `end` that many ticks
later); anything else is a one-shot. A fire is skipped while an entry is still
active, so a short cadence can't stack overlapping runs. Purely in-memory — resets
on restart, like repop and the Tide.

The first action type is **`visit`** (`{ mob, room, stayTicks }`): a mob arrives in
a room, then leaves after `stayTicks`. It's an ordinary instance carrying no
spawner `origin` (never repops, never counts against a cap), so a `shop` template
makes it a trader through the usual trade path, and arrival/departure reuse the
`mob-spawn` (`spawnMessage`) and `mob-flee` (`despawnVerb`) events. The **visiting
trader** at the Landward Gate is the first — arriving every 20 min, trading 5 min,
then gone.

Each tick a mob takes **one weighted action** from its `actions` table
(`attack` / `emote` / `wander` / `idle`) among those currently available — so mobs
fight, mutter flavour lines, wander, or lurk with distinct personalities. Mob
actions you can't see read as "Something …". Mobs act in their own room only (no
cross-room pursuit yet); `wander` lets them roam between rooms, bounded by its
`scope` (`"zone"` keeps a mob in its current zone, `"any"` crosses zones).
Destinations can also be gated by room **`tags`** (free-form terrain labels like
`"water"`): an action's `requireTags` admits only rooms carrying *all* the listed
tags (a cave-fish that keeps to water), `forbidTags` rejects any room carrying one
(a surface beast that won't enter the deep dark). Untagged rooms are neutral —
excluded by `requireTags`, allowed by `forbidTags` — so a tagless world roams
exactly as before; tags only ever constrain mobs that ask for them. A
`flee` action (also `scope`- and tag-bounded) is a light trigger, not a weighted choice:
the instant room light rises above its `lightAbove`, the mob bolts for a random
exit, overriding everything else (even combat) — used by the dark-dwelling
gloom-crawler, which flees light above 3.

**Trading.** A mob with a `shop` block is a trader. Pricing is **data-driven from
item `value`**, not a per-trader script. In its room a player can `list` the wares,
`buy <item>` (deducts the item's `value`, or a per-shop `price` override, and hands
over a fresh instance) and `sell <item>` — the trader buys *any* valued item at its
`sellValue` (default 20% of `value`); there is no per-trader buy list. Currency
(`shards`) has no value and can't be sold. Shards are an abstract integer balance on
the character, shown in the player panel.

Mobs keep a minimal **aggro table** (`{ combatantId: threat }`, keyed by any
combatant — a player **or** a mob): trading blows earns threat and hostile mobs
engage any **enemy** present. A mob with live threat is *in combat* — it won't
`wander` away and strikes its highest-threat target. Threat is dropped when a
combatant leaves or dies (a fuller threat/decay/pursuit system later). A
**non-hostile** creature that is struck **retaliates** (it acts on the threat it
gains), provided it has an `attack` block — so a neutral lurker fights back when
provoked, while attack-less NPCs (shopkeepers) stay passive.

**Factions & mob-vs-mob.** Allegiance is **instance-level**: every mob carries a
`faction` (defaults to its template's, else `"wild"`; players are `"player"`) and an
optional `ownerId`. There are five — `player`, `rim`, `fauna`, `wild`, `umbral` — related by a
symmetric ally/enemy/neutral table (`factionRelation`), replacing the old
"differing = enemy" binary. `_areEnemies` (enemy) and the `helper` assist pass (ally)
both read it, so the same combat path resolves player↔mob *and* mob↔mob and a `rim`
guard defends players, NPCs, and fauna against `wild` predators while ignoring the
livestock. A `helper` now joins a fight an ally is in **or** steps in when an enemy is
the aggressor against an ally (covering a passive victim). A `"player"`-faction mob
fights enemies on sight (no `hostile` flag needed) and credits its `ownerId` on a
kill — the groundwork **summons** sit on; `@spawn <mobId> [count] [wild|player|rim|fauna|umbral]`
overrides faction for live testing. Beneficial spells (heal/buff) draw the caster
threat on whatever is fighting the mended ally, mirroring damage→threat.

### Posture — sit, sleep & rest recovery

Every actor (players and mobs) carries a **posture**: `standing` (default),
`sitting`, or `sleeping`. For players it's both a **recovery** mechanism and a
social one — HP does not regenerate while standing (only mana trickles), so resting
is the way to heal:

- `sit` (alias `rest`) — mends **1 HP and 1 MP every 5 ticks**; no effect on sight.
- `sleep` — mends **1 HP and 1 MP every 2 ticks**, but you go **blind**: while asleep
  your perception reads as 0 and the room as dark, so your room view is withheld.
- `stand` (alias `wake`) — get up. Moving, attacking, or casting **auto-stands** you
  first; being **struck** (melee or a hostile spell) instantly rouses you to standing
  *and* into the fight (auto-retaliation). Resting is barred mid-fight, and rest
  recovery *replaces* the standing mana trickle (no stacking).

Posture changes broadcast to the room and are tagged in others' views ("Bob (asleep)").
A player's posture **resets to standing on login** (a save can't strand you blind).

Mobs use the same field for **room/encounter design**: a mob template may declare
`"posture": "sitting"` or `"sleeping"` to author a dozing guardian or resting NPC.
A resting mob is **inert** — it won't wander, attack, or emote — until a blow
**rouses** it (a `mob-woke` event), giving authored ambush-style openings.

### Hidden features (`search`)

Any room feature can carry `hidden: { perception }` — groundItems, spawns, and
fixture entries (a fixture entry may be a template string *or* `{ template, hidden }`),
plus a parallel `room.hiddenExits: { <dir>: { to, perception, name } }`. Hidden
features are withheld from the room view and can't be targeted until `search`
reveals them. `search` reveals everything whose requirement is met by **effective
Perception** = the attribute × `hitChance(band, light)` (the combat light tiers), so
light is required to search well; it costs ~one action of energy. The room's lasting
secrets — hidden **exits** and **fixtures** — are recorded on `player.discovered`
(persisted, so a found passage stays found). Hidden **items** and **mobs** reveal
only ephemerally — in `GameState.revealedItems` / `.revealedMobs`, cleared on leaving
the room or disconnecting — so a stashed item you don't pick up is forgotten and must
be searched out again, and a lurking mob stays unseen *and inert* until a delver who
has revealed it provokes it.

An **`ambush`** mob is the exception to that inertness: it silently tracks the
unaware, takes a **sleeping** delver outright, and — once it has fully noticed one
who is awake but **lingering** in reach — carries a small per-action chance
(`AMBUSH_LINGER`) that its patience breaks and it strikes anyway. Either way the
blow from concealment is its own reveal (a `mob-ambush` appearance line), and it
fires no "spotted you" tell. It never chases unless it also carries `pursues`, so
a rooted ambusher (a carnivorous plant) or a leashed lair predator can always be
backed away from — the danger is standing still in its room, not passing through.

A find is **shared with everyone present**: the searcher points it out, so every
co-located delver gets the same reveal — permanent discoveries onto their
`player.discovered`, ephemeral item/mob reveals into their `revealedItems` /
`revealedMobs` — *regardless of their own Perception or light* (they're being shown
it). `search` returns `shared` so the caller can refresh onlookers' views even when
the searcher personally turned up nothing new.

### Crafting

`craft <recipe>` produces a recipe's `output` when the player is at a fixture whose
`station` matches, **knows** the recipe (`knownRecipes`), and has the `inputs` plus
any `shards` cost — all then consumed. `recipes` lists known recipes split into
**Here** (station in the room) and **Elsewhere** (station to seek appended),
ordered by output kind (gear by slot, then consumables, then materials), greying
any you can't currently afford the inputs for. Shards are both currency and a crafting
component (the abyss's reason-for-being), so recipes may spend them directly.

### Status effects & potions

Actors carry timed status effects (`player.states`) applied from a data-driven spec
`{ type, name, magnitude, duration }` — the same primitive a potion or (later) a
spell references. The tick loop counts down each effect and removes it on expiry.
Implemented primitive: `emit-light` (the actor radiates `magnitude` light, summed
into room light and shown as a glow). A **negative** `magnitude` is a *darkness
aura* — it subtracts from room light, so a shadow that self-casts one drinks the
chamber to black (see the `drink-light` spell). `drink`/`quaff`/`use <potion>`
applies the item's `consumable.effect`.

A second light-touching primitive, `douse`, is a hostile spell effect (no status):
on a player target it snuffs the equipped light (`lit → false`), forcing a relight
or a blind fight, and darkens the room at once. Both are mob-castable abilities,
built reusable for light-hating creatures (see the `snuff`/`drink-light` spells and
*the Starving Dark*).

### Switchable fixtures

A fixture template may carry a `switch` block (`{ emitsLight, on }`); each instance
holds live on/off state. `use`/`switch <fixture>` toggles it and recomputes room
light — e.g. the iron lamp at the shaft mouth adds 3 light when on. `use` operates a
matching fixture in the room, otherwise falls back to drinking.

### Doors (gated exits)

A fixture template may instead carry a `door` block (`{ dir, to, open }`); each
instance holds live open/shut state. While **open**, the room gains an exit `dir → to`
(movement and the room view both honour it); **shut**, that way reads as no exit at
all. `use <fixture>` toggles it, and `open`/`close <fixture>` set it explicitly — e.g.
the trapdoor in the Mage's Shed opens the way `down` to Vesper's warded cellar. The
data validator treats a room's door fixture as a graph edge, so a room reachable only
through a door still passes the reachability check.
