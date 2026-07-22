"use strict";
/**
 * Builds the structured view payloads sent to clients: `player` (always full
 * truth — it's your own character) and `room` (filtered by what the viewer can
 * perceive at the current light level, per DESIGN.md §3.1 / §5.4).
 */
const { bandOf, canSee, isHarmedByLight } = require("./light");
const { matchesQuery } = require("./query");
const { actorEmitLight, playerDefence, effectiveSpeed, sellValueOf, buyValueOf, itemVisibleTo, fixtureVisibleTo, mobVisibleTo, canPerceive, isDiscovered, discoveryKey, xpForLevel, effectiveAttributes, spellScaleBonus, MELEE_SCALE } = require("./state");

// How a posture reads to OTHERS in the room (the social tag). Standing is the
// default and shows nothing.
const POSTURE_LABEL = { sitting: "sitting", sleeping: "asleep" };

// The social tag shown after a *mob's* name in the room list — extends the bare
// posture label with light- and behaviour-driven states, so a delver understands
// WHY a visible creature isn't attacking (the alternative reads as a bug). Only
// ever applied to a mob the viewer can already see; it never reveals a hidden one
// (those are filtered out upstream). Highest-priority inert reason wins:
//   asleep      — inert until struck (posture)
//   dazzled     — dark-adapted, blinded by light past `blindAbove`: can't perceive
//                 anyone, so it never engages (the centipede-in-glare confusion)
//   reeling     — harmed by light past `harmedAbove` but still able to fight (glare)
//   lying in wait — an `ambush` mob tracking the room, holding its strike (see
//                 _isEngaged): it hasn't traded blows yet, so shows no aggro
//   sitting     — alert-at-rest (posture)
// NOTE: the surfaced wording ("dazzled", "reeling", "lying in
// wait") is placeholder pending maintainer sign-off — mechanics only for now.
function mobStatusTag(t, m, light) {
  if (m.posture === "sleeping") return "asleep";
  const per = t.perception;
  if (per && per.blindAbove != null && light > per.blindAbove) return "dazzled";
  if (isHarmedByLight(per, light)) return "reeling";
  // Lying in wait: an ambusher that has not yet committed to anyone (no live
  // combat threat). Once it snaps and trades blows, `aggro` fills and the tag
  // drops — it's plainly fighting from there.
  if (t.ambush && !(m.aggro && Object.values(m.aggro).some((v) => v > 0))) return "lying in wait";
  return POSTURE_LABEL[m.posture] || undefined;
}

function itemView(inst, world) {
  if (!inst) return null;
  const t = world.items[inst.template];
  const v = { id: inst.id, template: inst.template, name: t.name, type: t.type, slot: t.slot || null, rarity: t.rarity || "common" };
  if (t.weapon && t.weapon.twoHanded) v.twoHanded = true; // client tags the hand slot "2H"
  if (t.filterGroup) v.filterGroup = t.filterGroup; // honour the authored inventory-tab override client-side
  if (inst.qty != null) v.qty = inst.qty;
  if (t.light) {
    v.lit = !!inst.lit;
    v.fuel = inst.fuel;
    v.fuelMax = t.light.fuelMax;
  }
  return v;
}

