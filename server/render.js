"use strict";
/**
 * Builds the structured view payloads sent to clients: `player` (always full
 * truth — it's your own character) and `room` (filtered by what the viewer can
 * perceive at the current light level, per DESIGN.md §3.1 / §5.4).
 */
const { bandOf, canSee, isHarmedByLight } = require("./light");
const { actorEmitLight, playerDefence, sellValueOf, itemVisibleTo, fixtureVisibleTo, mobVisibleTo, isDiscovered, discoveryKey, matchesQuery } = require("./state");

function itemView(inst, world) {
  if (!inst) return null;
  const t = world.items[inst.template];
  const v = { id: inst.id, template: inst.template, name: t.name, type: t.type, slot: t.slot || null };
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
  return {
    type: "player",
    player: {
      name: p.name,
      level: p.level,
      xp: p.xp,
      shards: p.shards || 0,
      hp: p.hp,
      maxHp: p.maxHp,
      mana: Math.floor(p.mana || 0),
      maxMana: p.maxMana,
      energy: p.energy,
      energyMax: p.speed * 3, // action-point bank cap (matches state.advance)
      speed: p.speed,
      armour: defence.armour,
      ward: defence.ward, // gear Ward + innate Ward from Wits
      evasion: defence.evasion, // Wits-derived dodge (fraction, e.g. 0.06)
      crit: ((p.attributes && p.attributes.perception) || 0) * 0.01, // Perception crit chance (fraction)
      attributes: p.attributes,
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
  const see = canSee(p.perception, light);

  // Hidden features stay out of the view until this player has searched them out.
  const mobs = [];
  for (const m of rt.mobs) {
    if (!mobVisibleTo(state, p, m)) continue;
    const t = w.mobs[m.template];
    const luminous = !!t.emitsLight;
    if (see || luminous) mobs.push({ id: m.id, name: t.name, hostile: !!t.hostile, luminous });
  }
  const items = see
    ? rt.items.filter((i) => itemVisibleTo(p, i)).map((i) => ({ id: i.id, name: w.items[i.template].name, template: i.template, qty: i.qty != null ? i.qty : undefined }))
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
    if (see || luminous) players.push({ id: o.id, name: o.name, luminous });
  }

  return {
    type: "room",
    room: {
      id: room.id,
      name: room.name,
      depth: room.depth,
      light: { value: light, band: bandOf(light) },
      canSee: see,
      harmed: isHarmedByLight(p.perception, light),
      description: see ? room.description : null,
      // Normal exits, plus any hidden exits this player has discovered.
      exits: [
        ...Object.keys(room.exits || {}),
        ...Object.keys(room.hiddenExits || {}).filter((dir) => isDiscovered(p, discoveryKey(room.id, "exit", dir))),
      ],
      contents: { players, mobs, items, fixtures },
    },
  };
}

// --- Examine -----------------------------------------------------------------
// A single examined entity, rendered in the Inspect window. The payload is
// intentionally generic — `bars`/`lines`/`hints` — so HP bars, stats, and
// interaction hints can grow without protocol churn.

function itemSpecLines(tmpl, w) {
  const lines = [`type: ${tmpl.type}`];
  if (tmpl.weapon) {
    const dmg = Object.entries(tmpl.weapon.damage || {}).map(([k, v]) => `${v} ${k}`).join(", ");
    lines.push(`damage: ${dmg}`, `action cost: ${tmpl.weapon.actionCost}`);
  }
  if (tmpl.armour) {
    lines.push(`armour ${tmpl.armour.armour}, ward ${tmpl.armour.ward}`);
    if (tmpl.armour.speedPenalty) lines.push(`speed penalty: ${tmpl.armour.speedPenalty}`);
  }
  if (tmpl.light) {
    lines.push(`light output: ${tmpl.light.output}`, `fuel capacity: ${tmpl.light.fuelMax}`);
    if (tmpl.light.fuelItem) lines.push(`refuel with: ${w.items[tmpl.light.fuelItem] ? w.items[tmpl.light.fuelItem].name : tmpl.light.fuelItem}`);
  }
  const eff = tmpl.consumable && tmpl.consumable.effect;
  if (eff && typeof eff === "object") {
    if (eff.type === "emit-light") lines.push(`drink: emit ${eff.magnitude} light for ${fmtDuration(eff.duration)}`);
    else lines.push(`drink: ${eff.type}`);
  }
  if (tmpl.scroll && tmpl.scroll.spell) {
    const s = w.spells[tmpl.scroll.spell];
    lines.push(`study: learn ${s ? s.name : tmpl.scroll.spell}`);
  }
  if (tmpl.value != null) lines.push(`value: ${tmpl.value} shards · sells for ${sellValueOf(tmpl)}`);
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
  const see = canSee(p.perception, light);
  // Detail (HP, description, specs) only at *clear* sight; in the partial/dim
  // tier you make out what a thing is, but not its particulars.
  const dimBelow = p.perception && p.perception.dimBelow != null ? p.perception.dimBelow : p.perception.blindBelow;
  const detailed = light >= dimBelow;
  const ql = (q || "").toLowerCase();
  const hit = (id, name) => matchesQuery(id, name, ql);
  const tooDim = { hints: ["Too dim to make out details."] };

  for (const m of rt.mobs) {
    if (!mobVisibleTo(state, p, m)) continue; // a hidden lurker isn't examinable until searched out
    const t = w.mobs[m.template];
    if ((see || t.emitsLight) && hit(m.id, t.name)) {
      const attack = { actions: [{ label: "Attack", command: `attack ${m.id}` }] };
      if (!detailed) return entity("mob", m.id, t.name, null, { dim: true, ...tooDim, ...attack });
      const hints = [
        t.hostile ? "Hostile — it may attack if it senses you."
          : t.lightAggro ? "Calm in the dark — light rouses it."
          : "It seems harmless.",
      ];
      // Telegraph the data-driven combat triggers (see applyHitOutcome).
      if (t.attack && Array.isArray(t.attack.onHit) && t.attack.onHit.some((o) => o.type === "damage-over-time"))
        hints.push("Venomous — its bite festers.");
      // Spined if it has `spikes` sugar or any onDamage entry that hits the attacker back.
      const retaliates = (t.onDamage || []).some((e) => (e.target || "attacker") === "attacker" && (e.type === "damage" || e.type === "damage-over-time"));
      if (t.spikes || retaliates) hints.push("Spined — striking it draws blood.");
      if (t.shop) hints.push("Trades here — try `list`, then `buy <item>` / `sell <item>`.");
      return entity("mob", m.id, t.name, t.description, {
        bars: [{ label: "HP", value: m.hp, max: m.maxHp, kind: "hp" }],
        hints,
        ...attack,
      });
    }
  }
  if (see) {
    for (const i of rt.items) {
      if (!itemVisibleTo(p, i)) continue;
      const t = w.items[i.template];
      if (hit(i.id, t.name))
        return detailed
          ? entity("item", i.id, t.name, t.description, { lines: itemSpecLines(t, w) })
          : entity("item", i.id, t.name, null, { dim: true, ...tooDim });
    }
    for (const f of rt.fixtures) {
      if (!fixtureVisibleTo(p, f)) continue;
      const t = w.fixtures[f.template];
      if (hit(f.id, t.name)) {
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
        if (t.mine) {
          const left = f.charges != null ? f.charges : t.mine.charges;
          lines.push(`ore: ${w.items[t.mine.template].name}`);
          lines.push(`yield left: ${left}/${t.mine.charges}`);
          hints.push(left > 0 ? "Work it with `mine`." : "Worked out — leave it time to recover.");
        }
        return entity("fixture", f.id, t.name, t.description, { lines, hints });
      }
    }
    for (const o of state.playersIn(p.location)) {
      if (o.id !== p.id && hit(o.id, o.name))
        return detailed
          ? entity("player", o.id, o.name, "A fellow delver.", { bars: [{ label: "HP", value: o.hp, max: o.maxHp, kind: "hp" }] })
          : entity("player", o.id, o.name, null, { dim: true, ...tooDim });
    }
  }
  // Carried items are always examined clearly (in hand).
  for (const i of p.inventory) {
    const t = w.items[i.template];
    if (hit(i.id, t.name)) return entity("item", i.id, t.name, t.description, { lines: itemSpecLines(t, w) });
  }
  for (const slot of Object.values(p.equipment)) {
    if (slot && hit(slot.id, w.items[slot.template].name)) {
      const t = w.items[slot.template];
      return entity("item", slot.id, t.name, t.description, { lines: itemSpecLines(t, w) });
    }
  }
  return null;
}

module.exports = { buildPlayerView, buildRoomView, buildExamineView, itemView };
