"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { GameState } = require("../server/state");
const { craft } = require("../server/commands/craft");
const { buy, sell } = require("../server/commands/trade");
const { cast } = require("../server/commands/magic");
const { execute } = require("../server/commands");
const { NOOP_CTX, countItem, findMobInRoom, hostileToward, peaceable } = require("../server/commands/shared");
const { buildExamineView } = require("../server/render");

// A minimal lit world for craft target-resolution tests. The regression under
// test: `craft bar` used to resolve against ALL world recipes in definition
// order, so it hit "Barbed Bomb" (defined first, "bar" is a prefix of
// "barbed") and refused with "You don't know how to make Barbed Bomb" — even
// when the player knew Rion Bar, held the ore and stood at the furnace.
function makeCraftWorld({ fixtures, oreQty, sells }) {
  const band = { blindBelow: 1, dimBelow: 3, harmedAbove: 9 };
  return {
    rooms: {
      forge: {
        id: "forge", name: "Forge", description: "", depth: 0, ambientLight: 5, exits: {}, fixtures,
        // The rat-catcher spawns BEFORE the cave rat, so plain room-order
        // matching on "rat" would pick the friendly one.
        spawns: [{ mob: "trader", max: 1 }, { mob: "rat_catcher", max: 1 }, { mob: "cave_rat", max: 1 }],
      },
    },
    items: {
      rion_ore: { id: "rion_ore", name: "a lump of rion ore", description: "", type: "material", stackable: true },
      rion_bar: { id: "rion_bar", name: "a rion bar", description: "", type: "material", stackable: true, value: 10 },
      silver_bar: { id: "silver_bar", name: "a silver bar", description: "", type: "material", stackable: true, value: 10 },
      barbed_bomb: { id: "barbed_bomb", name: "a barbed bomb", description: "", type: "consumable", stackable: true, value: 8 },
      // A vendor recipe sheet whose keywords collide with the bomb it teaches —
      // the real "a barbed-bomb method" carries barbed/bomb keywords too.
      // "plans" is an authored keyword absent from the display name.
      bomb_method: { id: "bomb_method", name: "a barbed-bomb method", description: "", type: "recipe", keywords: ["method", "barbed", "bomb", "plans"], value: 12, stackable: true, recipe: "barbed_bomb" },
      bar_method: { id: "bar_method", name: "a bar-smelting method", description: "", type: "recipe", keywords: ["method", "bar", "smelting"], value: 12, stackable: true, recipe: "rion_bar" },
    },
    mobs: {
      trader: { id: "trader", name: "a tinker", description: "", keywords: ["tinker"], maxHp: 10, xp: 1, faction: "rim", perception: band, shop: { sells } },
      rat_catcher: { id: "rat_catcher", name: "a rat-catcher", description: "", keywords: ["rat", "catcher"], maxHp: 10, xp: 1, faction: "rim", perception: band },
      cave_rat: { id: "cave_rat", name: "a cave rat", description: "", keywords: ["rat", "cave"], hostile: true, maxHp: 10, xp: 1, faction: "wild", perception: band },
    },
    spells: {
      spark: { id: "spark", name: "Spark", description: "", hostile: true, manaCost: 1, effect: { type: "damage", amount: 1 } },
    },
    fixtures: {
      furnace: { id: "furnace", name: "a squat furnace", description: "", type: "scenery", station: "furnace" },
      bench: { id: "bench", name: "a tinker-bench", description: "", type: "scenery", station: "tinker" },
    },
    recipes: {
      // Barbed Bomb comes FIRST so plain definition-order matching would pick it.
      barbed_bomb: { id: "barbed_bomb", name: "Barbed Bomb", station: "tinker", inputs: [{ template: "rion_ore", qty: 1 }], output: { template: "barbed_bomb" } },
      rion_bar: { id: "rion_bar", name: "Rion Bar", station: "furnace", inputs: [{ template: "rion_ore", qty: 2 }], output: { template: "rion_bar" } },
      silver_bar: { id: "silver_bar", name: "Silver Bar", station: "furnace", inputs: [{ template: "rion_ore", qty: 2 }], output: { template: "silver_bar" } },
    },
    quests: {},
    playerTemplate: {
      level: 1, xp: 0, shards: 0,
      attributes: { might: 5, vitality: 5, intellect: 5, wits: 0, perception: 5 },
      manaRegen: 0, speed: 12,
      perception: band,
      startLocation: "forge",
      startInventory: [{ template: "rion_ore", qty: oreQty }],
      startEquipment: { light: null, body: null },
      knownRecipes: ["rion_bar"], knownSpells: [],
    },
  };
}

