"use strict";
// Pure combat & character math — no runtime state, no `this`. Attribute reads,
// defence profiles, attribute-scaling, the swing resolver, and the small random
// helpers shared by the tick loop, render, and command resolvers. Split out of
// state.js so combat tuning can be read/edited without loading the whole engine.
const { canSee, hitChance } = require("./light");
const { rollDice } = require("./dice");
const { XP_BASE, XP_GROWTH, DEFAULT_ACTION_COST, UNARMED_ACTION_COST } = require("./config");

/** Cumulative lifetime XP required to *reach* `level` (level 1 = 0). The
 *  increment for each step is XP_BASE * XP_GROWTH^(step-1), so successive levels
 *  cost XP_GROWTH× the last. See config.XP_BASE/XP_GROWTH. */
function xpForLevel(level) {
  let total = 0;
  let step = XP_BASE;
  for (let l = 1; l < level; l++) { total += step; step *= XP_GROWTH; }
  return total;
}

// Default melee scaling when a weapon omits its own `scale`: floor(Might / 4)
// added to physical damage. Mirrors a spell's `effect.scale`.
const MELEE_SCALE = { attr: "might", per: 4 };

/** The attacker's effective weapon: equipped hand weapon, or unarmed. `scale`
 *  is the attribute the weapon's damage grows with (default Might/4). */
function weaponOf(world, player) {
  const hand = player.equipment && player.equipment.hand;
  if (hand) {
    const t = world.items[hand.template];
    if (t && t.weapon) {
      // A weapon's swing is physical by default; declaring `damage.magical` instead
      // makes it a magical blow, cut by the defender's Ward percentage rather than
      // soaked flat by Armour (see strike). Glimmer-craft weapons scale on Intellect.
      const dmg = t.weapon.damage || {};
      const magical = dmg.magical != null;
      return {
        dice: (magical ? dmg.magical : dmg.physical) || "1d2",
        damageType: magical ? "magical" : "physical",
        actionCost: t.weapon.actionCost || DEFAULT_ACTION_COST,
        scale: t.weapon.scale || MELEE_SCALE,
        crit: t.weapon.crit || 0, // flat crit chance the weapon grants, on top of Perception
        onHit: t.weapon.onHit || null, // on-hit effects applied to the struck defender
      };
    }
  }
  return { dice: "1d2", actionCost: UNARMED_ACTION_COST, scale: MELEE_SCALE, crit: 0, onHit: null, damageType: "physical" }; // unarmed
}

// --- Defender-side triggers (onDamage) -------------------------------------
// `onDamage` is the general "when I'm struck" list, the defender-side mirror of
// the attacker's `onHit`. Each entry is an effect spec plus two extra axes the
// attacker side never needs: `target` ("attacker" — reflect/retaliate — or
// "self" — e.g. draw mana off a blow; default "attacker") and `on` (which damage
// sources fire it; default ["melee"], with "spell" reserved for a later castSpell
// wiring). `spikes: { damage, chance? }` is kept as terse authoring sugar for the
// commonest entry — a flat melee reflect — normalized here into an onDamage entry.
const spikesEntry = (s) => ({ type: "damage", damage: s.damage, chance: s.chance, target: "attacker", cause: "spikes", on: ["melee"] });

/** A mob's resolved onDamage triggers: explicit `onDamage` entries plus its
 *  `spikes` sugar (a reflect entry). */
function mobOnDamage(t) {
  const list = Array.isArray(t.onDamage) ? [...t.onDamage] : [];
  if (t.spikes) list.push(spikesEntry(t.spikes));
  return list;
}

/** A player's resolved onDamage triggers, gathered across equipped armour
 *  (`armour.onDamage` entries plus `armour.spikes` sugar). Lets gear punish or
 *  profit from being hit exactly as a mob does — none seeded yet. */
function playerOnDamage(world, player) {
  const list = [];
  for (const inst of Object.values(player.equipment || {})) {
    if (!inst) continue;
    const t = world.items[inst.template];
    if (!t || !t.armour) continue;
    if (Array.isArray(t.armour.onDamage)) list.push(...t.armour.onDamage);
    if (t.armour.spikes) list.push(spikesEntry(t.armour.spikes));
  }
  return list;
}

// Each point of Wits grants this much innate Ward (magic resist) and this much
// evasion (a flat reduction to an attacker's hit chance). Pure defensive stat.
const WARD_PER_WITS = 2;
const EVASION_PER_WITS = 0.02;
// Each point of Perception grants this much to-hit and this much crit chance.
const HIT_PER_PERCEPTION = 0.02;
const CRIT_PER_PERCEPTION = 0.01;
// Attribute-derived pools and the sight curve (see GameState.deriveStats).
// Max HP is a flat base + a per-level grant every build receives + a Vitality
// bonus, so no build is locked out of HP growth and a fresh L1/Vit-3 character
// still starts at HP_BASE + 3*HP_PER_VITALITY = 15.
const HP_BASE = 6;
const HP_PER_LEVEL = 2;
const HP_PER_VITALITY = 3;
const MANA_PER_INTELLECT = 4;
const ATTR_BASELINE = 3; // starting value of every attribute
const SIGHT_PER_PERCEPTION = 5; // every +5 Perception over baseline lowers dimBelow by 1

