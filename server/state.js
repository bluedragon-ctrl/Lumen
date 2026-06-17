"use strict";
const { effectiveLight, canSee, hitChance, noticeChance } = require("./light");
const { rollDice } = require("./dice");
const { XP_BASE, XP_GROWTH, POINTS_PER_LEVEL } = require("./config");

/** Cumulative lifetime XP required to *reach* `level` (level 1 = 0). The
 *  increment for each step is XP_BASE * XP_GROWTH^(step-1), so successive levels
 *  cost XP_GROWTH× the last. See config.XP_BASE/XP_GROWTH. */
function xpForLevel(level) {
  let total = 0;
  let step = XP_BASE;
  for (let l = 1; l < level; l++) { total += step; step *= XP_GROWTH; }
  return total;
}

// Default melee scaling when a weapon omits its own `scale`: floor(Might / 4)
// added to physical damage. Mirrors a spell's `effect.scale`.
const MELEE_SCALE = { attr: "might", per: 4 };

// Rest recovery: a resting actor regains 1 HP and 1 MP every N ticks. Sitting is
// the lighter rest; sleeping the deeper (and blinding) one. Standing never regains
// HP (only the slow innate mana trickle). Posture is a shared actor concept —
// players use it for recovery + social; mobs use it to author dozing/resting NPCs.
const SIT_RECOVER_TICKS = 5;
const SLEEP_RECOVER_TICKS = 2;
// Global damper on ambient `emote` frequency: each emote action's authored
// weight is scaled by this before the per-tick action roll, thinning idle
// chatter without touching every template. Reacts are deliberately exempt —
// they already carry a per-player cooldown and can deliver quest nudges.
const EMOTE_WEIGHT_SCALE = 0.5;
const RESTING = (actor) => actor.posture === "sitting" || actor.posture === "sleeping";

/** Posture-aware sight: a *sleeping* actor perceives nothing — its room view goes
 *  dark and its own sight-gated rolls flail — regardless of room light. Sitting and
 *  standing use the actor's real perception band. Shared by render and targeting. */
function canPerceive(actor, light) {
  if (actor.posture === "sleeping") return false;
  return canSee(actor.perception, light);
}

/** The attacker's effective weapon: equipped hand weapon, or unarmed. `scale`
 *  is the attribute the weapon's damage grows with (default Might/4). */
function weaponOf(world, player) {
  const hand = player.equipment && player.equipment.hand;
  if (hand) {
    const t = world.items[hand.template];
    if (t.weapon) return {
      dice: (t.weapon.damage && t.weapon.damage.physical) || "1d2",
      actionCost: t.weapon.actionCost || 12,
      scale: t.weapon.scale || MELEE_SCALE,
      onHit: t.weapon.onHit || null, // on-hit effects applied to the struck defender
    };
  }
  return { dice: "1d2", actionCost: 10, scale: MELEE_SCALE, onHit: null }; // unarmed
}

// --- Defender-side triggers (onDamage) -------------------------------------
// `onDamage` is the general "when I'm struck" list, the defender-side mirror of
// the attacker's `onHit`. Each entry is an effect spec plus two extra axes the
// attacker side never needs: `target` ("attacker" — reflect/retaliate — or
// "self" — e.g. draw mana off a blow; default "attacker") and `on` (which damage
// sources fire it; default ["melee"], with "spell" reserved for a later castSpell
// wiring). `spikes: { damage, chance? }` is kept as terse authoring sugar for the
// commonest entry — a flat melee reflect — normalized here into an onDamage entry.
const spikesEntry = (s) => ({ type: "damage", damage: s.damage, chance: s.chance, target: "attacker", cause: "spikes", on: ["melee"] });

/** A mob's resolved onDamage triggers: explicit `onDamage` entries plus its
 *  `spikes` sugar (a reflect entry). */
function mobOnDamage(t) {
  const list = Array.isArray(t.onDamage) ? [...t.onDamage] : [];
  if (t.spikes) list.push(spikesEntry(t.spikes));
  return list;
}

/** A player's resolved onDamage triggers, gathered across equipped armour
 *  (`armour.onDamage` entries plus `armour.spikes` sugar). Lets gear punish or
 *  profit from being hit exactly as a mob does — none seeded yet. */
function playerOnDamage(world, player) {
  const list = [];
  for (const inst of Object.values(player.equipment || {})) {
    if (!inst) continue;
    const t = world.items[inst.template];
    if (!t || !t.armour) continue;
    if (Array.isArray(t.armour.onDamage)) list.push(...t.armour.onDamage);
    if (t.armour.spikes) list.push(spikesEntry(t.armour.spikes));
  }
  return list;
}

// Each point of Wits grants this much innate Ward (magic resist) and this much
// evasion (a flat reduction to an attacker's hit chance). Pure defensive stat.
const WARD_PER_WITS = 2;
const EVASION_PER_WITS = 0.02;
// Each point of Perception grants this much to-hit and this much crit chance.
const HIT_PER_PERCEPTION = 0.02;
const CRIT_PER_PERCEPTION = 0.01;
// Attribute-derived pools and the sight curve (see GameState.deriveStats).
const HP_PER_VITALITY = 5;
const MANA_PER_INTELLECT = 4;
const ATTR_BASELINE = 3; // starting value of every attribute
const SIGHT_PER_PERCEPTION = 5; // every +5 Perception over baseline lowers dimBelow by 1
// Aggro detection (see GameState._detectAndDecay): a proactive hunter accrues a
// decaying "notice" meter on each enemy it can perceive, at AGGRO_RATE × the
// light-tier noticeChance per action, capped at AGGRO_ENGAGE; once a target's
// detection reaches AGGRO_ENGAGE the mob engages (clear sight ≈ ENGAGE/RATE
// actions, impaired ≈ 2×, dark never). A target it can no longer perceive for
// AGGRO_GRACE actions decays by AGGRO_RATE/action until forgotten.
const AGGRO_RATE = 1; // detection gained per action at clear sight
const AGGRO_ENGAGE = 2; // detection threshold at which a mob commits to attack
const AGGRO_GRACE = 3; // actions a target stays unperceived before detection decays
// Out-of-combat recovery (see GameState._recoverMobsTick): a wounded mob that
// nothing is fighting or watching, in a room clear of living foes, knits its
// wounds shut. It must hold OOC_REGEN_DELAY ticks past its last combat first (so
// a brief retreat barely helps), then mends maxHp/OOC_REGEN_TICKS per tick to
// full. The counter to flee-heal-return: a real heal-trip finds the mob whole.
// A per-mob `regen: { delay, perTick }` overrides either knob.
const OOC_REGEN_DELAY = 5; // ticks out of combat before recovery starts
const OOC_REGEN_TICKS = 20; // ticks to mend from empty to full (sets the default rate)

/** A player's effective attributes: base attributes plus any flat modifiers
 *  from equipped gear (`armour.attrMod`, e.g. heavy iron that dulls Wits).
 *  Each result is floored at 0. The single source for attribute reads at combat
 *  time, so a penalty (or bonus) on gear flows through to-hit, melee damage,
 *  Ward and evasion alike. */
function effectiveAttributes(world, player) {
  const attrs = { ...(player.attributes || {}) };
  for (const inst of Object.values(player.equipment || {})) {
    if (!inst) continue;
    const t = world.items[inst.template];
    const mod = t && t.armour && t.armour.attrMod;
    if (!mod) continue;
    for (const [k, v] of Object.entries(mod)) attrs[k] = Math.max(0, (attrs[k] || 0) + v);
  }
  return attrs;
}

/** Defensive profile of a player: Armour (vs physical) and Ward (vs magical)
 *  from equipped gear plus innate Ward from Wits, and Wits-derived evasion.
 *  Mirrors the {armour, ward} block on armour items. Wits is read effective —
 *  heavy gear that dulls Wits costs both Ward and evasion. */
function playerDefence(world, player) {
  let armour = 0;
  let ward = 0;
  for (const inst of Object.values(player.equipment || {})) {
    if (!inst) continue;
    const t = world.items[inst.template];
    if (t.armour) {
      armour += t.armour.armour || 0;
      ward += t.armour.ward || 0;
    }
  }
  const wits = effectiveAttributes(world, player).wits || 0;
  ward += wits * WARD_PER_WITS;
  // Temporary defensive buffs (Glimmerskin): each active "protect" state adds its
  // baked-in armour/ward for as long as it lasts.
  for (const s of player.states || []) {
    if (s.type === "protect") { armour += s.armour || 0; ward += s.ward || 0; }
  }
  return { armour, ward, evasion: wits * EVASION_PER_WITS };
}

// Total action-speed penalty from equipped gear: heavy armour (`armour.speedPenalty`)
// slows the rate a player banks action-energy, and thus how often they act.
function equipSpeedPenalty(world, player) {
  let pen = 0;
  for (const inst of Object.values(player.equipment || {})) {
    if (!inst) continue;
    const t = world.items[inst.template];
    if (t && t.armour && t.armour.speedPenalty) pen += t.armour.speedPenalty;
  }
  return pen;
}

// A player's effective action speed after gear penalties — never below 1, so even
// the heaviest load still lets them act. Drives energy gain and the bank cap.
function effectiveSpeed(world, player) {
  return Math.max(1, (player.speed || 0) - equipSpeedPenalty(world, player));
}

// A mob's live defence: its template armour/ward/evasion plus any active
// "protect" buff states (e.g. a self-cast Glimmerskin). Mirrors how
// playerDefence folds protect states in for players, so a buffed mob is tougher
// against both melee and the wholesale-negate ward roll.
function mobDefence(template, mob) {
  let armour = template.armour || 0;
  let ward = template.ward || 0;
  for (const s of (mob && mob.states) || []) {
    if (s.type === "protect") { armour += s.armour || 0; ward += s.ward || 0; }
  }
  return { armour, ward, evasion: template.evasion || 0 };
}

// A flat damage bonus from a scaling attribute, e.g. {attr:"intellect", per:4}
// adds floor(intellect / 4). Used by both spells (effect.scale) and melee
// weapons (weapon.scale). No `scale` block → no attribute bonus.
function spellScaleBonus(attrs, scale) {
  if (!scale || !scale.attr) return 0;
  const v = (attrs && attrs[scale.attr] != null) ? attrs[scale.attr] : 0;
  return Math.floor(v / (scale.per || 1));
}

// A duration/lifetime bonus from a scaling attribute, in TICKS. Unlike the damage
// bonus above (where `per` is a divisor), here `per` is a multiplier — ticks of
// duration added per point of the attribute: {attr:"intellect", per:15} adds 15
// ticks per point of Intellect (so Witchfire's per:1 still yields `length = int`).
function durationScaleBonus(attrs, scale) {
  if (!scale || !scale.attr) return 0;
  const v = (attrs && attrs[scale.attr] != null) ? attrs[scale.attr] : 0;
  return Math.floor(v * (scale.per != null ? scale.per : 1));
}

// Resolve a `{ base?, scale? }` amount spec (e.g. a Glimmerskin armour/ward
// component) against effective attributes: flat base plus an attribute-scaled
// bonus. A bare number or null is accepted too. Used for baked-at-cast buffs.
function scaledAmount(attrs, spec) {
  if (spec == null) return 0;
  if (typeof spec === "number") return spec;
  return (spec.base || 0) + spellScaleBonus(attrs, spec.scale);
}

// Ward resists hostile *spell casts* as an all-or-nothing negation: each point
// of the target's Ward is this much chance to fizzle the spell entirely (works
// for damage and effect spells alike). 0.01 = 1% per point, and it is NOT capped
// — ward 100+ shrugs off magic outright (a deliberate design choice). Magical
// *weapon* hits are handled separately, as a percent damage cut in strike().
const WARD_RESIST_PER_POINT = 0.01;

/** True if a defender's Ward negates an incoming hostile spell this cast.
 *  Shared by both directions: player→mob (castSpell) and mob→player (_mobCast). */
function wardNegates(ward) {
  return (ward || 0) > 0 && Math.random() < ward * WARD_RESIST_PER_POINT;
}

/** Weighted random choice from `[{weight}, ...]`; null if the list is empty. */
function pickWeighted(options) {
  const total = options.reduce((s, o) => s + (o.weight || 1), 0);
  if (total <= 0) return null;
  let r = Math.random() * total;
  for (const o of options) {
    r -= o.weight || 1;
    if (r < 0) return o;
  }
  return options[options.length - 1];
}

// A hit can never be rarer than this, even against heavy evasion — there is
// always a sliver of a chance to land a blow (matches the can't-see floor).
const MIN_HIT = 0.05;

/** Resolve one swing.
 *  @param attacker { band, hitBonus, dmgBonus, crit } — light-perception band,
 *         flat to-hit bonus (Perception), flat damage bonus (weapon scale), crit chance.
 *  @param defender { armour, ward, evasion } — mitigation + dodge.
 *  Accuracy is the light tier (clear 100% / glare 50% / can't-see 5%) plus the
 *  attacker's hit bonus minus the defender's evasion, clamped to [MIN_HIT, 1].
 *  `sighted` drives miss-message wording; a crit doubles the damage roll. */
function strike(attacker, defender, light, dice, damageType = "physical") {
  const chance = Math.max(MIN_HIT, Math.min(1, hitChance(attacker.band, light) + (attacker.hitBonus || 0) - (defender.evasion || 0)));
  const sighted = canSee(attacker.band, light);
  if (Math.random() >= chance) return { hit: false, sighted, damage: 0, crit: false };
  let base = rollDice(dice) + (attacker.dmgBonus || 0);
  const crit = Math.random() < (attacker.crit || 0);
  if (crit) base *= 2; // a critical strike doubles the offensive damage, before mitigation
  // Physical blows are soaked flat by Armour. Magical-type blows are cut by Ward
  // as a PERCENT reduction (ward is a percentage: ward 50 → halved). A spell
  // *cast* is instead negated wholesale by Ward (see wardNegates); a magical
  // weapon always lands once it hits, but its bite is reduced here.
  const damage = damageType === "physical"
    ? Math.max(1, base - (defender.armour || 0))
    : Math.max(1, Math.round(base * (1 - (defender.ward || 0) / 100)));
  return { hit: true, sighted, damage, crit };
}

// Monotonic source of unique runtime ids. Every addressable runtime entity —
// players, mob instances, item instances, placed fixtures — gets one
// (`player.N`, `mob.N`, `item.N`, `fixture.N`). Authored static defs (rooms,
// templates) keep their own unique string ids.
// NOTE: resets on restart; when snapshot-resume lands we must seed this above
// the highest id seen in the snapshot to avoid collisions.
let nextEntityId = 1;
const entityId = (prefix) => `${prefix}.${nextEntityId++}`;
/** Raise the counter past an existing id (e.g. when loading a saved account). */
function ensureIdAbove(id) {
  const n = typeof id === "string" ? parseInt(id.split(".")[1], 10) : NaN;
  if (!isNaN(n) && n >= nextEntityId) nextEntityId = n + 1;
}

/**
 * Create a runtime item instance from an authoring ItemRef (`{template, qty?, fuel?}`).
 * Stackables carry `qty`; fuelled light sources carry `fuel`/`lit`.
 */
function makeItemInstance(ref, world) {
  const tmpl = world.items[ref.template];
  if (!tmpl) throw new Error(`unknown item template: ${ref.template}`);
  const inst = { id: entityId("item"), template: ref.template };
  if (tmpl.stackable) inst.qty = ref.qty != null ? ref.qty : 1;
  if (tmpl.light) {
    inst.fuel = ref.fuel != null ? ref.fuel : tmpl.light.fuelMax;
    inst.lit = ref.lit || false;
  }
  return inst;
}