function buildPlayerView(state, p) {
  const w = state.world;
  const equipment = {};
  for (const [slot, inst] of Object.entries(p.equipment)) equipment[slot] = itemView(inst, w);
  const defence = playerDefence(w, p); // Armour (vs physical) + Ward (vs magical) from gear
  const sp = effectiveSpeed(w, p); // base speed minus heavy-gear speedPenalty
  const eff = effectiveAttributes(w, p); // base attributes plus gear attrMod — what combat actually reads
  return {
    type: "player",
    player: {
      name: p.name,
      level: p.level,
      xp: p.xp,
      xpNext: xpForLevel((p.level || 1) + 1), // lifetime XP needed for the next level
      unspentPoints: p.unspentPoints || 0, // banked attribute points to `train`
      shards: p.shards || 0,
      hp: p.hp,
      maxHp: p.maxHp,
      mana: Math.floor(p.mana || 0),
      maxMana: p.maxMana,
      energy: p.energy,
      energyMax: sp * 3, // action-point bank cap (matches state.advance, after gear penalty)
      speed: sp, // effective action speed (base minus heavy-gear speedPenalty)
      posture: p.posture || "standing", // sit/sleep for rest recovery

      armour: defence.armour,
      ward: defence.ward, // gear Ward + innate Ward from Wits (shown as "spellward")
      voidWard: defence.voidWard, // vs void only, from Umbral gear/weaves (shown as "voidward")
      evasion: defence.evasion, // Wits-derived dodge (fraction, e.g. 0.06)
      crit: (eff.perception || 0) * 0.01, // Perception crit chance (fraction), gear-modified
      attributes: eff, // effective attributes (base + gear attrMod), matching what combat uses
      perception: p.perception,
      equipment,
      inventory: p.inventory.map((i) => itemView(i, w)),
      states: (p.states || []).map((s) => ({
        name: s.remaining != null ? `${s.name} ${fmtDuration(s.remaining)}` : s.name,
        good: s.good !== false,
      })),
      recipes: (p.knownRecipes || []).map((id) => (w.recipes[id] ? w.recipes[id].name : id)),
      spells: (p.knownSpells || []).map((id) => (w.spells[id] ? w.spells[id].name : id)),
    },
  };
}

/**
 * The room as THIS player perceives it. If they cannot see (light below their
 * blindBelow threshold), the description and most contents are withheld — but
 * self-illuminating things (a lightbug) remain visible, and the client shows a
 * darkness placeholder.
 */
function buildRoomView(state, p) {
  const w = state.world;
  const room = w.rooms[p.location];
  const rt = state.rooms[p.location];
  const light = rt.light;
  const see = canPerceive(p, light); // a sleeping viewer is blind, room light notwithstanding

  // Hidden features stay out of the view until this player has searched them out.
  const mobs = [];
  for (const m of rt.mobs) {
    if (!mobVisibleTo(state, p, m)) continue;
    const t = w.mobs[m.template];
    const luminous = t.emitsLight > 0; // a dark-shedding mob (negative emit) never glows or shows in the dark
    if (see || luminous) {
      // A trader exposes the names of its wares so the client can Tab-complete `buy`.
      const sells = t.shop && t.shop.sells ? t.shop.sells.map((o) => w.items[o.template].name) : undefined;
      // A mob the viewer summoned/owns reads as friendly (blue), never as an enemy.
      const owned = m.faction === "player" && m.ownerId === p.id;
      mobs.push({ id: m.id, name: t.name, hostile: !!t.hostile, owned, luminous, posture: mobStatusTag(t, m, light), sells });
    }
  }
  const items = see
    ? rt.items.filter((i) => itemVisibleTo(state, p, i)).map((i) => ({ id: i.id, name: w.items[i.template].name, template: i.template, qty: i.qty != null ? i.qty : undefined }))
    : [];
  const fixtures = see
    ? rt.fixtures.filter((f) => fixtureVisibleTo(p, f)).map((f) => {
        const ft = w.fixtures[f.template];
        return { id: f.id, name: ft.name, template: f.template, lit: ft.switch ? !!f.on : undefined };
      })
    : [];
  // A delver glowing with a Light effect stays visible even in the dark, and
  // gets the same luminous treatment as a lightbug.
  const players = [];
  for (const o of state.playersIn(p.location)) {
    if (o.id === p.id) continue;
    const luminous = actorEmitLight(o) > 0;
    if (see || luminous) players.push({ id: o.id, name: o.name, luminous, posture: POSTURE_LABEL[o.posture] || undefined });
  }

  return {
    type: "room",
    room: {
      id: room.id,
      name: room.name,
      depth: room.depth,
      // Cosmetic biome tag (optional) — the client tints the Inspect window for it.
      biome: room.biome,
      light: { value: light, band: bandOf(light) },
      canSee: see,
      harmed: isHarmedByLight(p.perception, light),
      description: see ? room.description : null,
      // Normal exits, plus any hidden exits this player has discovered. Each
      // carries `to`: the destination room's name when the room is lit enough to
      // see (you can read where the passage leads), else null in the dark.
      exits: [
        ...Object.keys(room.exits || {}).map((dir) => ({ dir, to: room.exits[dir] })),
        ...Object.keys(room.hiddenExits || {})
          .filter((dir) => isDiscovered(p, discoveryKey(room.id, "exit", dir)))
          .map((dir) => ({ dir, to: room.hiddenExits[dir] })),
        // An open, visible door fixture (a trapdoor, gate) opens a way in its direction.
        ...rt.fixtures
          .filter((f) => { const ft = w.fixtures[f.template]; return ft && ft.door && f.open && fixtureVisibleTo(p, f); })
          .map((f) => { const d = w.fixtures[f.template].door; return { dir: d.dir, to: d.to }; }),
      ].map((e) => ({ dir: e.dir, to: see && w.rooms[e.to] ? w.rooms[e.to].name : null })),
      contents: { players, mobs, items, fixtures },
    },
  };
}