function setup({
  knownRecipes, knownSpells, shards,
  fixtures = ["furnace", "bench"], oreQty = 2,
  sells = [{ template: "bomb_method", price: 12 }],
} = {}) {
  const state = new GameState(makeCraftWorld({ fixtures, oreQty, sells }));
  const p = state.createCharacter("Smith");
  state.admit(p);
  state.setPlayerLocation(p, "forge");
  if (knownRecipes) p.knownRecipes = knownRecipes;
  if (knownSpells) p.knownSpells = knownSpells;
  if (shards) p.shards = shards;
  return { state, p };
}

test("craft prefers a known recipe over an unknown definition-order match", () => {
  const { state, p } = setup();
  const out = craft(state, p, "bar", NOOP_CTX);
  assert.ok(out.some((m) => m.type !== "error" && /You craft a rion bar/.test(m.text || "")),
    `crafts Rion Bar, got: ${JSON.stringify(out[0])}`);
  assert.equal(countItem(p, "rion_bar"), 1);
  assert.equal(countItem(p, "rion_ore"), 0, "ore consumed");
});

test("craft prefers a whole-word match over a prefix match when both are known and craftable", () => {
  const { state, p } = setup({ knownRecipes: ["barbed_bomb", "rion_bar"] });
  const out = craft(state, p, "bar", NOOP_CTX);
  assert.ok(out.some((m) => m.type !== "error" && /You craft a rion bar/.test(m.text || "")),
    `"bar" is a whole word of Rion Bar but only a prefix of Barbed Bomb, got: ${JSON.stringify(out[0])}`);
});

test("craft prefers the known recipe whose station is here", () => {
  // Only the tinker-bench is present; both recipes are known and affordable, so
  // the here-and-now Barbed Bomb outranks Rion Bar's better name match.
  const { state, p } = setup({ knownRecipes: ["barbed_bomb", "rion_bar"], fixtures: ["bench"] });
  const out = craft(state, p, "bar", NOOP_CTX);
  assert.ok(out.some((m) => m.type !== "error" && /You craft a barbed bomb/.test(m.text || "")),
    `the bomb is craftable at this station, the bar is not, got: ${JSON.stringify(out[0])}`);
});

test("craft prefers the known recipe whose inputs are in pocket", () => {
  // Both stations present, but one ore only affords the bomb (the bar needs 2).
  const { state, p } = setup({ knownRecipes: ["barbed_bomb", "rion_bar"], oreQty: 1 });
  const out = craft(state, p, "bar", NOOP_CTX);
  assert.ok(out.some((m) => m.type !== "error" && /You craft a barbed bomb/.test(m.text || "")),
    `only the bomb's inputs are affordable, got: ${JSON.stringify(out[0])}`);
});

