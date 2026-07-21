"use strict";
/**
 * Crafting: `craft`/`make` and the `recipes` listing.
 */
const { makeItemInstance, sellValueOf } = require("../state");
const quests = require("../quests");
const {
  selfAndViews, err, logMsg, announce, announceLevelUps, matchRank, closestName, whichDoYouMean,
  countItem, removeItem, addToInventory, stationLabel,
} = require("./shared");

function craft(state, player, arg, ctx) {
  const w = state.world;
  if (!arg) return err("Craft what? Try `recipes`.");
  // Rank every recipe the query could mean instead of taking the first name
  // match in definition order (which made `craft bar` refuse over an unlearned
  // Barbed Bomb while you stood at the smelter with iron ore). Knowing the
  // recipe dominates everything; then whatever you could craft right now —
  // being at its station and holding its inputs each lift the score — and a
  // whole-word match ("bar" in Iron Bar) beats a mere prefix ("bar" in
  // Barbed). Ties keep world definition order.
  const known = new Set(player.knownRecipes || []);
  const here = new Set(state.rooms[player.location].fixtures.map((f) => w.fixtures[f.template] && w.fixtures[f.template].station));
  let entry = null, best = 0, ties = [];
  for (const [id, r] of Object.entries(w.recipes)) {
    const rank = matchRank(arg, r.name || id, r.keywords, id);
    if (!rank) continue;
    const score = rank
      + (known.has(id) ? 1000 : 0)
      + (here.has(r.station) ? 100 : 0)
      + (canAfford(player, r) ? 100 : 0);
    if (score > best) { entry = [id, r]; best = score; ties = [r.name || id]; }
    else if (score === best) ties.push(r.name || id);
  }
  if (!entry) {
    // Nothing matched at all — a typo, most likely. Offer the closest recipe
    // the player KNOWS (suggesting an unlearned one would only lead to a
    // "you don't know how" dead end).
    const close = closestName(arg, [...known].map((id) => w.recipes[id]).filter(Boolean));
    return err(`You know no recipe for "${arg}".${close ? ` Did you mean ${close}?` : ""}`);
  }
  // A dead-even tie between recipes you know is genuinely ambiguous — crafting
  // spends materials, so ask rather than guess. (Ties among unknown recipes
  // don't matter: that path only picks which name the refusal cites.)
  if (best >= 1000 && ties.length > 1) return whichDoYouMean(ties);
  const [rid, r] = entry;
  const label = r.name || rid;
  if (!known.has(rid))
    return err(`You don't know how to make ${label}.`);
  // Must be at a fixture providing the recipe's station.
  const rt = state.rooms[player.location];
  const hasStation = rt.fixtures.some((f) => w.fixtures[f.template] && w.fixtures[f.template].station === r.station);
  if (!hasStation) return err(`You need ${stationLabel(w, r.station)} to make ${label}.`);
  // Check material inputs and shard cost before consuming anything.
  for (const inp of r.inputs || []) {
    const need = inp.qty || 1;
    const have = countItem(player, inp.template);
    if (have < need)
      return err(`You need ${need}× ${w.items[inp.template].name} (you have ${have}).`);
  }
  const cost = r.shards || 0;
  if ((player.shards || 0) < cost)
    return err(`You need ${cost} shards (you have ${player.shards || 0}).`);
  // Consume, then produce.
  for (const inp of r.inputs || []) removeItem(player, inp.template, inp.qty || 1);
  if (cost) player.shards -= cost;
  addToInventory(player, makeItemInstance({ template: r.output.template, qty: r.output.qty || 1 }, w), w);
  const qmsgs = quests.noteAcquire(state, player, r.output.template);
  const outName = w.items[r.output.template].name;
  announce(ctx, player, `${player.name} works at ${stationLabel(w, r.station)}.`);
  // Crafting XP = the output's sale value × quantity: it scales with the worth of
  // what you made (and thus the rarity/cost of its inputs), so spamming a cheap
  // recipe pays almost nothing. Award before building views so XP shows current.
  const xp = sellValueOf(w.items[r.output.template]) * (r.output.qty || 1);
  const ups = xp ? state.awardXp(player, xp) : [];
  const msgs = selfAndViews(state, player, `You craft ${outName}.${cost ? ` (−${cost} shards)` : ""}${xp ? ` (+${xp} xp)` : ""}`);
  announceLevelUps(player, ups, ctx, msgs);
  msgs.push(...qmsgs);
  return msgs;
}

