"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { itemSpecLines } = require("../server/render");

// The spec bullet-lines the Inspect window shows for an examined item. Pure
// helper: (template, world, viewer) → string[]. These tests pin the fields the
// engine acts on but examine used to hide: consumable effects, weapon/armour
// riders, book/schematic teachings, spell gists, burn time, slot, and the
// vs-equipped comparison.

// A minimal world: only the cross-referenced bits itemSpecLines reads.
const world = {
  items: {
    "iron-cap": { id: "iron-cap", name: "an iron cap", slot: "head", armour: { armour: 2, speedPenalty: 1, attrMod: { wits: -1 } } },
    "lamp-oil": { id: "lamp-oil", name: "a flask of lamp oil" },
  },
  mobs: { "baby-thornbug": { name: "a baby thornbug" } },
  spells: {
    spark: { name: "Spark", manaCost: 3, target: "creature", effect: { type: "damage", damageType: "magical", damage: "2d4", scale: { attr: "intellect", per: 3 } } },
    halo: { name: "Halo", manaCost: 6, target: "creature", effect: { type: "protect", name: "Halo" } },
  },
  recipes: {
    "forge-iron-sword": { name: "Iron Sword" },
    "forge-iron-helm": { name: "Iron Helm" },
  },
};

const viewer = {
  attributes: { might: 8, intellect: 6 },
  equipment: { head: { id: "i1", template: "iron-cap" } },
  knownSpells: ["halo"],
  knownRecipes: ["forge-iron-sword"],
};

test("examine lines: type and slot share one line", () => {
  const lines = itemSpecLines({ type: "armour", slot: "body", armour: { armour: 1 } }, world, viewer);
  assert.ok(lines.includes("type: armour · slot: body"));
  // No slot → the plain type line, no dangling separator.
  assert.ok(itemSpecLines({ type: "material" }, world, viewer).includes("type: material"));
});

test("examine lines: restore consumable shows the HP/mana gained", () => {
  const t = { type: "consumable", consumable: { effect: { type: "restore", hp: 8, mana: 6 } } };
  assert.ok(itemSpecLines(t, world, viewer).includes("use: restores 8 HP, 6 mana"));
});

test("examine lines: heal-over-time consumable shows magnitude, pulse, duration", () => {
  const t = { type: "consumable", consumable: { effect: { type: "heal-over-time", magnitude: 3, interval: 3, duration: 24 } } };
  assert.ok(itemSpecLines(t, world, viewer).includes("use: 3 HP every 3 ticks for 0:24"));
});

test("examine lines: a reflect (Fire Shield) consumable shows the burn-back and duration", () => {
  const t = { type: "consumable", consumable: { effect: { type: "reflect", name: "Fire Shield", duration: 90,
    onDamage: [{ type: "damage", damage: "1d4", target: "attacker", on: ["melee"] }] } } };
  assert.ok(itemSpecLines(t, world, viewer).includes("use: melee attackers take 1d4 damage back for 1:30"));
});

test("examine lines: summon consumable names what hatches", () => {
  const t = { type: "consumable", consumable: { effect: { type: "summon", mob: "baby-thornbug" } } };
  const lines = itemSpecLines(t, world, viewer);
  assert.ok(lines.some((l) => l.startsWith("use: hatches a baby thornbug")));
});

test("examine lines: weapon lifesteal rider surfaces", () => {
  const t = { type: "weapon", weapon: { damage: { physical: "1d6" }, actionCost: 8, onHit: [{ type: "restore", hp: 2, target: "self", chance: 1 }] } };
  assert.ok(itemSpecLines(t, world, viewer).includes("on hit: restore 2 HP"));
});

test("examine lines: chance-gated bleed rider carries its odds", () => {
  const t = { type: "weapon", weapon: { damage: { physical: "1d8" }, actionCost: 10, onHit: [{ type: "damage-over-time", damageType: "physical", name: "bleed", damage: "1d2", duration: 3, chance: 0.5 }] } };
  assert.ok(itemSpecLines(t, world, viewer).includes("on hit (50%): bleed — 1d2 physical per tick for 0:03"));
});

