"use strict";
/**
 * Trading with a shopkeeper mob: `list`/`shop`, `buy`, `sell`.
 * Pricing lives in state.js (buyValueOf/sellValueOf/SELL_RATE); this resolves the
 * trader and the ware, moves shards and goods, and narrates.
 */
const { canSee } = require("../light");
const { makeItemInstance, buyValueOf, sellValueOf, SELL_RATE } = require("../state");
const quests = require("../quests");
const {
  selfAndViews, err, logMsg, roomLog, consumeOne, parseTarget, itemMatches,
  rankedFindItem, addToInventory, matchRank, closestName, whichDoYouMean,
} = require("./shared");

// A trader you can currently deal with: a mob in the room carrying a `shop` block,
// visible in the present light. Returns { mob, t } or null.
function shopHere(state, player) {
  const rt = state.rooms[player.location];
  if (!canSee(player.perception, rt.light)) return null;
  for (const m of rt.mobs) {
    const t = state.world.mobs[m.template];
    if (t.shop) return { mob: m, t };
  }
  return null;
}

// Price a trader sells an item for: its intrinsic value, or a per-shop override.
function buyPrice(offer, t) {
  return offer && offer.price != null ? offer.price : buyValueOf(t);
}

// An offer the player is currently allowed to buy. `requiresQuest` keeps stock
// hidden until that quest is finished — the item only joins the trader's wares
// once it sits in player.quests.done. Ungated offers are always available.
function offerUnlocked(player, offer) {
  if (!offer.requiresQuest) return true;
  return !!(player.quests && player.quests.done && player.quests.done.includes(offer.requiresQuest));
}

// Does the player already know everything a teachable ware would teach? Marks
// schematics/scrolls/books in `list` so a shopper can see, before buying, that a
// recipe or spell is nothing new. Items that teach nothing return false. The
// same known/unknown rules the `learn` command consumes on: `teaches` (book,
// several entries), `scroll.spell` (one spell), `recipe` (one recipe).
function alreadyKnown(player, t) {
  const knownR = player.knownRecipes || [];
  const knownS = player.knownSpells || [];
  if (t.teaches) {
    const recipes = t.teaches.recipes || [];
    const spells = t.teaches.spells || [];
    if (!recipes.length && !spells.length) return false;
    return recipes.every((r) => knownR.includes(r)) && spells.every((s) => knownS.includes(s));
  }
  if (t.scroll && t.scroll.spell) return knownS.includes(t.scroll.spell);
  if (t.recipe) return knownR.includes(t.recipe);
  return false;
}