// Order a recipe list by what it outputs: worn gear first (by slot, weapon →
// armour → trinket → light), then consumables, then raw materials, then the
// rest. Keeps the list reading top-to-bottom from "things you wield" to "things
// you stockpile" rather than in arbitrary definition order.
const CRAFT_SLOT_ORDER = ["hand", "body", "head", "cloak", "neck", "finger", "light"];
function craftSortKey(item) {
  const s = CRAFT_SLOT_ORDER.indexOf(item.slot);
  if (s >= 0) return s;
  if (item.type === "consumable") return CRAFT_SLOT_ORDER.length;
  if (item.type === "material") return CRAFT_SLOT_ORDER.length + 2;
  return CRAFT_SLOT_ORDER.length + 1;
}

// Can the player pay a recipe's inputs (components + shards) right now? Used
// only to grey the list — `craft` re-checks before consuming anything.
function canAfford(player, r) {
  for (const inp of r.inputs || [])
    if (countItem(player, inp.template) < (inp.qty || 1)) return false;
  return (player.shards || 0) >= (r.shards || 0);
}

function recipes(state, player, filter) {
  const w = state.world;
  const known = player.knownRecipes || [];
  if (!known.length) return logMsg("You know no recipes.");
  const here = new Set(state.rooms[player.location].fixtures.map((f) => w.fixtures[f.template] && w.fixtures[f.template].station));
  let recs = known.map((rid) => w.recipes[rid]).filter(Boolean);
  // Optional filter word: substring match on the recipe name, its output item's
  // name, OR any input material's name — so `recipes glimmer` finds glimmer craft
  // and `recipes chitin` answers "what uses chitin?". (Shards is a numeric recipe
  // field, not an input item, so it never broadens the match.)
  const q = (filter || "").trim().toLowerCase();
  if (q) {
    const itemName = (tpl) => (w.items[tpl] && w.items[tpl].name) || "";
    recs = recs.filter((r) =>
      (r.name || r.id).toLowerCase().includes(q) ||
      itemName(r.output.template).toLowerCase().includes(q) ||
      (r.inputs || []).some((i) => i.template.toLowerCase().includes(q) || itemName(i.template).toLowerCase().includes(q))
    );
    if (!recs.length) return logMsg(`You know no recipes matching "${filter.trim()}".`);
  }
  // Plain code-unit compare for the name tiebreak — `localeCompare` pulls in the
  // host locale's collation, which on some machines sorts the "ch" digraph after
  // "h" (Czech-style) and scrambles names like Chitin vs Glimmersteel.
  const byName = (a, b) => {
    const na = a.name || a.id, nb = b.name || b.id;
    return na < nb ? -1 : na > nb ? 1 : 0;
  };
  recs.sort((a, b) =>
    craftSortKey(w.items[a.output.template]) - craftSortKey(w.items[b.output.template]) ||
    byName(a, b));
  // One line per recipe. The name leads green when you can make it right now,
  // grey when you can't. Each component is coloured on its own: green if you
  // already hold enough, red (with the count you have) if you're short — so the
  // list reads as a shopping list of what's still missing. Shards are checked
  // the same way. In the "Elsewhere" block the station you'd need is appended,
  // since those recipes span different stations.
  const fmt = (r, withStation) => {
    const parts = (r.inputs || []).map((i) => {
      const need = i.qty || 1;
      const have = countItem(player, i.template);
      const nm = w.items[i.template].name;
      return have >= need
        ? `<#green>${need}× ${nm}<#reset>`
        : `<#red>${need}× ${nm} (have ${have})<#reset>`;
    });
    if (r.shards) {
      const have = player.shards || 0;
      parts.push(have >= r.shards
        ? `<#green>${r.shards} shards<#reset>`
        : `<#red>${r.shards} shards (have ${have})<#reset>`);
    }
    const where = withStation ? ` — at ${stationLabel(w, r.station)}` : "";
    const name = r.name || r.id;
    const nameTag = canAfford(player, r) ? `<#green>${name}<#reset>` : `<#gray>${name}<#reset>`;
    return `  ${nameTag}: ${parts.join(", ")} → ${w.items[r.output.template].name}${where}`;
  };
  const hereRecs = recs.filter((r) => here.has(r.station));
  const awayRecs = recs.filter((r) => !here.has(r.station));
  const lines = [q ? `<#gold>Recipes<#reset> (matching "${filter.trim()}")` : "<#gold>Recipes<#reset>"];
  if (hereRecs.length) lines.push("", "<#cyan>Here<#reset>", ...hereRecs.map((r) => fmt(r, false)));
  if (awayRecs.length) lines.push("", "<#cyan>Elsewhere<#reset>", ...awayRecs.map((r) => fmt(r, true)));
  return logMsg(lines.join("\n"));
}

module.exports = { craft, recipes };
