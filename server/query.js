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
  const ql = (q || "").trim().toLowerCase();
  if (!ql) return false;
  if (id && String(id).toLowerCase() === ql) return true;
  const kws = keywords && keywords.length ? keywords.map((k) => k.toLowerCase()) : nameTokens(name);
  if (ql.split(/\s+/).every((qw) => kws.some((kw) => kw === qw || kw.startsWith(qw)))) return true;
  return (name || "").toLowerCase().includes(ql);
}

module.exports = { STOP_WORDS, nameTokens, matchesQuery };
