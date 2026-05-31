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
  const player = read("data/templates/player.json");

  const errs = [];

  for (const [id, r] of Object.entries(rooms)) {
    if (r.id !== id) errs.push(`room ${id}: id field mismatch (${r.id})`);
    for (const [dir, dest] of Object.entries(r.exits || {}))
      if (!has(rooms, dest)) errs.push(`room ${id}: exit ${dir} -> missing room ${dest}`);
    for (const f of r.fixtures || [])
      if (!has(fixtures, f)) errs.push(`room ${id}: missing fixture ${f}`);
    for (const s of r.spawns || [])
      if (!has(mobs, s.mob)) errs.push(`room ${id}: spawn references missing mob ${s.mob}`);
    for (const g of r.groundItems || [])
      if (!has(items, g.template)) errs.push(`room ${id}: groundItem missing template ${g.template}`);
  }

  for (const [id, it] of Object.entries(items)) {
    if (it.type === "weapon" && it.weapon) {
      for (const [kind, val] of Object.entries(it.weapon.damage || {}))
        if (typeof val !== "string" || !DICE_RE.test(val))
          errs.push(`item ${id}: weapon.damage.${kind} "${val}" is not valid dice notation`);
    }
  }

  for (const [id, m] of Object.entries(mobs)) {
    for (const l of m.loot || [])
      if (!has(items, l.template)) errs.push(`mob ${id}: loot references missing template ${l.template}`);
    if (m.attack && (typeof m.attack.damage !== "string" || !DICE_RE.test(m.attack.damage)))
      errs.push(`mob ${id}: attack.damage "${m.attack.damage}" is not valid dice notation`);
  }

  for (const [id, rc] of Object.entries(recipes)) {
    for (const i of rc.inputs || [])
      if (!has(items, i.template)) errs.push(`recipe ${id}: input missing template ${i.template}`);
    if (!rc.output || !has(items, rc.output.template))
      errs.push(`recipe ${id}: output missing template ${rc.output && rc.output.template}`);
  }

  if (!has(rooms, player.startLocation))
    errs.push(`player: startLocation references missing room ${player.startLocation}`);
  for (const i of player.startInventory || [])
    if (!has(items, i.template)) errs.push(`player: startInventory missing template ${i.template}`);
  for (const [slot, it] of Object.entries(player.startEquipment || {}))
    if (it !== null && !has(items, it)) errs.push(`player: startEquipment ${slot} missing template ${it}`);

  // Reachability from the starting room.
  const seen = new Set();
  const stack = [player.startLocation];
  while (stack.length) {
    const c = stack.pop();
    if (seen.has(c) || !rooms[c]) continue;
    seen.add(c);
    for (const dest of Object.values(rooms[c].exits || {})) stack.push(dest);
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
      `${Object.keys(recipes).length} recipes. All references resolve; ` +
      `all rooms reachable from ${player.startLocation}.`
  );
}

main();
