"use strict";
// --- Economy ---------------------------------------------------------------
// Every (non-currency) item carries a `value` — the price to buy it from a
// trader. A trader pays SELL_RATE of that value when buying an item from a
// player; an item may override its sell price with an explicit `sellValue`.
const SELL_RATE = 0.2;
const buyValueOf = (t) => (t && t.value) || 0;
const sellValueOf = (t) => (t && t.sellValue != null ? t.sellValue : Math.round(buyValueOf(t) * SELL_RATE));

module.exports = { SELL_RATE, buyValueOf, sellValueOf };
