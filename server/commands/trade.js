"use strict";
/**
 * Trading with a shopkeeper mob: `list`/`shop`, `buy`, `sell`.
 * Pricing lives in state.js (buyValueOf/sellValueOf/SELL_RATE); this resolves the
 * trader and the ware, moves shards and goods, and narrates.
 */
const { canSee } = require("../light");
const { makeItemInstance, buyValueOf, sellValueOf, SELL_RATE } = require("../state");
const quests = require("../quests");
const { selfAndViews, parseTarget, itemMatches, findItem, addToInventory } = require("./shared");

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
  if (!sh) return [{ type: "error", text: "There is no one here to trade with." }];
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
    if (!sells.length) return [{ type: "log", text: `${sh.t.name} has nothing for sale matching "${filter.trim()}".` }];
  }
  const lines = [q ? `${sh.t.name} trades (matching "${filter.trim()}"):` : `${sh.t.name} trades:`];
  const purse = player.shards || 0;
  if (sells.length) {
    lines.push("Sells (you buy):");
    for (const o of sells) {
      const item = w.items[o.template];
      const price = buyPrice(o, item);
      // Flag teachables you'd gain nothing from, so `(known)` warns before a wasted buy.
      const known = alreadyKnown(player, item) ? " (known)" : "";
      const line = `  ${item.name} — ${price} shards`;
      lines.push(price > purse ? `<#gray>${line}${known}` : `${line}${known ? `<#gray>${known}<#reset>` : ""}`);
    }
  }
  // The generic sell-rate blurb is about selling, not the filtered view — skip it
  // when the player has narrowed the list to specific wares.
  if (!q) lines.push(`Buys most goods at ${Math.round(SELL_RATE * 100)}% of value — \`sell <item>\` for an offer.`);
  lines.push(`You have ${player.shards || 0} shards.`);
  return [{ type: "log", text: lines.join("\n") }];
}

function buy(state, player, arg, ctx) {
  if (!arg) return [{ type: "error", text: "Buy what?" }];
  const sh = shopHere(state, player);
  if (!sh) return [{ type: "error", text: "There is no one here to trade with." }];
  const w = state.world;
  const ql = arg.toLowerCase();
  const offer = (sh.t.shop.sells || []).find(
    (s) => offerUnlocked(player, s) && (s.template.toLowerCase() === ql || w.items[s.template].name.toLowerCase().includes(ql))
  );
  if (!offer) return [{ type: "error", text: `${sh.t.name} doesn't sell "${arg}".` }];
  const name = w.items[offer.template].name;
  const price = buyPrice(offer, w.items[offer.template]);
  if ((player.shards || 0) < price)
    return [{ type: "error", text: `You can't afford ${name} — ${price} shards, you have ${player.shards || 0}.` }];
  player.shards -= price;
  addToInventory(player, makeItemInstance({ template: offer.template }, w), w);
  const qmsgs = quests.noteAcquire(state, player, offer.template);
  ctx.toRoom(player.location, { type: "log", text: `${player.name} buys ${name} from ${sh.t.name}.` }, player.id);
  const out = selfAndViews(state, player, `You buy ${name} for ${price} shards. (${player.shards} left)`);
  out.push(...qmsgs);
  return out;
}

function sell(state, player, arg, ctx) {
  if (!arg) return [{ type: "error", text: "Sell what?" }];
  const sh = shopHere(state, player);
  if (!sh) return [{ type: "error", text: "There is no one here to trade with." }];
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
    if (!sold.length) return [{ type: "error", text: keyword ? `${sh.t.name} won't buy any "${keyword}" from you.` : `${sh.t.name} won't buy anything you're carrying.` }];
    player.shards = (player.shards || 0) + total;
    ctx.toRoom(player.location, { type: "log", text: `${player.name} trades with ${sh.t.name}.` }, player.id);
    return selfAndViews(state, player, `You sell ${sold.join(", ")} for ${total} shards. (${player.shards} total)`);
  }
  const idx = findItem(player.inventory, w, arg);
  if (idx < 0) return [{ type: "error", text: `You aren't carrying "${arg}".` }];
  const inst = player.inventory[idx];
  const t = w.items[inst.template];
  const price = sellValueOf(t);
  if (!t.value || price <= 0) return [{ type: "error", text: `${sh.t.name} won't give you anything for ${t.name}.` }];
  if (inst.qty != null && inst.qty > 1) inst.qty -= 1;
  else player.inventory.splice(idx, 1);
  player.shards = (player.shards || 0) + price;
  ctx.toRoom(player.location, { type: "log", text: `${player.name} sells ${t.name} to ${sh.t.name}.` }, player.id);
  return selfAndViews(state, player, `You sell ${t.name} for ${price} shards. (${player.shards} total)`);
}

module.exports = { shopList, buy, sell };