// --- Examine -----------------------------------------------------------------
// A single examined entity, rendered in the Inspect window. The payload is
// intentionally generic — `bars`/`lines`/`hints` — so HP bars, stats, and
// interaction hints can grow without protocol churn.

// One terse line for an item's combat rider: a weapon's `onHit` entry ("on
// hit") or armour's spikes/`onDamage` answer ("when struck"). These are an
// item's defining trick — they must read at the counter, not be discovered
// mid-fight. A chance-gated rider carries its odds in the prefix.
function riderLine(when, o) {
  const p = o.chance != null && o.chance < 1 ? `${when} (${Math.round(o.chance * 100)}%)` : when;
  if (o.type === "restore") {
    const gain = [o.hp ? `${o.hp} HP` : null, o.mana ? `${o.mana} mana` : null].filter(Boolean).join(", ");
    return `${p}: restore ${gain}`;
  }
  if (o.type === "damage-over-time")
    return `${p}: ${o.name || "bleed"} — ${o.damage}${o.damageType ? ` ${o.damageType}` : ""} per tick for ${fmtDuration(o.duration)}`;
  if (o.type === "slow") return `${p}: ${(o.name || "slow").toLowerCase()} — speed −${o.magnitude} for ${fmtDuration(o.duration)}`;
  if (o.type === "damage") return `${p}: attacker takes ${o.damage}`;
  return `${p}: ${o.name || o.type}`;
}

// A one-line gist of what a scroll's spell does, so the sheet can be weighed
// before it is bought or studied. Damage dice show the viewer's current scale
// bonus (like weapon lines); status effects reduce to a plain phrase.
function spellGist(s, w, viewer) {
  const e = s.effect || {};
  const dice = (roll) => {
    const bonus = viewer && e.scale ? spellScaleBonus(effectiveAttributes(w, viewer), e.scale) : 0;
    const cur = bonus ? ` +${bonus}` : "";
    const rule = e.scale ? ` (${e.scale.attr}/${e.scale.per || 1})` : "";
    return `${roll}${e.damageType ? ` ${e.damageType}` : ""}${cur}${rule}`;
  };
  switch (e.type) {
    case "damage": return `${dice(e.damage)} damage to one target`;
    case "damage-room": return `${dice(e.damage)} damage to every foe in the room`;
    case "damage-over-time": return `${dice(e.damage)} per tick, lingering`;
    case "drain": return `${dice(e.damage)} damage, part drunk back as healing`;
    case "mana-drain": return `${dice(e.drain)} drawn from the target's mana`;
    case "heal-over-time": return s.target === "room" ? "mends everyone on your side over time" : "mends the target over time";
    case "protect": return "wraps the target in a protective ward";
    case "summon": return "summons a creature to fight for you";
    case "emit-light": return "the target sheds light";
    case "cleanse": return "strips harmful effects";
    case "sleep": return "puts a creature to sleep";
    case "douse": return "snuffs the target's light";
    default: return e.type || "?";
  }
}

