"use strict";
// Faction model — who fights whom. The relation table plus the two readers the
// engine resolves sides with. Split out of state.js so the social/combat
// alignment rules can be read without the rest of the engine. The faction
// *vocabulary* (FACTIONS) lives in config.js so the validator shares it.
const { FACTIONS, DEFAULT_FACTION } = require("./config");

/** The faction a combatant fights for. Players are always "player"; a mob carries
 *  its instance `faction` (default "wild"). Sides are resolved by `factionRelation`. */
function combatantFaction(actor, kind) {
  return kind === "player" ? "player" : (actor.faction || DEFAULT_FACTION);
}

// The factions and how they regard one another. A relation is "ally" (assist each
// other, never targeted), "enemy" (eligible to fight), or "neutral" (ignore —
// neither defend nor hunt). The table is symmetric and lists only the off-diagonal
// pairs; a faction is always its own ally, and any pairing not named here falls
// back to "enemy" so an unrecognised faction still behaves safely (the old
// "different = enemy" binary).
//   player — PCs and their summons         rim    — village NPCs and their guards
//   fauna  — peaceful wildlife/livestock    wild   — the deep's predators (default)
//   umbral — the deep-dwelling Umbrals (Mallki & kin; hostile members gated by
//            `hostile`, peaceful ones like the trader simply never act on it)
//   outlaw — living, hostile humans (claim-jumpers/deserters preying on delvers).
//            A sane, coordinated enemy class, `enemy` to both `player` and the
//            `rim` watch that would clear them; `neutral` to the deep's own things
//            (fauna/wild/umbral) — the camp squats among the vermin, not against it.
// `enemy` only marks who *may* fight; whether a creature *starts* one is the
// separate `hostile` flag. So fauna are `enemy` to `player` — non-hostile (they
// never initiate and aren't hunted) but they fight back when farmed (a struck Old
// Grinder still has teeth). fauna↔wild is "neutral" for now (predators don't prey
// on livestock yet); flip both halves to "enemy" to switch the predation ecosystem
// on. umbral↔player is "enemy" so hostile Umbrals can engage delvers; non-hostile
// Umbrals (the trader) stay inert and a peaceful enclave is just `hostile: false`.
const FACTION_RELATIONS = {
  player: { rim: "ally", fauna: "enemy", wild: "enemy", umbral: "enemy", outlaw: "enemy" },
  rim: { player: "ally", fauna: "ally", wild: "enemy", umbral: "neutral", outlaw: "enemy" },
  fauna: { player: "enemy", rim: "ally", wild: "neutral", umbral: "neutral", outlaw: "neutral" },
  wild: { player: "enemy", rim: "enemy", fauna: "neutral", umbral: "neutral", outlaw: "neutral" },
  umbral: { player: "enemy", rim: "neutral", fauna: "neutral", wild: "neutral", outlaw: "neutral" },
  outlaw: { player: "enemy", rim: "enemy", fauna: "neutral", wild: "neutral", umbral: "neutral" },
};
/** How faction `a` regards faction `b`: "ally" | "enemy" | "neutral". */
function factionRelation(a, b) {
  if (a === b) return "ally";
  return (FACTION_RELATIONS[a] && FACTION_RELATIONS[a][b]) || "enemy";
}
// Invariant: the relation table is symmetric — `a` regards `b` exactly as `b`
// regards `a`. Both halves are hand-maintained, so a one-sided edit (e.g.
// setting player→umbral "neutral" but leaving umbral→player "enemy") would
// produce baffling one-way aggression. Assert it at load so the typo is a loud
// crash, not a field bug. Uses the shared FACTIONS vocabulary as the key set.
for (const a of FACTIONS) {
  for (const b of FACTIONS) {
    if (factionRelation(a, b) !== factionRelation(b, a)) {
      throw new Error(
        `FACTION_RELATIONS asymmetry: ${a}->${b} is "${factionRelation(a, b)}" ` +
        `but ${b}->${a} is "${factionRelation(b, a)}"`
      );
    }
  }
}

module.exports = { FACTION_RELATIONS, factionRelation, combatantFaction };
