"use strict";
/**
 * Query/keyword resolution — how a player's typed word names a thing (an item,
 * a mob, a fixture, a recipe, a spell). Lives below both the command layer
 * (commands/shared.js re-exports these for the domain modules) and the view
 * layer (render.js's examine lookup), so either side can match a target the
 * same way without an import cycle.
 */

// Words too generic to single out a target — dropped when deriving keywords
// from a display name (so "a sliver of glimmerstone" yields sliver/glimmerstone).
const STOP_WORDS = new Set(["a", "an", "the", "of", "some", "and", "with", "to"]);

// Significant lowercase tokens from a display name, used as fallback keywords.
function nameTokens(name) {
  return (name || "").toLowerCase().split(/[^a-z0-9]+/).filter((t) => t && !STOP_WORDS.has(t));
}

// Does query `q` name a thing called `name` (with optional authored `keywords`
// and instance/template `id`)? Resolution order:
//   1. exact id match
//   2. every query word is (a prefix of) some keyword — authored `keywords` if
//      present, else words derived from the display name. Multi-word queries use
//      AND semantics, so "glimmer crystal" needs both keywords present.
//   3. legacy fallback: `q` is a substring of the full display name.
function matchesQuery(q, name, keywords, id) {
  return matchRank(q, name, keywords, id) > 0;
}

// How well `q` names the thing: 0 = no match, 1 = prefix/substring match,
// 2 = every query word equals a keyword outright, 3 = exact id. Callers that
// pick one candidate from many (craft) prefer higher ranks, so `bar` resolves
// to "Rion Bar" (whole word) over "Barbed Bomb" (mere prefix).
function matchRank(q, name, keywords, id) {
  const ql = (q || "").trim().toLowerCase();
  if (!ql) return 0;
  if (id && String(id).toLowerCase() === ql) return 3;
  const kws = keywords && keywords.length ? keywords.map((k) => k.toLowerCase()) : nameTokens(name);
  const words = ql.split(/\s+/);
  if (words.every((qw) => kws.includes(qw))) return 2;
  if (words.every((qw) => kws.some((kw) => kw.startsWith(qw)))) return 1;
  return (name || "").toLowerCase().includes(ql) ? 1 : 0;
}

// Levenshtein edit distance — bounded use only (a verb table, a recipe book, a
// trader's counter are all small). Drives every "did you mean?" hint.
function editDistance(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}

// The noun-side "did you mean?": the display name among `things` ({name,
// keywords}) whose name or any keyword sits within 2 edits of `q`, or null if
// nothing is close enough to be worth suggesting on a failed lookup.
function closestName(q, things) {
  const ql = (q || "").trim().toLowerCase();
  if (!ql) return null;
  let best = null, bestD = Infinity;
  for (const t of things) {
    if (!t || !t.name) continue;
    const kws = t.keywords && t.keywords.length ? t.keywords.map((k) => k.toLowerCase()) : nameTokens(t.name);
    for (const term of [t.name.toLowerCase(), ...kws]) {
      const d = editDistance(ql, term);
      if (d < bestD) { bestD = d; best = t.name; }
    }
  }
  return bestD <= 2 ? best : null;
}

module.exports = { STOP_WORDS, nameTokens, matchesQuery, matchRank, editDistance, closestName };