// `opts.salePrice` (a ware at a visible trader's counter) rides the value line
// rather than a hint of its own, keeping the block short.
function itemSpecLines(tmpl, w, viewer, opts = {}) {
  // Type and slot share a line (like value · sells) to keep the block short.
  const lines = [tmpl.slot ? `type: ${tmpl.type} · slot: ${tmpl.slot}` : `type: ${tmpl.type}`];
  if (tmpl.weapon) {
    const dmg = Object.entries(tmpl.weapon.damage || {}).map(([k, v]) => `${v} ${k}`).join(", ");
    // Every melee swing adds an attribute bonus — the weapon's own `scale`, or
    // the default Might/4 when it declares none. Show the rule (so a plain sword
    // reads differently from a Might-scaling one) plus the viewer's current
    // bonus, so two same-dice weapons aren't indistinguishable.
    const sc = (tmpl.weapon.scale && tmpl.weapon.scale.attr) ? tmpl.weapon.scale : MELEE_SCALE;
    const bonus = viewer ? spellScaleBonus(effectiveAttributes(w, viewer), sc) : null;
    const cur = bonus ? `+${bonus} ` : "";
    lines.push(`damage: ${dmg} ${cur}(${sc.attr}/${sc.per || 1})`, `action cost: ${tmpl.weapon.actionCost}`);
    // Flat crit the weapon adds on top of the viewer's Perception crit.
    if (tmpl.weapon.crit) lines.push(`crit: +${Math.round(tmpl.weapon.crit * 100)}%`);
    // Armour a blunt weapon cracks through before the defender's physical soak.
    if (tmpl.weapon.pierce) lines.push(`armour pierce: ${tmpl.weapon.pierce}`);
    // Two-handed weapons fill both hands — no shield alongside them.
    if (tmpl.weapon.twoHanded) lines.push("two-handed (no shield)");
    for (const o of tmpl.weapon.onHit || []) lines.push(riderLine("on hit", o));
  }
  if (tmpl.armour) {
    const ar = tmpl.armour.armour || 0, wd = tmpl.armour.ward || 0, vw = tmpl.armour.voidWard || 0;
    if (ar || wd) lines.push(`armour ${ar}, ward ${wd}`); // skip for pure-bonus gear (a ring, a coil)
    if (vw) lines.push(`voidward ${vw}`); // Umbral gear only — turns void aside
    // A positive value slows the wearer (heavy plate); a negative one quickens them
    // (feather-light cloth) and reads as a speed bonus rather than a "penalty".
    if (tmpl.armour.speedPenalty > 0) lines.push(`speed penalty: ${tmpl.armour.speedPenalty}`);
    else if (tmpl.armour.speedPenalty < 0) lines.push(`speed +${-tmpl.armour.speedPenalty}`);
    if (tmpl.armour.maxHp) lines.push(`max HP +${tmpl.armour.maxHp}`);
    if (tmpl.armour.maxMana) lines.push(`max mana +${tmpl.armour.maxMana}`);
    if (tmpl.armour.manaRegen) lines.push(`mana regen +${tmpl.armour.manaRegen}/tick`);
    if (tmpl.armour.evasion) lines.push(`evasion +${Math.round(tmpl.armour.evasion * 100)}%`);
    // Spikes (and any onDamage rider) answer the attacker — the mirror of onHit.
    if (tmpl.armour.spikes) lines.push(riderLine("when struck", { type: "damage", damage: tmpl.armour.spikes.damage, chance: tmpl.armour.spikes.chance }));
    for (const o of tmpl.armour.onDamage || []) lines.push(riderLine("when struck", o));
    const mod = tmpl.armour.attrMod;
    if (mod) lines.push(...Object.entries(mod).map(([k, v]) => `${k} ${v > 0 ? "+" : ""}${v}`));
    // A wearable compares against what the viewer has in that slot, so "is this
    // an upgrade?" is answered at a glance. Silent for the very piece being worn
    // (or a second copy of it), and when nothing (comparable) fills the slot.
    const worn = viewer && tmpl.slot && viewer.equipment && viewer.equipment[tmpl.slot];
    const wornT = worn && worn.template !== tmpl.id ? w.items[worn.template] : null;
    if (wornT && wornT.armour) {
      const a = tmpl.armour, b = wornT.armour;
      const diffs = [];
      const diff = (label, nv, ov, suffix = "") => {
        const d = (nv || 0) - (ov || 0);
        if (d) diffs.push(`${label} ${d > 0 ? "+" : ""}${d}${suffix}`);
      };
      diff("armour", a.armour, b.armour);
      diff("ward", a.ward, b.ward);
      diff("voidward", a.voidWard, b.voidWard);
      diff("speed", -(a.speedPenalty || 0), -(b.speedPenalty || 0));
      diff("max HP", a.maxHp, b.maxHp);
      diff("max mana", a.maxMana, b.maxMana);
      diff("mana regen", a.manaRegen, b.manaRegen);
      diff("evasion", Math.round((a.evasion || 0) * 100), Math.round((b.evasion || 0) * 100), "%");
      for (const k of new Set([...Object.keys(a.attrMod || {}), ...Object.keys(b.attrMod || {})]))
        diff(k, (a.attrMod || {})[k], (b.attrMod || {})[k]);
      if (diffs.length) lines.push(`vs ${wornT.name}: ${diffs.join(", ")}`);
    }
  }
  if (tmpl.light) {
    lines.push(`light output: ${tmpl.light.output}`, `fuel capacity: ${tmpl.light.fuelMax}`);
    // Fuel alone doesn't say how LONG it lasts — a blaze-lantern gulps 5/tick.
    if (tmpl.light.burnPerTick) lines.push(`burn time: ~${fmtDuration(Math.round(tmpl.light.fuelMax / tmpl.light.burnPerTick))} from full`);
    if (tmpl.light.fuelItem) lines.push(`refuel with: ${w.items[tmpl.light.fuelItem] ? w.items[tmpl.light.fuelItem].name : tmpl.light.fuelItem}`);
  }
  const eff = tmpl.consumable && tmpl.consumable.effect;
  if (eff && typeof eff === "object") {
    // Prefixed `use:` — the catch-all verb that works on every consumable
    // (`drink`/`eat` work too; they only shape the flavour text).
    if (eff.type === "restore") {
      const gain = [eff.hp ? `${eff.hp} HP` : null, eff.mana ? `${eff.mana} mana` : null].filter(Boolean).join(", ");
      lines.push(`use: restores ${gain}`);
    }
    else if (eff.type === "heal-over-time")
      lines.push(`use: ${eff.magnitude} HP every ${eff.interval > 1 ? `${eff.interval} ticks` : "tick"} for ${fmtDuration(eff.duration)}`);
    else if (eff.type === "summon") {
      const mt = w.mobs[eff.mob];
      lines.push(`use: hatches ${mt ? mt.name : eff.mob} to fight at your side (one at a time)`);
    }
    else if (eff.type === "emit-light") lines.push(`use: emit ${eff.magnitude} light for ${fmtDuration(eff.duration)}`);
    else if (eff.type === "attr-buff" && (eff.attrMod || eff.maxHp)) {
      const mods = Object.entries(eff.attrMod || {}).map(([k, v]) => `${k} ${v > 0 ? "+" : ""}${v}`);
      if (eff.maxHp) mods.push(`max HP +${eff.maxHp}`);
      lines.push(`use: ${mods.join(", ")} for ${fmtDuration(eff.duration)}`);
    }
    else if (eff.type === "damage-room") lines.push(`throw: ${eff.damage}${eff.damageType ? ` ${eff.damageType}` : ""} damage to every foe in the room (single use)`);
    else lines.push(`use: ${eff.type}`);
  }
  if (tmpl.scroll && tmpl.scroll.spell) {
    const s = w.spells[tmpl.scroll.spell];
    const known = viewer && (viewer.knownSpells || []).includes(tmpl.scroll.spell);
    lines.push(`study: learn ${s ? s.name : tmpl.scroll.spell}${known ? " (already known)" : ""}`);
    if (s) lines.push(`spell: ${s.manaCost} mana${s.shardCost ? ` + ${s.shardCost} shards` : ""} — ${spellGist(s, w, viewer)}`);
  }
  // A book (`teaches`) names several recipes/spells; a schematic (`recipe`)
  // exactly one. List them — marking what's already known — so the sheet can
  // be weighed before it's bought or studied (mirrors trade.js's "(known)").
  if (tmpl.teaches || tmpl.recipe) {
    const kr = (viewer && viewer.knownRecipes) || [];
    const ks = (viewer && viewer.knownSpells) || [];
    const label = (def, id, known) => `${def ? def.name : id}${known ? " (known)" : ""}`;
    const taught = [
      ...(tmpl.teaches ? tmpl.teaches.recipes || [] : [tmpl.recipe]).map((id) => label(w.recipes[id], id, kr.includes(id))),
      ...(tmpl.teaches ? tmpl.teaches.spells || [] : []).map((id) => label(w.spells[id], id, ks.includes(id))),
    ];
    if (taught.length) lines.push(`study: learn ${taught.join(", ")}`);
  }
  if (tmpl.value != null) lines.push(`value: ${tmpl.value} shards · sells for ${sellValueOf(tmpl)}${opts.salePrice != null ? ` · on sale for ${opts.salePrice}` : ""}`);
  else if (opts.salePrice != null) lines.push(`on sale for ${opts.salePrice}`); // a valueless ware still shows its price
  return lines;
}