/** A player's effective attributes: base attributes plus any flat modifiers
 *  from equipped gear (`armour.attrMod`, e.g. heavy iron that dulls Wits).
 *  Each result is floored at 0. The single source for attribute reads at combat
 *  time, so a penalty (or bonus) on gear flows through to-hit, melee damage,
 *  Ward and evasion alike. */
function effectiveAttributes(world, player) {
  const attrs = { ...(player.attributes || {}) };
  for (const inst of Object.values(player.equipment || {})) {
    if (!inst) continue;
    const t = world.items[inst.template];
    const mod = t && t.armour && t.armour.attrMod;
    if (!mod) continue;
    for (const [k, v] of Object.entries(mod)) attrs[k] = Math.max(0, (attrs[k] || 0) + v);
  }
  return attrs;
}

/** Defensive profile of a player: Armour (vs physical) and Ward (vs magical)
 *  from equipped gear plus innate Ward from Wits, and Wits-derived evasion.
 *  Mirrors the {armour, ward} block on armour items. Wits is read effective —
 *  heavy gear that dulls Wits costs both Ward and evasion. */
function playerDefence(world, player) {
  let armour = 0;
  let ward = 0;
  for (const inst of Object.values(player.equipment || {})) {
    if (!inst) continue;
    const t = world.items[inst.template];
    if (t.armour) {
      armour += t.armour.armour || 0;
      ward += t.armour.ward || 0;
    }
  }
  const wits = effectiveAttributes(world, player).wits || 0;
  ward += wits * WARD_PER_WITS;
  // Temporary defensive buffs (Glimmerskin): each active "protect" state adds its
  // baked-in armour/ward for as long as it lasts.
  for (const s of player.states || []) {
    if (s.type === "protect") { armour += s.armour || 0; ward += s.ward || 0; }
  }
  return { armour, ward, evasion: wits * EVASION_PER_WITS };
}

// Total action-speed penalty from equipped gear: heavy armour (`armour.speedPenalty`)
// slows the rate a player banks action-energy, and thus how often they act.
function equipSpeedPenalty(world, player) {
  let pen = 0;
  for (const inst of Object.values(player.equipment || {})) {
    if (!inst) continue;
    const t = world.items[inst.template];
    if (t && t.armour && t.armour.speedPenalty) pen += t.armour.speedPenalty;
  }
  return pen;
}

// A player's effective action speed after gear penalties — never below 1, so even
// the heaviest load still lets them act. Drives energy gain and the bank cap.
function effectiveSpeed(world, player) {
  return Math.max(1, (player.speed || 0) - equipSpeedPenalty(world, player));
}

// A mob's live defence: its template armour/ward/evasion plus any active
// "protect" buff states (e.g. a self-cast Glimmerskin). Mirrors how
// playerDefence folds protect states in for players, so a buffed mob is tougher
// against both melee and the wholesale-negate ward roll.
function mobDefence(template, mob) {
  let armour = template.armour || 0;
  let ward = template.ward || 0;
  for (const s of (mob && mob.states) || []) {
    if (s.type === "protect") { armour += s.armour || 0; ward += s.ward || 0; }
  }
  return { armour, ward, evasion: template.evasion || 0 };
}

// A flat damage bonus from a scaling attribute, e.g. {attr:"intellect", per:4}
// adds floor(intellect / 4). Used by both spells (effect.scale) and melee
// weapons (weapon.scale). No `scale` block → no attribute bonus.
function spellScaleBonus(attrs, scale) {
  if (!scale || !scale.attr) return 0;
  const v = (attrs && attrs[scale.attr] != null) ? attrs[scale.attr] : 0;
  return Math.floor(v / (scale.per || 1));
}

// A duration/lifetime bonus from a scaling attribute, in TICKS. Unlike the damage
// bonus above (where `per` is a divisor), here `per` is a multiplier — ticks of
// duration added per point of the attribute: {attr:"intellect", per:15} adds 15
// ticks per point of Intellect (so Witchfire's per:1 still yields `length = int`).
function durationScaleBonus(attrs, scale) {
  if (!scale || !scale.attr) return 0;
  const v = (attrs && attrs[scale.attr] != null) ? attrs[scale.attr] : 0;
  return Math.floor(v * (scale.per != null ? scale.per : 1));
}

// Resolve a `{ base?, scale? }` amount spec (e.g. a Glimmerskin armour/ward
// component) against effective attributes: flat base plus an attribute-scaled
// bonus. A bare number or null is accepted too. Used for baked-at-cast buffs.
function scaledAmount(attrs, spec) {
  if (spec == null) return 0;
  if (typeof spec === "number") return spec;
  return (spec.base || 0) + spellScaleBonus(attrs, spec.scale);
}