/**
 * Drop an item instance onto a room floor, merging into an existing stack of the
 * same stackable template (so three dead grubs read as "a dead grub ×3", not three
 * separate piles). Mirrors `addToInventory` on the carry side.
 */
function addToFloor(rt, inst, world) {
  const t = world.items[inst.template];
  if (t.stackable) {
    const ex = rt.items.find((i) => i.template === inst.template);
    if (ex) {
      ex.qty = (ex.qty || 1) + (inst.qty || 1);
      return;
    }
  }
  rt.items.push(inst);
}

// --- Economy ---------------------------------------------------------------
// Every (non-currency) item carries a `value` — the price to buy it from a
// trader. A trader pays SELL_RATE of that value when buying an item from a
// player; an item may override its sell price with an explicit `sellValue`.
const SELL_RATE = 0.2;
const buyValueOf = (t) => (t && t.value) || 0;
const sellValueOf = (t) => (t && t.sellValue != null ? t.sellValue : Math.round(buyValueOf(t) * SELL_RATE));

/** Create a runtime mob instance from a mob template id. */
function makeMobInstance(mobId, world) {
  const tmpl = world.mobs[mobId];
  if (!tmpl) throw new Error(`unknown mob template: ${mobId}`);
  return {
    id: entityId("mob"),
    template: mobId,
    hp: tmpl.maxHp,
    maxHp: tmpl.maxHp,
    energy: 0, // accumulated action points
    aggro: {}, // combatantId -> threat; key is any combatant (player OR mob) id, see _addThreat()
    // Instance-level faction (the side this creature fights FOR). Default "wild";
    // a summon/ally spawns as "player". Faction defines sides — `_areEnemies` makes
    // differing factions hostile — while `hostile`/provocation still gate active
    // aggression. `ownerId` names the player a "player"-faction mob belongs to
    // (kill credit, future pet upkeep); null for wild creatures.
    faction: "wild",
    ownerId: null,
    summonerId: null, // who conjured it (player or mob id); null if not summoned
    summonGroup: null, // per-owner recast-cap key (defaults to the source spell id)
    expiresIn: null, // ticks until it winks out; null = permanent
    noSpoils: false, // summoned creatures drop no loot/XP on any death
    posture: tmpl.posture || "standing", // authored dozing/resting NPCs; inert until roused
  };
}

/** The faction a combatant fights for. Players are always "player"; a mob carries
 *  its instance `faction` (default "wild"). Differing factions are enemies. */
function combatantFaction(actor, kind) {
  return kind === "player" ? "player" : (actor.faction || "wild");
}

/** Total light an actor radiates from active `emit-light` status effects. */
function actorEmitLight(actor) {
  let sum = 0;
  for (const s of actor.states || []) if (s.type === "emit-light") sum += s.magnitude || 0;
  return sum;
}

// --- Hidden features (search) ----------------------------------------------
// A room feature (item, fixture, exit, mob) may carry a `hidden: { perception }`
// block; it is omitted from a player's view until they `search` and meet the
// requirement. Permanent finds (items/fixtures/exits) are recorded per-player as
// stable discovery keys on `player.discovered`; mob reveals are ephemeral
// (in-memory, current-visit only — see GameState.revealedMobs).
const discoveryKey = (roomId, kind, ident) => `${roomId}|${kind}|${ident}`;
const isDiscovered = (player, key) => Array.isArray(player.discovered) && player.discovered.includes(key);

/** Effective Perception for searching: the attribute scaled by how well the player
 *  sees the room — the same light tiers combat uses (darkness ×0.05, dim/glare
 *  ×0.5, clear ×1.0). So light is required to find what's hidden. */
function effectivePerception(world, player, light) {
  const per = effectiveAttributes(world, player).perception || 0; // includes gear (e.g. a ring of sight)
  return per * hitChance(player.perception, light);
}

// Visibility predicates — a hidden feature is shown only once discovered/revealed.
// Reused by the room view (render.js) and command resolvers so filtering matches.
const itemVisibleTo = (player, inst) => !inst.hidden || isDiscovered(player, inst.discoveryKey);
const fixtureVisibleTo = (player, inst) => !inst.hidden || isDiscovered(player, inst.discoveryKey);
const mobVisibleTo = (state, player, mob) => {
  if (!mob.hidden) return true;
  const set = state.revealedMobs.get(player.id);
  return !!(set && set.has(mob.id));
};

/**
 * Authoritative in-memory world state (DESIGN.md §6.1). Owns all dynamic state:
 * per-room mob/item instances and connected players. Static content lives in `world`.
 */
class GameState {
  constructor(world) {
    this.world = world;
    this.tick = 0;
    this.players = new Map(); // playerId -> player instance
    this.playersByRoom = new Map(); // roomId -> Set(player instance); kept in sync with player.location
    this.rooms = {}; // roomId -> { mobs:[], items:[], light:int }
    this.revealedMobs = new Map(); // playerId -> Set(mob runtime id); ephemeral hidden-mob reveals
    this.ownedCounts = new Map(); // `${roomId}|${mob}` -> living mobs from that spawner (see _countOwned)
    this._initRooms();
  }

  _initRooms() {
    // Spawners drive repop: each remembers its room, mob, population cap, and a
    // countdown. A rule without `respawn` is static (spawned once, never refills).
    this.spawners = [];
    // Harvesters regrow a picked-up floor item after a delay (mushrooms, seeps,
    // …). A groundItem without `respawn` is static (placed once, gone when taken).
    this.harvesters = [];
    for (const [id, room] of Object.entries(this.world.rooms)) {
      this.rooms[id] = { mobs: [], items: [], fixtures: [], light: room.ambientLight || 0 };
      for (const g of room.groundItems || []) {
        const inst = makeItemInstance(g, this.world);
        if (g.respawn != null) {
          inst.origin = { roomId: id, template: g.template, harvest: true }; // tags it for regrow tracking
          this.harvesters.push({ roomId: id, template: g.template, qty: g.qty != null ? g.qty : 1, respawn: g.respawn, timer: g.respawn });
        }
        if (g.hidden) { inst.hidden = g.hidden; inst.discoveryKey = discoveryKey(id, "item", g.template); }
        this.rooms[id].items.push(inst);
      }
      for (const f of room.fixtures || []) {
        // A fixture entry is a template string, or an object `{ template, hidden }`.
        const tmplId = typeof f === "string" ? f : f.template;
        const inst = { id: entityId("fixture"), template: tmplId };
        const ft = this.world.fixtures[tmplId];
        if (ft && ft.switch) inst.on = !!ft.switch.on; // switchable fixtures carry on/off state
        if (ft && ft.door) inst.open = !!ft.door.open; // door fixtures carry open/shut state
        if (ft && (ft.mine || ft.fish || ft.harvest)) { const res = ft.mine || ft.fish || ft.harvest; inst.charges = res.charges; inst.regrow = res.respawn; } // resource veins/pools/beds deplete as worked
        if (typeof f === "object" && f.hidden) { inst.hidden = f.hidden; inst.discoveryKey = discoveryKey(id, "fix", tmplId); }
        this.rooms[id].fixtures.push(inst);
      }
      for (const s of room.spawns || []) {
        const max = s.max != null ? s.max : 1;
        for (let i = 0; i < max; i++) this._spawnMob(id, s.mob, s.hidden);
        if (s.respawn != null) this.spawners.push({ roomId: id, mob: s.mob, max, respawn: s.respawn, timer: s.respawn, hidden: s.hidden });
      }
      this.rooms[id].light = this.computeRoomLight(id);
    }
  }

  /** Create a mob instance, tag it with the spawner that owns it, and place it. */
  _spawnMob(roomId, mobId, hidden) {
    const m = makeMobInstance(mobId, this.world);
    m.origin = { roomId, mob: mobId }; // which spawner this counts against (survives wandering)
    if (hidden) m.hidden = hidden; // a lurker — unseen/inert until a delver searches it out
    this.rooms[roomId].mobs.push(m);
    this._adjustOwned(m, +1);
    return m;
  }

  /**
   * The summon primitive. Conjures `count` instances of `mobId` into `roomId`,
   * stamped with faction/ownership/lifetime, and places them WITHOUT a spawner
   * `origin` (so they never respawn or count against a room's spawn cap). Used by
   * both the player Summon spell (faction "player", an ownerId, a lifetime) and a
   * mob `summon` action (faction "wild", a summonerId, permanent). Pushes one
   * `summon` event for narration. Returns the new instances.
   */
  _summon({ roomId, mobId, count = 1, faction = "wild", ownerId = null, summonerId = null, group = null, lifetime = null, by = "mob", byName = null, verb = null }, events = []) {
    const t = this.world.mobs[mobId];
    if (!t) throw new Error(`summon: unknown mob template ${mobId}`);
    const made = [];
    for (let i = 0; i < count; i++) {
      const m = makeMobInstance(mobId, this.world);
      m.faction = faction;
      m.ownerId = ownerId;
      m.summonerId = summonerId;
      m.summonGroup = group;
      m.expiresIn = lifetime;
      m.noSpoils = true;
      this.rooms[roomId].mobs.push(m);
      made.push(m);
    }
    this.rooms[roomId].light = this.computeRoomLight(roomId); // a glowing summon lights the room
    events.push({
      type: "summon", roomId, by, byId: by === "player" ? ownerId : summonerId, byName,
      mobTemplate: mobId, mobName: t.name, emitsLight: !!t.emitsLight,
      count: made.length, light: this.rooms[roomId].light, verb,
    });
    return made;
  }

  /** Remove a summoned mob from the world silently — no corpse, loot, XP, or death
   *  event, just a `summon-end`. Finds the mob's room by scan (few summons exist). */
  _dismissSummon(mob, reason, events = []) {
    for (const [roomId, rt] of Object.entries(this.rooms)) {
      const idx = rt.mobs.indexOf(mob);
      if (idx < 0) continue;
      rt.mobs.splice(idx, 1);
      mob.hp = 0; // mark gone for any lingering reference
      rt.light = this.computeRoomLight(roomId);
      const t = this.world.mobs[mob.template];
      events.push({ type: "summon-end", roomId, mobName: t.name, emitsLight: !!t.emitsLight, light: rt.light, reason });
      return;
    }
  }

  /** A skittish prey mob slips out of the world — no corpse, loot, or XP, just a
   *  `mob-flee` tell. Unlike a summon's dismissal this frees its spawner slot
   *  (`_adjustOwned(-1)`) so the bed repops on the normal timer. Called from the
   *  skittish branch in `_mobAct`. */
  _bolt(m, t, roomId, events, verb) {
    const rt = this.rooms[roomId];
    const idx = rt.mobs.indexOf(m);
    if (idx < 0) return;
    rt.mobs.splice(idx, 1);
    m.hp = 0; // mark gone for any lingering reference
    this._adjustOwned(m, -1); // free the spawn slot — it repops on the room's timer
    rt.light = this.computeRoomLight(roomId);
    events.push({ type: "mob-flee", roomId, mobName: t.name, emitsLight: !!t.emitsLight, light: rt.light, verb: verb || "slips out of sight" });
  }

  /** Dismiss every summon owned by `ownerId` (owner death/disconnect). */
  _dismissOwnedSummons(ownerId, reason, events = []) {
    const owned = [];
    for (const rt of Object.values(this.rooms)) for (const m of rt.mobs) if (m.ownerId === ownerId) owned.push(m);
    for (const m of owned) this._dismissSummon(m, reason, events);
    return events;
  }

  /** Relocate a player's owned summons from `from` to `dest` (follow on move).
   *  Returns [{ mobName, emitsLight }] for the caller to narrate. Recomputes light
   *  in both rooms if anything moved. Wild (ownerless) summons never follow. */
  _moveSummonsWith(player, from, dest) {
    const rtFrom = this.rooms[from], rtDest = this.rooms[dest];
    const moved = [];
    for (const m of [...rtFrom.mobs]) {
      if (m.ownerId !== player.id) continue;
      const idx = rtFrom.mobs.indexOf(m);
      if (idx >= 0) rtFrom.mobs.splice(idx, 1);
      rtDest.mobs.push(m);
      const t = this.world.mobs[m.template];
      moved.push({ mobName: t.name, emitsLight: !!t.emitsLight });
    }
    if (moved.length) {
      rtFrom.light = this.computeRoomLight(from);
      rtDest.light = this.computeRoomLight(dest);
    }
    return moved;
  }

  /** Count living summons sharing a `summonerId` (a mob's living brood). */
  _broodCount(summonerId) {
    let n = 0;
    for (const rt of Object.values(this.rooms)) for (const m of rt.mobs) if (m.summonerId === summonerId && m.hp > 0) n++;
    return n;
  }

  /** Tick summon lifetimes: decrement `expiresIn`, wink out at zero. */
  _summonTick(events) {
    for (const rt of Object.values(this.rooms)) {
      for (const m of [...rt.mobs]) {
        if (m.expiresIn == null) continue;
        m.expiresIn -= 1;
        if (m.expiresIn <= 0) this._dismissSummon(m, "expired", events);
      }
    }
  }

  // --- Spawner population accounting -----------------------------------------
  // A spawner is identified by its (home room, mob) pair; mobs tag themselves
  // with that pair via `origin` at spawn and keep it as they wander. Rather than
  // rescan the whole world each tick, we keep a running per-spawner live count,
  // bumped at spawn (_spawnMob) and at death (every mob-removal path).
  _ownerKey(origin) {
    return origin ? `${origin.roomId}|${origin.mob}` : null;
  }
  /** Bump a mob's spawner count by `delta` (+1 spawned, −1 removed). */
  _adjustOwned(mob, delta) {
    const k = this._ownerKey(mob.origin);
    if (!k) return;
    const n = (this.ownedCounts.get(k) || 0) + delta;
    if (n > 0) this.ownedCounts.set(k, n);
    else this.ownedCounts.delete(k);
  }

  /** Living mobs that belong to a spawner, wherever they have since wandered. */
  _countOwned(roomId, mobId) {
    return this.ownedCounts.get(`${roomId}|${mobId}`) || 0;
  }

  /**
   * Repop: each tick, any spawner below its cap counts down; at zero it spawns one
   * mob back in its home room and rearms. At/above cap the timer stays primed, so
   * the full delay only begins once a kill (or a wandered-off mob) drops the count.
   */
  _respawnTick(events) {
    for (const sp of this.spawners) {
      if (this._countOwned(sp.roomId, sp.mob) >= sp.max) { sp.timer = sp.respawn; continue; }
      if (--sp.timer > 0) continue;
      sp.timer = sp.respawn;
      const m = this._spawnMob(sp.roomId, sp.mob, sp.hidden);
      const t = this.world.mobs[sp.mob];
      const light = this.rooms[sp.roomId].light = this.computeRoomLight(sp.roomId);
      events.push({ type: "mob-spawn", roomId: sp.roomId, mobId: m.id, mobName: t.name, emitsLight: !!t.emitsLight, light });
    }
  }

