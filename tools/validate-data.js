#!/usr/bin/env node
/**
 * Validates Lumen static world data: JSON validity, cross-references,
 * reachability of all rooms from the starting location, vertical consistency
 * (every room solves to a single derived floor), horizontal direction
 * consistency (compass loops must be able to close at some passage lengths),
 * exit reciprocity, and zone contiguity.
 *
 * Usage:  node tools/validate-data.js
 *         node tools/validate-data.js --floors   # also print the solved-elevation report
 * Exits non-zero on any error (suitable for a pre-merge check).
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { FACTIONS } = require("../server/config");
const { PHASES } = require("../server/world-clock");
const { SCHEDULE_ACTION_TYPES } = require("../server/schedule-actions");

const ROOT = path.resolve(__dirname, "..");
const read = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), "utf8"));
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
// Dice notation: "<count>d<sides>" with optional "+/-<flat>", or a plain integer.
const DICE_RE = /^\d+d\d+([+-]\d+)?$|^\d+$/;

// Known-open map geometry: edges excluded from the floor solve pending a
// content decision. A cut severs the a<->b edges in both directions; the
// stale-cut check in main() errors once a cut's edge is satisfied by the rest
// of the graph, so entries cannot outlive their reason. Exported so map-3d
// draws with the same cuts the validator solves with.
const FLOOR_CUTS = [
  // (empty) Every known contradiction is resolved — the world's vertical
  // geometry closes with no exceptions. Add an entry (`{ a, b }` severs the
  // a<->b edges) only while a genuine content decision is pending, with a
  // comment saying what that decision is.
];

// Zones deliberately split while the content that will connect them is still
// upcoming (the world is built top-down). A listed zone may solve as multiple
// islands; the stale check errors once the zone becomes contiguous, so
// entries cannot outlive their reason.
const PENDING_ZONE_LINKS = [
  // (empty) every zone is currently one connected piece.
];

// Known-open horizontal geometry: edges excluded from the grid solve pending a
// content decision, stale-checked like FLOOR_CUTS. The grid solve treats
// compass directions as authored truth and distances as free — a cut is only
// needed where a loop's directions cannot reconcile at ANY lengths.
const GRID_CUTS = [
  // (empty) Every compass loop in the world can close — no direction lies.
  // Add an entry (`{ a, b }` severs the a<->b edges from the grid solve) only
  // while a genuine content decision is pending, with a comment saying what
  // that decision is.
];

function main() {
  const rooms = read("data/world/rooms.json");
  const items = read("data/world/items.json");
  const mobs = read("data/world/mobs.json");
  const fixtures = read("data/world/fixtures.json");
  const recipes = read("data/world/recipes.json");
  const spells = read("data/world/spells.json");
  const quests = read("data/world/quests.json");
  const tide = read("data/world/tide.json");
  const schedule = read("data/world/schedule.json");
  const player = read("data/templates/player.json");

  const errs = [];

  // VERSION and package.json move in lockstep (bumped together in every PR —
  // see CONTRIBUTING.md → Versioning); catch drift before it lands.
  const versionFile = fs.readFileSync(path.join(ROOT, "VERSION"), "utf8").trim();
  const pkgVersion = read("package.json").version;
  if (versionFile !== pkgVersion)
    errs.push(`VERSION (${versionFile}) and package.json version (${pkgVersion}) disagree`);

  // Cosmetic room biomes — the Inspect window tints itself for these (see the
  // `.biome-*` rules in client/styles.css). Add a name here and a matching CSS
  // rule there to introduce a new one.
  const BIOMES = ["umbral", "gloaming", "wraith", "rim", "water", "slime", "mutant", "ember"];

  // The Tide's phase vocabulary is data-driven (tide.json `phases`); mob action /
  // reaction `phase` gates below validate against it (falling back to the engine
  // default PHASES if a world omits the list).
  const tidePhases = Array.isArray(tide.phases) && tide.phases.length ? tide.phases : PHASES;

  // A `hidden: { perception }` block gates a feature behind `search` (positive req).
  const checkHidden = (h, where) => {
    if (h == null) return;
    if (typeof h !== "object" || typeof h.perception !== "number" || h.perception <= 0)
      errs.push(`${where}: hidden.perception must be a positive number`);
  };

  for (const [id, r] of Object.entries(rooms)) {
    if (r.id !== id) errs.push(`room ${id}: id field mismatch (${r.id})`);
    // Room ids are depth-led: `d<depth>.[region.]name`. The id's depth prefix is
    // the canonical handle, so it must agree with the room's `depth` field — this
    // is what keeps a retune from silently leaving an id that lies about its depth.
    const dm = /^d(\d+)\./.exec(id);
    if (!dm) errs.push(`room ${id}: id must start with a depth prefix like "d<depth>."`);
    else if (Number(dm[1]) !== r.depth)
      errs.push(`room ${id}: id depth prefix d${dm[1]} disagrees with depth field (${r.depth})`);
    if (r.zone != null && typeof r.zone !== "string") errs.push(`room ${id}: zone must be a string`);
    // Optional biome: a purely cosmetic tag that tints the Inspect window (a blue
    // glow for umbral, a green one for gloaming). Enum-checked so a typo can't
    // silently render as no tint; the matching CSS lives in client/styles.css.
    if (r.biome != null && !BIOMES.includes(r.biome))
      errs.push(`room ${id}: unknown biome "${r.biome}" (known: ${BIOMES.join(", ")})`);
    // Free-form room tags (e.g. "water", "outdoor") — gate tag-aware wander/flee
    // destinations (a mob's requireTags/forbidTags). Must be an array of strings.
    if (r.tags != null && (!Array.isArray(r.tags) || !r.tags.every((g) => typeof g === "string")))
      errs.push(`room ${id}: tags must be an array of strings`);
    for (const [dir, dest] of Object.entries(r.exits || {}))
      if (!has(rooms, dest)) errs.push(`room ${id}: exit ${dir} -> missing room ${dest}`);
    // Hidden exits are a parallel map of { to, perception } — gated, but still edges.
    for (const [dir, h] of Object.entries(r.hiddenExits || {})) {
      if (!h || !has(rooms, h.to)) errs.push(`room ${id}: hiddenExit ${dir} -> missing room ${h && h.to}`);
      if (typeof h.perception !== "number" || h.perception <= 0)
        errs.push(`room ${id}: hiddenExit ${dir} perception must be a positive number`);
      // move() resolves visible exits first, so a visible exit on the same
      // direction shadows the hidden one — it could never be walked.
      if ((r.exits || {})[dir])
        errs.push(`room ${id}: hiddenExit ${dir} is shadowed by the visible exit ${dir} — it would be unwalkable even once discovered`);
    }
    // A dir is a real exit if it's a plain exit, a hidden exit, or the direction
    // of a door fixture in the room (all three are walked by move(), which shows
    // the exitMessage regardless of how the destination resolved).
    const doorDirs = new Set(
      (r.fixtures || [])
        .map((f) => (typeof f === "string" ? f : f.template))
        .map((fid) => fixtures[fid])
        .filter((ft) => ft && ft.door)
        .map((ft) => ft.door.dir)
    );
    const hasExitDir = (dir) => (r.exits && r.exits[dir]) || (r.hiddenExits && r.hiddenExits[dir]) || doorDirs.has(dir);
    // Optional per-exit departure flavour (move() shows it to the mover instead of
    // "You go <dir>."). Object of dir -> non-empty string; each dir must be a real exit.
    if (r.exitMessages != null) {
      if (typeof r.exitMessages !== "object" || Array.isArray(r.exitMessages))
        errs.push(`room ${id}: exitMessages must be an object of dir -> message`);
      else for (const [dir, msg] of Object.entries(r.exitMessages)) {
        if (typeof msg !== "string" || !msg.trim())
          errs.push(`room ${id}: exitMessage ${dir} must be a non-empty string`);
        if (!hasExitDir(dir))
          errs.push(`room ${id}: exitMessage ${dir} has no matching exit`);
      }
    }
    // Optional multi-floor spans: `exitSpans: { "down": 4 }` declares that the
    // vertical exit in that direction moves that many floors in one step — a
    // chute or long shaft acting as a progression shortcut. Cartographic
    // metadata only: the floor solve below and the map tools read it, the game
    // engine never does. The paired return exit, if any, must imply the same
    // span — the floor solve flags a mismatch as a loop that doesn't close.
    if (r.exitSpans != null) {
      if (typeof r.exitSpans !== "object" || Array.isArray(r.exitSpans))
        errs.push(`room ${id}: exitSpans must be an object of dir -> floor count`);
      else for (const [dir, n] of Object.entries(r.exitSpans)) {
        if (dir !== "up" && dir !== "down")
          errs.push(`room ${id}: exitSpans.${dir} — only up/down exits can span floors`);
        else if (!hasExitDir(dir))
          errs.push(`room ${id}: exitSpans.${dir} has no matching exit`);
        if (!Number.isInteger(n) || n < 2)
          errs.push(`room ${id}: exitSpans.${dir} must be an integer >= 2 (1 is the implicit default)`);
        // A multi-floor passage must *feel* long: require departure prose so the
        // mover understands they travelled further than one room's worth.
        if (!(r.exitMessages || {})[dir])
          errs.push(`room ${id}: exitSpans.${dir} spans ${n} floors but has no exitMessages.${dir} — a multi-floor passage needs departure prose`);
      }
    }
    for (const f of r.fixtures || []) {
      // A fixture entry is a template string, or an object { template, hidden }.
      const fid = typeof f === "string" ? f : f.template;
      if (!has(fixtures, fid)) errs.push(`room ${id}: missing fixture ${fid}`);
      if (typeof f === "object") checkHidden(f.hidden, `room ${id} fixture ${fid}`);
    }
    for (const s of r.spawns || []) {
      if (!has(mobs, s.mob)) errs.push(`room ${id}: spawn references missing mob ${s.mob}`);
      if (s.max != null && (typeof s.max !== "number" || s.max <= 0))
        errs.push(`room ${id}: spawn max must be a positive number`);
      if (s.respawn != null && (typeof s.respawn !== "number" || s.respawn <= 0))
        errs.push(`room ${id}: spawn respawn must be a positive number (ticks)`);
      checkHidden(s.hidden, `room ${id} spawn ${s.mob}`);
    }
    for (const g of r.groundItems || []) {
      if (!has(items, g.template)) errs.push(`room ${id}: groundItem missing template ${g.template}`);
      if (g.respawn != null && (typeof g.respawn !== "number" || g.respawn <= 0))
        errs.push(`room ${id}: groundItem respawn must be a positive number (ticks)`);
      checkHidden(g.hidden, `room ${id} groundItem ${g.template}`);
    }
    if (r.effects !== undefined) {
      if (!Array.isArray(r.effects)) {
        errs.push(`room ${id}: "effects" must be an array`);
      } else {
        r.effects.forEach((eff, i) => {
          const where = `room ${id} effects[${i}]`;
          if (!eff || typeof eff !== "object") { errs.push(`${where}: must be an object`); return; }
          if (eff.trigger !== "enter" && eff.trigger !== "tick")
            errs.push(`${where}: "trigger" must be "enter" or "tick"`);
          if (eff.when !== undefined) {
            if (!eff.when || typeof eff.when !== "object") { errs.push(`${where}: "when" must be an object`); return; }
            const keys = ["lightBelow", "lightAbove"].filter((k) => eff.when[k] !== undefined);
            if (keys.length !== 1) errs.push(`${where}: "when" needs exactly one of lightBelow/lightAbove`);
            else if (!Number.isInteger(eff.when[keys[0]])) errs.push(`${where}: when.${keys[0]} must be an integer`);
          }
          if (eff.interval !== undefined && (!Number.isInteger(eff.interval) || eff.interval < 1))
            errs.push(`${where}: "interval" must be a positive integer`);
          const a = eff.action;
          if (!a || typeof a !== "object") { errs.push(`${where}: missing "action"`); return; }
          const actionKeys = ["douse", "restore", "damage"].filter((k) => a[k] !== undefined);
          if (actionKeys.length !== 1) { errs.push(`${where}: "action" needs exactly one of douse/restore/damage`); return; }
          if (a.restore !== undefined && (typeof a.restore !== "object" || a.restore === null)) errs.push(`${where}: "restore" must be an object`);
          else if (a.restore) {
            for (const k of ["hp", "mana"]) if (a.restore[k] !== undefined && !Number.isInteger(a.restore[k]))
              errs.push(`${where}: restore.${k} must be an integer`);
          }
          if (a.damage !== undefined && (typeof a.damage !== "object" || a.damage === null)) errs.push(`${where}: "damage" must be an object`);
          else if (a.damage) {
            for (const k of ["hp", "mana"]) if (a.damage[k] !== undefined && !(typeof a.damage[k] === "string" && DICE_RE.test(a.damage[k])))
              errs.push(`${where}: damage.${k} must be dice notation (e.g. "1d2")`);
            if (a.damage.cause !== undefined && (typeof a.damage.cause !== "string" || !a.damage.cause))
              errs.push(`${where}: damage.cause must be a non-empty string`);
          }
        });
      }
    }
  }

  const EFFECT_TYPES = ["emit-light", "restore", "damage-over-time"];
  // Consumables add `damage-room` — a thrown area bomb that blasts every foe in
  // the room (see commands.throwBomb / state.detonateRoom) — and `heal-over-time`,
  // a drunk-down regen pulse (the `drink` path pushes any non-`restore` effect as a
  // status; _tickEffects mends the drinker each interval, as the Regeneration spell
  // does). `summon` conjures a friendly companion under the user's command (the
  // pet path — see commands.drink), mirroring the spell effect of the same name.
  // `attr-buff` grants flat attribute bonuses for a duration (its `attrMod` is
  // folded into effectiveAttributes while the status is live — see combat-math).
  // None is valid on a weapon onHit/onDamage trigger, so they live apart from
  // EFFECT_TYPES.
  const CONSUMABLE_EFFECT_TYPES = [...EFFECT_TYPES, "damage-room", "heal-over-time", "summon", "attr-buff"];
  const ATTRS = ["might", "vitality", "intellect", "wits", "perception"];
  const RARITIES = ["common", "uncommon", "rare", "epic", "legendary"];

  // Combat triggers (see GameState.applyHitOutcome): `onHit` is a list of effect
  // specs an attacker lands on a hit (mob `attack.onHit` / item `weapon.onHit`);
  // `spikes` is a defender's melee reflect (mob-level / item `armour.spikes`).
  // onHit adds `immobilize` over EFFECT_TYPES — a timed hold that bars the struck
  // delver from leaving the room (a snapper's grip; see commands.move) — and `slow`,
  // a timed speed debuff that shaves points off how fast the struck actor banks
  // action-energy (a vine-whip's lash; see state.advance / slowAmount). Neither is a
  // consumable effect, so they stay out of CONSUMABLE_EFFECT_TYPES.
  const ONHIT_TYPES = [...EFFECT_TYPES, "immobilize", "slow"];
  const checkOnHit = (arr, where) => {
    if (arr == null) return;
    if (!Array.isArray(arr)) { errs.push(`${where}: onHit must be an array of effect specs`); return; }
    for (const spec of arr) {
      if (!spec || typeof spec !== "object") { errs.push(`${where}: onHit entry must be an object { type, ... }`); continue; }
      if (!ONHIT_TYPES.includes(spec.type)) errs.push(`${where}: onHit unknown effect type "${spec.type}" (known: ${ONHIT_TYPES.join(", ")})`);
      if (spec.type === "damage-over-time" && (typeof spec.damage !== "string" || !DICE_RE.test(spec.damage)))
        errs.push(`${where}: onHit damage-over-time needs valid dice (got "${spec.damage}")`);
      if (spec.type === "immobilize" && (typeof spec.duration !== "number" || spec.duration <= 0))
        errs.push(`${where}: onHit immobilize needs a positive duration (ticks) — an untimed hold never releases`);
      if (spec.type === "slow") {
        if (typeof spec.magnitude !== "number" || spec.magnitude <= 0)
          errs.push(`${where}: onHit slow needs a positive magnitude (the speed points shaved off the target)`);
        if (typeof spec.duration !== "number" || spec.duration <= 0)
          errs.push(`${where}: onHit slow needs a positive duration (ticks) — an untimed slow never lifts`);
      }
      if (spec.duration != null && (typeof spec.duration !== "number" || spec.duration <= 0))
        errs.push(`${where}: onHit duration must be a positive number (ticks)`);
      if (spec.chance != null && (typeof spec.chance !== "number" || spec.chance <= 0 || spec.chance > 1))
        errs.push(`${where}: onHit chance must be a number in (0,1]`);
    }
  };
  const checkSpikes = (s, where) => {
    if (s == null) return;
    if (typeof s !== "object") { errs.push(`${where}: spikes must be an object { damage, chance? }`); return; }
    if (typeof s.damage !== "string" || !DICE_RE.test(s.damage)) errs.push(`${where}: spikes.damage "${s.damage}" is not valid dice notation`);
    if (s.chance != null && (typeof s.chance !== "number" || s.chance <= 0 || s.chance > 1)) errs.push(`${where}: spikes.chance must be a number in (0,1]`);
  };

  // `onDamage` is the general defender-side trigger (mob-level / item `armour.onDamage`):
  // a list of effect specs, each with a `target` (attacker/self), a `chance`, and an
  // `on` source filter. `spikes` is terse sugar for the commonest entry (melee reflect).
  const ONDAMAGE_TYPES = ["damage", "emit-light", "restore", "damage-over-time"];
  const SOURCES = ["melee", "spell"];
  const checkOnDamage = (arr, where) => {
    if (arr == null) return;
    if (!Array.isArray(arr)) { errs.push(`${where}: onDamage must be an array of effect specs`); return; }
    for (const e of arr) {
      if (!e || typeof e !== "object") { errs.push(`${where}: onDamage entry must be an object { type, ... }`); continue; }
      if (!ONDAMAGE_TYPES.includes(e.type)) errs.push(`${where}: onDamage unknown type "${e.type}" (known: ${ONDAMAGE_TYPES.join(", ")})`);
      if (e.target != null && !["self", "attacker"].includes(e.target)) errs.push(`${where}: onDamage target must be "self" or "attacker"`);
      if (e.on != null && (!Array.isArray(e.on) || !e.on.every((s) => SOURCES.includes(s)))) errs.push(`${where}: onDamage.on must be an array drawn from ${SOURCES.join(", ")}`);
      if ((e.type === "damage" || e.type === "damage-over-time") && (typeof e.damage !== "string" || !DICE_RE.test(e.damage)))
        errs.push(`${where}: onDamage ${e.type} needs valid dice (got "${e.damage}")`);
      if (e.duration != null && (typeof e.duration !== "number" || e.duration <= 0)) errs.push(`${where}: onDamage duration must be a positive number (ticks)`);
      if (e.hp != null && typeof e.hp !== "number") errs.push(`${where}: onDamage hp must be a number`);
      if (e.mana != null && typeof e.mana !== "number") errs.push(`${where}: onDamage mana must be a number`);
      if (e.chance != null && (typeof e.chance !== "number" || e.chance <= 0 || e.chance > 1)) errs.push(`${where}: onDamage chance must be a number in (0,1]`);
    }
  };

  for (const [id, it] of Object.entries(items)) {
    // Rarity is optional and defaults to "common"; if set it must be a known tier.
    if (it.rarity != null && !RARITIES.includes(it.rarity))
      errs.push(`item ${id}: unknown rarity "${it.rarity}" (known: ${RARITIES.join(", ")})`);
    // Every tradeable item needs a buy `value`; currency (shards) is exempt.
    if (it.type !== "currency") {
      if (typeof it.value !== "number" || it.value < 0)
        errs.push(`item ${id}: value must be a non-negative number (buy price)`);
      if (it.sellValue != null && (typeof it.sellValue !== "number" || it.sellValue < 0))
        errs.push(`item ${id}: sellValue must be a non-negative number`);
    }
    if (it.type === "weapon" && it.weapon) {
      for (const [kind, val] of Object.entries(it.weapon.damage || {}))
        if (typeof val !== "string" || !DICE_RE.test(val))
          errs.push(`item ${id}: weapon.damage.${kind} "${val}" is not valid dice notation`);
    }
    if (it.weapon) checkOnHit(it.weapon.onHit, `item ${id} weapon`); // player on-hit effects (forward-ready)
    if (it.armour) {
      checkSpikes(it.armour.spikes, `item ${id} armour`); checkOnDamage(it.armour.onDamage, `item ${id} armour`); // player thorns / when-struck triggers (forward-ready)
      if (it.armour.voidWard != null && (typeof it.armour.voidWard !== "number" || it.armour.voidWard < 0))
        errs.push(`item ${id}: armour.voidWard must be a non-negative number`); // vs void only — Umbral gear
      if (it.armour.evasion != null && (typeof it.armour.evasion !== "number" || it.armour.evasion < 0))
        errs.push(`item ${id}: armour.evasion must be a non-negative number`); // flat dodge from gear (a light buckler/targe)
      if (it.armour.maxHp != null && (typeof it.armour.maxHp !== "number" || it.armour.maxHp < 0))
        errs.push(`item ${id}: armour.maxHp must be a non-negative number`); // bonus durability from heavy gear
      if (it.armour.maxMana != null && (typeof it.armour.maxMana !== "number" || it.armour.maxMana < 0))
        errs.push(`item ${id}: armour.maxMana must be a non-negative number`); // bonus mana from caster gear
      if (it.armour.manaRegen != null && (typeof it.armour.manaRegen !== "number" || it.armour.manaRegen < 0))
        errs.push(`item ${id}: armour.manaRegen must be a non-negative number`); // bonus standing mana trickle (a glimmersteel coil)
      if (it.armour.attrMod != null) {
        if (typeof it.armour.attrMod !== "object") errs.push(`item ${id}: armour.attrMod must be an object of attribute → number`);
        else for (const [k, v] of Object.entries(it.armour.attrMod)) {
          if (!ATTRS.includes(k)) errs.push(`item ${id}: armour.attrMod unknown attribute "${k}" (known: ${ATTRS.join(", ")})`);
          if (typeof v !== "number") errs.push(`item ${id}: armour.attrMod.${k} must be a number`);
        }
      }
    }
    if (it.light && it.light.fuelItem) {
      if (!has(items, it.light.fuelItem)) errs.push(`item ${id}: light.fuelItem references missing template ${it.light.fuelItem}`);
      if (it.light.refuelPerUnit != null && (typeof it.light.refuelPerUnit !== "number" || it.light.refuelPerUnit <= 0))
        errs.push(`item ${id}: light.refuelPerUnit must be a positive number`);
    }
    if (it.type === "scroll" && (!it.scroll || !it.scroll.spell))
      errs.push(`item ${id}: scroll item needs a scroll.spell`);
    if (it.scroll && it.scroll.spell && !has(spells, it.scroll.spell))
      errs.push(`item ${id}: scroll.spell references missing spell ${it.scroll.spell}`);
    if (it.type === "recipe" && !it.recipe)
      errs.push(`item ${id}: recipe item needs a recipe`);
    if (it.recipe && !has(recipes, it.recipe))
      errs.push(`item ${id}: recipe references missing recipe ${it.recipe}`);
    if (it.teaches) {
      const tr = it.teaches.recipes || [];
      const ts = it.teaches.spells || [];
      if (!tr.length && !ts.length)
        errs.push(`item ${id}: teaches needs at least one recipe or spell`);
      for (const rid of tr)
        if (!has(recipes, rid)) errs.push(`item ${id}: teaches.recipes references missing recipe ${rid}`);
      for (const sid of ts)
        if (!has(spells, sid)) errs.push(`item ${id}: teaches.spells references missing spell ${sid}`);
    }
    const eff = it.consumable && it.consumable.effect;
    if (eff != null) {
      if (typeof eff !== "object")
        errs.push(`item ${id}: consumable.effect must be an effect object { type, ... }`);
      else {
        if (!CONSUMABLE_EFFECT_TYPES.includes(eff.type)) errs.push(`item ${id}: unknown effect type "${eff.type}" (known: ${CONSUMABLE_EFFECT_TYPES.join(", ")})`);
        if (eff.magnitude != null && typeof eff.magnitude !== "number") errs.push(`item ${id}: effect.magnitude must be a number`);
        if (eff.duration != null && (typeof eff.duration !== "number" || eff.duration <= 0)) errs.push(`item ${id}: effect.duration must be a positive number (ticks)`);
        if (eff.interval != null && (typeof eff.interval !== "number" || eff.interval <= 0)) errs.push(`item ${id}: effect.interval must be a positive number (ticks)`);
        if (eff.hp != null && typeof eff.hp !== "number") errs.push(`item ${id}: effect.hp must be a number`);
        if (eff.mana != null && typeof eff.mana !== "number") errs.push(`item ${id}: effect.mana must be a number`);
        if (eff.damage != null && (typeof eff.damage !== "string" || !DICE_RE.test(eff.damage)))
          errs.push(`item ${id}: effect.damage "${eff.damage}" is not valid dice notation`);
        // An `attr-buff` needs a numeric `attrMod` keyed by known attributes, and
        // a duration (a permanent attribute buff belongs on gear, not a potion).
        if (eff.type === "attr-buff") {
          if (!eff.attrMod || typeof eff.attrMod !== "object") errs.push(`item ${id}: attr-buff effect needs an attrMod object`);
          else for (const [k, v] of Object.entries(eff.attrMod)) {
            if (!ATTRS.includes(k)) errs.push(`item ${id}: effect.attrMod unknown attribute "${k}" (known: ${ATTRS.join(", ")})`);
            if (typeof v !== "number") errs.push(`item ${id}: effect.attrMod.${k} must be a number`);
          }
          if (eff.duration == null) errs.push(`item ${id}: attr-buff effect must set a duration (ticks)`);
          // Optional fortify: a flat, timed max-HP bonus the buff also grants
          // (real durability a Vitality attrMod can't give — see state.deriveStats).
          if (eff.maxHp != null && (typeof eff.maxHp !== "number" || eff.maxHp < 0))
            errs.push(`item ${id}: attr-buff effect.maxHp must be a non-negative number`);
        }
        // A thrown bomb may burst (instant `damage`), leave a lingering `dot`
        // (corroding/poison cloud), or both — but it must do at least one.
        if (eff.type === "damage-room") {
          if (eff.damage == null && eff.dot == null)
            errs.push(`item ${id}: damage-room needs a "damage" burst, a "dot" cloud, or both`);
          if (eff.dot != null) {
            if (typeof eff.dot !== "object") errs.push(`item ${id}: effect.dot must be an object { damage, duration }`);
            else {
              if (typeof eff.dot.damage !== "string" || !DICE_RE.test(eff.dot.damage))
                errs.push(`item ${id}: effect.dot.damage "${eff.dot.damage}" is not valid dice notation`);
              if (eff.dot.duration != null && (typeof eff.dot.duration !== "number" || eff.dot.duration <= 0))
                errs.push(`item ${id}: effect.dot.duration must be a positive number (ticks)`);
            }
          }
        }
        // A `summon` consumable conjures a friendly companion (faction "player",
        // permanent) — it must name a real mob template, and any count is a count.
        if (eff.type === "summon") {
          if (!eff.mob || !has(mobs, eff.mob)) errs.push(`item ${id}: summon effect references missing mob ${eff.mob}`);
          if (eff.count != null && (!Number.isInteger(eff.count) || eff.count < 1))
            errs.push(`item ${id}: effect.count must be a positive integer`);
        }
      }
    }
  }

  for (const [id, m] of Object.entries(mobs)) {
    for (const l of m.loot || [])
      if (!has(items, l.template)) errs.push(`mob ${id}: loot references missing template ${l.template}`);
    if (m.attack && (typeof m.attack.damage !== "string" || !DICE_RE.test(m.attack.damage)))
      errs.push(`mob ${id}: attack.damage "${m.attack.damage}" is not valid dice notation`);
    if (m.attack) checkOnHit(m.attack.onHit, `mob ${id} attack`); // bite poisons, etc.
    // An attack block is only usable if an `attack` action can be rolled. A mob
    // with an `actions` array must therefore list an `{ type: "attack" }` action;
    // otherwise it can never swing even when engaged (the auto-attack fallback
    // only fires for mobs with no actions array). Catches an armed-but-toothless
    // guard/helper — the bug class that once left the rim watch unable to fight.
    if (m.attack && Array.isArray(m.actions) && m.actions.length &&
        !m.actions.some((a) => a.type === "attack"))
      errs.push(`mob ${id}: has an attack block but no "attack" action, so it can never swing — add { "type": "attack" } to its actions`);
    checkSpikes(m.spikes, `mob ${id}`); // contact reflect sugar (thornbug)
    checkOnDamage(m.onDamage, `mob ${id}`); // general when-struck triggers
    if (m.shards != null && (typeof m.shards !== "string" || !DICE_RE.test(m.shards)))
      errs.push(`mob ${id}: shards "${m.shards}" is not valid dice notation`);
    if (m.lightBane) {
      if (typeof m.lightBane.above !== "number") errs.push(`mob ${id}: lightBane.above must be a number`);
      if (typeof m.lightBane.damage !== "string" || !DICE_RE.test(m.lightBane.damage))
        errs.push(`mob ${id}: lightBane.damage "${m.lightBane.damage}" is not valid dice notation`);
    }
    // A calm mob roused to attack once room light exceeds `above` (inverse of flee).
    if (m.lightAggro && typeof m.lightAggro.above !== "number")
      errs.push(`mob ${id}: lightAggro.above must be a number`);
    // Dark-adapted sight cap: light past `blindAbove` dazzles the creature blind
    // (bright-side mirror of blindBelow). Must sit above the glare band it caps.
    if (m.perception && m.perception.blindAbove != null) {
      const ba = m.perception.blindAbove;
      if (typeof ba !== "number") errs.push(`mob ${id}: perception.blindAbove must be a number`);
      else if (m.perception.harmedAbove != null && ba <= m.perception.harmedAbove)
        errs.push(`mob ${id}: perception.blindAbove (${ba}) must be greater than harmedAbove (${m.perception.harmedAbove})`);
    }
    // Authored starting posture — a dozing/resting mob is inert until struck.
    if (m.posture != null && !["standing", "sitting", "sleeping"].includes(m.posture))
      errs.push(`mob ${id}: posture must be "standing", "sitting", or "sleeping"`);
    // Instance faction (the side this creature fights for); defaults to "wild".
    // Whitelist is shared with the game via server/config.js (single source).
    if (m.faction != null && !FACTIONS.includes(m.faction))
      errs.push(`mob ${id}: faction must be one of ${FACTIONS.map((f) => `"${f}"`).join(", ")}`);
    if (m.remembers != null && typeof m.remembers !== "boolean")
      errs.push(`mob ${id}: remembers must be a boolean`);
    if (m.pursues != null && typeof m.pursues !== "boolean")
      errs.push(`mob ${id}: pursues must be a boolean`);
    if (m.pursueRange != null && (!Number.isInteger(m.pursueRange) || m.pursueRange < 1))
      errs.push(`mob ${id}: pursueRange must be a positive integer`);
    if (m.armour != null && typeof m.armour !== "number")
      errs.push(`mob ${id}: armour must be a number`);
    if (m.ward != null && typeof m.ward !== "number")
      errs.push(`mob ${id}: ward must be a number`);
    if (m.voidWard != null && typeof m.voidWard !== "number")
      errs.push(`mob ${id}: voidWard must be a number`); // vs void only — Umbral mobs
    if (m.shop) {
      // A trader's stock; prices default to each item's `value` (override optional).
      // Buying from a player is data-driven (any valued item), so no `buys` list.
      for (const o of m.shop.sells || []) {
        if (!has(items, o.template)) errs.push(`mob ${id}: shop.sells missing template ${o.template}`);
        if (o.price != null && (typeof o.price !== "number" || o.price < 0)) errs.push(`mob ${id}: shop.sells price for ${o.template} must be a non-negative number`);
        if (o.requiresQuest != null && !has(quests, o.requiresQuest)) errs.push(`mob ${id}: shop.sells requiresQuest ${o.requiresQuest} for ${o.template} is not a known quest`);
      }
    }
    for (const a of m.actions || []) {
      if (!["attack", "cast", "emote", "wander", "idle", "flee", "summon", "react"].includes(a.type))
        errs.push(`mob ${id}: invalid action type "${a.type}"`);
      // Tide-gated action: a `phase` array restricts when the action is eligible.
      if (a.phase != null && (!Array.isArray(a.phase) || !a.phase.length || a.phase.some((p) => !tidePhases.includes(p))))
        errs.push(`mob ${id}: action phase must be a non-empty array of ${tidePhases.map((p) => `"${p}"`).join(", ")}`);
      if (a.type === "emote" && (!Array.isArray(a.messages) || !a.messages.length))
        errs.push(`mob ${id}: emote action needs a non-empty messages array`);
      if (a.type === "cast") {
        if (!a.spell || !has(spells, a.spell)) {
          errs.push(`mob ${id}: cast action references missing spell ${a.spell}`);
        } else if (!spells[a.spell].hostile) {
          // A non-hostile cast is a self-buff a mob lays on itself (see
          // state._mobCastSelf) — valid only for effect kinds that path handles.
          const SELF_CASTABLE = ["protect", "restore", "heal-over-time", "emit-light"];
          const t = (spells[a.spell].effect || {}).type;
          if (!SELF_CASTABLE.includes(t))
            errs.push(`mob ${id}: non-hostile cast spell ${a.spell} has effect "${t}" a mob can't self-cast (use one of ${SELF_CASTABLE.join(", ")})`);
        } else {
          // A hostile cast resolves through the shared per-type core (see
          // state._applyHostileSpellEffect) — only these kinds land from a mob.
          const MOB_CASTABLE = ["damage", "douse", "damage-over-time", "drain", "mana-drain"];
          const t = (spells[a.spell].effect || {}).type;
          if (!MOB_CASTABLE.includes(t))
            errs.push(`mob ${id}: hostile cast spell ${a.spell} has effect "${t}" a mob can't cast (use one of ${MOB_CASTABLE.join(", ")})`);
        }
      }
      if (a.type === "summon") {
        if (!a.mob || !has(mobs, a.mob)) errs.push(`mob ${id}: summon action references missing mob ${a.mob}`);
        if (a.count != null && (typeof a.count !== "number" || a.count <= 0)) errs.push(`mob ${id}: summon count must be a positive number`);
        if (a.max != null && (typeof a.max !== "number" || a.max <= 0)) errs.push(`mob ${id}: summon max must be a positive number`);
      }
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
          if (c.phase != null && (!Array.isArray(c.phase) || !c.phase.length || c.phase.some((p) => !tidePhases.includes(p))))
            errs.push(`mob ${id}: react if.phase must be a non-empty array of ${tidePhases.map((p) => `"${p}"`).join(", ")}`);
          if (c.carriedLightBelow != null && (typeof c.carriedLightBelow !== "number" || c.carriedLightBelow <= 0))
            errs.push(`mob ${id}: react if.carriedLightBelow must be a positive number`);
        }
      }
      if ((a.type === "wander" || a.type === "flee") && a.scope != null && !["zone", "any"].includes(a.scope))
        errs.push(`mob ${id}: ${a.type} scope must be "zone" or "any"`);
      // Tag-gated destinations: requireTags admits only rooms carrying *all* listed
      // tags; forbidTags rejects any room carrying one. Both are string arrays and
      // apply on wander/flee (untagged rooms satisfy neither, so they're excluded
      // by requireTags and allowed by forbidTags).
      for (const key of ["requireTags", "forbidTags"]) {
        if (a[key] == null) continue;
        if (a.type !== "wander" && a.type !== "flee")
          errs.push(`mob ${id}: ${key} only applies to wander/flee actions`);
        if (!Array.isArray(a[key]) || !a[key].every((g) => typeof g === "string"))
          errs.push(`mob ${id}: ${a.type} ${key} must be an array of strings`);
      }
      if (a.type === "flee" && a.lightAbove != null && typeof a.lightAbove !== "number")
        errs.push(`mob ${id}: flee lightAbove must be a number`);
      if (a.weight != null && typeof a.weight !== "number")
        errs.push(`mob ${id}: action weight must be a number`);
    }
  }

  // A resource block (mine/harvest/fish) yields either a single `template` (+`yield`)
  // or a weighted `drops` table — one entry rolled per action. Validate whichever it
  // declares; `drops` and `template` are mutually exclusive ways to say the same thing.
  const DICE_OR_INT = /^(\d+)d(\d+)([+-]\d+)?$|^\d+$/;
  const checkResourceDrop = (block, label, id) => {
    if (block.drops != null) {
      if (block.template != null) errs.push(`fixture ${id}: ${label} declares both template and drops — use one`);
      if (!Array.isArray(block.drops) || !block.drops.length)
        return errs.push(`fixture ${id}: ${label}.drops must be a non-empty array`);
      block.drops.forEach((d, i) => {
        if (!d || typeof d !== "object") return errs.push(`fixture ${id}: ${label}.drops[${i}] must be an object`);
        if (!has(items, d.template)) errs.push(`fixture ${id}: ${label}.drops[${i}] missing item ${d.template}`);
        if (d.weight != null && (typeof d.weight !== "number" || d.weight <= 0))
          errs.push(`fixture ${id}: ${label}.drops[${i}].weight must be a positive number`);
        if (d.qty != null && !DICE_OR_INT.test(String(d.qty).trim()))
          errs.push(`fixture ${id}: ${label}.drops[${i}].qty must be an integer or dice string (e.g. "2d4")`);
      });
    } else if (!has(items, block.template)) {
      errs.push(`fixture ${id}: ${label}.template missing item ${block.template}`);
    }
  };

  for (const [id, f] of Object.entries(fixtures)) {
    if (f.emitsLight != null && (typeof f.emitsLight !== "number" || f.emitsLight < 0))
      errs.push(`fixture ${id}: emitsLight must be a non-negative number`);
    if (f.switch) {
      if (f.switch.emitsLight != null && (typeof f.switch.emitsLight !== "number" || f.switch.emitsLight < 0))
        errs.push(`fixture ${id}: switch.emitsLight must be a non-negative number`);
      if (f.switch.on != null && typeof f.switch.on !== "boolean")
        errs.push(`fixture ${id}: switch.on must be a boolean`);
    }
    // A door fixture gates an exit: open it (`use`/`open`) to walk its `dir` to `to`.
    if (f.door) {
      if (typeof f.door.dir !== "string" || !f.door.dir) errs.push(`fixture ${id}: door.dir must be a non-empty direction string`);
      if (!f.door.to || !has(rooms, f.door.to)) errs.push(`fixture ${id}: door.to references missing room ${f.door.to}`);
      if (f.door.open != null && typeof f.door.open !== "boolean") errs.push(`fixture ${id}: door.open must be a boolean`);
      // An optional `door.key` locks the door to carriers of that item template.
      if (f.door.key != null && !has(items, f.door.key)) errs.push(`fixture ${id}: door.key references missing item ${f.door.key}`);
      // An optional `door.requires` gates opening on an effective attribute score.
      if (f.door.requires != null) {
        const rq = f.door.requires;
        const ATTRS = ["might", "vitality", "intellect", "wits", "perception"];
        if (typeof rq !== "object") errs.push(`fixture ${id}: door.requires must be an object`);
        else {
          if (!ATTRS.includes(rq.attr)) errs.push(`fixture ${id}: door.requires.attr must be one of ${ATTRS.join(", ")}`);
          if (typeof rq.value !== "number" || rq.value <= 0) errs.push(`fixture ${id}: door.requires.value must be a positive number`);
          if (rq.failText != null && typeof rq.failText !== "string") errs.push(`fixture ${id}: door.requires.failText must be a string`);
          if (rq.successText != null && typeof rq.successText !== "string") errs.push(`fixture ${id}: door.requires.successText must be a string`);
        }
      }
    }
    if (f.mine) {
      checkResourceDrop(f.mine, "mine", id);
      for (const k of ["charges", "respawn"])
        if (typeof f.mine[k] !== "number" || f.mine[k] <= 0) errs.push(`fixture ${id}: mine.${k} must be a positive number`);
      if (f.mine.yield != null && (typeof f.mine.yield !== "number" || f.mine.yield <= 0))
        errs.push(`fixture ${id}: mine.yield must be a positive number`);
      if (f.mine.energy != null && (typeof f.mine.energy !== "number" || f.mine.energy < 0))
        errs.push(`fixture ${id}: mine.energy must be a non-negative number`);
    }
    if (f.harvest) {
      checkResourceDrop(f.harvest, "harvest", id);
      for (const k of ["charges", "respawn"])
        if (typeof f.harvest[k] !== "number" || f.harvest[k] <= 0) errs.push(`fixture ${id}: harvest.${k} must be a positive number`);
      if (f.harvest.yield != null && (typeof f.harvest.yield !== "number" || f.harvest.yield <= 0))
        errs.push(`fixture ${id}: harvest.yield must be a positive number`);
      if (f.harvest.energy != null && (typeof f.harvest.energy !== "number" || f.harvest.energy < 0))
        errs.push(`fixture ${id}: harvest.energy must be a non-negative number`);
    }
    if (f.fish) {
      checkResourceDrop(f.fish, "fish", id);
      if (f.fish.bait != null && !has(items, f.fish.bait)) errs.push(`fixture ${id}: fish.bait missing item ${f.fish.bait}`);
      for (const k of ["charges", "respawn"])
        if (typeof f.fish[k] !== "number" || f.fish[k] <= 0) errs.push(`fixture ${id}: fish.${k} must be a positive number`);
      if (f.fish.yield != null && (typeof f.fish.yield !== "number" || f.fish.yield <= 0))
        errs.push(`fixture ${id}: fish.yield must be a positive number`);
      if (f.fish.energy != null && (typeof f.fish.energy !== "number" || f.fish.energy < 0))
        errs.push(`fixture ${id}: fish.energy must be a non-negative number`);
      if (f.fish.catchChance != null && (typeof f.fish.catchChance !== "number" || f.fish.catchChance <= 0 || f.fish.catchChance > 1))
        errs.push(`fixture ${id}: fish.catchChance must be a number in (0, 1]`);
    }
  }

  const stations = new Set(Object.values(fixtures).map((f) => f.station).filter(Boolean));
  for (const [id, rc] of Object.entries(recipes)) {
    for (const i of rc.inputs || []) {
      if (!has(items, i.template)) errs.push(`recipe ${id}: input missing template ${i.template}`);
      if (i.qty != null && (typeof i.qty !== "number" || i.qty <= 0)) errs.push(`recipe ${id}: input ${i.template} qty must be a positive number`);
    }
    if (!rc.output || !has(items, rc.output.template))
      errs.push(`recipe ${id}: output missing template ${rc.output && rc.output.template}`);
    if (rc.station == null || !stations.has(rc.station))
      errs.push(`recipe ${id}: station "${rc.station}" has no matching fixture (known: ${[...stations].join(", ") || "none"})`);
    if (rc.shards != null && (typeof rc.shards !== "number" || rc.shards < 0))
      errs.push(`recipe ${id}: shards cost must be a non-negative number`);
  }

  // Spells: data-driven casting (manaCost + an effect primitive). `damage` is
  // instantaneous (dice + optional attribute scaling); `emit-light`,
  // `heal-over-time` and `protect` are statuses (heal pulses on an interval;
  // protect grants timed armour/ward).
  const SPELL_EFFECT_TYPES = ["damage", "damage-over-time", "damage-room", "douse", "drain", "mana-drain", "emit-light", "heal-over-time", "protect", "restore", "sleep", "summon", "cleanse"];
  // Effect types each PLAYER cast path resolves — must mirror the runtime sets
  // in server/commands/magic.js (HOSTILE_EFFECTS / SUPPORT_EFFECTS). A spell a
  // player can come to know must fall inside them, or `cast` refuses it.
  const PLAYER_HOSTILE_EFFECTS = ["damage", "damage-over-time", "sleep", "damage-room", "drain"];
  const PLAYER_SUPPORT_EFFECTS = ["restore", "protect", "cleanse", "heal-over-time", "emit-light"];
  const playerCastable = (sp) => {
    const t = (sp.effect || {}).type;
    return t === "summon" || (sp.hostile ? PLAYER_HOSTILE_EFFECTS : PLAYER_SUPPORT_EFFECTS).includes(t);
  };
  // Narration overrides a spell may carry (see fillTemplate in magic.js).
  const SPELL_MESSAGE_KEYS = ["self", "room", "hitVerb", "killVerb"];
  // The targeting contract: who a cast may land on. Routing in magic.js keys off
  // this (crossed with `hostile`, which decides eligibility for "room"), so it
  // must exist on every spell and agree with the effect's shape.
  const SPELL_TARGETS = ["self", "creature", "room"];
  // Validate a `{ base?, scale? }` amount spec (or a bare number) — used by the
  // protect effect's armour/ward components.
  const chkAmount = (a, where) => {
    if (a == null || typeof a === "number") return;
    if (typeof a !== "object") return void errs.push(`${where} must be a number or { base, scale }`);
    if (a.base != null && typeof a.base !== "number") errs.push(`${where}.base must be a number`);
    if (a.scale != null) {
      if (typeof a.scale !== "object" || !a.scale.attr) errs.push(`${where}.scale must be { attr, per }`);
      else if (a.scale.per != null && (typeof a.scale.per !== "number" || a.scale.per <= 0)) errs.push(`${where}.scale.per must be a positive number`);
    }
  };
  for (const [id, sp] of Object.entries(spells)) {
    if (sp.id !== id) errs.push(`spell ${id}: id field mismatch (${sp.id})`);
    if (sp.manaCost != null && (typeof sp.manaCost !== "number" || sp.manaCost < 0))
      errs.push(`spell ${id}: manaCost must be a non-negative number`);
    if (sp.shardCost != null && (typeof sp.shardCost !== "number" || sp.shardCost < 0))
      errs.push(`spell ${id}: shardCost must be a non-negative number`);
    // A material component consumed on cast (e.g. Glimmer Husk's chitin plate).
    if (sp.itemCost != null) {
      if (!Array.isArray(sp.itemCost)) errs.push(`spell ${id}: itemCost must be an array of { template, qty }`);
      else for (const c of sp.itemCost) {
        if (!c || typeof c !== "object" || !has(items, c.template)) errs.push(`spell ${id}: itemCost references missing item ${c && c.template}`);
        if (c && c.qty != null && (typeof c.qty !== "number" || c.qty <= 0)) errs.push(`spell ${id}: itemCost qty must be a positive number`);
      }
    }
    // Targeting: required, enum-checked, and cross-checked against the effect
    // shape so the field can never contradict how the spell actually resolves.
    if (!SPELL_TARGETS.includes(sp.target)) {
      errs.push(`spell ${id}: target must be one of ${SPELL_TARGETS.join(", ")}`);
    } else if (sp.effect && typeof sp.effect === "object" && sp.effect.type) {
      const t = sp.effect.type;
      if (t === "summon" && sp.target !== "self")
        errs.push(`spell ${id}: a summon conjures at the caster — target must be "self"`);
      if (sp.hostile && sp.target === "self")
        errs.push(`spell ${id}: a hostile spell cannot target "self"`);
      if (t === "damage-room" && sp.target !== "room")
        errs.push(`spell ${id}: a damage-room effect must have target "room"`);
      if (sp.hostile && ["damage", "damage-over-time", "sleep", "douse", "drain", "mana-drain"].includes(t) && sp.target !== "creature")
        errs.push(`spell ${id}: hostile effect "${t}" is single-target — target must be "creature"`);
    }
    // Optional narration overrides: an object of template strings by known key.
    if (sp.messages != null) {
      if (typeof sp.messages !== "object" || Array.isArray(sp.messages)) errs.push(`spell ${id}: messages must be an object of template strings`);
      else for (const [k, v] of Object.entries(sp.messages)) {
        if (!SPELL_MESSAGE_KEYS.includes(k)) errs.push(`spell ${id}: unknown messages key "${k}" (known: ${SPELL_MESSAGE_KEYS.join(", ")})`);
        else if (typeof v !== "string" || !v) errs.push(`spell ${id}: messages.${k} must be a non-empty string`);
      }
    }
    const eff = sp.effect;
    if (!eff || typeof eff !== "object" || !eff.type) {
      errs.push(`spell ${id}: effect must be an object { type, ... }`);
    } else if (!SPELL_EFFECT_TYPES.includes(eff.type)) {
      errs.push(`spell ${id}: unknown effect type "${eff.type}" (known: ${SPELL_EFFECT_TYPES.join(", ")})`);
    } else if (eff.type === "damage") {
      if (typeof eff.damage !== "string" || !DICE_RE.test(eff.damage))
        errs.push(`spell ${id}: effect.damage "${eff.damage}" is not valid dice notation`);
      if (eff.scale != null) {
        if (typeof eff.scale !== "object" || !eff.scale.attr) errs.push(`spell ${id}: effect.scale must be { attr, per }`);
        else if (eff.scale.per != null && (typeof eff.scale.per !== "number" || eff.scale.per <= 0))
          errs.push(`spell ${id}: effect.scale.per must be a positive number`);
      }
    } else if (eff.type === "damage-over-time") {
      // A clinging burn (Witchfire): per-tick dice over a timed duration, with an
      // optional Intellect `durationScale` lengthening the burn and an `emitLight`
      // glow shed for as long as it smoulders.
      if (typeof eff.damage !== "string" || !DICE_RE.test(eff.damage))
        errs.push(`spell ${id}: effect.damage "${eff.damage}" is not valid dice notation`);
      if (eff.duration != null && (typeof eff.duration !== "number" || eff.duration <= 0)) errs.push(`spell ${id}: effect.duration must be a positive number (ticks)`);
      if (eff.emitLight != null && (typeof eff.emitLight !== "number" || eff.emitLight < 0)) errs.push(`spell ${id}: effect.emitLight must be a non-negative number (light the burning foe sheds)`);
      if (eff.durationScale != null) {
        if (typeof eff.durationScale !== "object" || !eff.durationScale.attr) errs.push(`spell ${id}: effect.durationScale must be { attr, per }`);
        else if (eff.durationScale.per != null && (typeof eff.durationScale.per !== "number" || eff.durationScale.per <= 0))
          errs.push(`spell ${id}: effect.durationScale.per must be a positive number`);
      }
    } else if (eff.type === "damage-room") {
      // An area burst (Arc Flash): per-target dice + optional attribute scaling, via detonateRoom.
      if (typeof eff.damage !== "string" || !DICE_RE.test(eff.damage))
        errs.push(`spell ${id}: effect.damage "${eff.damage}" is not valid dice notation`);
      if (eff.scale != null) {
        if (typeof eff.scale !== "object" || !eff.scale.attr) errs.push(`spell ${id}: effect.scale must be { attr, per }`);
        else if (eff.scale.per != null && (typeof eff.scale.per !== "number" || eff.scale.per <= 0))
          errs.push(`spell ${id}: effect.scale.per must be a positive number`);
      }
    } else if (eff.type === "emit-light") {
      if (eff.magnitude != null && typeof eff.magnitude !== "number") errs.push(`spell ${id}: effect.magnitude must be a number`);
      if (eff.duration != null && (typeof eff.duration !== "number" || eff.duration <= 0)) errs.push(`spell ${id}: effect.duration must be a positive number (ticks)`);
    } else if (eff.type === "heal-over-time") {
      if (eff.magnitude != null && typeof eff.magnitude !== "number") errs.push(`spell ${id}: effect.magnitude must be a number`);
      if (eff.interval != null && (typeof eff.interval !== "number" || eff.interval <= 0)) errs.push(`spell ${id}: effect.interval must be a positive number (ticks)`);
      if (eff.duration != null && (typeof eff.duration !== "number" || eff.duration <= 0)) errs.push(`spell ${id}: effect.duration must be a positive number (ticks)`);
      if (eff.scale != null) {
        if (typeof eff.scale !== "object" || !eff.scale.attr) errs.push(`spell ${id}: effect.scale must be { attr, per }`);
        else if (eff.scale.per != null && (typeof eff.scale.per !== "number" || eff.scale.per <= 0))
          errs.push(`spell ${id}: effect.scale.per must be a positive number`);
      }
    } else if (eff.type === "protect") {
      if (eff.duration != null && (typeof eff.duration !== "number" || eff.duration <= 0)) errs.push(`spell ${id}: effect.duration must be a positive number (ticks)`);
      if (eff.armour == null && eff.ward == null && eff.voidWard == null) errs.push(`spell ${id}: protect effect needs at least one of armour/ward/voidWard`);
      chkAmount(eff.armour, `spell ${id}: effect.armour`);
      chkAmount(eff.ward, `spell ${id}: effect.ward`);
      chkAmount(eff.voidWard, `spell ${id}: effect.voidWard`); // vs void only (Umbral weaves)
    } else if (eff.type === "summon") {
      if (!eff.mob || !has(mobs, eff.mob)) errs.push(`spell ${id}: summon effect references missing mob ${eff.mob}`);
      if (eff.count != null && (typeof eff.count !== "number" || eff.count <= 0)) errs.push(`spell ${id}: summon count must be a positive number`);
      if (eff.duration != null && (typeof eff.duration !== "number" || eff.duration <= 0)) errs.push(`spell ${id}: summon duration must be a positive number (ticks)`);
      // durationScale lengthens the summon's lifetime with an attribute (ticks per point).
      if (eff.durationScale != null) {
        if (typeof eff.durationScale !== "object" || !eff.durationScale.attr) errs.push(`spell ${id}: effect.durationScale must be { attr, per }`);
        else if (eff.durationScale.per != null && (typeof eff.durationScale.per !== "number" || eff.durationScale.per <= 0))
          errs.push(`spell ${id}: effect.durationScale.per must be a positive number`);
      }
      if (eff.group != null && typeof eff.group !== "string") errs.push(`spell ${id}: summon group must be a string`);
    } else if (eff.type === "restore") {
      // An instant top-up (hp and/or mana), the spell twin of a potion's restore.
      if (eff.hp == null && eff.mana == null) errs.push(`spell ${id}: restore effect needs at least one of hp/mana`);
      if (eff.hp != null && (typeof eff.hp !== "number" || eff.hp <= 0)) errs.push(`spell ${id}: effect.hp must be a positive number`);
      if (eff.mana != null && (typeof eff.mana !== "number" || eff.mana <= 0)) errs.push(`spell ${id}: effect.mana must be a positive number`);
    }
  }

  // Every spell a player can come to KNOW — scrolls, books, quest rewards, the
  // new-player template — must resolve through a player cast path, or `cast`
  // refuses it at the table (e.g. `douse` is a mob-only weave; see magic.js).
  const learnable = new Map(); // spell id -> one source, for the error line
  for (const [id, it] of Object.entries(items)) {
    if (it.scroll && it.scroll.spell) learnable.set(it.scroll.spell, `item ${id} (scroll)`);
    for (const sid of (it.teaches && it.teaches.spells) || []) learnable.set(sid, `item ${id} (teaches)`);
  }
  for (const [id, q] of Object.entries(quests))
    for (const sid of (q.rewards && q.rewards.spells) || []) learnable.set(sid, `quest ${id} (reward)`);
  for (const sid of player.knownSpells || []) learnable.set(sid, "player template knownSpells");
  for (const [sid, src] of learnable) {
    const sp = spells[sid];
    if (sp && !playerCastable(sp))
      errs.push(`spell ${sid}: learnable via ${src} but its ${sp.hostile ? "hostile" : "support"} effect "${(sp.effect || {}).type}" has no player cast path (hostile: ${PLAYER_HOSTILE_EFFECTS.join("/")}; support: ${PLAYER_SUPPORT_EFFECTS.join("/")}; or summon)`);
  }

  // Quests: data-driven goals (data/world/quests.json). A `start` trigger offers
  // the quest; ordered `steps` each carry exactly one objective; `rewards` pay out
  // on completion. Every referenced template (mob/item/fixture/room/recipe/spell)
  // must resolve.
  const QUEST_TRIGGERS = ["talk", "use", "item", "enter"];
  const OBJ_KEYS = ["kill", "deliver", "use", "collect"];
  for (const [id, q] of Object.entries(quests)) {
    if (q.id !== id) errs.push(`quest ${id}: id field mismatch (${q.id})`);
    if (typeof q.name !== "string" || !q.name) errs.push(`quest ${id}: name must be a non-empty string`);
    if (q.repeatable != null && typeof q.repeatable !== "boolean") errs.push(`quest ${id}: repeatable must be a boolean`);
    const s = q.start;
    if (!s || typeof s !== "object" || !QUEST_TRIGGERS.includes(s.trigger)) {
      errs.push(`quest ${id}: start.trigger must be one of ${QUEST_TRIGGERS.join(", ")}`);
    } else {
      if (s.trigger === "talk" && !has(mobs, s.npc)) errs.push(`quest ${id}: start.npc references missing mob ${s.npc}`);
      if (s.trigger === "use" && !has(fixtures, s.fixture)) errs.push(`quest ${id}: start.fixture references missing fixture ${s.fixture}`);
      if (s.trigger === "item" && !has(items, s.item)) errs.push(`quest ${id}: start.item references missing item ${s.item}`);
      if (s.trigger === "enter" && !has(rooms, s.room)) errs.push(`quest ${id}: start.room references missing room ${s.room}`);
    }
    if (!Array.isArray(q.steps) || !q.steps.length) {
      errs.push(`quest ${id}: needs a non-empty steps array`);
    } else {
      q.steps.forEach((step, i) => {
        const present = OBJ_KEYS.filter((k) => step[k] != null);
        if (present.length !== 1) { errs.push(`quest ${id} step ${i}: must have exactly one objective key (${OBJ_KEYS.join("/")})`); return; }
        const kind = present[0];
        if (["kill", "deliver", "collect"].includes(kind) && step.count != null && (typeof step.count !== "number" || step.count <= 0))
          errs.push(`quest ${id} step ${i}: count must be a positive number`);
        if (kind === "kill" && !has(mobs, step.kill)) errs.push(`quest ${id} step ${i}: kill references missing mob ${step.kill}`);
        if (kind === "collect" && !has(items, step.collect)) errs.push(`quest ${id} step ${i}: collect references missing item ${step.collect}`);
        if (kind === "use" && !has(fixtures, step.use)) errs.push(`quest ${id} step ${i}: use references missing fixture ${step.use}`);
        if (kind === "deliver") {
          if (!has(items, step.deliver)) errs.push(`quest ${id} step ${i}: deliver references missing item ${step.deliver}`);
          if (!has(mobs, step.npc)) errs.push(`quest ${id} step ${i}: deliver.npc references missing mob ${step.npc}`);
        }
        if (step.text != null && typeof step.text !== "string") errs.push(`quest ${id} step ${i}: text must be a string`);
      });
    }
    const r = q.rewards;
    if (r != null) {
      if (typeof r !== "object") errs.push(`quest ${id}: rewards must be an object`);
      else {
        if (r.xp != null && (typeof r.xp !== "number" || r.xp < 0)) errs.push(`quest ${id}: rewards.xp must be a non-negative number`);
        if (r.shards != null && (typeof r.shards !== "number" || r.shards < 0)) errs.push(`quest ${id}: rewards.shards must be a non-negative number`);
        for (const it of r.items || []) {
          if (!it || !has(items, it.template)) errs.push(`quest ${id}: rewards.items references missing item ${it && it.template}`);
          if (it && it.qty != null && (typeof it.qty !== "number" || it.qty <= 0)) errs.push(`quest ${id}: rewards.items qty must be a positive number`);
        }
        for (const rid of r.recipes || []) if (!has(recipes, rid)) errs.push(`quest ${id}: rewards.recipes references missing recipe ${rid}`);
        for (const sid of r.spells || []) if (!has(spells, sid)) errs.push(`quest ${id}: rewards.spells references missing spell ${sid}`);
      }
    }
  }

  // The Tide (data/world/tide.json): the world clock's config — timing, darkening,
  // generation, messages, emotes. Cross-check the phase vocabulary and every mob
  // the dark looses; a re-storied world lives or dies by this file resolving.
  {
    if (tide.enabled != null && typeof tide.enabled !== "boolean") errs.push("tide: enabled must be a boolean");
    if (!Array.isArray(tide.phases) || !tide.phases.length || !tide.phases.every((p) => typeof p === "string"))
      errs.push("tide: phases must be a non-empty array of phase-name strings");
    const knownPhase = (p) => tidePhases.includes(p);
    const phaseList = (arr, where) => {
      if (arr == null) return;
      if (!Array.isArray(arr) || arr.some((p) => !knownPhase(p)))
        errs.push(`tide: ${where} must be an array of known phases (${tidePhases.join(", ")})`);
    };
    // Every declared phase needs a length, and every length names a real phase.
    if (tide.phaseTicks == null || typeof tide.phaseTicks !== "object") {
      errs.push("tide: phaseTicks must be an object of phase -> tick count");
    } else {
      for (const p of tidePhases)
        if (typeof tide.phaseTicks[p] !== "number" || tide.phaseTicks[p] < 0)
          errs.push(`tide: phaseTicks.${p} must be a non-negative number`);
      for (const p of Object.keys(tide.phaseTicks)) if (!knownPhase(p)) errs.push(`tide: phaseTicks has unknown phase "${p}"`);
    }
    const d = tide.darkening;
    if (d != null) {
      for (const k of ["deepCap", "edgeOffset", "tideBase"])
        if (d[k] != null && typeof d[k] !== "number") errs.push(`tide: darkening.${k} must be a number`);
      if (d.tideDepthDivisor != null && (typeof d.tideDepthDivisor !== "number" || d.tideDepthDivisor <= 0))
        errs.push("tide: darkening.tideDepthDivisor must be a positive number");
      phaseList(d.tidePhases, "darkening.tidePhases");
      phaseList(d.edgePhases, "darkening.edgePhases");
    }
    const lamp = tide.lamp;
    if (lamp != null) {
      phaseList(lamp.onPhases, "lamp.onPhases");
      phaseList(lamp.offPhases, "lamp.offPhases");
      for (const k of ["onMessage", "offMessage"])
        if (lamp[k] != null && typeof lamp[k] !== "string") errs.push(`tide: lamp.${k} must be a string`);
    }
    if (tide.phaseMessages != null) {
      if (typeof tide.phaseMessages !== "object" || Array.isArray(tide.phaseMessages)) errs.push("tide: phaseMessages must be an object of phase -> string");
      else for (const [p, v] of Object.entries(tide.phaseMessages)) {
        if (!knownPhase(p)) errs.push(`tide: phaseMessages has unknown phase "${p}"`);
        if (typeof v !== "string" || !v) errs.push(`tide: phaseMessages.${p} must be a non-empty string`);
      }
    }
    // A `chance` knob is a probability in (0, 1].
    const chkChance = (v, where) => { if (v != null && (typeof v !== "number" || v <= 0 || v > 1)) errs.push(`tide: ${where} must be a number in (0, 1]`); };
    // The per-tick creep predator(s) — one rule, an array of rules, or null (a
    // toothless Tide). Each rule is validated the same way; `where` names it.
    if (tide.predator != null) {
      const chkPredator = (pr, where) => {
        if (!pr || typeof pr !== "object") return errs.push(`tide: ${where} must be an object`);
        if (!has(mobs, pr.mob)) errs.push(`tide: ${where}.mob references missing mob ${pr.mob}`);
        chkChance(pr.chance, `${where}.chance`);
        if (pr.cap != null && (typeof pr.cap !== "number" || pr.cap < 0)) errs.push(`tide: ${where}.cap must be a non-negative number`);
        if (pr.maxLight != null && typeof pr.maxLight !== "number") errs.push(`tide: ${where}.maxLight must be a number`);
        if (pr.faction != null && !FACTIONS.includes(pr.faction)) errs.push(`tide: ${where}.faction "${pr.faction}" is not one of ${FACTIONS.join(", ")}`);
        if (pr.noSpoils != null && typeof pr.noSpoils !== "boolean") errs.push(`tide: ${where}.noSpoils must be a boolean`);
      };
      if (Array.isArray(tide.predator)) tide.predator.forEach((pr, i) => chkPredator(pr, `predator[${i}]`));
      else chkPredator(tide.predator, "predator");
    }
    // The onset roster the dark looses across depth bands.
    if (tide.spawns != null) {
      if (!Array.isArray(tide.spawns)) errs.push("tide: spawns must be an array of rules");
      else tide.spawns.forEach((r, i) => {
        if (!r || typeof r !== "object") return errs.push(`tide: spawns[${i}] must be an object`);
        if (!has(mobs, r.mob)) errs.push(`tide: spawns[${i}] references missing mob ${r.mob}`);
        for (const k of ["minDepth", "maxDepth", "maxLight"])
          if (r[k] != null && typeof r[k] !== "number") errs.push(`tide: spawns[${i}].${k} must be a number`);
        if (r.count != null && (typeof r.count !== "number" || r.count <= 0)) errs.push(`tide: spawns[${i}].count must be a positive number`);
        if (r.faction != null && !FACTIONS.includes(r.faction)) errs.push(`tide: spawns[${i}].faction "${r.faction}" is not one of ${FACTIONS.join(", ")}`);
        if (r.noSpoils != null && typeof r.noSpoils !== "boolean") errs.push(`tide: spawns[${i}].noSpoils must be a boolean`);
      });
    }
    // Ambient per-phase emotes.
    if (tide.emotes != null) {
      if (typeof tide.emotes !== "object" || Array.isArray(tide.emotes)) errs.push("tide: emotes must be an object keyed by phase");
      else for (const [p, e] of Object.entries(tide.emotes)) {
        if (!knownPhase(p)) errs.push(`tide: emotes has unknown phase "${p}"`);
        if (!e || typeof e !== "object") { errs.push(`tide: emotes.${p} must be an object`); continue; }
        if (!Array.isArray(e.lines) || !e.lines.length || e.lines.some((l) => typeof l !== "string" || !l))
          errs.push(`tide: emotes.${p}.lines must be a non-empty array of strings`);
        if (e.everyTicks != null && (typeof e.everyTicks !== "number" || e.everyTicks < 0)) errs.push(`tide: emotes.${p}.everyTicks must be a non-negative number`);
        chkChance(e.chance, `emotes.${p}.chance`);
        if (e.requireDark != null && typeof e.requireDark !== "boolean") errs.push(`tide: emotes.${p}.requireDark must be a boolean`);
      }
    }
  }

  // The Scheduler (data/world/schedule.json): timed events. Each entry needs a
  // unique id, a positive fire cadence, and a known action type (the whitelist is
  // imported from schedule-actions.js, so it stays in lockstep with the engine).
  // Per-type params are checked below — `visit` is the only type today.
  {
    if (schedule != null && !Array.isArray(schedule)) {
      errs.push("schedule: must be an array of scheduled entries");
    } else {
      const seenIds = new Set();
      (schedule || []).forEach((e, i) => {
        if (!e || typeof e !== "object") return errs.push(`schedule[${i}] must be an object`);
        const where = e.id ? `schedule "${e.id}"` : `schedule[${i}]`;
        if (typeof e.id !== "string" || !e.id) errs.push(`${where}: id must be a non-empty string`);
        else if (seenIds.has(e.id)) errs.push(`${where}: duplicate id`);
        else seenIds.add(e.id);
        if (typeof e.everyTicks !== "number" || e.everyTicks <= 0) errs.push(`${where}: everyTicks must be a positive number`);
        if (e.firstTicks != null && (typeof e.firstTicks !== "number" || e.firstTicks < 0)) errs.push(`${where}: firstTicks must be a non-negative number`);
        const a = e.action;
        if (!a || typeof a !== "object") { errs.push(`${where}: action must be an object`); return; }
        if (!SCHEDULE_ACTION_TYPES.includes(a.type)) {
          errs.push(`${where}: action.type "${a.type}" is not one of ${SCHEDULE_ACTION_TYPES.join(", ")}`);
          return;
        }
        if (a.type === "visit") {
          if (!has(mobs, a.mob)) errs.push(`${where}: action.mob references missing mob ${a.mob}`);
          if (!has(rooms, a.room)) errs.push(`${where}: action.room references missing room ${a.room}`);
          if (typeof a.stayTicks !== "number" || a.stayTicks <= 0) errs.push(`${where}: action.stayTicks must be a positive number`);
          else if (typeof e.everyTicks === "number" && a.stayTicks >= e.everyTicks) errs.push(`${where}: action.stayTicks must be less than everyTicks`);
        }
      });
    }
  }

  if (!has(rooms, player.startLocation))
    errs.push(`player: startLocation references missing room ${player.startLocation}`);
  for (const i of player.startInventory || [])
    if (!has(items, i.template)) errs.push(`player: startInventory missing template ${i.template}`);
  for (const [slot, it] of Object.entries(player.startEquipment || {}))
    if (it !== null && !has(items, it)) errs.push(`player: startEquipment ${slot} missing template ${it}`);
  for (const rid of player.knownRecipes || [])
    if (!has(recipes, rid)) errs.push(`player: knownRecipes references missing recipe ${rid}`);
  for (const sid of player.knownSpells || [])
    if (!has(spells, sid)) errs.push(`player: knownSpells references missing spell ${sid}`);

  // Reachability from the starting room.
  const seen = new Set();
  const stack = [player.startLocation];
  while (stack.length) {
    const c = stack.pop();
    if (seen.has(c) || !rooms[c]) continue;
    seen.add(c);
    for (const dest of Object.values(rooms[c].exits || {})) stack.push(dest);
    // A hidden exit still connects rooms — a room reachable only via one is reachable.
    for (const h of Object.values(rooms[c].hiddenExits || {})) if (h && h.to) stack.push(h.to);
    // A door fixture in the room is an edge too (you `use` it to open the way through).
    for (const f of rooms[c].fixtures || []) {
      const ft = fixtures[typeof f === "string" ? f : f.template];
      if (ft && ft.door && ft.door.to) stack.push(ft.door.to);
    }
  }
  for (const id of Object.keys(rooms))
    if (!seen.has(id)) errs.push(`room ${id}: NOT reachable from start (${player.startLocation})`);

  // ── Vertical consistency: derived floors ─────────────────────────────────
  // `depth` is the progression band (the rung of the descent), NOT elevation.
  // True elevation — the "floor" — is derived from the exit graph: an up/down
  // exit moves one floor unless the source room's `exitSpans` declares a longer
  // shaft; every other direction stays level. The solve must close: two routes
  // to the same room must agree on its floor, otherwise the world's geometry
  // contradicts itself and no floor-accurate map of it can be drawn.
  // (map-3d solves with the same rules and the shared FLOOR_CUTS above.)
  const edgeList = (rid) => {
    const r = rooms[rid], out = [];
    for (const [dir, to] of Object.entries(r.exits || {})) out.push([dir, to]);
    for (const [dir, h] of Object.entries(r.hiddenExits || {})) if (h && h.to) out.push([dir, h.to]);
    for (const f of r.fixtures || []) {
      const ft = fixtures[typeof f === "string" ? f : f.template];
      if (ft && ft.door && ft.door.to) out.push([ft.door.dir, ft.door.to]);
    }
    return out;
  };
  const cutSet = new Set(FLOOR_CUTS.flatMap(({ a, b }) => [a + " " + b, b + " " + a]));
  const floorStep = (rid, dir) => {
    const span = (rooms[rid].exitSpans || {})[dir] || 1;
    return dir === "down" ? -span : dir === "up" ? span : 0;
  };
  const floors = new Map([[player.startLocation, 0]]);
  const fq = [player.startLocation];
  while (fq.length) {
    const c = fq.shift();
    if (!rooms[c]) continue;
    for (const [dir, to] of edgeList(c)) {
      if (!rooms[to] || cutSet.has(c + " " + to)) continue;
      const f = floors.get(c) + floorStep(c, dir);
      if (floors.has(to)) {
        if (floors.get(to) !== f)
          errs.push(`floor solve: ${c} -${dir}-> ${to} implies floor ${f}, but another route already solved ${to} to floor ${floors.get(to)} (vertical loop does not close)`);
      } else {
        floors.set(to, f);
        fq.push(to);
      }
    }
  }
  for (const id of Object.keys(rooms))
    if (seen.has(id) && !floors.has(id))
      errs.push(`floor solve: ${id} is only reachable through a FLOOR_CUTS edge — cannot assign a floor`);
  for (const { a, b } of FLOOR_CUTS) {
    if (!rooms[a] || !rooms[b]) { errs.push(`floor solve: FLOOR_CUTS references missing room ${!rooms[a] ? a : b}`); continue; }
    const ab = edgeList(a).find(([, to]) => to === b);
    const ba = edgeList(b).find(([, to]) => to === a);
    if (!ab && !ba) { errs.push(`floor solve: FLOOR_CUTS ${a} <-> ${b} matches no edge — remove it`); continue; }
    const satisfied = (from, to, e) =>
      !e || (floors.has(from) && floors.has(to) && floors.get(to) === floors.get(from) + floorStep(from, e[0]));
    if (satisfied(a, b, ab) && satisfied(b, a, ba))
      errs.push(`floor solve: FLOOR_CUTS ${a} <-> ${b} is satisfied by the solve — the cut is stale, remove it`);
  }

  // ── Exit reciprocity ──────────────────────────────────────────────────
  // A one-way passage is legal (no return edge at all), but where a return
  // edge exists it must run in the exact opposite direction — a pair like
  // "down one way, west back" lies about the shape of the world. Checked
  // across all three edge kinds.
  const OPP = { north: "south", south: "north", east: "west", west: "east", up: "down", down: "up" };
  for (const id of Object.keys(rooms))
    for (const [dir, to] of edgeList(id)) {
      if (!rooms[to] || !OPP[dir]) continue;
      const back = edgeList(to).filter(([, t]) => t === id);
      if (back.length && !back.some(([d]) => d === OPP[dir]))
        errs.push(`room ${id}: exit ${dir} -> ${to} returns via ${back.map(([d]) => d).join("/")} — a return exit must be the opposite direction (${OPP[dir]}), or absent (one-way)`);
    }

  // ── Zone contiguity ───────────────────────────────────────────────────
  // `zone` bounds wander (scope: "zone"), so a zone split into islands
  // strands zone-scoped mobs. Every zone must be one connected piece unless
  // declared in PENDING_ZONE_LINKS (built top-down, connection upcoming).
  const zoneRooms = new Map();
  for (const [id, r] of Object.entries(rooms))
    if (r.zone) {
      if (!zoneRooms.has(r.zone)) zoneRooms.set(r.zone, []);
      zoneRooms.get(r.zone).push(id);
    }
  const pendingZones = new Set(PENDING_ZONE_LINKS.map((p) => p.zone));
  for (const [zone, ids] of zoneRooms) {
    const zseen = new Set([ids[0]]);
    const zq = [ids[0]];
    while (zq.length) {
      const c = zq.shift();
      for (const [, to] of edgeList(c))
        if (rooms[to] && rooms[to].zone === zone && !zseen.has(to)) { zseen.add(to); zq.push(to); }
    }
    const stranded = ids.filter((i) => !zseen.has(i));
    if (stranded.length && !pendingZones.has(zone))
      errs.push(`zone ${zone}: not contiguous — unreachable from ${ids[0]} within the zone: ${stranded.join(", ")} (declare in PENDING_ZONE_LINKS while the connecting content is upcoming)`);
    if (!stranded.length && pendingZones.has(zone))
      errs.push(`zone ${zone}: PENDING_ZONE_LINKS entry is stale — the zone is contiguous now, remove it`);
  }
  for (const p of PENDING_ZONE_LINKS)
    if (!zoneRooms.has(p.zone)) errs.push(`PENDING_ZONE_LINKS references unknown zone ${p.zone}`);

  // ── Horizontal direction consistency ──────────────────────────────────
  // Compass directions are authored truth; distances are not (a "west"
  // passage may be long or short, so lengths stay free variables). Per axis,
  // a perpendicular exit pins two rooms to the same coordinate and a parallel
  // exit orders them strictly; a loop whose directions cannot reconcile at
  // ANY choice of lengths (it nets eastward no matter what) is a direction
  // lie. Vertical and unrecognised directions impose no horizontal constraint.
  const allEdges = [];
  for (const id of Object.keys(rooms))
    for (const [dir, to] of edgeList(id)) if (rooms[to]) allEdges.push([id, dir, to]);
  const gridErrors = (cuts) => {
    const cset = new Set(cuts.flatMap(({ a, b }) => [a + " " + b, b + " " + a]));
    const out = [];
    for (const [axis, posDir, negDir, eqA, eqB] of [
      ["x", "east", "west", "north", "south"],
      ["y", "north", "south", "east", "west"],
    ]) {
      // union-find: perpendicular edges pin rooms to the same axis coordinate
      const parent = {};
      const find = (n) => (parent[n] === n ? n : (parent[n] = find(parent[n])));
      for (const id of Object.keys(rooms)) parent[id] = id;
      for (const [a, dir, b] of allEdges)
        if ((dir === eqA || dir === eqB) && !cset.has(a + " " + b)) {
          const ra = find(a), rb = find(b);
          if (ra !== rb) parent[ra] = rb;
        }
      // parallel edges strictly order the pinned classes; a directed cycle can
      // never flatten, whatever lengths the passages take
      const adj = new Map();
      for (const [a, dir, b] of allEdges) {
        if (cset.has(a + " " + b)) continue;
        let from, to2;
        if (dir === posDir) { from = find(a); to2 = find(b); }
        else if (dir === negDir) { from = find(b); to2 = find(a); }
        else continue;
        if (from === to2) {
          out.push(`grid: ${a} -${dir}-> ${b} needs a strict ${axis} offset, but a perpendicular path pins the two rooms ${axis}-equal`);
          continue;
        }
        if (!adj.has(from)) adj.set(from, []);
        adj.get(from).push({ to: to2, via: `${a} -${dir}-> ${b}` });
      }
      const state = new Map();
      const stack = [];
      const dfs = (u) => {
        state.set(u, 1);
        for (const e of adj.get(u) || []) {
          const st = state.get(e.to) || 0;
          if (st === 0) { stack.push(e); dfs(e.to); stack.pop(); }
          else if (st === 1) {
            const start = stack.findIndex((se) => se.to === e.to);
            const loop = stack.slice(start < 0 ? 0 : start).concat([e]).map((x) => x.via);
            out.push(`grid: loop cannot flatten on the ${axis} axis at any passage lengths: ${loop.join("  +  ")}`);
          }
        }
        state.set(u, 2);
      };
      for (const u of adj.keys()) if (!state.get(u)) dfs(u);
    }
    return out;
  };
  errs.push(...gridErrors(GRID_CUTS));
  for (const cut of GRID_CUTS) {
    if (!rooms[cut.a] || !rooms[cut.b]) { errs.push(`grid: GRID_CUTS references missing room ${!rooms[cut.a] ? cut.a : cut.b}`); continue; }
    if (!allEdges.some(([a, , b]) => (a === cut.a && b === cut.b) || (a === cut.b && b === cut.a))) {
      errs.push(`grid: GRID_CUTS ${cut.a} <-> ${cut.b} matches no edge — remove it`);
      continue;
    }
    if (!gridErrors(GRID_CUTS.filter((c) => c !== cut)).length)
      errs.push(`grid: GRID_CUTS ${cut.a} <-> ${cut.b} is satisfied by the solve — the cut is stale, remove it`);
  }

  if (errs.length) {
    console.error("VALIDATION FAILED:\n" + errs.map((e) => "  - " + e).join("\n"));
    process.exit(1);
  }

  // Optional elevation report (--floors): the solved floor of every band, for
  // retuning bands, choosing exitSpans values, and spotting mis-banded rooms.
  if (process.argv.includes("--floors")) {
    const byBand = new Map(), byFloor = new Map();
    for (const [id, f] of floors) {
      const d = rooms[id].depth;
      if (!byBand.has(d)) byBand.set(d, []);
      byBand.get(d).push(f);
      if (!byFloor.has(f)) byFloor.set(f, new Map());
      byFloor.get(f).set(d, (byFloor.get(f).get(d) || 0) + 1);
    }
    const median = (xs) => xs.slice().sort((p, q) => p - q)[xs.length >> 1];
    const trunk = new Map([...byBand].map(([d, fs2]) => [d, median(fs2)]));
    console.log(`FLOOR REPORT — floor 0 = ${player.startLocation}; up positive, down negative`);
    console.log("  band | rooms | floors     | trunk (median)");
    for (const d of [...byBand.keys()].sort((p, q) => p - q)) {
      const fs2 = byBand.get(d);
      console.log(
        `  d${String(d).padEnd(3)} | ${String(fs2.length).padStart(5)} | ` +
        `${String(Math.min(...fs2)).padStart(3)} .. ${String(Math.max(...fs2)).padEnd(3)} | ${trunk.get(d)}`
      );
    }
    console.log("  floor | rooms | bands present");
    for (const f of [...byFloor.keys()].sort((p, q) => q - p)) {
      const bands = [...byFloor.get(f)].sort((p, q) => p[0] - q[0]).map(([d, c]) => `d${d}(${c})`).join(" ");
      const total = [...byFloor.get(f).values()].reduce((s, c) => s + c, 0);
      console.log(`  ${String(f).padStart(5)} | ${String(total).padStart(5)} | ${bands}`);
    }
    const outliers = [...floors].filter(([id, f]) => Math.abs(f - trunk.get(rooms[id].depth)) >= 2);
    if (outliers.length) {
      console.log("  rooms >= 2 floors from their band's trunk (re-band or span candidates):");
      for (const [id, f] of outliers.sort((p, q) => p[1] - q[1]))
        console.log(`    ${id}  floor ${f}  (band trunk ${trunk.get(rooms[id].depth)})`);
    }
  }

  console.log(
    `OK: ${Object.keys(rooms).length} rooms, ${Object.keys(items).length} items, ` +
      `${Object.keys(mobs).length} mobs, ${Object.keys(fixtures).length} fixtures, ` +
      `${Object.keys(recipes).length} recipes, ${Object.keys(spells).length} spells, ` +
      `${Object.keys(quests).length} quests. ` +
      `All references resolve; all rooms reachable from ${player.startLocation}.`
  );
}

if (require.main === module) main();

module.exports = { FLOOR_CUTS, GRID_CUTS };
