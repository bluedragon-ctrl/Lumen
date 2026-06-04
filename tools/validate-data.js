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
    if (it.armour) { checkSpikes(it.armour.spikes, `item ${id} armour`); checkOnDamage(it.armour.onDamage, `item ${id} armour`); } // player thorns / when-struck triggers (forward-ready)
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
    const eff = it.consumable && it.consumable.effect;
    if (eff != null) {
      if (typeof eff !== "object")
        errs.push(`item ${id}: consumable.effect must be an effect object { type, ... }`);
      else {
        if (!EFFECT_TYPES.includes(eff.type)) errs.push(`item ${id}: unknown effect type "${eff.type}" (known: ${EFFECT_TYPES.join(", ")})`);
        if (eff.magnitude != null && typeof eff.magnitude !== "number") errs.push(`item ${id}: effect.magnitude must be a number`);
        if (eff.duration != null && (typeof eff.duration !== "number" || eff.duration <= 0)) errs.push(`item ${id}: effect.duration must be a positive number (ticks)`);
        if (eff.hp != null && typeof eff.hp !== "number") errs.push(`item ${id}: effect.hp must be a number`);
        if (eff.mana != null && typeof eff.mana !== "number") errs.push(`item ${id}: effect.mana must be a number`);
        if (eff.damage != null && (typeof eff.damage !== "string" || !DICE_RE.test(eff.damage)))
          errs.push(`item ${id}: effect.damage "${eff.damage}" is not valid dice notation`);
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
      }
    }
    for (const a of m.actions || []) {
      if (!["attack", "emote", "wander", "idle", "flee"].includes(a.type))
        errs.push(`mob ${id}: invalid action type "${a.type}"`);
      if (a.type === "emote" && (!Array.isArray(a.messages) || !a.messages.length))
        errs.push(`mob ${id}: emote action needs a non-empty messages array`);
      if ((a.type === "wander" || a.type === "flee") && a.scope != null && !["zone", "any"].includes(a.scope))
        errs.push(`mob ${id}: ${a.type} scope must be "zone" or "any"`);
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
    if (f.mine) {
      if (!has(items, f.mine.template)) errs.push(`fixture ${id}: mine.template missing item ${f.mine.template}`);
      for (const k of ["charges", "respawn"])
        if (typeof f.mine[k] !== "number" || f.mine[k] <= 0) errs.push(`fixture ${id}: mine.${k} must be a positive number`);
      if (f.mine.yield != null && (typeof f.mine.yield !== "number" || f.mine.yield <= 0))
        errs.push(`fixture ${id}: mine.yield must be a positive number`);
      if (f.mine.energy != null && (typeof f.mine.energy !== "number" || f.mine.energy < 0))
        errs.push(`fixture ${id}: mine.energy must be a non-negative number`);
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
  // instantaneous (dice + optional attribute scaling); `emit-light` and
  // `heal-over-time` are statuses (the latter pulses healing on an interval).
  const SPELL_EFFECT_TYPES = ["damage", "emit-light", "heal-over-time"];
  for (const [id, sp] of Object.entries(spells)) {
    if (sp.id !== id) errs.push(`spell ${id}: id field mismatch (${sp.id})`);
    if (sp.manaCost != null && (typeof sp.manaCost !== "number" || sp.manaCost < 0))
      errs.push(`spell ${id}: manaCost must be a non-negative number`);
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
      `${Object.keys(recipes).length} recipes, ${Object.keys(spells).length} spells. ` +
      `All references resolve; all rooms reachable from ${player.startLocation}.`
  );
}

main();
