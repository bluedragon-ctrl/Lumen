"use strict";
/**
 * Builds the structured view payloads sent to clients: `player` (always full
 * truth — it's your own character) and `room` (filtered by what the viewer can
 * perceive at the current light level, per DESIGN.md §3.1 / §5.4).
 */
const { bandOf, canSee, isHarmedByLight } = require("./light");

function itemView(inst, world) {
  if (!inst) return null;
  const t = world.items[inst.template];
  const v = { id: inst.id, template: inst.template, name: t.name, type: t.type };
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
  return {
    type: "player",
    player: {
      name: p.name,
      level: p.level,
      xp: p.xp,
      hp: p.hp,
      maxHp: p.maxHp,
      mana: p.mana,
      maxMana: p.maxMana,
      energy: p.energy,
      speed: p.speed,
      attributes: p.attributes,
      perception: p.perception,
      equipment,
      inventory: p.inventory.map((i) => itemView(i, w)),
      states: p.states,
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

  const mobs = [];
  for (const m of rt.mobs) {
    const t = w.mobs[m.template];
    const luminous = !!t.emitsLight;
    if (see || luminous) mobs.push({ id: m.id, name: t.name, hostile: !!t.hostile, luminous });
  }
  const items = see
    ? rt.items.map((i) => ({ id: i.id, name: w.items[i.template].name, template: i.template }))
    : [];
  const fixtures = see
    ? rt.fixtures.map((f) => ({ id: f.id, name: w.fixtures[f.template].name, template: f.template }))
    : [];
  const players = see
    ? state.playersIn(p.location).filter((o) => o.id !== p.id).map((o) => ({ id: o.id, name: o.name }))
    : [];

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
      exits: Object.keys(room.exits || {}),
      contents: { players, mobs, items, fixtures },
    },
  };
}

module.exports = { buildPlayerView, buildRoomView, itemView };