  /**
   * Regrow: each tick, any harvester whose home room no longer holds its tagged
   * floor item counts down; at zero it places a fresh one and rearms. Dropping a
   * matching item back on the floor (untagged) does not suppress regrow.
   */
  _harvestTick(events) {
    for (const hv of this.harvesters) {
      const present = this.rooms[hv.roomId].items.some(
        (it) => it.origin && it.origin.harvest && it.origin.template === hv.template
      );
      if (present) { hv.timer = hv.respawn; continue; }
      if (--hv.timer > 0) continue;
      hv.timer = hv.respawn;
      const inst = makeItemInstance({ template: hv.template, qty: hv.qty }, this.world);
      inst.origin = { roomId: hv.roomId, template: hv.template, harvest: true };
      this.rooms[hv.roomId].items.push(inst);
      const t = this.world.items[hv.template];
      events.push({ type: "item-regrow", roomId: hv.roomId, itemName: t.name });
    }
  }

  /**
   * Recover: each tick, any resource vein below its full charge count counts
   * down; at zero it refills to full and rearms. The timer only begins once the
   * seam has been worked below max, mirroring the spawner/harvester rhythm.
   */
  _mineTick(events) {
    for (const [roomId, rt] of Object.entries(this.rooms)) {
      for (const f of rt.fixtures) {
        const ft = this.world.fixtures[f.template];
        const res = ft && (ft.mine || ft.fish || ft.harvest);
        if (!res) continue;
        if (f.charges >= res.charges) { f.regrow = res.respawn; continue; }
        if (--f.regrow > 0) continue;
        f.charges = res.charges;
        f.regrow = res.respawn;
        events.push({ type: "vein-recover", roomId, fixtureName: ft.name, kind: ft.fish ? "fish" : ft.harvest ? "growth" : "ore" });
      }
    }
  }

  /** Players currently located in a room. O(occupants) via the room index. */
  playersIn(roomId) {
    const set = this.playersByRoom.get(roomId);
    return set ? [...set] : [];
  }

  // --- Room occupancy index --------------------------------------------------
  // `playersByRoom` mirrors every player's `location`, so `playersIn` (called
  // for each room every tick, and on every broadcast) stays O(occupants) rather
  // than rescanning all players. Every write to `player.location` MUST go through
  // setPlayerLocation (or admit/removePlayer) to keep the index honest.
  _indexPlayer(player) {
    let set = this.playersByRoom.get(player.location);
    if (!set) { set = new Set(); this.playersByRoom.set(player.location, set); }
    set.add(player);
  }
  _deindexPlayer(player) {
    const set = this.playersByRoom.get(player.location);
    if (set) { set.delete(player); if (set.size === 0) this.playersByRoom.delete(player.location); }
  }
  /** Move a player to a new room, keeping the occupancy index in sync. */
  setPlayerLocation(player, roomId) {
    this._deindexPlayer(player);
    player.location = roomId;
    this._indexPlayer(player);
  }

  /**
   * Effective light for a room: ambient + every active source present
   * (light-emitting mobs, plus players carrying a lit light source).
   */
  computeRoomLight(roomId) {
    const room = this.world.rooms[roomId];
    const rt = this.rooms[roomId];
    if (!room || !rt) return 0;
    const outputs = [];
    for (const m of rt.mobs) {
      const tmpl = this.world.mobs[m.template];
      if (tmpl && tmpl.emitsLight) outputs.push(tmpl.emitsLight);
      const e = actorEmitLight(m); // a mob could carry a light effect (e.g. a spell)
      if (e) outputs.push(e);
    }
    for (const f of rt.fixtures) {
      const ft = this.world.fixtures[f.template];
      if (!ft) continue;
      if (ft.switch && f.on) outputs.push(ft.switch.emitsLight || 0); // a lit lamp, etc.
      else if (ft.emitsLight) outputs.push(ft.emitsLight); // an always-glowing fixture (witchglow, sky-fissure)
    }
    for (const p of this.playersIn(roomId)) {
      const lightItem = p.equipment && p.equipment.light;
      if (lightItem && lightItem.lit && lightItem.fuel > 0) {
        const tmpl = this.world.items[lightItem.template];
        if (tmpl && tmpl.light) outputs.push(tmpl.light.output);
      }
      const e = actorEmitLight(p); // a held Light effect (potion/spell) glows too
      if (e) outputs.push(e);
    }
    return effectiveLight(room.ambientLight, outputs);
  }

  /**
   * Apply a status-effect primitive to an actor. `spec` is the data-driven
   * descriptor authored on a potion/spell, e.g.
   *   { type: "emit-light", name: "Light", magnitude: 1, duration: 180 }
   * Effects stack as independent instances, each with its own countdown; the
   * engine reads them where relevant (emit-light is summed into room light).
   * `spec.refresh` opts out of stacking: any existing instance of the same
   * type+name is dropped first, so re-applying just resets the timer (the right
   * behaviour for buffs like Glimmerskin; DoTs leave it unset to keep stacking).
   */
  applyEffect(actor, spec) {
    if (!actor.states) actor.states = [];
    const name = spec.name || spec.type;
    if (spec.refresh) actor.states = actor.states.filter((s) => !(s.type === spec.type && s.name === name));
    actor.states.push({
      type: spec.type,
      name,
      magnitude: spec.magnitude || 0,
      armour: spec.armour || 0, // flat defence buffs (see "protect" / playerDefence)
      ward: spec.ward || 0,
      damage: spec.damage || null, // dice string, for "damage-over-time" (bleed/poison)
      interval: spec.interval || null, // ticks between pulses, for periodic effects (heal-over-time)
      pulse: 0, // counts ticks toward the next pulse (see _tickEffects)
      sourceId: spec.sourceId || null, // player to credit if a DoT lands the kill
      source: spec.source || null, // "item" = sustained by worn/carried gear; survives death
      remaining: spec.duration != null ? spec.duration : null, // null = permanent
      good: spec.good !== false,
    });
  }

  /**
   * Instantly restore hp and/or mana (a consumable's `restore` effect), clamping
   * to the actor's maxima. Returns the amounts actually applied.
   */
  applyRestore(actor, spec) {
    const out = { hp: 0, mana: 0 };
    if (spec.hp) {
      const before = actor.hp;
      actor.hp = Math.min(actor.maxHp, actor.hp + spec.hp);
      out.hp = actor.hp - before;
    }
    if (spec.mana) {
      const before = actor.mana || 0;
      actor.mana = Math.min(actor.maxMana, before + spec.mana);
      out.mana = actor.mana - before;
    }
    return out;
  }

  /**
   * Tick active status effects on every actor (players and mobs): first apply any
   * `damage-over-time` (bleed/poison) through the shared damage sinks, then count
   * down timed effects and announce expiries. A DoT that kills its host stops that
   * actor's remaining ticks.
   */
  _tickEffects(events) {
    for (const p of this.players.values()) {
      if (!p.states || !p.states.length || p.hp <= 0) continue;
      let dead = false;
      for (const s of p.states) {
        if (s.type !== "damage-over-time" || !s.damage) continue;
        if (this._hurtPlayer(p, Math.max(1, rollDice(s.damage)), events, { cause: s.name || "bleed" })) { dead = true; break; }
      }
      if (dead) continue;
      for (const s of p.states) {
        if (s.type !== "heal-over-time" || !this._pulseReady(s)) continue;
        const healed = this._heal(p, s.magnitude);
        if (healed) events.push({ type: "regen-tick", playerId: p.id, amount: healed, name: s.name });
      }
      this._expireStates(p, events, (s) => ({ type: "effect-expired", playerId: p.id, effectType: s.type, name: s.name }));
    }
    for (const [roomId, rt] of Object.entries(this.rooms)) {
      for (const m of [...rt.mobs]) {
        if (!m.states || !m.states.length) continue;
        let dead = false;
        for (const s of m.states) {
          if (s.type !== "damage-over-time" || !s.damage) continue;
          const src = s.sourceId ? this.players.get(s.sourceId) : null;
          if (this._hurtMob(m, roomId, Math.max(1, rollDice(s.damage)), events, { cause: s.name || "bleed", killer: src && src.hp > 0 ? src : null })) { dead = true; break; }
        }
        if (!dead) {
          const t = this.world.mobs[m.template];
          for (const s of m.states) {
            if (s.type !== "heal-over-time" || !this._pulseReady(s)) continue;
            const healed = this._heal(m, s.magnitude);
            if (healed) events.push({ type: "mob-regen", roomId, mobId: m.id, mobName: t.name, amount: healed, name: s.name, emitsLight: !!t.emitsLight, light: rt.light });
          }
          this._expireStates(m, events, (s) => ({ type: "mob-effect-expired", roomId, mobId: m.id, mobName: t.name, effectType: s.type, name: s.name, emitsLight: !!t.emitsLight, light: rt.light }));
        }
      }
    }
  }

  /** Out-of-combat recovery: a wounded mob that nothing is fighting or watching,
   *  in a room with no living foe, knits its wounds shut. It must stay out of
   *  combat for `delay` ticks first — so darting out and back barely helps — then
   *  mends `perTick` HP toward full each tick, defaulting to maxHp/OOC_REGEN_TICKS
   *  so any mob recovers fully in ~OOC_REGEN_TICKS ticks regardless of size. This
   *  is the counter to flee-heal-return: a genuine heal-trip finds the mob whole
   *  again. `m.lastCombatTick` is stamped every tick the mob is alerted; a per-mob
   *  `regen: { delay, perTick }` overrides either knob (e.g. a slow-mending boss). */
  _recoverMobsTick(events) {
    for (const [roomId, rt] of Object.entries(this.rooms)) {
      const foePresent = this.playersIn(roomId).some((p) => p.hp > 0);
      for (const m of rt.mobs) {
        if (m.hp <= 0 || m.hp >= m.maxHp) continue;
        if (this._alerted(m)) { m.lastCombatTick = this.tick; continue; } // still in a fight
        if (foePresent) continue; // never mend in front of a living delver
        const reg = this.world.mobs[m.template].regen || {};
        const delay = reg.delay != null ? reg.delay : OOC_REGEN_DELAY;
        if (this.tick - (m.lastCombatTick != null ? m.lastCombatTick : -Infinity) < delay) continue;
        const perTick = reg.perTick != null ? reg.perTick : Math.max(1, Math.ceil(m.maxHp / OOC_REGEN_TICKS));
        const healed = this._heal(m, perTick);
        if (!healed) continue;
        const t = this.world.mobs[m.template];
        events.push({ type: "mob-regen", roomId, mobId: m.id, mobName: t.name, amount: healed, name: "recovery", emitsLight: !!t.emitsLight, light: rt.light });
      }
    }
  }

  /** Advance a periodic state's pulse counter; true on the tick its `interval`
   *  comes due (default every tick). Used by heal-over-time (and future pulses). */
  _pulseReady(s) {
    const every = s.interval || 1;
    if (++s.pulse < every) return false;
    s.pulse = 0;
    return true;
  }

  /** Restore up to `amount` HP to an actor (player or mob), clamped to its
   *  maximum. Returns the HP actually gained (0 if already full). */
  _heal(actor, amount) {
    if (!amount || actor.hp >= actor.maxHp) return 0;
    const before = actor.hp;
    actor.hp = Math.min(actor.maxHp, actor.hp + amount);
    return actor.hp - before;
  }

  /** Count down an actor's timed states, dropping (and announcing via `mkEvent`)
   *  any that reach zero. Permanent states (remaining == null) persist. */
  _expireStates(actor, events, mkEvent) {
    if (!actor.states) return;
    const expired = [];
    actor.states = actor.states.filter((s) => {
      if (s.remaining == null) return true;
      s.remaining -= 1;
      if (s.remaining <= 0) { expired.push(s); return false; }
      return true;
    });
    for (const s of expired) events.push(mkEvent(s));
  }

  /** Bonus max HP from equipped gear (`armour.maxHp`) — lets heavy armour add
   *  raw durability on top of Vitality. Summed across every equipped slot, so it
   *  is folded into `deriveStats` and refreshed whenever gear changes. */
  _equipHpBonus(player) {
    let bonus = 0;
    for (const inst of Object.values(player.equipment || {})) {
      if (!inst) continue;
      const t = this.world.items[inst.template];
      if (t && t.armour && t.armour.maxHp) bonus += t.armour.maxHp;
    }
    return bonus;
  }

  /** Bonus max Mana from equipped gear (`armour.maxMana`) — e.g. an Umbral
   *  glimmer-ring that deepens a caster's well. Summed across every equipped
   *  slot and folded into `deriveStats`, refreshed whenever gear changes. */
  _equipManaBonus(player) {
    let bonus = 0;
    for (const inst of Object.values(player.equipment || {})) {
      if (!inst) continue;
      const t = this.world.items[inst.template];
      if (t && t.armour && t.armour.maxMana) bonus += t.armour.maxMana;
    }
    return bonus;
  }

  /** The standing mana-regen rate for a player: the template's global trickle plus
   *  any bonus from equipped gear (`armour.manaRegen`, e.g. a glimmersteel coil).
   *  Summed across every slot and folded into `deriveStats`, refreshed whenever
   *  gear changes — so the base stays a tuning constant while gear can deepen it. */
  manaRegenFor(player) {
    let bonus = 0;
    for (const inst of Object.values(player.equipment || {})) {
      if (!inst) continue;
      const t = this.world.items[inst.template];
      if (t && t.armour && t.armour.manaRegen) bonus += t.armour.manaRegen;
    }
    return (this.world.playerTemplate.manaRegen || 0) + bonus;
  }

  /**
   * Recompute a player's derived stats from their attributes (DESIGN.md §3.2):
   * max HP (Vitality), max Mana (Intellect), the standing mana-regen rate (global
   * trickle + gear), and the low-light sight band (Perception). Idempotent —
   * always derived from `attributes`/gear plus the template's perception band as
   * the baseline-at-3 anchor, so it is safe to re-run on every admit and whenever
   * gear changes. Innate Ward/evasion (Wits), to-hit/crit (Perception), and melee
   * damage (Might) are applied live at combat time, not stored here. Does NOT
   * touch current hp/mana — callers clamp.
   */
  deriveStats(player) {
    const a = player.attributes || {};
    player.maxHp = (a.vitality || 0) * HP_PER_VITALITY + this._equipHpBonus(player);
    player.maxMana = (a.intellect || 0) * MANA_PER_INTELLECT + this._equipManaBonus(player);
    player.manaRegen = this.manaRegenFor(player);
    const band = this.world.playerTemplate.perception || { blindBelow: 1, dimBelow: 3, harmedAbove: 9 };
    const sight = Math.floor(((a.perception || 0) - ATTR_BASELINE) / SIGHT_PER_PERCEPTION);
    const dimBelow = Math.max(band.blindBelow, band.dimBelow - sight);
    player.perception = { blindBelow: band.blindBelow, dimBelow, harmedAbove: band.harmedAbove };
  }

  /** Credit `amount` lifetime XP to a player and resolve any level-ups it
   *  crosses. Mutates `xp`, `level` and `unspentPoints`; returns one
   *  `{ level, points }` per level gained (a big award can cross several). The
   *  caller narrates/broadcasts these (see index.js `level-up` handling). */
  awardXp(player, amount) {
    player.xp = (player.xp || 0) + (amount || 0);
    const ups = [];
    while (player.xp >= xpForLevel((player.level || 1) + 1)) {
      player.level = (player.level || 1) + 1;
      player.unspentPoints = (player.unspentPoints || 0) + POINTS_PER_LEVEL;
      ups.push({ level: player.level, points: POINTS_PER_LEVEL });
    }
    return ups;
  }

