"use strict";
/**
 * The `attributes` / `attr` / `stats` sheet — a live, personalised readout of
 * what each attribute is granting THIS player right now, and what the three
 * defence pools mean in plain language.
 *
 * Everything here is derived, never stored: attributes are read *effective*
 * (base + gear `attrMod` + active buffs, exactly what combat reads), so heavy
 * iron that dulls Wits shows its cost in spellward and evasion, and a might
 * draught shows its lift. Weapon damage is weapon-aware — the "+N damage"
 * clause attaches to whichever attribute the held weapon actually scales on,
 * so a glimmer blade teaches "this scales on Intellect", not Might.
 *
 * Rendered with the same inline colour markup as `help` (see renderMarkup in the
 * client): section titles gold, names cyan, derived numbers green, footnotes and
 * gear/buff deltas grey.
 */
const {
  effectiveAttributes, playerDefence, weaponOf,
  HP_PER_VITALITY, MANA_PER_INTELLECT,
  HIT_PER_PERCEPTION, CRIT_PER_PERCEPTION,
  WARD_PER_WITS, EVASION_PER_WITS,
} = require("../combat-math");
const { logMsg } = require("./shared");

// Attribute display order: the two offensive/utility stats, then the defensive
// one last so Perception's to-hit sits beside Wits' evasion in the eye.
const ATTR_ORDER = ["might", "vitality", "intellect", "perception", "wits"];
const NAME_W = 11; // column width for the attribute/pool label

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const pct = (frac) => `${Math.round(frac * 100)}%`;

// One "  Label  VALUE (delta)   effect  — description" row.
function row(label, value, effect, desc, delta) {
  const name = `<#cyan>${cap(label).padEnd(NAME_W)}<#reset>`;
  const v = `<#green>${String(value).padStart(3)}<#reset>`;
  const d = delta ? ` <#gray>${delta}<#reset>` : "";
  const tail = desc ? `  — ${desc}` : "";
  return `  ${name}${v}${d}   ${effect}${tail}`;
}

// The gear/buff delta note for an attribute, or "" when effective == base.
function deltaNote(base, eff) {
  if (eff === base) return "";
  const diff = eff - base;
  return `(base ${base}, ${diff > 0 ? "+" : "−"}${Math.abs(diff)})`;
}

function attributesSheet(state, player) {
  const w = state.world;
  const base = player.attributes || {};
  const eff = effectiveAttributes(w, player);
  const def = playerDefence(w, player);

  // The held weapon (or fists) and the attribute its damage scales on.
  const weapon = weaponOf(w, player);
  const scaleAttr = weapon.scale && weapon.scale.attr;
  const per = (weapon.scale && weapon.scale.per) || 1;
  const hand = player.equipment && player.equipment.hand;
  const handTpl = hand && w.items[hand.template];
  const weaponName = handTpl && handTpl.name ? handTpl.name : "your fists";
  const weaponDmg = scaleAttr ? Math.floor((eff[scaleAttr] || 0) / per) : 0;

  const pts = player.unspentPoints || 0;
  const ptLine = `${pts} point${pts === 1 ? "" : "s"} to train`;
  const lines = [`<#gold>Attributes<#reset> — Level ${player.level || 1}, ${ptLine}`, ""];

  for (const attr of ATTR_ORDER) {
    const val = eff[attr] || 0;
    const delta = deltaNote(base[attr] || 0, val);
    let effect;
    let desc;
    switch (attr) {
      case "might":
        if (scaleAttr === "might") {
          effect = `<#green>+${weaponDmg} damage with ${weaponName}<#reset>`;
          desc = `scales this weapon's damage (1 per ${per} Might)`;
        } else {
          effect = `<#green>scales might-based weapons<#reset>`;
          desc = `none equipped right now`;
        }
        break;
      case "vitality":
        effect = `<#green>+${val * HP_PER_VITALITY} max HP<#reset>`;
        desc = `${HP_PER_VITALITY} HP per point`;
        break;
      case "intellect":
        effect = `<#green>+${val * MANA_PER_INTELLECT} max MP<#reset>`;
        desc = `${MANA_PER_INTELLECT} MP per point; also powers spells & glimmer weapons`;
        break;
      case "perception":
        effect = `<#green>+${pct(val * HIT_PER_PERCEPTION)} to-hit · +${pct(val * CRIT_PER_PERCEPTION)} crit<#reset>`;
        desc = `+${pct(HIT_PER_PERCEPTION)} hit, +${pct(CRIT_PER_PERCEPTION)} crit per point; sharpens sight in the dark`;
        break;
      case "wits":
        effect = `<#green>${val * WARD_PER_WITS} spellward · +${pct(val * EVASION_PER_WITS)} evasion<#reset>`;
        desc = `${WARD_PER_WITS} spellward & +${pct(EVASION_PER_WITS)} dodge per point`;
        break;
    }
    // A weapon that scales on something other than Might (e.g. a glimmer blade on
    // Intellect) hangs its live damage clause on that attribute's row instead.
    if (attr !== "might" && attr === scaleAttr) {
      effect += ` <#green>· +${weaponDmg} damage with ${weaponName}<#reset>`;
    }
    lines.push(row(attr, val, effect, desc, delta));
  }

  // Defences: the pool value is the point of each row, so the plain-language
  // meaning rides in the `effect` column with no leading em-dash.
  lines.push("", "<#gold>Defences<#reset>", "");
  lines.push(row("armour", def.armour, "flat cut to physical damage you take"));
  lines.push(row("spellward", def.ward, `${def.ward}% to fizzle a hostile spell · −${def.ward}% to magical weapon blows`));
  lines.push(row("voidward", def.voidWard, "like spellward, but vs void damage only"));
  lines.push(row("evasion", pct(def.evasion), "chance to avoid an incoming blow"));

  lines.push("", "<#gray>To-hit and crit also depend on light and your weapon.<#reset>");
  if (pts > 0) lines.push(`<#gray>You have ${pts} point${pts === 1 ? "" : "s"} — train <attribute> to raise one.<#reset>`);

  return logMsg(lines.join("\n"));
}

module.exports = { attributesSheet };