test("craft still names the unknown recipe when nothing known matches", () => {
  const { state, p } = setup();
  const out = craft(state, p, "bomb", NOOP_CTX);
  assert.equal(out[0].type, "error");
  assert.match(out[0].text, /You don't know how to make Barbed Bomb/);
});

test("craft reports no recipe for a query matching nothing", () => {
  const { state, p } = setup();
  const out = craft(state, p, "widget", NOOP_CTX);
  assert.equal(out[0].type, "error");
  assert.match(out[0].text, /You know no recipe for "widget"/);
});

test("craft asks on a dead-even tie between known recipes", () => {
  // Rion Bar and Silver Bar both answer "bar" as a whole word, both stations
  // and inputs are at hand — genuinely ambiguous, so ask rather than guess.
  const { state, p } = setup({ knownRecipes: ["rion_bar", "silver_bar"] });
  const out = craft(state, p, "bar", NOOP_CTX);
  assert.equal(out[0].type, "error");
  assert.match(out[0].text, /Which do you mean: Rion Bar or Silver Bar\?/);
  assert.equal(countItem(p, "rion_ore"), 2, "nothing was consumed");
});

test("craft suggests the nearest known recipe on a typo", () => {
  const { state, p } = setup();
  const out = craft(state, p, "rion barr", NOOP_CTX);
  assert.equal(out[0].type, "error");
  assert.match(out[0].text, /You know no recipe for "rion barr"\. Did you mean Rion Bar\?/);
});

// --- buy: ranked counter, tie ask, typo hint -----------------------------------

test("buy resolves a ware by an authored keyword absent from its name", () => {
  const { state, p } = setup({ shards: 20 });
  const out = buy(state, p, "plans", NOOP_CTX);
  assert.ok(out.some((m) => m.type !== "error" && /You buy a barbed-bomb method/.test(m.text || "")),
    `keyword "plans" resolves the sheet, got: ${JSON.stringify(out[0])}`);
});

test("buy prefers the ware you can pay for", () => {
  const sells = [{ template: "rion_bar", price: 50 }, { template: "barbed_bomb", price: 5 }];
  const { state, p } = setup({ sells, shards: 10 });
  const out = buy(state, p, "bar", NOOP_CTX);
  assert.ok(out.some((m) => m.type !== "error" && /You buy a barbed bomb/.test(m.text || "")),
    `only the bomb is affordable, got: ${JSON.stringify(out[0])}`);
});

test("buy prefers the exact word once both wares are affordable", () => {
  const sells = [{ template: "rion_bar", price: 50 }, { template: "barbed_bomb", price: 5 }];
  const { state, p } = setup({ sells, shards: 100 });
  const out = buy(state, p, "bar", NOOP_CTX);
  assert.ok(out.some((m) => m.type !== "error" && /You buy a rion bar/.test(m.text || "")),
    `"bar" is a whole word of the rion bar only, got: ${JSON.stringify(out[0])}`);
});

test("buy deprioritises a teachable you already know", () => {
  const sells = [{ template: "bomb_method", price: 12 }, { template: "barbed_bomb", price: 5 }];
  const { state, p } = setup({ sells, shards: 100, knownRecipes: ["rion_bar", "barbed_bomb"] });
  const out = buy(state, p, "barbed", NOOP_CTX);
  assert.ok(out.some((m) => m.type !== "error" && /You buy a barbed bomb/.test(m.text || "")),
    `the sheet teaches nothing new, so the bomb wins, got: ${JSON.stringify(out[0])}`);
});

test("buy asks on a dead-even tie between wares", () => {
  const sells = [{ template: "bomb_method", price: 12 }, { template: "barbed_bomb", price: 5 }];
  const { state, p } = setup({ sells, shards: 100 });
  const out = buy(state, p, "barbed", NOOP_CTX);
  assert.equal(out[0].type, "error");
  assert.match(out[0].text, /Which do you mean: a barbed-bomb method or a barbed bomb\?/);
  assert.equal(p.shards, 100, "no shards were spent");
});

test("buy suggests the nearest ware on a typo", () => {
  const { state, p } = setup({ shards: 20 });
  const out = buy(state, p, "metod", NOOP_CTX);
  assert.equal(out[0].type, "error");
  assert.match(out[0].text, /doesn't sell "metod"\. Did you mean a barbed-bomb method\?/);
});

// --- sell: tie ask before parting with the wrong item --------------------------

test("sell asks on a dead-even tie between carried items", () => {
  const { state, p } = setup();
  p.inventory.push({ id: "b1", template: "rion_bar", qty: 1 }, { id: "b2", template: "silver_bar", qty: 1 });
  const out = sell(state, p, "bar", NOOP_CTX);
  assert.equal(out[0].type, "error");
  assert.match(out[0].text, /Which do you mean: a rion bar or a silver bar\?/);
  assert.equal(countItem(p, "rion_bar"), 1, "nothing was sold");
});

test("sell proceeds once the query singles one out", () => {
  const { state, p } = setup();
  p.inventory.push({ id: "b1", template: "rion_bar", qty: 1 }, { id: "b2", template: "silver_bar", qty: 1 });
  const out = sell(state, p, "silver bar", NOOP_CTX);
  assert.ok(out.some((m) => m.type !== "error" && /You sell a silver bar/.test(m.text || "")),
    `got: ${JSON.stringify(out[0])}`);
  assert.equal(countItem(p, "silver_bar"), 0);
});

// --- mob targeting: attack prefers hostiles, talk the peaceable -----------------

test("attack swings at the hostile rat, not the rat-catcher spawned before it", () => {
  const { state, p } = setup();
  const out = execute(state, p, "attack rat", NOOP_CTX);
  assert.ok(out.some((m) => /ready your attack on a cave rat/.test(m.text || "")),
    `got: ${JSON.stringify(out[0])}`);
});

test("findMobInRoom: the peaceable preference resolves 'rat' to the rat-catcher", () => {
  const { state, p } = setup();
  const mob = findMobInRoom(state, p, "rat", true, peaceable());
  assert.ok(mob);
  assert.equal(mob.template, "rat_catcher");
});

test("findMobInRoom: the hostile preference resolves 'rat' to the cave rat", () => {
  const { state, p } = setup();
  const mob = findMobInRoom(state, p, "rat", true, hostileToward(p));
  assert.ok(mob);
  assert.equal(mob.template, "cave_rat");
});

// --- learn: prefer the sheet with something new to teach ------------------------

test("learn studies the schematic that still teaches something new", () => {
  const { state, p } = setup(); // knows rion_bar — the bar-smelting method is redundant
  p.inventory.push({ id: "m1", template: "bar_method", qty: 1 }, { id: "m2", template: "bomb_method", qty: 1 });
  const out = execute(state, p, "learn method", NOOP_CTX);
  assert.ok(out.some((m) => m.type !== "error" && /learn to craft Barbed Bomb/.test(m.text || "")),
    `got: ${JSON.stringify(out[0])}`);
  assert.ok(p.knownRecipes.includes("barbed_bomb"));
  assert.equal(countItem(p, "bar_method"), 1, "the redundant sheet is untouched");
});

// --- cast: typo hint against the caster's own spellbook -------------------------

test("cast suggests the nearest known spell on a typo", () => {
  const { state, p } = setup({ knownSpells: ["spark"] });
  const out = cast(state, p, "sprak rat", NOOP_CTX);
  assert.equal(out[0].type, "error");
  assert.match(out[0].text, /You don't know any spell called "sprak rat"\. Did you mean Spark\?/);
});

// --- examine: a known craftable outranks the vendor's stock --------------------

test("examine resolves a known craftable before a vendor ware with clashing keywords", () => {
  // The tinker sells "a barbed-bomb method" (keywords barbed/bomb); the player
  // KNOWS the recipe it teaches. `examine barbed bomb` must show the bomb you
  // can make (recall), not the sheet on the counter.
  const { state, p } = setup({ knownRecipes: ["barbed_bomb"] });
  const view = buildExamineView(state, p, "barbed bomb");
  assert.ok(view, "resolves to an examine view");
  assert.equal(view.entity.name, "a barbed bomb");
  assert.ok((view.entity.hints || []).some((h) => /Craftable/.test(h)), "shows the craftable recall view");
});

test("examine still resolves the vendor ware by its own keyword", () => {
  const { state, p } = setup({ knownRecipes: ["barbed_bomb"] });
  const view = buildExamineView(state, p, "method");
  assert.ok(view, "resolves to an examine view");
  assert.equal(view.entity.name, "a barbed-bomb method");
  assert.ok((view.entity.hints || []).some((h) => /On sale/.test(h)), "shows the ware with its price");
});

test("examine falls back to the vendor ware when the recipe is unknown", () => {
  const { state, p } = setup({ knownRecipes: [] });
  const view = buildExamineView(state, p, "barbed bomb");
  assert.ok(view, "resolves to an examine view");
  assert.equal(view.entity.name, "a barbed-bomb method");
  assert.ok((view.entity.hints || []).some((h) => /On sale/.test(h)), "the counter is all that matches now");
});