  /**
   * Build a fresh character from the static template. Returns plain player data;
   * it is NOT added to the live world (that's `admit`). Used both for new
   * accounts and the auto-created admin.
   */
  createCharacter(name, opts = {}) {
    const t = this.world.playerTemplate;
    const player = {
      id: entityId("player"),
      name,
      isAdmin: !!opts.isAdmin,
      level: t.level,
      xp: t.xp,
      unspentPoints: 0, // attribute points banked from level-ups, spent via `train`
      shards: t.shards || 0,
      attributes: { ...t.attributes },
      manaRegen: t.manaRegen || 0,
      speed: t.speed,
      energy: 0,
      location: t.startLocation,
      equipment: {},
      inventory: (t.startInventory || []).map((ref) => makeItemInstance(ref, this.world)),
      states: [], // active status effects (see applyEffect / _tickEffects)
      posture: "standing", // sit/sleep for rest recovery; resets to standing on login
      restTicks: 0, // counts ticks toward the next rest-recovery point (see _recoverTick)
      knownRecipes: [...(t.knownRecipes || [])],
      knownSpells: [...(t.knownSpells || [])],
      quests: { active: {}, done: [] }, // quest log: in-progress cursors + finished ids (see quests.js)
      visitedRooms: [t.startLocation], // first-entry explore XP; the spawn room is free
    };
    for (const [slot, tmplId] of Object.entries(t.startEquipment || {})) {
      player.equipment[slot] =
        tmplId == null ? null : makeItemInstance({ template: tmplId }, this.world);
    }
    this.deriveStats(player); // maxHp/maxMana/sight band from attributes
    player.hp = player.maxHp;
    player.mana = player.maxMana;
    return player;
  }

  /**
   * Admit a character (freshly created or loaded from an account) into the live
   * world. Seeds the id counter past any ids it carries so a post-restart load
   * can't collide with freshly minted ids.
   */
  admit(player) {
    ensureIdAbove(player.id);
    for (const inst of player.inventory || []) if (inst) ensureIdAbove(inst.id);
    for (const inst of Object.values(player.equipment || {})) if (inst) ensureIdAbove(inst.id);
    // A persisted location can name a room that no longer exists (e.g. content was
    // reworked since the save). Strand-proof it: fall back to the start room.
    if (!this.rooms[player.location]) player.location = this.world.playerTemplate.startLocation;
    // Likewise, drop carried/equipped items whose template was removed since the
    // save, so a content rework can't crash rendering on an orphaned instance.
    player.inventory = (player.inventory || []).filter((i) => i && this.world.items[i.template]);
    for (const slot of Object.keys(player.equipment || {}))
      if (player.equipment[slot] && !this.world.items[player.equipment[slot].template]) player.equipment[slot] = null;
    // Backfill fields added after this save was written (e.g. effects, recipes, spells).
    if (!Array.isArray(player.states)) player.states = [];
    if (!Array.isArray(player.knownRecipes)) player.knownRecipes = [...(this.world.playerTemplate.knownRecipes || [])];
    if (!Array.isArray(player.knownSpells)) player.knownSpells = [...(this.world.playerTemplate.knownSpells || [])];
    if (!Array.isArray(player.discovered)) player.discovered = []; // permanently-found hidden features (keys)
    // Quest log added later: backfill the container so older saves can take quests.
    if (!player.quests || typeof player.quests !== "object") player.quests = { active: {}, done: [] };
    if (!player.quests.active || typeof player.quests.active !== "object") player.quests.active = {};
    if (!Array.isArray(player.quests.done)) player.quests.done = [];
    if (player.unspentPoints == null) player.unspentPoints = 0; // banked attribute points (leveling added later)
    // Explore XP added later: seed with the current room so a pre-existing delver
    // isn't paid for re-treading ground, then earns from the next new room on.
    if (!Array.isArray(player.visitedRooms)) player.visitedRooms = [player.location];
    // Posture always resets to standing on login — a delver wakes up when they
    // reconnect, so a save can't strand them blind and asleep.
    player.posture = "standing";
    player.restTicks = 0;
    if (player.maxMana == null) player.maxMana = this.world.playerTemplate.maxMana;
    if (player.mana == null) player.mana = player.maxMana;
    player.hp = Math.min(player.hp, player.maxHp);
    player.mana = Math.min(player.mana, player.maxMana);
    // manaRegen's base is a global tuning constant (not per-character progress), so
    // always re-derive it — tuning changes then apply to existing saves too — adding
    // any bonus from gear worn into the session (e.g. a glimmersteel coil).
    player.manaRegen = this.manaRegenFor(player);
    // Admin always knows every recipe — handy for testing. Re-synced on each
    // login, so recipes added to the world after the admin save are picked up.
    if (player.isAdmin) player.knownRecipes = Object.keys(this.world.recipes);
    this.players.set(player.id, player);
    this._indexPlayer(player); // location is final by here — add to the occupancy index
    return player;
  }

  removePlayer(playerId) {
    const player = this.players.get(playerId);
    const events = [];
    if (player) {
      this._dismissOwnedSummons(player.id, "owner-gone", events); // disconnect unravels summons
      this._deindexPlayer(player);
    }
    this.players.delete(playerId);
    this.revealedMobs.delete(playerId); // drop ephemeral hidden-mob reveals on disconnect
    return events;
  }

  /** Forget a player's ephemeral hidden-mob reveals (e.g. on leaving a room). */
  clearRevealedMobs(playerId) {
    this.revealedMobs.delete(playerId);
  }

  /**
   * `search` the current room: reveal every hidden feature whose requirement is met
   * by the player's effective Perception (attribute × light tier — so light matters).
   * Permanent finds (items/fixtures/exits) are recorded on `player.discovered`;
   * hidden mobs are revealed ephemerally (this visit only). Returns { found, any }.
   */
  search(player) {
    const roomId = player.location;
    const room = this.world.rooms[roomId];
    const rt = this.rooms[roomId];
    const eff = effectivePerception(this.world, player, rt.light);
    if (!Array.isArray(player.discovered)) player.discovered = [];
    const found = [];

    for (const inst of rt.items) {
      if (inst.hidden && !isDiscovered(player, inst.discoveryKey) && inst.hidden.perception <= eff) {
        player.discovered.push(inst.discoveryKey);
        found.push(this.world.items[inst.template].name);
      }
    }
    for (const inst of rt.fixtures) {
      if (inst.hidden && !isDiscovered(player, inst.discoveryKey) && inst.hidden.perception <= eff) {
        player.discovered.push(inst.discoveryKey);
        found.push(this.world.fixtures[inst.template].name);
      }
    }
    for (const [dir, h] of Object.entries(room.hiddenExits || {})) {
      const key = discoveryKey(roomId, "exit", dir);
      if (!isDiscovered(player, key) && (h.perception || 0) <= eff) {
        player.discovered.push(key);
        found.push(h.name || `a passage ${dir}`);
      }
    }
    let set = this.revealedMobs.get(player.id);
    for (const m of rt.mobs) {
      if (!m.hidden) continue;
      if (!set) { set = new Set(); this.revealedMobs.set(player.id, set); }
      if (!set.has(m.id) && m.hidden.perception <= eff) {
        set.add(m.id);
        found.push(this.world.mobs[m.template].name);
      }
    }
    return { found, any: found.length > 0 };
  }

  /**
   * Per-tick vitals recovery for a player. Resting (sit/sleep) regains 1 HP and
   * 1 MP on a posture-set cadence and *replaces* the standing mana trickle while
   * it lasts; standing keeps the slow innate mana trickle and never regains HP.
   * Flags a `vitals` refresh whenever a *displayed* value changes, so an idle
   * resting player actually sees the bars climb (views aren't pushed every tick).
   */
  _recoverTick(p, events) {
    if (p.hp <= 0) return; // the dead don't mend; respawn restores them
    const every = p.posture === "sleeping" ? SLEEP_RECOVER_TICKS : p.posture === "sitting" ? SIT_RECOVER_TICKS : 0;
    if (every) {
      if (p.hp >= p.maxHp && p.mana >= p.maxMana) { p.restTicks = 0; return; } // fully mended
      if (++p.restTicks < every) return;
      p.restTicks = 0;
      const hpBefore = p.hp;
      const manaBefore = Math.floor(p.mana || 0);
      p.hp = Math.min(p.maxHp, p.hp + 1);
      p.mana = Math.min(p.maxMana, (p.mana || 0) + 1);
      if (p.hp !== hpBefore || Math.floor(p.mana) !== manaBefore) events.push({ type: "vitals", playerId: p.id });
      return;
    }
    // Standing: only the slow innate mana trickle (fractional, rendered floored).
    p.restTicks = 0;
    if (p.manaRegen && p.mana < p.maxMana) {
      const before = Math.floor(p.mana || 0);
      p.mana = Math.min(p.maxMana, (p.mana || 0) + p.manaRegen);
      if (Math.floor(p.mana) !== before) events.push({ type: "vitals", playerId: p.id });
    }
  }

  /** Rouse a resting actor (player or mob) to standing — they share `posture`.
   *  Returns true if it actually changed, so callers can announce the waking. */
  _rouse(actor) {
    if (RESTING(actor)) { actor.posture = "standing"; actor.restTicks = 0; return true; }
    return false;
  }

  /**
   * Advance the world one tick:
   *   1. accrue action-point energy (capped) for all actors
   *   2. burn fuel on lit lights (→ light-out events)
   *   3. recompute room light
   *   4. resolve combat (player attacks + hostile mob attacks), light-gated
   * Returns an event list the server turns into messages/view refreshes.
   */
  advance() {
    this.tick++;
    const events = [];

    for (const p of this.players.values()) {
      const sp = effectiveSpeed(this.world, p); // heavy gear (speedPenalty) slows action-energy gain
      p.energy = Math.min(p.energy + sp, sp * 3);
      this._recoverTick(p, events);
    }
    for (const rt of Object.values(this.rooms)) {
      for (const m of rt.mobs) {
        const speed = this.world.mobs[m.template].speed || 10;
        m.energy = Math.min((m.energy || 0) + speed, speed * 3);
      }
    }

    for (const p of this.players.values()) {
      const li = p.equipment && p.equipment.light;
      if (li && li.lit && li.fuel > 0) {
        const tmpl = this.world.items[li.template];
        li.fuel -= (tmpl.light && tmpl.light.burnPerTick) || 1;
        if (li.fuel <= 0) {
          li.fuel = 0;
          li.lit = false;
          // A non-refuellable light (a torch) is spent for good when it burns out —
          // there's nothing to refill, so the husk just clutters the slot. Consume it.
          const consumed = !(tmpl.light && tmpl.light.fuelItem);
          if (consumed) p.equipment.light = null;
          events.push({ type: "light-out", playerId: p.id, item: li.template, consumed });
        } else if (this.tick % 10 === 0) {
          // Fuel ticks down every tick, but the gauge only refreshes when the player
          // view is re-sent (on move, vitals, etc.). Nudge it periodically so an idle
          // player still watches their light burn down rather than jumping at the end.
          events.push({ type: "vitals", playerId: p.id });
        }
      }
    }

    this._tickEffects(events);

    // Per-tick light only changes where a dynamic source lives: a player (burning
    // fuel, an emit-light effect) or a mob (luminous, or an expiring light effect).
    // Rooms with neither hold their last value — ambient and fixtures are static
    // between events, which already recompute the affected room (move/toggle/spawn).
    for (const [id, rt] of Object.entries(this.rooms)) {
      const here = this.playersByRoom.get(id);
      if (rt.mobs.length === 0 && (!here || here.size === 0)) continue;
      rt.light = this.computeRoomLight(id);
    }

    this._environmentTick(events); // light-bane and other room hazards, on fresh light
    this.resolvePlayerAttacks(events);
    this.resolveMobAI(events);
    this._recoverMobsTick(events); // wounded, disengaged mobs knit their wounds (post-AI: aggro is freshly pruned)
    this._respawnTick(events);
    this._harvestTick(events);
    this._summonTick(events);
    this._mineTick(events);
    return events;
  }

  /** Narrate a status effect taking hold on an actor (player or mob). */
  _narrateEffectApplied(events, who, name) {
    if (who.kind === "mob")
      events.push({ type: "mob-effect-applied", roomId: who.roomId, mobId: who.id, mobName: who.name, name, emitsLight: who.emitsLight, light: this.rooms[who.roomId].light });
    else
      events.push({ type: "effect-applied", playerId: who.id, name });
  }

  /** Roll an effect spec's `chance` (default 1). True → it fires this hit. */
  _rollChance(spec) {
    return spec.chance == null || Math.random() < spec.chance;
  }

  /**
   * Apply one effect spec to a target actor, dispatching by type: instant
   * `damage` goes through the target's hurt sink (returns its death event, if
   * any); `restore` tops up hp/mana; everything else (`damage-over-time`,
   * `emit-light`, …) is a status via applyEffect. `creditId`, when set, stamps
   * the spec's `sourceId` so a DoT this lands credits that player on a kill.
   * Used for both attacker `onHit` (target = defender) and defender `onDamage`
   * (target = attacker or self).
   */
  _applyTriggerEffect(events, spec, target, hurt, creditId) {
    if (spec.type === "damage")
      return hurt(Math.max(1, rollDice(spec.damage)), spec.cause || "spikes");
    if (spec.type === "restore") {
      const got = this.applyRestore(target.actor, spec);
      if (target.kind === "player" && (got.hp || got.mana)) events.push({ type: "trigger-restore", playerId: target.id, hp: got.hp, mana: got.mana });
      return null;
    }
    const s = creditId ? { ...spec, sourceId: creditId } : spec;
    this.applyEffect(target.actor, s);
    this._narrateEffectApplied(events, target, s.name || s.type);
    return null;
  }

  /**
   * Process the outcome of one resolved **melee** swing, for either direction
   * (player→mob or mob→player), from a single place so both get the data-driven
   * contact triggers identically. Pushes the `attack` event, applies damage via
   * the caller's `defender.deal` sink, then on a *landed* hit fires:
   *   • attacker `onHit` — effect specs applied to the still-living defender (a
   *     venomous bite, a debuff). A player attacker stamps `sourceId` so a poison
   *     kill credits them; a mob's venom credits no one. Each hit stacks an
   *     independent instance, by design.
   *   • defender `onDamage` — the general "when struck" list (reflect, retaliate,
   *     draw mana off the blow). Each entry targets the `attacker` (default) or
   *     `self`, and fires only for a matching damage `source` (default melee).
   *     `spikes` is normalized into this list (see mobOnDamage/playerOnDamage).
   *     A reflected DoT credits the *defender* if it's a player (mirror of onHit).
   * `source` is the damage origin ("melee"); spells/ranged don't call this yet —
   * the `castSpell` path is where `on: ["spell"]` entries would later hook.
   * Returns { defenderDeath, attackerDeath } (each a death event or null) so the
   * caller can stop its swing loop and skip double-processing a death.
   */
  applyHitOutcome({ r, events, attackEvent, source = "melee", attacker, defender }) {
    events.push(attackEvent);
    let defenderDeath = defender.deal(r.damage); // damage + threat/kill (or respawn); pushes its own death event
    let attackerDeath = null;
    if (!r.hit) return { defenderDeath, attackerDeath };

    // Attacker onHit → the defender by default (venom, a debuff), but an entry marked
    // `target: "self"` (or "attacker") lands on the attacker instead — life-steal: a
    // blade that heals its wielder on a landed hit (the mirror of onDamage's target
    // axis). Self-target fires even on a killing blow (you drink life as you cut);
    // defender-target only while the defender still lives.
    if (attacker.onHit) {
      for (const spec of attacker.onHit) {
        if (!this._rollChance(spec)) continue;
        if (spec.target === "self" || spec.target === "attacker")
          this._applyTriggerEffect(events, spec, attacker, attacker.hurt, null);
        else if (!defenderDeath)
          this._applyTriggerEffect(events, spec, defender, defender.hurt, attacker.sourceId);
      }
    }

    // Defender onDamage → the attacker (reflect/retaliate) or self (mana-on-hit).
    // Reflect fires on contact regardless of whether the defender has an attack of
    // its own, and even on the blow that kills it.
    for (const entry of defender.onDamage || []) {
      if (!(entry.on || ["melee"]).includes(source)) continue;
      if (!this._rollChance(entry)) continue;
      const toAttacker = (entry.target || "attacker") === "attacker";
      const target = toAttacker ? attacker : defender;
      // A defender-applied DoT on the attacker credits the defender if it's a player.
      const credit = toAttacker ? defender.sourceId : null;
      const death = this._applyTriggerEffect(events, entry, target, target.hurt, credit);
      if (death) { if (toAttacker) attackerDeath = attackerDeath || death; else defenderDeath = defenderDeath || death; }
    }
    return { defenderDeath, attackerDeath };
  }