function shopList(state, player, filter) {
  const sh = shopHere(state, player);
  if (!sh) return err("There is no one here to trade with.");
  const w = state.world;
  // Quest-gated stock stays out of the list entirely until earned (offerUnlocked).
  let sells = (sh.t.shop.sells || []).filter((o) => offerUnlocked(player, o));
  // Optional filter word: substring match on item name or template id, mirroring
  // how `buy` resolves a ware — `list glimmer` narrows to glimmer goods.
  const q = (filter || "").trim().toLowerCase();
  if (q) {
    sells = sells.filter(
      (o) => o.template.toLowerCase().includes(q) || w.items[o.template].name.toLowerCase().includes(q)
    );
    if (!sells.length) return logMsg(`${sh.t.name} has nothing for sale matching "${filter.trim()}".`);
  }
  // Styled like the other sheets (`attributes` / `recipes` / `spells`): a gold
  // title, cyan section headers after a blank line, indented rows with the ware
  // name green when you can afford it (grey whole-row when you can't, matching
  // the recipes list's can/can't-make colouring), grey footnotes at the bottom.
  const lines = [q ? `<#gold>Trade<#reset> — ${sh.t.name} (matching "${filter.trim()}")` : `<#gold>Trade<#reset> — ${sh.t.name}`];
  const purse = player.shards || 0;
  if (sells.length) {
    lines.push("", "<#cyan>Sells (you buy)<#reset>");
    for (const o of sells) {
      const item = w.items[o.template];
      const price = buyPrice(o, item);
      // Flag teachables you'd gain nothing from, so `(known)` warns before a wasted buy.
      const known = alreadyKnown(player, item) ? " (known)" : "";
      lines.push(price > purse
        ? `  <#gray>${item.name} — ${price} shards${known}<#reset>`
        : `  <#green>${item.name}<#reset> — ${price} shards${known ? `<#gray>${known}<#reset>` : ""}`);
    }
  }
  // The generic sell-rate blurb is about selling, not the filtered view — skip it
  // when the player has narrowed the list to specific wares.
  lines.push("");
  if (!q) lines.push(`<#gray>Buys most goods at ${Math.round(SELL_RATE * 100)}% of value — \`sell <item>\` for an offer.<#reset>`);
  lines.push(`<#gray>You have ${player.shards || 0} shards.<#reset>`);
  return logMsg(lines.join("\n"));
}

function buy(state, player, arg, ctx) {
  if (!arg) return err("Buy what?");
  const sh = shopHere(state, player);
  if (!sh) return err("There is no one here to trade with.");
  const w = state.world;
  // Rank the counter the way `craft` ranks recipes: authored keywords count, a
  // whole-word match beats a prefix, an offer you can pay for beats one you
  // can't, and a teachable you already know is deprioritised (`list` flags it
  // "(known)" — buying it again teaches nothing). A dead-even tie between
  // different wares asks rather than guesses; a miss suggests the nearest name.
  const offers = (sh.t.shop.sells || []).filter((s) => offerUnlocked(player, s));
  let offer = null, best = 0, ties = [];
  for (const s of offers) {
    const item = w.items[s.template];
    const rank = matchRank(arg, item.name, item.keywords, s.template);
    if (!rank) continue;
    const score = rank
      + ((player.shards || 0) >= buyPrice(s, item) ? 100 : 0)
      + (alreadyKnown(player, item) ? 0 : 10);
    if (score > best) { offer = s; best = score; ties = [item.name]; }
    else if (score === best) ties.push(item.name);
  }
  if (!offer) {
    const close = closestName(arg, offers.map((s) => w.items[s.template]));
    return err(`${sh.t.name} doesn't sell "${arg}".${close ? ` Did you mean ${close}?` : ""}`);
  }
  const distinct = [...new Set(ties)];
  if (distinct.length > 1) return whichDoYouMean(distinct);
  const name = w.items[offer.template].name;
  const price = buyPrice(offer, w.items[offer.template]);
  if ((player.shards || 0) < price)
    return err(`You can't afford ${name} — ${price} shards, you have ${player.shards || 0}.`);
  player.shards -= price;
  addToInventory(player, makeItemInstance({ template: offer.template }, w), w);
  const qmsgs = quests.noteAcquire(state, player, offer.template);
  roomLog(ctx, player, `${player.name} buys ${name} from ${sh.t.name}.`);
  const out = selfAndViews(state, player, `You buy ${name} for ${price} shards. (${player.shards} left)`);
  out.push(...qmsgs);
  return out;
}

function sell(state, player, arg, ctx) {
  if (!arg) return err("Sell what?");
  const sh = shopHere(state, player);
  if (!sh) return err("There is no one here to trade with.");
  const w = state.world;
  const { all, keyword } = parseTarget(arg);
  // The trader buys any valued item at its sell value — no per-trader buy list.
  if (all) {
    // `sell all` clears out the whole of each matching valued stack at once.
    const targets = itemMatches(player.inventory, w, keyword).map((i) => player.inventory[i]);
    const sold = [];
    let total = 0;
    for (const inst of targets) {
      const t = w.items[inst.template];
      const unit = sellValueOf(t);
      if (!t.value || unit <= 0) continue; // trader won't buy it — leave it in the pack
      const qty = inst.qty != null ? inst.qty : 1;
      player.inventory.splice(player.inventory.indexOf(inst), 1);
      total += unit * qty;
      sold.push(qty > 1 ? `${t.name} ×${qty}` : t.name);
    }
    if (!sold.length) return err(keyword ? `${sh.t.name} won't buy any "${keyword}" from you.` : `${sh.t.name} won't buy anything you're carrying.`);
    player.shards = (player.shards || 0) + total;
    roomLog(ctx, player, `${player.name} trades with ${sh.t.name}.`);
    return selfAndViews(state, player, `You sell ${sold.join(", ")} for ${total} shards. (${player.shards} total)`);
  }
  // Ranked resolution with a tie ask — selling the wrong thing parts with it at
  // 20% of value, so a dead-even tie between different items refuses to guess.
  const { inst, ties } = rankedFindItem(player.inventory, w, arg);
  if (ties.length) return whichDoYouMean(ties);
  if (!inst) return err(`You aren't carrying "${arg}".`);
  const t = w.items[inst.template];
  const price = sellValueOf(t);
  if (!t.value || price <= 0) return err(`${sh.t.name} won't give you anything for ${t.name}.`);
  consumeOne(player, inst);
  player.shards = (player.shards || 0) + price;
  roomLog(ctx, player, `${player.name} sells ${t.name} to ${sh.t.name}.`);
  return selfAndViews(state, player, `You sell ${t.name} for ${price} shards. (${player.shards} total)`);
}

module.exports = { shopList, buy, sell };