// Ward resists hostile *spell casts* as an all-or-nothing negation: each point
// of the target's Ward is this much chance to fizzle the spell entirely (works
// for damage and effect spells alike). 0.01 = 1% per point, and it is NOT capped
// — ward 100+ shrugs off magic outright (a deliberate design choice). Magical
// *weapon* hits are handled separately, as a percent damage cut in strike().
const WARD_RESIST_PER_POINT = 0.01;

/** True if a defender's Ward negates an incoming hostile spell this cast.
 *  Shared by both directions: player→mob (castSpell) and mob→player (_mobCast). */
function wardNegates(ward) {
  return (ward || 0) > 0 && Math.random() < ward * WARD_RESIST_PER_POINT;
}

/** How much of a *landed* blow survives the defender's mitigation, keyed by
 *  damage type. `physical` is soaked flat by Armour; every other type (magical,
 *  and any future label until it earns its own rule) is cut by Ward as a PERCENT
 *  (ward 50 → halved). This is the reduction step ONLY — whether the blow lands
 *  at all is the caller's business (melee's accuracy roll; a spell cast's Ward
 *  fizzle, see wardNegates). Floor of 1 so any blow that lands still stings.
 *  The single seam shared by strike() (weapons) and the spell-damage paths, and
 *  the one place a new damage type's mitigation rule is added. */
function mitigate(base, damageType, defence) {
  return damageType === "physical"
    ? Math.max(1, base - (defence.armour || 0))
    : Math.max(1, Math.round(base * (1 - (defence.ward || 0) / 100)));
}

/** Weighted random choice from `[{weight}, ...]`; null if the list is empty. */
function pickWeighted(options) {
  const total = options.reduce((s, o) => s + (o.weight || 1), 0);
  if (total <= 0) return null;
  let r = Math.random() * total;
  for (const o of options) {
    r -= o.weight || 1;
    if (r < 0) return o;
  }
  return options[options.length - 1];
}

/** Whether a room effect's optional light condition is met at `light`. The only
 *  v1 condition axis: `when.lightBelow` (fires when room light < N; lightBelow:1
 *  means total darkness) or `when.lightAbove` (fires when light > N, mirroring
 *  lightBane.above). No `when` → always fires. */
function roomEffectFires(effect, light) {
  const w = effect.when;
  if (!w) return true;
  if (w.lightBelow != null) return light < w.lightBelow;
  if (w.lightAbove != null) return light > w.lightAbove;
  return true;
}

// A hit can never be rarer than this, even against heavy evasion — there is
// always a sliver of a chance to land a blow (matches the can't-see floor).
const MIN_HIT = 0.05;

/** Resolve one swing.
 *  @param attacker { band, hitBonus, dmgBonus, crit } — light-perception band,
 *         flat to-hit bonus (Perception), flat damage bonus (weapon scale), crit chance.
 *  @param defender { armour, ward, evasion } — mitigation + dodge.
 *  Accuracy is the light tier (clear 100% / glare 50% / can't-see 5%) plus the
 *  attacker's hit bonus minus the defender's evasion, clamped to [MIN_HIT, 1].
 *  Accuracy *past* 100% isn't wasted: the surplus sharpens into bonus crit at
 *  1:1 (evasion is subtracted first, so it's paid down before any spills over) —
 *  this is what keeps Perception's to-hit meaningful once a delver can't miss.
 *  `sighted` drives miss-message wording; a crit doubles the damage roll. */
function strike(attacker, defender, light, dice, damageType = "physical") {
  const raw = hitChance(attacker.band, light) + (attacker.hitBonus || 0) - (defender.evasion || 0);
  const chance = Math.max(MIN_HIT, Math.min(1, raw));
  const overflowCrit = Math.max(0, raw - 1); // accuracy beyond a sure hit becomes crit
  const sighted = canSee(attacker.band, light);
  if (Math.random() >= chance) return { hit: false, sighted, damage: 0, crit: false };
  let base = rollDice(dice) + (attacker.dmgBonus || 0);
  const crit = Math.random() < ((attacker.crit || 0) + overflowCrit);
  if (crit) base *= 2; // a critical strike doubles the offensive damage, before mitigation
  // Physical blows are soaked flat by Armour; magical-type blows are cut by Ward
  // as a PERCENT (see mitigate). A spell *cast* is instead negated wholesale by
  // Ward (see wardNegates); a magical weapon always lands once it hits, but its
  // bite is reduced here.
  const damage = mitigate(base, damageType, defender);
  return { hit: true, sighted, damage, crit };
}

module.exports = {
  xpForLevel,
  MELEE_SCALE,
  weaponOf,
  mobOnDamage,
  playerOnDamage,
  HIT_PER_PERCEPTION,
  CRIT_PER_PERCEPTION,
  HP_BASE,
  HP_PER_LEVEL,
  HP_PER_VITALITY,
  MANA_PER_INTELLECT,
  ATTR_BASELINE,
  SIGHT_PER_PERCEPTION,
  effectiveAttributes,
  playerDefence,
  effectiveSpeed,
  mobDefence,
  spellScaleBonus,
  durationScaleBonus,
  scaledAmount,
  wardNegates,
  mitigate,
  pickWeighted,
  roomEffectFires,
  strike,
};
