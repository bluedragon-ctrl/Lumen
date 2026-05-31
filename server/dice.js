"use strict";
/** Dice notation roller: "XdY", "XdY+Z", "XdY-Z", or a plain integer string. */
const DICE_RE = /^(\d+)d(\d+)([+-]\d+)?$|^(\d+)$/;

function rollDice(notation) {
  const m = DICE_RE.exec(String(notation).trim());
  if (!m) return 0;
  if (m[4] != null) return parseInt(m[4], 10); // plain integer
  const count = parseInt(m[1], 10);
  const sides = parseInt(m[2], 10);
  const flat = m[3] ? parseInt(m[3], 10) : 0;
  let total = flat;
  for (let i = 0; i < count; i++) total += 1 + Math.floor(Math.random() * sides);
  return total;
}

module.exports = { rollDice };