  /** Player pending-attacks. Accuracy gated by light; multiple swings if energy allows. */
  resolvePlayerAttacks(events) {
    const w = this.world;
    for (const p of this.players.values()) {
      if (p.hp <= 0 || !p.pending || p.pending.type !== "attack") continue;
      const rt = this.rooms[p.location];
      const mob = rt.mobs.find((m) => m.id === p.pending.targetId);
      if (!mob) {
        p.pending = null;
        events.push({ type: "combat-stop", playerId: p.id, reason: "Your quarry is gone." });
        continue;
      }
      const weapon = weaponOf(w, p);
      const mt = w.mobs[mob.template];
      const mobDef = mobDefence(mt, mob);
      const attrs = effectiveAttributes(w, p);
      const per = attrs.perception || 0;
      const attacker = {
        band: p.perception,
        hitBonus: per * HIT_PER_PERCEPTION,
        dmgBonus: spellScaleBonus(attrs, weapon.scale),
        crit: per * CRIT_PER_PERCEPTION,
      };
      const mobName = w.mobs[mob.template].name;
      const mobEmits = !!w.mobs[mob.template].emitsLight;
      // A dozing/resting mob is jolted awake the instant a delver strikes it —
      // the authored ambush payoff: free opening blows, then it fights back.
      if (this._rouse(mob)) events.push({ type: "mob-woke", roomId: p.location, mobId: mob.id, mobName, emitsLight: mobEmits, light: rt.light });
      // Stop swinging if the mob dies OR a spike reflect kills the player mid-loop.
      while (p.energy >= weapon.actionCost && mob.hp > 0 && p.hp > 0) {
        p.energy -= weapon.actionCost;
        const r = strike(attacker, mobDef, rt.light, weapon.dice, weapon.damageType || "physical");
        const attackEvent = {
          type: "attack", by: "player", attackerId: p.id, attackerName: p.name, roomId: p.location,
          targetId: mob.id, targetName: mobName, hit: r.hit, sighted: r.sighted,
          damage: r.damage, crit: r.crit, targetHp: Math.max(0, mob.hp - r.damage), targetMaxHp: mob.maxHp,
          light: rt.light, targetEmitsLight: mobEmits,
        };
        const { attackerDeath } = this.applyHitOutcome({
          r, events, attackEvent,
          attacker: {
            actor: p, kind: "player", id: p.id, name: p.name, emitsLight: false, roomId: p.location,
            onHit: weapon.onHit,
            sourceId: p.id, // a player-applied DoT credits them on the kill
            hurt: (dmg, cause) => this._hurtPlayer(p, dmg, events, { cause }), // reflect lands here
          },
          defender: this._mobDefender(mob, mt, p.location, { id: p.id, kind: "player", actor: p }, events),
        });
        if (attackerDeath) break; // a reflect killed the player — they've respawned away
      }
    }
  }

  /**
   * The full price of casting `spell`, in one place: mana, `shardCost` (glimmer burned
   * in the cast), and any `itemCost` material components (e.g. Glimmer Husk's chitin
   * plate). Returns a human-readable error string if the caster can't pay — nothing is
   * spent — or null if they can. The command handler calls this before committing.
   */
  costShortfall(player, spell) {
    const w = this.world;
    if (Math.floor(player.mana || 0) < (spell.manaCost || 0))
      return `You lack the mana for ${spell.name} (need ${spell.manaCost}, have ${Math.floor(player.mana || 0)}).`;
    if (spell.shardCost && (player.shards || 0) < spell.shardCost)
      return `${spell.name} burns ${spell.shardCost} shards as glimmer and you have ${player.shards || 0}.`;
    for (const need of spell.itemCost || []) {
      const have = (player.inventory || []).reduce((n, i) => (i && i.template === need.template ? n + (i.qty || 1) : n), 0);
      if (have < (need.qty || 1)) {
        const it = w.items[need.template];
        return `${spell.name} needs ${it ? it.name : need.template} (${need.qty || 1}) to shape, and you have ${have}.`;
      }
    }
    return null;
  }

  /**
   * Deduct a spell's full cost — mana, shards, and material components — in one place,
   * shared by every player cast-resolution path. Assumes the caster can pay (the
   * command handler has already run `costShortfall`). Shards are a currency counter,
   * not inventory, so they deduct numerically; `itemCost` pulls instances from the bag.
   */
  spendCost(player, spell) {
    player.mana = Math.max(0, (player.mana || 0) - (spell.manaCost || 0));
    if (spell.shardCost) player.shards = Math.max(0, (player.shards || 0) - spell.shardCost);
    for (const need of spell.itemCost || []) {
      let remaining = need.qty || 1;
      for (let i = player.inventory.length - 1; i >= 0 && remaining > 0; i--) {
        const inst = player.inventory[i];
        if (!inst || inst.template !== need.template) continue;
        const take = Math.min(remaining, inst.qty || 1);
        if (inst.qty != null && inst.qty > take) inst.qty -= take;
        else player.inventory.splice(i, 1);
        remaining -= take;
      }
    }
  }

  /**
   * Resolve an immediate spell cast by a player at a mob. Spends the cost, rolls the
   * target's Ward to (maybe) fizzle the whole spell, then applies the effect
   * primitive — today only `damage` (dice + scaling-attribute bonus). Hostile
   * spells earn the target's threat even when resisted. Returns a result the
   * caller narrates: { resisted } | { damage, killed, death }.
   *
   * Cost and target validation happen in the command handler; by here the cast
   * is committed. `events` is optional and used to push auto-retaliation events.
   */
  castSpell(player, spell, mob, events = []) {
    const w = this.world;
    const eff = spell.effect || {};
    this.spendCost(player, spell);

    const ward = mobDefence(w.mobs[mob.template], mob).ward || 0;
    if (spell.hostile && wardNegates(ward)) {
      this._addThreat(mob, player.id, 1); // a fizzled bolt still draws its ire
      return { resisted: true };
    }

    // Sleep: a non-damaging hex that drops a perceiving foe into slumber, making
    // it inert (see resolveMobAI) until any blow rouses it. Ward had its wholesale
    // chance to negate above; on success it draws no threat and does NOT rouse or
    // auto-engage — the point is to slip away or line up an ambush.
    if (eff.type === "sleep") {
      mob.posture = "sleeping";
      this.rooms[player.location].light = this.computeRoomLight(player.location);
      return { resisted: false, slept: true };
    }

    const result = { resisted: false };
    if (eff.type === "damage") {
      const damage = Math.max(1, rollDice(eff.damage) + spellScaleBonus(effectiveAttributes(w, player), eff.scale));
      this._addThreat(mob, player.id, Math.max(1, damage));
      mob.hp -= damage;
      result.damage = damage;
      if (mob.hp <= 0) {
        result.killed = true;
        result.death = this._killMob(mob, player); // removes mob, drops loot/shards, awards xp
      }
    } else if (eff.type === "damage-over-time") {
      // A clinging burn (Witchfire): no immediate blow, but a DoT stamped with the
      // caster so a smoulder-kill credits them (like a bleed). Intellect lengthens the
      // burn (more total damage, and a longer-lasting mark) rather than hitting harder.
      // Ward already had its wholesale chance to fizzle it above; per-tick damage runs
      // in _tickEffects.
      const duration = (eff.duration || 0) + durationScaleBonus(effectiveAttributes(w, player), eff.durationScale);
      this.applyEffect(mob, { type: "damage-over-time", name: eff.name || spell.name, damage: eff.damage, duration, sourceId: player.id, good: false });
      // The burning glimmer glows: a matching emit-light state marks the foe in the
      // dark for as long as it smoulders (summed into room light by computeRoomLight).
      if (eff.emitLight) this.applyEffect(mob, { type: "emit-light", name: eff.name || spell.name, magnitude: eff.emitLight, duration, good: false });
      this._addThreat(mob, player.id, 1);
      result.dot = true;
      result.duration = duration;
      result.name = eff.name || spell.name;
    } else if (spell.hostile) {
      this._addThreat(mob, player.id, 1);
    }
    // A kill may remove a luminous mob; refresh the room's light either way.
    this.rooms[player.location].light = this.computeRoomLight(player.location);

    // A hostile spell rouses a resting mob just as a blow does (only if it survived).
    if (spell.hostile && mob.hp > 0 && this._rouse(mob)) {
      const t = w.mobs[mob.template];
      events.push({ type: "mob-woke", roomId: player.location, mobId: mob.id, mobName: t.name, emitsLight: !!t.emitsLight, light: this.rooms[player.location].light });
    }

    // Auto-retaliate on hostile spell: if the player isn't already attacking something, target this mob
    if (spell.hostile && !player.pending && player.hp > 0 && mob.hp > 0) {
      player.pending = { type: "attack", targetId: mob.id };
      const t = w.mobs[mob.template];
      events.push({ type: "combat-auto-start", playerId: player.id, targetId: mob.id, targetName: t.name });
    }

    return result;
  }

  /**
   * Resolve a hostile area spell (`effect.type === "damage-room"`, e.g. Arc Flash) cast
   * by a player. Spends mana and any `shardCost`, then blasts every mob in `targets`
   * (the caller has already filtered to the eligible) through the shared bomb
   * resolver, folding the caster's Intellect in as a flat per-target bonus. Returns
   * detonateRoom's per-target results for the caller to narrate.
   */
  castRoomSpell(player, spell, targets, events = []) {
    const eff = spell.effect || {};
    this.spendCost(player, spell);
    const bonus = spellScaleBonus(effectiveAttributes(this.world, player), eff.scale);
    return this.detonateRoom(player, eff, targets, bonus, events, true); // a magical burst rolls each foe's Ward
  }

  /**
   * Resolve a thrown area bomb (a consumable's `damage-room` effect), applying it to
   * every mob in `targets` (the caller has already filtered to the eligible — hostile
   * or already-engaged — mobs, so a stray toss never blasts a peaceful shopkeeper).
   * A bomb carries an instant burst (`damage`, fresh-rolled per target), a lingering
   * `dot` ({ name, damage, duration } — a corroding/poison cloud applied as a
   * damage-over-time state, credited to the thrower like an `onHit` venom), or both.
   * Either way it threatens the thrower so survivors turn on them, rouses any sleeper
   * it doesn't kill, and credits the thrower with kills (loot/xp). Mob removal, light
   * recompute and the kill's spoils are handled by `_hurtMob` (and, for the DoT, by
   * `_tickEffects`). Returns one result per target for the caller to narrate:
   * `{ id, name, damage, dot, killed, death }`.
   *
   * `bonus` is a flat per-target damage add (a caster's Intellect scaling for an
   * area spell); a thrown bomb passes none. `wardCheck` opts a target's Ward into a
   * per-target negation roll (a magical area *spell* — each foe's Ward may shrug the
   * burst off; see wardNegates), which a thrown bomb (mundane shrapnel/acid) skips.
   * A warded-off target still takes the thrower's threat but no damage or DoT.
   */
  detonateRoom(player, spec, targets, bonus = 0, events = [], wardCheck = false) {
    const w = this.world;
    const roomId = player.location;
    const rt = this.rooms[roomId];
    const results = [];
    // Snapshot the targets — _hurtMob splices the dead out of rt.mobs mid-loop.
    for (const mob of [...targets]) {
      const t = w.mobs[mob.template];
      // A magical burst rolls each foe's Ward independently — a shrugged-off blast
      // still earns the caster's ire, but lands no damage or burn on that target.
      if (wardCheck && wardNegates(mobDefence(t, mob).ward || 0)) {
        this._addThreat(mob, player.id, 1);
        results.push({ id: mob.id, name: t.name, damage: 0, dot: false, resisted: true, killed: false, death: null });
        continue;
      }
      let damage = 0;
      let death = null;
      if (spec.damage != null) {
        damage = Math.max(1, rollDice(spec.damage) + bonus);
        this._addThreat(mob, player.id, damage); // a survivor keeps the thrower in its sights
        death = this._hurtMob(mob, roomId, damage, events, { cause: spec.cause || "blast", killer: player });
      }
      // A lingering cloud sinks a DoT into anything the burst didn't outright kill,
      // stamped with the thrower so a corrosion kill credits them (like a bleed).
      let dot = false;
      if (spec.dot && !death) {
        this.applyEffect(mob, { type: "damage-over-time", name: spec.dot.name || spec.cause || "poison", damage: spec.dot.damage, duration: spec.dot.duration, sourceId: player.id, good: false });
        this._addThreat(mob, player.id, 1); // the splash sticks the thrower in its sights
        dot = true;
      }
      if (!death && this._rouse(mob))
        events.push({ type: "mob-woke", roomId, mobId: mob.id, mobName: t.name, emitsLight: !!t.emitsLight, light: rt.light });
      results.push({ id: mob.id, name: t.name, damage, dot, killed: !!death, death });
    }
    rt.light = this.computeRoomLight(roomId); // a luminous mob blasted apart changes the room
    return results;
  }

