"use strict";
/**
 * Resource gathering: `mine`, `gather`, and `fish`.
 *
 * All three pull a resource from a charged fixture and differ only in flavour and
 * which flag the fixture carries (`mine`, `harvest`, `fish`). They share one
 * worker, `workResource`, driven by a per-kind spec of flavour strings; the three
 * exported verbs are thin wrappers over it. Players don't know the flag — they
 * reach for the verb the *thing* suggests (`gather moss`, though moss is a `mine`
 * fixture; `mine` a mushroom bed). So when a resource verb has nothing of its own
 * kind to work, it hands the room off to the sibling verb that does (see
 * resourceRedirect). Veins/beds/water hold a few charges and refill on a timer
 * (see state._mineTick). Each action spends energy, so a seam can't be stripped
 * in a single tick.
 */
const { makeItemInstance, fixtureVisibleTo } = require("../state");
const { canSee } = require("../light");
const { rollDice } = require("../dice");
const quests = require("../quests");
const { selfAndViews, err, announce, countItem, removeItem, addToInventory, matchesQuery } = require("./shared");

const RESOURCE_KINDS = ["mine", "harvest", "fish"];
const resourceHandlers = {}; // { mine, harvest: gather, fish } — wired up below.

// Per-kind flavour. `flag` is the fixture flag / `ft` sub-object key; the rest
// are the strings each verb differs by. `verb`-bearing kinds (harvest) read it
// from the fixture spec, falling back to a default.
const RESOURCE_SPECS = {
  mine: {
    flag: "mine",
    dark: "It is too dark to find anything worth mining.",
    none: "There is nothing to mine here.",
    notFound: (arg) => `There is no "${arg}" to mine here.`,
    which: (names) => `Mine what? ${names}.`,
    depleted: () => "The seam is worked out for now — nothing more will come loose until it recovers.",
    spent: "You are too spent to swing again just yet.",
    roomLine: (name, item, fx) => `${name} works ${item} from ${fx}.`,
    success: (item) => `You work ${item} loose.`,
    last: " The seam runs thin and gives no more.",
  },
  harvest: {
    flag: "harvest",
    dark: "It is too dark to find anything worth gathering.",
    none: "There is nothing here to gather.",
    notFound: (arg) => `There is no "${arg}" to gather here.`,
    which: (names) => `Gather what? ${names}.`,
    depleted: (ft) => `${ft.name} has been picked clean — give it time to grow back.`,
    spent: "You are too spent to forage just now.",
    roomLine: (name, item, fx, spec) => `${name} ${spec.verb || "gather"}s ${item} from ${fx}.`,
    success: (item, spec) => `You ${spec.verb || "gather"} ${item}.`,
    last: " That is the last of them — the cluster is bare.",
  },
  fish: {
    flag: "fish",
    bait: true,
    dark: "It is too dark to find the water, let alone fish it.",
    none: "There is no water to fish here.",
    notFound: (arg) => `There is no "${arg}" to fish here.`,
    which: (names) => `Fish where? ${names}.`,
    depleted: () => "The water is fished out for now — nothing is biting until it recovers.",
    spent: "You are too spent to work the line just yet.",
    roomLine: (name, item, fx) => `${name} hauls ${item} from ${fx}.`,
    success: (item) => `You hook ${item} and swing it ashore.`,
    last: " The water goes still; nothing more is biting for now.",
  },
};

// Visible fixtures in the player's room that carry the given resource flag.
function resourceFixtures(state, player, flag) {
  const w = state.world;
  return state.rooms[player.location].fixtures.filter(
    (f) => w.fixtures[f.template] && w.fixtures[f.template][flag] && fixtureVisibleTo(player, f)
  );
}

// Does `arg` (lower-cased) name this fixture? Routes through the canonical
// matcher so authored `keywords` count — e.g. `mine vein` finds a glimmer-seam
// that carries "vein" as a keyword but not in its display name.
function fixtureMatchesArg(state, f, ql) {
  const ft = state.world.fixtures[f.template];
  return matchesQuery(ql, ft.name, ft.keywords, f.template);
}

// When a resource verb can't satisfy `arg` (or has none of its own kind here),
// pick the sibling handler that should run instead — or null to let the caller
// proceed with its own logic / error. The caller checks its own kind first, so
// this only ever delegates work the player's verb wouldn't otherwise do.
function resourceRedirect(state, player, arg, selfKind) {
  const ql = arg ? arg.toLowerCase() : null;
  const others = RESOURCE_KINDS.filter((k) => k !== selfKind)
    .map((k) => ({ kind: k, fixtures: resourceFixtures(state, player, k) }))
    .filter((o) => o.fixtures.length);
  if (!others.length) return null;
  if (ql) {
    // With an arg, redirect only when it actually names a sibling-kind fixture.
    const hit = others.find((o) => o.fixtures.some((f) => fixtureMatchesArg(state, f, ql)));
    return hit ? resourceHandlers[hit.kind] : null;
  }
  // No arg: redirect only when exactly one sibling kind is present, so e.g.
  // bare `gather` in a room that holds only an ore vein is unambiguous.
  return others.length === 1 ? resourceHandlers[others[0].kind] : null;
}