test("examine lines: slow rider shows magnitude and duration", () => {
  const t = { type: "weapon", weapon: { damage: { physical: "1d4" }, actionCost: 8, onHit: [{ type: "slow", name: "Slowed", magnitude: 5, duration: 4, chance: 0.5 }] } };
  assert.ok(itemSpecLines(t, world, viewer).includes("on hit (50%): slowed — speed −5 for 0:04"));
});

test("examine lines: evasion, spikes and when-struck riders surface on armour", () => {
  const t = { type: "armour", slot: "body", armour: { armour: 3, evasion: 0.05, spikes: { damage: "1d3", chance: 0.5 }, onDamage: [{ type: "restore", mana: 2, target: "self" }] } };
  const lines = itemSpecLines(t, world, viewer);
  assert.ok(lines.includes("evasion +5%"));
  assert.ok(lines.includes("when struck (50%): attacker takes 1d3"));
  assert.ok(lines.includes("when struck: restore 2 mana"));
});

test("examine lines: light source shows burn time from full", () => {
  const t = { type: "light", light: { output: 3, fuelMax: 600, burnPerTick: 5, fuelItem: "lamp-oil" } };
  const lines = itemSpecLines(t, world, viewer);
  assert.ok(lines.includes("burn time: ~2:00 from full"));
});

test("examine lines: scroll shows a spell gist with the viewer's scale bonus", () => {
  const t = { type: "scroll", scroll: { spell: "spark" } };
  const lines = itemSpecLines(t, world, viewer);
  assert.ok(lines.includes("study: learn Spark"));
  // intellect 6 / per 3 → +2 current bonus on the damage dice.
  assert.ok(lines.includes("spell: 3 mana — 2d4 magical +2 (intellect/3) damage to one target"));
});

test("examine lines: a scroll for a spell you know says so", () => {
  const t = { type: "scroll", scroll: { spell: "halo" } };
  assert.ok(itemSpecLines(t, world, viewer).includes("study: learn Halo (already known)"));
});

test("examine lines: a book lists what it teaches, marking the known", () => {
  const t = { type: "book", teaches: { recipes: ["forge-iron-sword", "forge-iron-helm"] } };
  assert.ok(itemSpecLines(t, world, viewer).includes("study: learn Iron Sword (known), Iron Helm"));
});

test("examine lines: a schematic names its one recipe", () => {
  const t = { type: "recipe", recipe: "forge-iron-helm" };
  assert.ok(itemSpecLines(t, world, viewer).includes("study: learn Iron Helm"));
});

test("examine lines: a wearable compares against the equipped piece", () => {
  // Candidate helm vs the worn iron cap (armour 2, speedPenalty 1, wits −1):
  // armour 3 → +1, no penalty → speed +1, no wits dent → wits +1.
  const t = { id: "fine-helm", type: "armour", slot: "head", armour: { armour: 3 } };
  assert.ok(itemSpecLines(t, world, viewer).includes("vs an iron cap: armour +1, speed +1, wits +1"));
});

test("examine lines: the worn piece itself (or a copy) draws no comparison", () => {
  const lines = itemSpecLines(world.items["iron-cap"], world, viewer);
  assert.ok(!lines.some((l) => l.startsWith("vs ")));
});

test("examine lines: a shop ware's price rides the value line", () => {
  const t = { type: "material", value: 20 };
  const lines = itemSpecLines(t, world, viewer, { salePrice: 26 });
  assert.ok(lines.includes("value: 20 shards · sells for 4 · on sale for 26"));
  // Without the option (not at a counter) the value line stays bare.
  assert.ok(itemSpecLines(t, world, viewer).includes("value: 20 shards · sells for 4"));
});

test("examine lines: an empty slot draws no comparison", () => {
  const bare = { attributes: {}, equipment: {}, knownSpells: [], knownRecipes: [] };
  const t = { id: "fine-helm", type: "armour", slot: "head", armour: { armour: 3 } };
  assert.ok(!itemSpecLines(t, world, bare).some((l) => l.startsWith("vs ")));
});