  /**
   * Resolve a beneficial (non-hostile) spell cast by a player on a target actor —
   * `target` is the normalized descriptor the command handler built:
   *   { kind: "player"|"mob", actor, name, id, roomId, emitsLight }
   * Spends mana (and any `shardCost` material), then applies the effect
   * primitive. `heal-over-time` bakes its per-pulse magnitude from the caster's
   * scaling attribute at cast time (so the power follows the caster, while an
   * innate mob regen authors `magnitude` directly); `protect` likewise bakes its
   * armour/ward from the caster; an instant `restore` tops up hp/mana now.
   * Returns a result the caller narrates: { effect, name, perPulse?, restored?,
   * armour?, ward?, duration? }.
   *
   * Support-spell threat: mending or buffing an ally makes whatever is fighting
   * that ally turn on the caster too (see `_drawSupportThreat`), mirroring the
   * damage→threat convention — the amount is the HP/mana mended (a flat 1 for a
   * pure buff). This is the aggro hook this method long reserved.
   */
  castBeneficial(player, spell, target, events = []) {
    const w = this.world;
    const eff = spell.effect || {};
    const attrs = effectiveAttributes(w, player);
    this.spendCost(player, spell);

    if (eff.type === "restore") {
      const got = this.applyRestore(target.actor, eff);
      this._drawSupportThreat(player, target.id, (got.hp || 0) + (got.mana || 0));
      return { effect: "restore", name: spell.name, restored: got };
    }

    if (eff.type === "protect") {
      // Bake the caster-scaled defence into the instance (base + attribute bonus).
      const armour = scaledAmount(attrs, eff.armour);
      const ward = scaledAmount(attrs, eff.ward);
      this.applyEffect(target.actor, { type: "protect", name: eff.name || "protect", armour, ward, duration: eff.duration, refresh: eff.refresh, good: true });
      this._narrateEffectApplied(events, target, eff.name || eff.type);
      this._drawSupportThreat(player, target.id, 1); // a pure buff: a flat sliver of threat
      return { effect: "protect", name: spell.name, armour, ward, duration: eff.duration || 0 };
    }

    // Status effects (heal-over-time and future buffs). Bake any caster scaling
    // into the magnitude so the instance carries a fixed strength.
    const bonus = spellScaleBonus(attrs, eff.scale);
    const magnitude = Math.max(eff.scale ? 1 : 0, (eff.magnitude || 0) + bonus);
    this.applyEffect(target.actor, { ...eff, magnitude });
    // A light-shedding weave (Candlelight) brightens the room at once, like a potion.
    if (eff.type === "emit-light") this.rooms[player.location].light = this.computeRoomLight(player.location);
    this._narrateEffectApplied(events, target, eff.name || eff.type);
    this._drawSupportThreat(player, target.id, magnitude); // mend-over-time: per-pulse magnitude as threat
    return { effect: eff.type, name: spell.name, perPulse: magnitude, interval: eff.interval || 1, duration: eff.duration || 0 };
  }

  /**
   * Resolve a player summon spell (effect.type "summon"). Spends mana/shards,
   * dismisses this caster's existing summons of the same `group` (recast replaces,
   * resetting the timer), then conjures the new one(s) via `_summon`. The per-owner
   * cap of one-per-group is enforced purely by the dismiss step. Returns
   * { mob, count, replaced } for the caller to narrate.
   */
  castSummon(player, spell, events = []) {
    const eff = spell.effect || {};
    this.spendCost(player, spell); // mana, shards, and the material component (e.g. a chitin plate)
    const group = eff.group || spell.id;
    // Lifetime scales with the caster's Intellect (durationScale, ticks per point), on
    // top of any flat base — so a keener mage holds a summon longer. A summon with
    // neither stays permanent (null).
    let lifetime = eff.duration != null ? eff.duration : null;
    if (eff.durationScale)
      lifetime = (eff.duration || 0) + durationScaleBonus(effectiveAttributes(this.world, player), eff.durationScale);
    const existing = [];
    for (const rt of Object.values(this.rooms))
      for (const m of rt.mobs) if (m.ownerId === player.id && m.summonGroup === group) existing.push(m);
    for (const m of existing) this._dismissSummon(m, "recast", events);
    const made = this._summon({
      roomId: player.location, mobId: eff.mob, count: eff.count || 1,
      faction: "player", ownerId: player.id, summonerId: player.id, group,
      lifetime, by: "player", byName: player.name,
    }, events);
    return { mob: this.world.mobs[eff.mob], count: made.length, replaced: existing.length, lifetime };
  }

  /** Support-spell threat (the deferred aggro hook): healing/buffing an ally makes
   *  whatever is currently fighting that ally turn on the caster too. `amount`
   *  mirrors the damage→threat convention — the HP/mana mended, or a flat 1 for a
   *  pure buff. For every live mob in the caster's room whose threat table already
   *  names the ally (so it is fighting them), the caster gains `amount` threat. A
   *  self-cast simply stokes the caster's own attackers — the intended healer-aggro
   *  feel. Co-located by construction: a beneficial cast resolves in the caster's room. */
  _drawSupportThreat(caster, allyId, amount) {
    if (!(amount > 0)) return;
    for (const m of this.rooms[caster.location].mobs) {
      if (m.hp > 0 && m.aggro && m.aggro[allyId] != null) this._addThreat(m, caster.id, amount);
    }
  }

  /** Each mob takes at most one weighted action per tick (attack/emote/flee/idle). */
  resolveMobAI(events) {
    for (const [roomId, rt] of Object.entries(this.rooms)) {
      for (const m of [...rt.mobs]) {
        if (m.hp <= 0) continue; // slain earlier this tick (e.g. mob-vs-mob) but still in the snapshot
        if (m.posture === "sleeping") continue; // a sleeping mob perceives nothing — inert until struck (see _rouse)
        // A *sitting* mob is alert-at-rest: it still runs _mobAct to detect enemies
        // and stands as it engages (it just won't wander/emote — see _mobAct).
        const t = this.world.mobs[m.template];
        const cost = (t.attack && t.attack.actionCost) || 12;
        if (m.energy < cost) continue;
        m.energy -= cost;
        this._mobAct(m, t, roomId, events);
      }
    }
  }

  _mobAct(m, t, roomId, events) {
    const rt = this.rooms[roomId];
    const self = { id: m.id, actor: m, kind: "mob", faction: combatantFaction(m, "mob") };
    // Enemies = opposing-faction combatants present (players + opposing mobs).
    let enemies = this._enemiesOf(self, roomId);

    // A hidden mob is normally inert toward any DELVER who hasn't searched it out
    // (reveal-on-find): only players who have revealed it perceive — and provoke —
    // it. An *ambush* mob is the exception: it silently tracks the unaware and
    // strikes when they're helpless, revealing itself with the blow (see
    // _mobAttack), so it skips this filter. Mobs sense each other regardless, so
    // the filter only ever touches player enemies.
    if (m.hidden && !t.ambush) {
      enemies = enemies.filter((c) => c.kind !== "player" || mobVisibleTo(this, c.actor, m));
      if (enemies.length === 0) return;
    }

    // Detection: forget combatants who have left, then a *proactive hunter* (a
    // hostile wild mob, or a player-faction ally) builds a decaying notice meter
    // on each enemy it can perceive. A mob it has actually traded blows with (a
    // live combat-threat entry) is engaged outright — being hit bypasses the ramp.
    this._pruneAggro(m, enemies);
    // A player's summon is a *defensive guard*, not an independent aggressor: it
    // never proactively hunts (even if its template is `hostile`, as a combat
    // summon is). It engages only what it has traded blows with or what its owner
    // is already fighting (the assist pass below). Wild mobs hunt as ever.
    const hunts = !!t.hostile && self.faction !== "player";
    this._detectAndDecay(m, t, enemies, rt.light, hunts, roomId, events);
    // A sitting mob that engaged stood up in _engageTell; one still seated noticed
    // nobody worth rising for this action — stay at rest (no wander/emote).
    if (m.posture === "sitting") return;
    // A `helper` (and every player-summon — it backs its owner) piles into any
    // fight a same-faction ally is already in. This is how a defensive summon
    // joins the master's fight without ever starting one of its own.
    if (t.helper || self.faction === "player") this._assistPass(m, t, enemies, rt.light, roomId, events);
    const engagedTargets = enemies.filter((c) => this._isEngaged(m, t, c));
    const inCombat = this._alerted(m); // alerted (combat threat or live detection) → won't wander

    // Wander destinations: "zone" scope confines a mob to its current zone (the
    // village stays in the village, the abyss below); "any" lets it cross zones.
    // On top of scope, an action may gate destinations by room `tags`:
    // `requireTags` admits only rooms carrying *all* listed tags (a cave-fish that
    // keeps to "water" rooms), `forbidTags` rejects any room carrying one (a
    // surface beast that won't enter the "deep-dark"). An untagged room satisfies
    // no requirement and trips no prohibition, so an action with neither field
    // roams exactly as before — tags only ever constrain mobs that ask for them.
    const exits = this.world.rooms[roomId].exits || {};
    const allDirs = Object.keys(exits);
    const roamDirs = this._zoneExits(roomId);
    const tagOk = (dir, a) => {
      const dest = this.world.rooms[exits[dir]];
      if (!dest) return false;
      const tags = dest.tags || [];
      if (a.requireTags && !a.requireTags.every((g) => tags.includes(g))) return false;
      if (a.forbidTags && a.forbidTags.some((g) => tags.includes(g))) return false;
      return true;
    };
    const wanderDirs = (a) => {
      const base = a.scope === "any" ? allDirs : roamDirs;
      return a.requireTags || a.forbidTags ? base.filter((d) => tagOk(d, a)) : base;
    };

    // Skittish prey (grubs, cave-fish): a calm critter that loses its nerve and
    // bolts out of the world entirely — no room-to-room flight, it simply slips
    // out of sight, freeing its spawn slot to repop on the room's timer. It bolts
    // readily once *alarmed* (`chance`) — struck, or spooked by a `helper` ally's
    // fight nearby (see _assistPass); these mobs carry no `attack`, so a cluster
    // that catches the alarm scatters rather than fights, and a delver must be
    // quick to take more than the one they struck. While merely *watched* by a
    // delver it also carries a faint ambient chance (`idle`) to vanish, so a
    // populated bed visibly breathes — a count that drifts under its cap as
    // critters slip away and respawn. Living scenery that won't sit still to farm.
    if (t.skittish) {
      const watched = this.playersIn(roomId).length > 0;
      const p = inCombat ? (t.skittish.chance != null ? t.skittish.chance : 0.4)
              : watched ? (t.skittish.idle || 0) : 0;
      if (p > 0 && Math.random() < p) return this._bolt(m, t, roomId, events, t.skittish.verb);
    }

    // Light-driven flight: a mob with a `flee` action bolts for a random exit the
    // instant the room light rises above its tolerance. This overrides its normal
    // action choice, even combat. With nowhere to run, it stands and acts as usual.
    const flee = (t.actions || []).find((a) => a.type === "flee" && rt.light > (a.lightAbove || 0));
    if (flee) {
      const dirs = wanderDirs(flee);
      if (dirs.length) return this._mobMove(m, t, roomId, events, flee.verb || "flees into the dark", dirs);
    }

    // A mob attacks if it has *engaged* a present enemy — either a target whose
    // detection meter reached `AGGRO_ENGAGE` (proactively noticed it; clear sight
    // commits in ~AGGRO_ENGAGE actions, impaired ~2×, dark never), or one it has
    // traded blows with (a live combat-threat entry → engaged outright, so being
    // hit always provokes, in any light) — OR if the room light has risen past its
    // `lightAggro` tolerance (a calm creature roused by light — the inverse of
    // `flee`; it lashes at anyone present). Shopkeepers et al. carry no `attack`
    // block, so they stay passive even if hit. Note: above `flee`'s threshold,
    // flight wins (it returned earlier); lightAggro bites between calm and flight.
    const lightProvoked = t.lightAggro && rt.light > (t.lightAggro.above || 0);
    const aggressive = engagedTargets.length > 0 || lightProvoked;
    // Whom to swing at: a committed target if there is one, else (light-rage only)
    // anyone present. _mobAttack/_mobCast weigh combined threat among these.
    const candidates = engagedTargets.length ? engagedTargets : enemies;

    let options;
    if (Array.isArray(t.actions) && t.actions.length) {
      options = t.actions.filter((a) => {
        if (a.type === "attack") return aggressive && t.attack && candidates.length > 0;
        if (a.type === "cast") {
          const sp = a.spell && this.world.spells[a.spell];
          if (!aggressive || !sp || !candidates.length) return false;
          // A beneficial self-buff (e.g. Glimmerskin) is only worth a turn if it
          // isn't already crusting the mob — otherwise it would recast forever.
          if (!sp.hostile) return !this._mobHasState(m, (sp.effect && sp.effect.name) || sp.effect && sp.effect.type);
          return true;
        }
        if (a.type === "summon") return aggressive && a.mob && this.world.mobs[a.mob] && candidates.length > 0 && this._broodCount(m.id) < (a.max != null ? a.max : Infinity);
        if (a.type === "wander") return !inCombat && wanderDirs(a).length > 0;
        if (a.type === "react") return Array.isArray(a.reactions) && a.reactions.length > 0 && this.playersIn(roomId).length > 0;
        if (a.type === "emote") return Array.isArray(a.messages) && a.messages.length > 0;
        return a.type === "idle";
      });
      // Thin ambient emotes globally (clone so we never mutate the template).
      options = options.map((a) =>
        a.type === "emote" ? { ...a, weight: (a.weight || 1) * EMOTE_WEIGHT_SCALE } : a
      );
    } else {
      // Default behaviour for mobs without an actions table: attack if able.
      options = aggressive && t.attack && candidates.length ? [{ type: "attack" }] : [];
    }

    const choice = pickWeighted(options);
    if (!choice || choice.type === "idle") return;
    if (choice.type === "attack") return this._mobAttack(m, t, roomId, events, candidates);
    if (choice.type === "cast") return this._mobCast(m, t, roomId, events, candidates, choice.spell);
    if (choice.type === "summon") return this._mobSummon(m, t, roomId, events, choice);
    if (choice.type === "react") return this._mobReact(m, t, roomId, choice, events);
    if (choice.type === "emote") {
      const text = choice.messages[Math.floor(Math.random() * choice.messages.length)];
      events.push({ type: "mob-emote", roomId, mobId: m.id, mobName: t.name, emitsLight: !!t.emitsLight, light: rt.light, text });
      return;
    }
    if (choice.type === "wander") return this._mobMove(m, t, roomId, events, choice.verb || "wanders off", wanderDirs(choice));
  }

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

  /** Command-side reaction: the in-character answer when a player TALKS to this
   *  mob — the first reaction matching that player. The cooldown gate is ignored
   *  (a direct address always earns an answer) but still stamped, so the tick
   *  roll doesn't pile on right after. Returns { textTarget, textRoom } or null
   *  (mob has no react action / no reaction matches). */
  reactToPlayer(mob, player) {
    const t = this.world.mobs[mob.template];
    const action = (t.actions || []).find((a) => a.type === "react" && Array.isArray(a.reactions) && a.reactions.length);
    if (!action || player.hp <= 0) return null;
    for (const r of action.reactions) {
      if (!this._reactMatches(player, r.if, mob.template)) continue;
      const msg = r.messages[Math.floor(Math.random() * r.messages.length)];
      if (!mob.reactCd) mob.reactCd = {};
      mob.reactCd[player.id] = this.tick + (action.cooldown || 120);
      return { textTarget: msg.target, textRoom: msg.room };
    }
    return null;
  }

  /** Exit directions whose destination room shares this room's zone (roamable). */
  _zoneExits(roomId) {
    const room = this.world.rooms[roomId];
    const zone = room.zone;
    return Object.entries(room.exits || {})
      .filter(([, dest]) => this.world.rooms[dest] && this.world.rooms[dest].zone === zone)
      .map(([dir]) => dir);
  }

  // --- Combatants & factions ------------------------------------------------
  // A combatant is any living actor that can fight — a player or a mob. Each is
  // described uniformly as { id, actor, kind, faction } so the threat table and
  // the combat loop can treat players and mobs the same. Faction defines sides
  // (differing factions are enemies); `hostile`/provocation still gate whether a
  // creature actually engages (see _mobAct).

  /** Living combatants in a room: every up player plus every up mob, as uniform
   *  { id, actor, kind, faction } descriptors. */
  _combatantsIn(roomId) {
    const out = [];
    for (const p of this.playersIn(roomId)) if (p.hp > 0) out.push({ id: p.id, actor: p, kind: "player", faction: "player" });
    for (const m of this.rooms[roomId].mobs) if (m.hp > 0) out.push({ id: m.id, actor: m, kind: "mob", faction: combatantFaction(m, "mob") });
    return out;
  }