// What a single successful pull yields. A vein/bed/water can carry a weighted
// `drops` table — one entry is rolled per action, so a vein "usually ore, rarely
// a few shards" and a glimmer seam "usually shards, rarely a crystal" are the same
// mechanic. `qty` is a dice string or integer (default 1). Without a table it
// falls back to the legacy single `template`/`yield`.
function rollResourceDrop(spec) {
  const drops = spec.drops;
  if (!drops || !drops.length) return { template: spec.template, qty: spec.yield || 1 };
  const total = drops.reduce((s, d) => s + (d.weight || 1), 0);
  let r = Math.random() * total;
  let pick = drops[drops.length - 1];
  for (const d of drops) {
    r -= d.weight || 1;
    if (r < 0) { pick = d; break; }
  }
  return { template: pick.template, qty: Math.max(1, rollDice(pick.qty != null ? pick.qty : 1)) };
}

// The shared worker behind mine/gather/fish. `kind` is the fixture flag; flavour
// comes from RESOURCE_SPECS[kind]. Fishing alone consumes bait and may miss.
function workResource(state, player, arg, ctx, kind) {
  const w = state.world;
  const rt = state.rooms[player.location];
  const R = RESOURCE_SPECS[kind];
  if (!canSee(player.perception, rt.light)) return err(R.dark);
  const fixtures = resourceFixtures(state, player, R.flag);
  // Hand off to a sibling verb when the player named something that isn't our
  // kind, or there's nothing of our kind here at all, so the wrong-verb instinct lands.
  const ownMatch = arg && fixtures.some((f) => fixtureMatchesArg(state, f, arg.toLowerCase()));
  if (!ownMatch && (!fixtures.length || arg)) {
    const redirect = resourceRedirect(state, player, arg, kind);
    if (redirect) return redirect(state, player, arg, ctx);
  }
  if (!fixtures.length) return err(R.none);
  let f;
  if (arg) {
    const ql = arg.toLowerCase();
    f = fixtures.find((v) => fixtureMatchesArg(state, v, ql));
    if (!f) return err(R.notFound(arg));
  } else if (fixtures.length === 1) {
    f = fixtures[0];
  } else {
    return err(R.which(fixtures.map((v) => w.fixtures[v.template].name).join(", ")));
  }
  const ft = w.fixtures[f.template];
  const spec = ft[R.flag];
  if (f.charges <= 0) return err(R.depleted(ft));
  // Fishing needs bait in the pack before anything else is spent.
  if (R.bait) {
    const bait = spec.bait || "grub";
    if (countItem(player, bait) < 1)
      return err(`You have no bait — you need ${w.items[bait].name} to work the line.`);
  }
  const cost = spec.energy || player.speed; // ~one tick's worth of effort per action
  if (player.energy < cost) return err(R.spent);
  player.energy -= cost;
  // Fishing: bait is lost to the water, catch or no — then a chance to miss.
  if (R.bait) {
    removeItem(player, spec.bait || "grub", 1);
    const chance = spec.catchChance != null ? spec.catchChance : 1;
    if (Math.random() >= chance) {
      ctx.refreshRoom(player.location, player.id);
      return selfAndViews(state, player, "Something worries the bait off your line and is gone before you can pull. The line comes up bare.");
    }
  }
  f.charges -= 1;
  const drop = rollResourceDrop(spec);
  const it = w.items[drop.template];
  // Currency (shards) tallies to the purse, like gathering a floor pile; everything
  // else goes into the pack. The label carries the count so "3 shards" / "2 iron ore"
  // read naturally in both the actor and room lines.
  let label;
  if (it.type === "currency") {
    player.shards = (player.shards || 0) + drop.qty;
    label = `${drop.qty} shard${drop.qty === 1 ? "" : "s"}`;
  } else {
    addToInventory(player, makeItemInstance({ template: drop.template, qty: drop.qty }, w), w);
    label = drop.qty > 1 ? `${drop.qty} ${it.name}` : it.name;
  }
  const qmsgs = quests.noteAcquire(state, player, drop.template);
  announce(ctx, player, R.roomLine(player.name, label, ft.name, spec));
  const tail = f.charges <= 0 ? R.last : "";
  const out = selfAndViews(state, player, `${R.success(label, spec)}${tail}`);
  out.push(...qmsgs);
  return out;
}

const mine = (state, player, arg, ctx) => workResource(state, player, arg, ctx, "mine");
const gather = (state, player, arg, ctx) => workResource(state, player, arg, ctx, "harvest");
const fish = (state, player, arg, ctx) => workResource(state, player, arg, ctx, "fish");

// Wire the resource verbs to their fixture flags now that all three exist, so
// resourceRedirect can hand off between them.
resourceHandlers.mine = mine;
resourceHandlers.harvest = gather;
resourceHandlers.fish = fish;

module.exports = { mine, gather, fish };