/** Tick count → m:ss (the world ticks once per second). */
function fmtDuration(ticks) {
  const s = Math.max(0, ticks | 0);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function entity(kind, id, name, description, extra) {
  return { type: "examine", entity: Object.assign({ kind, id, name, description }, extra) };
}

/**
 * Resolve a target (by id first, then name) within what the player can perceive,
 * and build its examine payload. Returns null if nothing matches.
 */
function buildExamineView(state, p, q) {
  const w = state.world;
  const rt = state.rooms[p.location];
  const light = rt.light;
  const see = canPerceive(p, light); // a sleeping examiner perceives nothing
  // Detail (HP, description, specs) only at *clear* sight; in the partial/dim
  // tier you make out what a thing is, but not its particulars.
  const dimBelow = p.perception && p.perception.dimBelow != null ? p.perception.dimBelow : p.perception.blindBelow;
  const detailed = see && light >= dimBelow;
  const ql = (q || "").toLowerCase();
  // Same resolution as command targeting (id, then authored keywords, then
  // name substring — see query.js), so what `get`/`use`/`attack` can name,
  // `examine` can too.
  const hit = (id, name, keywords) => matchesQuery(ql, name, keywords, id);
  const tooDim = { hints: ["Too dim to make out details."] };

  for (const m of rt.mobs) {
    if (!mobVisibleTo(state, p, m)) continue; // a hidden lurker isn't examinable until searched out
    const t = w.mobs[m.template];
    if ((see || t.emitsLight) && hit(m.id, t.name, t.keywords)) {
      if (!detailed) return entity("mob", m.id, t.name, null, { dim: true, ...tooDim });
      const hints = [
        t.hostile ? "Hostile — it may attack if it senses you."
          : t.lightAggro ? "Calm in the dark — light rouses it."
          : "It seems harmless.",
      ];
      // A dozing/resting creature is inert until struck — telegraph the opening.
      if (m.posture === "sleeping") hints.push("Asleep — it hasn't noticed you. Strike and it wakes.");
      else if (m.posture === "sitting") hints.push("At rest — not yet roused.");
      // Telegraph the data-driven combat triggers (see applyHitOutcome).
      if (t.attack && Array.isArray(t.attack.onHit) && t.attack.onHit.some((o) => o.type === "damage-over-time"))
        hints.push("Venomous — its bite festers.");
      // Spined if it has `spikes` sugar or any onDamage entry that hits the attacker back.
      const retaliates = (t.onDamage || []).some((e) => (e.target || "attacker") === "attacker" && (e.type === "damage" || e.type === "damage-over-time"));
      if (t.spikes || retaliates) hints.push("Spined — striking it draws blood.");
      if (t.shop) hints.push("Trades here — `list` the wares, `examine <ware>` for its stats, then `buy <item>` / `sell <item>`.");
      return entity("mob", m.id, t.name, t.description, {
        bars: [{ label: "HP", value: m.hp, max: m.maxHp, kind: "hp" }],
        hints,
      });
    }
  }
  if (see) {
    for (const i of rt.items) {
      if (!itemVisibleTo(state, p, i)) continue;
      const t = w.items[i.template];
      if (hit(i.id, t.name, t.keywords))
        return detailed
          ? entity("item", i.id, t.name, t.description, { rarity: t.rarity || "common", lines: itemSpecLines(t, w, p) })
          : entity("item", i.id, t.name, null, { dim: true, ...tooDim });
    }
    for (const f of rt.fixtures) {
      if (!fixtureVisibleTo(p, f)) continue;
      const t = w.fixtures[f.template];
      if (hit(f.id, t.name, t.keywords)) {
        if (!detailed) return entity("fixture", f.id, t.name, null, { dim: true, ...tooDim });
        const lines = [];
        const hints = [];
        if (t.station) {
          lines.push(`station: ${t.station}`);
          hints.push("Craft here — see `recipes`, then `craft <recipe>`.");
        }
        if (t.switch) {
          lines.push(`power: ${f.on ? "on" : "off"}`);
          if (t.switch.emitsLight) lines.push(`light when on: ${t.switch.emitsLight}`);
          const callName = t.name.replace(/^(a|an|the)\s+/i, ""); // "an iron lamp" → "iron lamp"
          hints.push(`Switch it with \`use ${callName}\`.`);
        }
        if (t.door) {
          lines.push(`it is ${f.open ? "open" : "shut"}`);
          // An attribute-gated door tells the player up front what it takes to force it.
          if (t.door.requires) {
            const rq = t.door.requires;
            const label = rq.attr.charAt(0).toUpperCase() + rq.attr.slice(1);
            lines.push(`needs: ${label} ${rq.value} to open`);
          }
          const callName = t.name.replace(/^(a|an|the)\s+/i, ""); // "a heavy trapdoor" → "heavy trapdoor"
          hints.push(`${f.open ? "Close" : "Open"} it with \`${f.open ? "close" : "open"} ${callName}\`.`);
        }
        if (t.mine) {
          const left = f.charges != null ? f.charges : t.mine.charges;
          lines.push(`ore: ${w.items[t.mine.template].name}`);
          lines.push(`yield left: ${left}/${t.mine.charges}`);
          hints.push(left > 0 ? "Work it with `mine`." : "Worked out — leave it time to recover.");
        }
        if (t.harvest) {
          const left = f.charges != null ? f.charges : t.harvest.charges;
          lines.push(`crop: ${w.items[t.harvest.template].name}`);
          lines.push(`ready: ${left}/${t.harvest.charges}`);
          const callName = t.name.replace(/^(a|an|the)\s+/i, ""); // "a cluster of glow-caps" → "cluster of glow-caps"
          hints.push(left > 0 ? `Pick them by hand with \`gather\` (or \`use ${callName}\`).` : "Picked clean — leave it time to grow back.");
        }
        if (t.fish) {
          hints.push(`Work a line here with \`fish\`.`);
        }
        if (t.restore) {
          const callName = t.name.replace(/^(a|an|the)\s+/i, ""); // "a dark seep" → "dark seep"
          hints.push(`Drink from it with \`use ${callName}\`.`);
        }
        // No affordance at all → say so plainly, so a player can tell inert scenery
        // (a relief, a pillar, a bone pile) from something they can work or take.
        if (!hints.length) hints.push("It's part of the cavern — nothing here to work or take.");
        return entity("fixture", f.id, t.name, t.description, { lines, hints });
      }
    }
    for (const o of state.playersIn(p.location)) {
      if (o.id !== p.id && hit(o.id, o.name)) {
        if (!detailed) return entity("player", o.id, o.name, null, { dim: true, ...tooDim });
        const phint = o.posture === "sleeping" ? ["Asleep."] : o.posture === "sitting" ? ["Sitting, at rest."] : [];
        return entity("player", o.id, o.name, "A fellow delver.", { bars: [{ label: "HP", value: o.hp, max: o.maxHp, kind: "hp" }], hints: phint });
      }
    }
  }
  // Carried items are always examined clearly (in hand).
  for (const i of p.inventory) {
    const t = w.items[i.template];
    if (hit(i.id, t.name, t.keywords)) return entity("item", i.id, t.name, t.description, { rarity: t.rarity || "common", lines: itemSpecLines(t, w, p) });
  }
  for (const slot of Object.values(p.equipment)) {
    if (slot && hit(slot.id, w.items[slot.template].name, w.items[slot.template].keywords)) {
      const t = w.items[slot.template];
      return entity("item", slot.id, t.name, t.description, { rarity: t.rarity || "common", lines: itemSpecLines(t, w, p) });
    }
  }
  // Craftable goods. After anything real you hold or perceive, fall back to the
  // output of a recipe you KNOW: a craftable is a template you could make, not
  // an instance, so (like a recipe sheet, which `recipes` shows regardless of
  // light) it's recall rather than sight and examines clearly even in the dark.
  // Checked BEFORE the trader's stock: your own craft knowledge wins a name
  // clash with the counter — `examine acid bomb` shows the bomb you can make,
  // not the "acid bomb recipe" sheet on sale (still reachable by its full name).
  for (const rid of p.knownRecipes || []) {
    const r = w.recipes[rid];
    if (!r || !r.output) continue;
    const t = w.items[r.output.template];
    if (!t || !hit(r.output.template, t.name, t.keywords)) continue;
    // Just the item itself — inputs, station and the craft command live in
    // `recipes`, so examine doesn't repeat them.
    return entity("item", r.output.template, t.name, t.description, {
      rarity: t.rarity || "common",
      lines: itemSpecLines(t, w, p),
    });
  }
  // Shop wares on display. Last of all — after everything you hold, perceive or
  // could make yourself — fall back to the present trader's stock: a ware is a
  // template offer, not a room instance, but a visible shopkeeper lets you
  // inspect it before buying — as CircleMUD does with `look <ware>` at the
  // counter. Anything you carry or know how to craft above wins a name clash,
  // so this only fires for goods that are truly the vendor's. Quest-gated stock
  // stays invisible until earned.
  if (see) {
    const trader = rt.mobs.find((m) => mobVisibleTo(state, p, m) && w.mobs[m.template].shop);
    if (trader) {
      const done = (p.quests && p.quests.done) || [];
      for (const o of w.mobs[trader.template].shop.sells || []) {
        if (o.requiresQuest && !done.includes(o.requiresQuest)) continue;
        const t = w.items[o.template];
        if (!hit(o.template, t.name, t.keywords)) continue;
        if (!detailed) return entity("item", o.template, t.name, null, { dim: true, ...tooDim });
        const price = o.price != null ? o.price : buyValueOf(t);
        // The price rides the value line (no hint) — `buy` itself is taught by
        // the trader's own examine hint.
        return entity("item", o.template, t.name, t.description, {
          rarity: t.rarity || "common",
          lines: itemSpecLines(t, w, p, { salePrice: price }),
        });
      }
    }
  }
  return null;
}

module.exports = { buildPlayerView, buildRoomView, buildExamineView, itemView, mobStatusTag, itemSpecLines };