  /** Two combatants are enemies iff their factions differ. */
  _areEnemies(a, b) {
    return a.faction !== b.faction;
  }

  /** Living opposing-faction combatants of `self` in `roomId`. For a wild mob this
   *  is players + player-faction (allied) mobs; for a player-faction mob, wild mobs. */
  _enemiesOf(self, roomId) {
    return this._combatantsIn(roomId).filter((c) => c.id !== self.id && this._areEnemies(self, c));
  }

  /** Resolve a combatant to the player who should receive kill credit for its
   *  actions: a player credits itself; a player-faction mob credits its owner (if
   *  that owner is a live player); anything else credits no one. */
  _killerPlayerFor(combatant) {
    if (!combatant) return null;
    if (combatant.kind === "player") return combatant.actor;
    const owner = combatant.actor && combatant.actor.ownerId ? this.players.get(combatant.actor.ownerId) : null;
    return owner && owner.hp > 0 ? owner : null;
  }

  // --- Aggro / threat tables (combatant-keyed) ---------------------------------
  // A mob holds two per-enemy maps, both keyed by any combatant id (a player OR a
  // mob): `aggro` is *combat* threat (from trading blows — drives kill-XP credit
  // and outright engagement), `detect` is the decaying *detection* meter a hunter
  // builds on enemies it can perceive (see _detectAndDecay). A mob is engaged once
  // a target has combat threat or detection ≥ AGGRO_ENGAGE; it stays to fight (won't
  // wander) while alerted, and targets the highest *combined* threat.
  // Later: per-action threat weighting, cross-room pursuit hook here.

  /** Add `amount` combat threat toward a combatant (from trading blows — drives
   *  XP credit and outright engagement). 0 just ensures an entry exists. Detection
   *  (mere noticing) lives in the separate, decaying `mob.detect` map so that being
   *  seen never counts as participation for kill XP. */
  _addThreat(mob, combatantId, amount) {
    if (!mob.aggro) mob.aggro = {};
    mob.aggro[combatantId] = (mob.aggro[combatantId] || 0) + amount;
  }

  /** A combatant is *engaged* by a mob once it has either traded blows (a live
   *  combat-threat entry, any amount → being hit provokes instantly, in any light
   *  or posture) or been noticed up to the detection threshold (`AGGRO_ENGAGE`).
   *  An `ambush` mob holds its proactive (detection-driven) strike until the target
   *  is a *sleeping* delver — it preys only on the helpless — but still fights back
   *  outright once blows are traded. */
  _isEngaged(mob, t, c) {
    if (mob.aggro && mob.aggro[c.id] > 0) return true;
    if (!(mob.detect && mob.detect[c.id] >= AGGRO_ENGAGE)) return false;
    if (t.ambush) return c.kind === "player" && c.actor.posture === "sleeping";
    return true;
  }

  /** A `helper` mob piles into a fight a same-faction ally is already in: for each
   *  present enemy that another same-faction combatant in the room holds combat
   *  threat on (a mob's `aggro`, or a player ally's `pending` target), the helper
   *  engages it too — seeding combat threat so it commits and stays in. Gated by
   *  the helper's own sight (it must perceive the enemy — no joining a fight in the
   *  dark, asleep), and announced once per enemy it newly joins on. */
  _assistPass(mob, t, enemies, light, roomId, events) {
    if (mob.posture === "sleeping" || noticeChance(t.perception, light) <= 0) return;
    const myFaction = combatantFaction(mob, "mob");
    const allies = this._combatantsIn(roomId).filter((c) => c.id !== mob.id && c.faction === myFaction);
    if (!allies.length) return;
    for (const e of enemies) {
      if (mob.aggro && mob.aggro[e.id] > 0) continue; // already in this fight — no re-announce
      const allyFighting = allies.some((a) =>
        (a.kind === "mob" && a.actor.aggro && a.actor.aggro[e.id] > 0) ||
        (a.kind === "player" && a.actor.pending && a.actor.pending.targetId === e.id));
      if (!allyFighting) continue;
      this._addThreat(mob, e.id, AGGRO_ENGAGE); // join the fight — committed like a full notice
      events.push({
        type: "mob-assist", roomId, mobId: mob.id, mobName: t.name,
        targetId: e.id, targetKind: e.kind,
        targetName: e.kind === "player" ? e.actor.name : this.world.mobs[e.actor.template].name,
        light: this.rooms[roomId].light, emitsLight: !!t.emitsLight,
      });
    }
  }

  /** Alerted = holds any combat threat or any live detection. An alerted mob is
   *  "in combat" and won't wander; an un-alerted hostile roams normally. */
  _alerted(mob) {
    if (mob.aggro && Object.keys(mob.aggro).length) return true;
    if (mob.detect) for (const v of Object.values(mob.detect)) if (v > 0) return true;
    return false;
  }

  /** Per-action detection pass. A proactive `hunts`er accrues a notice meter on
   *  each enemy it can perceive (mob posture + sight vs room light, via
   *  `canPerceive`/`noticeChance`), capped at `AGGRO_ENGAGE`; the first time a
   *  PLAYER target crosses that cap (and isn't already engaged via blows) the mob
   *  emits its engage tell (and stands if seated). Any enemy it can no longer
   *  perceive — too dark, or the mob itself blinded — decays after `AGGRO_GRACE`
   *  unperceived actions until forgotten. Detection of mob targets (a summon's
   *  wild quarry, or a wild mob noticing a summon) builds silently. */
  _detectAndDecay(mob, t, enemies, light, hunts, roomId, events) {
    if (!mob.detect) mob.detect = {};
    if (!mob._unseen) mob._unseen = {};
    // A mob's sight band lives on its template; a sleeping mob perceives nothing
    // (resolveMobAI already skips it — this is belt-and-suspenders).
    const nc = mob.posture === "sleeping" ? 0 : noticeChance(t.perception, light);
    for (const c of enemies) {
      const id = c.id;
      if (hunts && nc > 0) {
        mob._unseen[id] = 0;
        const before = mob.detect[id] || 0;
        if (before < AGGRO_ENGAGE) {
          const now = Math.min(AGGRO_ENGAGE, before + nc * AGGRO_RATE);
          mob.detect[id] = now;
          // An ambush mob fires no "spotted" tell — its strike from hiding is the
          // reveal (see _mobAttack); a normal mob announces the moment it commits.
          if (now >= AGGRO_ENGAGE && c.kind === "player" && !t.ambush && !(mob.aggro && mob.aggro[id] > 0)) {
            this._engageTell(mob, t, c, roomId, events);
          }
        }
      } else if (mob.detect[id] > 0) {
        // Can't perceive this enemy (dark, or not a hunter): grace, then decay.
        mob._unseen[id] = (mob._unseen[id] || 0) + 1;
        if (mob._unseen[id] > AGGRO_GRACE) {
          const v = mob.detect[id] - AGGRO_RATE;
          if (v > 0) mob.detect[id] = v;
          else { delete mob.detect[id]; delete mob._unseen[id]; }
        }
      }
    }
  }

  /** The Diku-style "spotted you" tell, fired once as a player target crosses the
   *  detection threshold. A seated mob stands as it commits (`rose`). Light-gated
   *  by the renderer like other mob events. */
  _engageTell(mob, t, target, roomId, events) {
    let rose = false;
    if (mob.posture === "sitting") { mob.posture = "standing"; rose = true; }
    events.push({
      type: "aggro-engage", roomId, mobId: mob.id, mobName: t.name,
      targetId: target.id, targetName: target.actor.name, rose,
      light: this.rooms[roomId].light, emitsLight: !!t.emitsLight,
    });
  }

  /** Award `xp` to every PLAYER who earned a mob's death — the finisher (always,
   *  even if a remote DoT landed the blow; for an allied-mob kill this is its
   *  owner, resolved by the caller) plus any player who traded blows (a live combat
   *  threat entry) and is still present and alive. A threat key that is a *mob* id
   *  is an allied **summon** that helped: it credits its owner (owner-share), so a
   *  delver whose pet did the work shares the kill even when something else lands
   *  the final blow. Model A: each participant gets the FULL value (co-op, no
   *  division). Returns [{ playerId, levelUps }]. */
  _awardKillXp(mob, primaryKiller, xp, roomId) {
    const out = [];
    const credited = new Set();
    if (primaryKiller) {
      out.push({ playerId: primaryKiller.id, levelUps: this.awardXp(primaryKiller, xp) });
      credited.add(primaryKiller.id);
    }
    for (const id of Object.keys(mob.aggro || {})) {
      if (!(mob.aggro[id] > 0)) continue; // participation requires traded blows, not mere detection
      let pl = this.players.get(id);
      if (!pl) {
        // A mob-id key — an allied summon that helped. Credit its owner instead.
        const helper = this.rooms[roomId].mobs.find((x) => x.id === id);
        if (helper && helper.faction === "player" && helper.ownerId) pl = this.players.get(helper.ownerId);
      }
      if (!pl || credited.has(pl.id) || pl.hp <= 0 || pl.location !== roomId) continue; // present, alive, once
      out.push({ playerId: pl.id, levelUps: this.awardXp(pl, xp) });
      credited.add(pl.id);
    }
    return out;
  }

  /** Forget combatants no longer present/alive across every per-enemy table
   *  (combat threat, detection meter, unseen counters). `present` is the current
   *  candidate list ({ id } descriptors). In-room decay is handled separately by
   *  `_detectAndDecay`; this is the hard drop for those who left. */
  _pruneAggro(mob, present) {
    const ids = new Set(present.map((c) => c.id));
    for (const map of [mob.aggro, mob.detect, mob._unseen]) {
      if (!map) continue;
      for (const cid of Object.keys(map)) if (!ids.has(cid)) delete map[cid];
    }
    if (!mob.aggro) mob.aggro = {};
  }

  /** The present combatant a mob is most angry at (a { id, actor, kind } descriptor),
   *  or null. Weighs combined combat threat + detection so a proactively-noticed
   *  enemy is a valid quarry. `candidates` are the valid targets to weigh among. */
  _topThreat(mob, candidates) {
    let best = null, bestT = 0;
    for (const c of candidates) {
      const th = (mob.aggro && mob.aggro[c.id] || 0) + (mob.detect && mob.detect[c.id] || 0);
      if (th > bestT) { bestT = th; best = c; }
    }
    return best;
  }

  /** Defender descriptor for a MOB being struck, for `applyHitOutcome`. `attacker`
   *  is the striking combatant ({ id, kind, actor }); landing the kill credits its
   *  resolved player (a player attacker, or an allied mob's owner — see
   *  `_killerPlayerFor`). Shared by the player-attack path and mob-vs-mob combat. */
  _mobDefender(mob, mt, roomId, attacker, events) {
    return {
      actor: mob, kind: "mob", id: mob.id, name: mt.name, emitsLight: !!mt.emitsLight, roomId,
      onDamage: mobOnDamage(mt),
      sourceId: null, // a mob defender's retaliatory DoT credits no one
      deal: (dmg) => {
        this._addThreat(mob, attacker.id, Math.max(1, dmg)); // being hit earns the striker its ire
        mob.hp -= dmg;
        if (mob.hp <= 0) {
          const d = this._killMobAt(mob, roomId, this._killerPlayerFor(attacker));
          events.push(d);
          if (attacker.kind === "player") attacker.actor.pending = null; // quarry slain — stop swinging
          return d;
        }
        return null;
      },
      hurt: (dmg, cause) => this._hurtMob(mob, roomId, dmg, events, { cause }), // self-damage onDamage (rare)
    };
  }

  /** Defender descriptor for a PLAYER being struck, for `applyHitOutcome`. */
  _playerDefender(player, roomId, events) {
    return {
      actor: player, kind: "player", id: player.id, name: player.name, emitsLight: false, roomId,
      onDamage: playerOnDamage(this.world, player), // player armour triggers (none seeded yet)
      sourceId: player.id, // a player's reflected DoT credits them
      deal: (dmg) => {
        player.hp -= dmg;
        if (player.hp <= 0) { const d = this._respawn(player, roomId, events); events.push(d); return d; }
        return null;
      },
      hurt: (dmg, cause) => this._hurtPlayer(player, dmg, events, { cause }), // self-damage onDamage (rare)
    };
  }

  /** A mob makes one melee attack against its highest-threat enemy — a player OR
   *  an opposing-faction mob (an allied summon, etc.). `enemies` is the candidate
   *  set from `_mobAct`. Reuses `strike`/`applyHitOutcome` via the shared defender
   *  builders, so contact triggers (onHit/onDamage/spikes) fire identically in both
   *  directions. Player targets also rouse from rest and auto-retaliate. */
  _mobAttack(m, t, roomId, events, enemies) {
    const rt = this.rooms[roomId];
    const target = this._topThreat(m, enemies) || enemies[Math.floor(Math.random() * enemies.length)];
    if (!target) return;
    this._addThreat(m, target.id, 1); // attacking sticks the mob to its quarry
    const isPlayer = target.kind === "player";
    // Ambush: a hidden mob striking a delver who never found it bursts from
    // concealment — reveal it to that player (ephemerally, like `search`) and
    // announce the appearance just before the blow lands.
    if (m.hidden && isPlayer && !mobVisibleTo(this, target.actor, m)) {
      let set = this.revealedMobs.get(target.actor.id);
      if (!set) { set = new Set(); this.revealedMobs.set(target.actor.id, set); }
      set.add(m.id);
      events.push({ type: "mob-ambush", roomId, mobId: m.id, mobName: t.name,
        targetId: target.id, light: rt.light, emitsLight: !!t.emitsLight });
    }
    const tmt = isPlayer ? null : this.world.mobs[target.actor.template];
    const targetName = isPlayer ? target.actor.name : tmt.name;
    const targetEmitsLight = isPlayer ? false : !!tmt.emitsLight;
    const defence = isPlayer
      ? playerDefence(this.world, target.actor)
      : mobDefence(tmt, target.actor);
    const attacker = {
      band: t.perception,
      hitBonus: (t.attack.hitBonus) || 0, // a keen-eyed mob (data-driven, default 0)
      dmgBonus: (t.attack.bonus) || 0,
      crit: (t.attack.crit) || 0, // mirrors player crit; default 0 → no live change
    };
    const r = strike(attacker, defence, rt.light, t.attack.damage, t.attack.type || "physical");
    const attackEvent = {
      type: "attack", by: "mob", attackerId: m.id, attackerName: t.name, roomId,
      targetId: target.id, targetName, targetKind: target.kind, hit: r.hit, sighted: r.sighted,
      damage: r.damage, crit: r.crit, targetHp: Math.max(0, target.actor.hp - r.damage), targetMaxHp: target.actor.maxHp,
      light: rt.light, attackerEmitsLight: !!t.emitsLight, targetEmitsLight,
    };
    const defender = isPlayer
      ? this._playerDefender(target.actor, roomId, events)
      : this._mobDefender(target.actor, tmt, roomId, { id: m.id, kind: "mob", actor: m }, events);
    this.applyHitOutcome({
      r, events, attackEvent,
      attacker: {
        actor: m, kind: "mob", id: m.id, name: t.name, emitsLight: !!t.emitsLight, roomId,
        onHit: t.attack.onHit,
        sourceId: null, // a mob's venom credits no one
        // Reflect/retaliate lands on the mob; the struck defender's owner (a player,
        // if it's a delver or an allied mob still up) gets the credit.
        hurt: (dmg, cause) => this._hurtMob(m, roomId, dmg, events, { cause, killer: target.actor.hp > 0 ? this._killerPlayerFor(target) : null }),
      },
      defender,
    });

    if (!isPlayer) return; // mob-vs-mob: no rouse-from-rest or player auto-retaliate
    const p = target.actor;
    // A blow rouses a resting target — you can't sleep through being hit. (A
    // sleeping delver is blind, so the first they know of a threat is this strike.)
    if (p.hp > 0 && this._rouse(p)) events.push({ type: "player-woke", playerId: p.id });
    // Auto-retaliate: if the player isn't already attacking something, target this mob
    if (!p.pending && p.hp > 0) {
      p.pending = { type: "attack", targetId: m.id };
      events.push({ type: "combat-auto-start", playerId: p.id, targetId: m.id, targetName: t.name });
    }
  }

