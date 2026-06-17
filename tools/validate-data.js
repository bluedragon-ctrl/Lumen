#!/usr/bin/env node
/**
 * Validates Lumen static world data: JSON validity, cross-references, and
 * reachability of all rooms from the starting location.
 *
 * Usage:  node tools/validate-data.js
 * Exits non-zero on any error (suitable for a pre-merge check).
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { FACTIONS } = require("../server/config");

const ROOT = path.resolve(__dirname, "..");
const read = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), "utf8"));
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
// Dice notation: "<count>d<sides>" with optional "+/-<flat>", or a plain integer.
const DICE_RE = /^\d+d\d+([+-]\d+)?$|^\d+$/;

function main() {
  const rooms = read("data/world/rooms.json");
  const items = read("data/world/items.json");
  const mobs = read("data/world/mobs.json");
  const fixtures = read("data/world/fixtures.json");
  const recipes = read("data/world/recipes.json");
  const spells = read("data/world/spells.json");
  const quests = read("data/world/quests.json");
  const player = read("data/templates/player.json");

  const errs = [];

  // A `hidden: { perception }` block gates a feature behind `search` (positive req).
  const checkHidden = (h, where) => {
    if (h == null) return;
    if (typeof h !== "object" || typeof h.perception !== "number" || h.perception <= 0)
      errs.push(`${where}: hidden.perception must be a positive number`);
  };

  for (const [id, r] of Object.entries(rooms)) {
    if (r.id !== id) errs.push(`room ${id}: id field mismatch (${r.id})`);
    if (r.zone != null && typeof r.zone !== "string") errs.push(`room ${id}: zone must be a string`);
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
  }

  const EFFECT_TYPES = ["emit-light", "restore", "damage-over-time"];
  // Consumables add `damage-room` — a thrown area bomb that blasts every foe in
  // the room (see commands.throwBomb / state.detonateRoom) — and `heal-over-time`,
  // a drunk-down regen pulse (the `drink` path pushes any non-`restore` effect as a
  // status; _tickEffects mends the drinker each interval, as the Regeneration spell
  // does). Neither is valid on a weapon onHit/onDamage trigger, so they live apart
  // from EFFECT_TYPES.
  const CONSUMABLE_EFFECT_TYPES = [...EFFECT_TYPES, "damage-room", "heal-over-time"];
  const ATTRS = ["might", "vitality", "intellect", "wits", "perception"];
  const RARITIES = ["common", "uncommon", "rare", "epic", "legendary"];

  // Combat triggers (see GameState.applyHitOutcome): `onHit` is a list of effect
  // specs an attacker lands on a hit (mob `attack.onHit` / item `weapon.onHit`);
  // `spikes` is a defender's melee reflect (mob-level / item `armour.spikes`).
  const checkOnHit = (arr, where) => {
    if (arr == null) return;
    if (!Array.isArray(arr)) { errs.push(`${where}: onHit must be an array of effect specs`); return; }
    for (const spec of arr) {
      if (!spec || typeof spec !== "object") { errs.push(`${where}: onHit entry must be an object { type, ... }`); continue; }
      if (!EFFECT_TYPES.includes(spec.type)) errs.push(`${where}: onHit unknown effect type "${spec.type}" (known: ${EFFECT_TYPES.join(", ")})`);
      if (spec.type === "damage-over-time" && (typeof spec.damage !== "string" || !DICE_RE.test(spec.damage)))
        errs.push(`${where}: onHit damage-over-time needs valid dice (got "${spec.damage}")`);
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
      }
    }
  }

  for (const [id, m] of Object.entries(mobs)) {
    for (const l of m.loot || [])
      if (!has(items, l.template)) errs.push(`mob ${id}: loot references missing template ${l.template}`);
    if (m.attack && (typeof m.attack.damage !== "string" || !DICE_RE.test(m.attack.damage)))
      errs.push(`mob ${id}: attack.damage "${m.attack.damage}" is not valid dice notation`);
    if (m.attack) checkOnHit(m.attack.onHit, `mob ${id} attack`); // bite poisons, etc.
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
    // Authored starting posture — a dozing/resting mob is inert until struck.
    if (m.posture != null && !["standing", "sitting", "sleeping"].includes(m.posture))
      errs.push(`mob ${id}: posture must be "standing", "sitting", or "sleeping"`);
    // Instance faction (the side this creature fights for); defaults to "wild".
    // Whitelist is shared with the game via server/config.js (single source).
    if (m.faction != null && !FACTIONS.includes(m.faction))
      errs.push(`mob ${id}: faction must be one of ${FACTIONS.map((f) => `"${f}"`).join(", ")}`);
    if (m.remembers != null && typeof m.remembers !== "boolean")
      errs.push(`mob ${id}: remembers must be a boolean`);
    if (m.armour != null && typeof m.armour !== "number")
      errs.push(`mob ${id}: armour must be a number`);
    if (m.ward != null && typeof m.ward !== "number")
      errs.push(`mob ${id}: ward must be a number`);
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
    }
    if (f.mine) {
      if (!has(items, f.mine.template)) errs.push(`fixture ${id}: mine.template missing item ${f.mine.template}`);
      for (const k of ["charges", "respawn"])
        if (typeof f.mine[k] !== "number" || f.mine[k] <= 0) errs.push(`fixture ${id}: mine.${k} must be a positive number`);
      if (f.mine.yield != null && (typeof f.mine.yield !== "number" || f.mine.yield <= 0))
        errs.push(`fixture ${id}: mine.yield must be a positive number`);
      if (f.mine.energy != null && (typeof f.mine.energy !== "number" || f.mine.energy < 0))
        errs.push(`fixture ${id}: mine.energy must be a non-negative number`);
    }
    if (f.harvest) {
      if (!has(items, f.harvest.template)) errs.push(`fixture ${id}: harvest.template missing item ${f.harvest.template}`);
      for (const k of ["charges", "respawn"])
        if (typeof f.harvest[k] !== "number" || f.harvest[k] <= 0) errs.push(`fixture ${id}: harvest.${k} must be a positive number`);
      if (f.harvest.yield != null && (typeof f.harvest.yield !== "number" || f.harvest.yield <= 0))
        errs.push(`fixture ${id}: harvest.yield must be a positive number`);
      if (f.harvest.energy != null && (typeof f.harvest.energy !== "number" || f.harvest.energy < 0))
        errs.push(`fixture ${id}: harvest.energy must be a non-negative number`);
    }
    if (f.fish) {
      if (!has(items, f.fish.template)) errs.push(`fixture ${id}: fish.template missing item ${f.fish.template}`);
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
  const SPELL_EFFECT_TYPES = ["damage", "damage-over-time", "damage-room", "douse", "emit-light", "heal-over-time", "protect", "sleep", "summon"];
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
      if (eff.armour == null && eff.ward == null) errs.push(`spell ${id}: protect effect needs at least one of armour/ward`);
      chkAmount(eff.armour, `spell ${id}: effect.armour`);
      chkAmount(eff.ward, `spell ${id}: effect.ward`);
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
    }
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

  if (errs.length) {
    console.error("VALIDATION FAILED:\n" + errs.map((e) => "  - " + e).join("\n"));
    process.exit(1);
  }
  console.log(
    `OK: ${Object.keys(rooms).length} rooms, ${Object.keys(items).length} items, ` +
      `${Object.keys(mobs).length} mobs, ${Object.keys(fixtures).length} fixtures, ` +
      `${Object.keys(recipes).length} recipes, ${Object.keys(spells).length} spells, ` +
      `${Object.keys(quests).length} quests. ` +
      `All references resolve; all rooms reachable from ${player.startLocation}.`
  );
}

main();