  /** A mob summons reinforcements (the `summon` action). Conjures up to its
   *  `count`, never exceeding the living-brood `max`, on the mob's own faction
   *  (allies that fight alongside it, not each other). Permanent, spoil-less. */
  _mobSummon(m, t, roomId, events, action) {
    const max = action.max != null ? action.max : Infinity;
    const room = this._broodCount(m.id);
    const count = Math.min(action.count || 1, max - room);
    if (count <= 0) return;
    this._summon({
      roomId, mobId: action.mob, count, faction: m.faction || "wild",
      ownerId: null, summonerId: m.id, group: null, lifetime: null,
      by: "mob", byName: t.name, verb: action.verb || null,
    }, events);
  }

  /** A mob casts a hostile spell at its highest-threat enemy — a player OR an
   *  opposing-faction mob (mirror of _mobAttack for the `cast` action). The target's
   *  Ward gets a wholesale negation roll (see wardNegates); a spell that lands deals
   *  magical damage scaled by the mob's own attributes, or applies a hostile status
   *  effect. No mana bookkeeping for mobs — cadence is gated by action energy. Pushes
   *  a `mob-cast` event the server narrates; a player target also rouses/retaliates. */
  _mobCast(m, t, roomId, events, enemies, spellId) {
    const rt = this.rooms[roomId];
    const spell = this.world.spells[spellId];
    if (!spell) return;
    if (!spell.hostile) return this._mobCastSelf(m, t, roomId, events, spell); // a beneficial weave lands on the caster
    const eff = spell.effect || {};
    const target = this._topThreat(m, enemies) || enemies[Math.floor(Math.random() * enemies.length)];
    if (!target) return;
    this._addThreat(m, target.id, 1); // casting sticks the mob to its quarry
    const isPlayer = target.kind === "player";
    const tmt = isPlayer ? null : this.world.mobs[target.actor.template];
    const targetName = isPlayer ? target.actor.name : tmt.name;

    const ward = isPlayer ? (playerDefence(this.world, target.actor).ward || 0) : (mobDefence(tmt, target.actor).ward || 0);
    const resisted = wardNegates(ward);
    let damage = 0, killed = false, death = null, effectName = null, doused = false;
    if (!resisted) {
      if (eff.type === "damage") {
        damage = Math.max(1, rollDice(eff.damage) + spellScaleBonus(t.attributes || {}, eff.scale));
        this._addThreat(m, target.id, damage); // mirror melee: damage stokes threat
        target.actor.hp -= damage;
        if (target.actor.hp <= 0) {
          killed = true;
          death = isPlayer
            ? this._respawn(target.actor, roomId, events)
            : this._killMobAt(target.actor, roomId, this._killerPlayerFor({ id: m.id, kind: "mob", actor: m }));
        }
      } else if (eff.type === "douse") {
        // Snuff the target's carried light — a shadow's signature reach. Only a player
        // wields a doused-able lit source (a mob's glow is innate, not a kindled flame),
        // so it no-ops on a mob target. The delver must relight (a turn) or fight blind;
        // the room darkens immediately, recomputed below so the band is fresh.
        if (isPlayer) {
          const li = target.actor.equipment && target.actor.equipment.light;
          if (li && li.lit) { li.lit = false; doused = true; }
        }
        effectName = eff.name || "Douse";
      } else {
        // A hostile status effect (debuff). Stamp no sourceId — a mob credits no one.
        this.applyEffect(target.actor, { ...eff });
        effectName = eff.name || eff.type;
      }
    }
    if (doused) rt.light = this.computeRoomLight(roomId); // the snuffed flame leaves the room darker
    events.push({
      type: "mob-cast", roomId, mobId: m.id, mobName: t.name, emitsLight: !!t.emitsLight, light: rt.light,
      targetId: target.id, targetName, targetKind: target.kind, targetEmitsLight: isPlayer ? false : !!tmt.emitsLight,
      spellName: spell.name, resisted, damage, effectName, doused, killed,
      targetHp: Math.max(0, target.actor.hp), targetMaxHp: target.actor.maxHp,
    });
    if (death) events.push(death);

    if (!isPlayer || killed || target.actor.hp <= 0) return;
    const p = target.actor;
    if (this._rouse(p)) events.push({ type: "player-woke", playerId: p.id });
    if (!p.pending) {
      p.pending = { type: "attack", targetId: m.id };
      events.push({ type: "combat-auto-start", playerId: p.id, targetId: m.id, targetName: t.name });
    }
  }

  /** A mob casts a beneficial spell on *itself* — the support side of mob casting
   *  (e.g. an Umbral glimmer-singer crusting Glimmerskin over its own hide before
   *  it spikes you). Mobs pay no mana/shards; defence/heal magnitudes are baked
   *  from the mob's own attributes, mirroring castBeneficial. Reusable for future
   *  warder/healer mobs. The _mobAct filter gates a refresh-buff so it isn't recast
   *  while already up. */
  _mobCastSelf(m, t, roomId, events, spell) {
    const rt = this.rooms[roomId];
    const eff = spell.effect || {};
    const attrs = t.attributes || {};
    if (eff.type === "protect") {
      const armour = scaledAmount(attrs, eff.armour);
      const ward = scaledAmount(attrs, eff.ward);
      this.applyEffect(m, { type: "protect", name: eff.name || "protect", armour, ward, duration: eff.duration, refresh: eff.refresh, good: true });
    } else if (eff.type === "restore") {
      this.applyRestore(m, eff);
    } else {
      const bonus = spellScaleBonus(attrs, eff.scale);
      const raw = (eff.magnitude || 0) + bonus;
      // A *darkness* aura is an emit-light effect authored with a negative magnitude
      // (it drinks the room's light rather than sheds it — see computeRoomLight, which
      // sums a source's output be it positive or negative). Preserve the negative; a
      // positive light weave still floors at 1 so a scaling source always shows.
      const magnitude = raw < 0 ? raw : Math.max(eff.scale ? 1 : 0, raw);
      this.applyEffect(m, { ...eff, magnitude });
      if (eff.type === "emit-light") rt.light = this.computeRoomLight(roomId);
    }
    events.push({
      type: "mob-cast-self", roomId, mobId: m.id, mobName: t.name,
      emitsLight: !!t.emitsLight, light: rt.light, spellName: spell.name, effectName: eff.name || eff.type,
      // A negative emit-light weave is a darkness aura, not a self-buff — the client
      // narrates it as the room being swallowed rather than something drawn "about itself".
      darkened: eff.type === "emit-light" && ((eff.magnitude || 0) < 0),
    });
  }

  /** True if a mob currently carries an active state by name (used to gate a
   *  refresh self-buff so it isn't recast while still up). */
  _mobHasState(m, name) {
    return !!name && (m.states || []).some((s) => s.name === name);
  }

  _mobMove(m, t, roomId, events, verb, exits) {
    const dir = exits[Math.floor(Math.random() * exits.length)];
    const dest = this.world.rooms[roomId].exits[dir];
    const rt = this.rooms[roomId];
    const idx = rt.mobs.indexOf(m);
    if (idx >= 0) rt.mobs.splice(idx, 1);
    this.rooms[dest].mobs.push(m);
    rt.light = this.computeRoomLight(roomId);
    this.rooms[dest].light = this.computeRoomLight(dest);
    events.push({
      type: "mob-move", mobId: m.id, mobName: t.name, from: roomId, to: dest, dir, verb,
      emitsLight: !!t.emitsLight, lightFrom: rt.light, lightTo: this.rooms[dest].light,
    });
  }

  /**
   * Drop a slain mob's loot roll and shard roll onto `roomId`'s floor; returns
   * the list of names dropped (shards as "N shards"). Shards merge into an
   * existing pile rather than littering separate stacks. Shared by every death
   * path — a direct kill, the room itself, a bleed tick.
   */
  _dropSpoils(mob, roomId) {
    if (mob.noSpoils) return [];
    const t = this.world.mobs[mob.template];
    const rt = this.rooms[roomId];
    const dropped = [];
    for (const l of t.loot || []) {
      if (Math.random() < l.chance) {
        addToFloor(rt, makeItemInstance({ template: l.template }, this.world), this.world);
        dropped.push(this.world.items[l.template].name);
      }
    }
    if (t.shards) {
      const shards = rollDice(t.shards);
      if (shards > 0) {
        addToFloor(rt, makeItemInstance({ template: "shards", qty: shards }, this.world), this.world);
        dropped.push(`${shards} shards`);
      }
    }
    return dropped;
  }

  /** A direct kill by a player (melee/spell): removes the mob, drops spoils, and
   *  awards xp to the killer. Non-combat deaths go through `_hurtMob` instead. */
  _killMob(mob, killer) {
    return this._killMobAt(mob, killer.location, killer);
  }

  /** Remove a mob killed by a direct hit in `roomId`, drop its spoils, and award
   *  XP. `killerPlayer` is the player to credit as finisher (a player attacker, or
   *  the OWNER of an allied mob that landed the blow — resolved by the caller) or
   *  null when no player struck the killing blow (e.g. an ownerless ally's kill);
   *  other players who held threat are still credited via `_awardKillXp`. Returns
   *  the `death` event. Shared by the player-attack path and mob-vs-mob combat. */
  _killMobAt(mob, roomId, killerPlayer, cause = "hit") {
    const t = this.world.mobs[mob.template];
    const idx = this.rooms[roomId].mobs.indexOf(mob);
    if (idx >= 0) this.rooms[roomId].mobs.splice(idx, 1);
    this._adjustOwned(mob, -1);
    const loot = this._dropSpoils(mob, roomId);
    const xp = t.xp || 0;
    const participants = mob.noSpoils ? [] : this._awardKillXp(mob, killerPlayer, xp, roomId); // shared credit (Model A); summons award nothing
    this.rooms[roomId].light = this.computeRoomLight(roomId); // a luminous mob dying changes the room
    return { type: "death", victimKind: "mob", victimId: mob.id, victimName: t.name, victimTemplate: mob.template, roomId, killerId: killerPlayer ? killerPlayer.id : null, loot, xp: participants.length ? xp : 0, cause, participants };
  }

  /**
   * Apply `amount` damage to a mob from a source that isn't a direct hit — the
   * room itself (light-bane), a bleed tick, etc. Pushes a `mob-hurt` event tagged
   * with `cause`; on death drops spoils where the mob stands and pushes a `death`
   * event. XP is credited only when a `killer` player is named (pure environment
   * rewards no one). This is the shared "killed by something else" path. Returns
   * the death event, or null if the mob survives.
   */
  _hurtMob(mob, roomId, amount, events, opts = {}) {
    const { cause = "hit", killer = null } = opts;
    const t = this.world.mobs[mob.template];
    const rt = this.rooms[roomId];
    mob.hp -= amount;
    events.push({ type: "mob-hurt", roomId, mobId: mob.id, mobName: t.name, cause, damage: amount, mobHp: Math.max(0, mob.hp), emitsLight: !!t.emitsLight, light: rt.light });
    if (mob.hp > 0) return null;
    const idx = rt.mobs.indexOf(mob);
    if (idx >= 0) rt.mobs.splice(idx, 1);
    this._adjustOwned(mob, -1);
    const loot = this._dropSpoils(mob, roomId);
    const xp = t.xp || 0;
    const participants = (killer && !mob.noSpoils) ? this._awardKillXp(mob, killer, xp, roomId) : []; // shared credit; summons award nothing
    rt.light = this.computeRoomLight(roomId); // a luminous mob dying changes the room
    const death = { type: "death", victimKind: "mob", victimId: mob.id, victimName: t.name, victimTemplate: mob.template, roomId, killerId: killer ? killer.id : null, loot, xp: (killer && !mob.noSpoils) ? xp : 0, cause, participants };
    events.push(death);
    return death;
  }

  /** Apply `amount` non-combat damage to a player (a bleed tick, the room). Pushes
   *  a `player-hurt` event; routes death through the usual rim respawn. Returns the
   *  death event, or null if the player survives. */
  _hurtPlayer(player, amount, events, opts = {}) {
    const { cause = "hit" } = opts;
    player.hp -= amount;
    events.push({ type: "player-hurt", playerId: player.id, cause, damage: amount, hp: Math.max(0, player.hp), maxHp: player.maxHp });
    if (player.hp <= 0) {
      const death = this._respawn(player, player.location, events);
      events.push(death);
      return death;
    }
    return null;
  }

  /** Environmental damage: any mob whose `lightBane.above` is exceeded by its
   *  room's light is seared this tick. Credits the top-threat player present (a
   *  kill the player engineered with light) — otherwise it is pure environment. */
  _environmentTick(events) {
    for (const [roomId, rt] of Object.entries(this.rooms)) {
      const playersHere = this.playersIn(roomId).filter((p) => p.hp > 0);
      for (const m of [...rt.mobs]) {
        const lb = this.world.mobs[m.template].lightBane;
        if (!lb || rt.light <= (lb.above || 0)) continue;
        const dmg = Math.max(1, rollDice(lb.damage));
        this._hurtMob(m, roomId, dmg, events, { cause: "light", killer: this._topThreat(m, playersHere) });
      }
    }
  }

  /** Player death (v1): respawn at the rim, full HP, no penalty beyond progress. */
  _respawn(player, deathRoom, events = []) {
    const start = this.world.playerTemplate.startLocation;
    player.hp = player.maxHp;
    // Death snuffs every carried light source — you wake at the rim in the dark.
    for (const inst of [...Object.values(player.equipment || {}), ...(player.inventory || [])])
      if (inst && inst.lit) inst.lit = false;
    // Transient effects (potions, venom, bleeds, glows) end on death. Effects
    // sustained by worn/carried gear (source "item") persist — the gear is still
    // on you when you respawn.
    player.states = (player.states || []).filter((s) => s.source === "item");
    this.setPlayerLocation(player, start);
    player.pending = null;
    player.energy = 0;
    this.rooms[start].light = this.computeRoomLight(start);
    this.rooms[deathRoom].light = this.computeRoomLight(deathRoom);
    this._dismissOwnedSummons(player.id, "owner-gone", events); // a falling delver's summons unravel
    return { type: "death", victimKind: "player", victimId: player.id, victimName: player.name, roomId: deathRoom, respawnRoom: start };
  }
}

module.exports = { GameState, makeItemInstance, addToFloor, makeMobInstance, actorEmitLight, playerDefence, effectiveSpeed, buyValueOf, sellValueOf, SELL_RATE, itemVisibleTo, fixtureVisibleTo, mobVisibleTo, effectivePerception, canPerceive, isDiscovered, discoveryKey, xpForLevel, effectiveAttributes, spellScaleBonus, durationScaleBonus, MELEE_SCALE };
