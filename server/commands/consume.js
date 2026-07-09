"use strict";
/**
 * Consumables and carried light sources: `drink`/`eat`/`throw` (one handler,
 * the verb only shapes flavour), `refuel`, and the lit/doused toggle behind
 * `use <light source>`. Effect resolution lives in state.js; this consumes,
 * targets, and narrates.
 */
const {
  selfAndViews, err, roomLog, announce, relight, consumeOne,
  matchesQuery, findItem, equipItem, restoreGain, questKill,
  autoStand, roomHostiles, stickToSurvivor,
} = require("./shared");

// Effect primitives this client knows how to flavour. The engine (state.js)
// owns what each one *does*; this only narrates applying it.
const EFFECT_FLAVOUR = {
  "emit-light": "A soft light wells up beneath your skin.",
};

// Toggle a carried/equipped light source via `use <source>`. Equipping a source
// already kindles it (see equipItem); this is how you douse one to save fuel and
// relight it later. A source still in the pack is equipped (and thus lit) first.
// Not gated by light — you must be able to light a torch in the dark.
function toggleLightSource(state, player, inst, ctx) {
  const w = state.world;
  const name = w.items[inst.template].name;
  const equipped = player.equipment.light === inst;
  if (equipped && inst.lit) {
    inst.lit = false;
    roomLog(ctx, player, `${player.name} douses ${name}.`);
    relight(state, ctx, player);
    return selfAndViews(state, player, `You douse ${name}.`);
  }
  if (inst.fuel <= 0) return err(`${name} is spent — you need a fresh light.`);
  if (equipped) inst.lit = true; // relight an equipped-but-doused source
  else equipItem(player, player.inventory.splice(player.inventory.indexOf(inst), 1)[0], w); // equipping kindles it
  roomLog(ctx, player, `${player.name} lights ${name}.`);
  relight(state, ctx, player);
  return selfAndViews(state, player, `You light ${name}. The dark recedes.`);
}

// A carried/equipped light source matching `arg`, or undefined. `use` reaches
// for this before falling back to drinking (works in the dark — that's the point).
function findLightSource(state, player, arg) {
  const w = state.world;
  return [player.equipment.light, ...player.inventory].filter(Boolean).find(
    (i) => w.items[i.template].light && matchesQuery(arg, w.items[i.template].name, w.items[i.template].keywords, i.id)
  );
}

// `refuel <item>`: top up a carried/equipped fuelled light from its fuel item
// (e.g. a lantern with a flask of oil). Torches aren't refuellable — replace them.
function refuel(state, player, arg, ctx) {
  const w = state.world;
  if (!arg) return err("Refuel what?");
  const ql = arg.toLowerCase();
  // A light source matching arg, equipped or in the pack.
  const candidates = [player.equipment && player.equipment.light, ...player.inventory].filter(Boolean);
  const inst = candidates.find(
    (i) => w.items[i.template].light && (i.id.toLowerCase() === ql || w.items[i.template].name.toLowerCase().includes(ql))
  );
  if (!inst) return err(`You have no light source "${arg}" to refuel.`);
  const t = w.items[inst.template];
  const lt = t.light;
  if (!lt.fuelItem) return err(`${t.name} can't be refuelled — you'd just replace it.`);
  if (inst.fuel >= lt.fuelMax) return err(`${t.name} is already full.`);
  const fidx = player.inventory.findIndex((i) => i.template === lt.fuelItem);
  if (fidx < 0) return err(`You need ${w.items[lt.fuelItem].name} to refuel ${t.name}.`);
  consumeOne(player, player.inventory[fidx]);
  inst.fuel = Math.min(lt.fuelMax, (inst.fuel || 0) + (lt.refuelPerUnit || lt.fuelMax));
  relight(state, ctx, player);
  return selfAndViews(state, player, `You refuel ${t.name} with ${w.items[lt.fuelItem].name}. (fuel ${inst.fuel}/${lt.fuelMax})`);
}

// Consume a carried consumable and apply its effect. `verb` is the word the
// player reached for — `drink`/`eat` (ingestibles) or `use` (the catch-all that
// also activates devices like a flare); it only shapes the flavour text.
function drink(state, player, arg, ctx, verb = "use") {
  const w = state.world;
  if (!arg) return err(`What do you want to ${verb}?`);
  const idx = findItem(player.inventory, w, arg);
  if (idx < 0) return err(`You aren't carrying "${arg}".`);
  const inst = player.inventory[idx];
  const t = w.items[inst.template];
  if (t.type !== "consumable" || !t.consumable) return err(`You can't ${verb} ${t.name}.`);
  const spec = t.consumable.effect;
  if (!spec || typeof spec !== "object" || !spec.type)
    return err(`${t.name} fizzles uselessly — nothing happens.`);
  // A thrown area bomb is its own resolution — it consumes only on a throw that
  // has something to hit, so it can refuse (and keep the bomb) in an empty room.
  if (spec.type === "damage-room") return throwBomb(state, player, inst, t, spec, ctx, verb);
  // Consume one, then apply the effect primitive.
  consumeOne(player, inst);
  // `restore` is instantaneous (heal hp/mana); everything else is a status effect.
  if (spec.type === "restore") {
    const r = state.applyRestore(player, spec);
    announce(ctx, player, `${player.name} ${verb}s ${t.name}.`);
    return selfAndViews(state, player, `You ${verb} ${t.name}.${restoreGain(r)}`);
  }
  // A `summon` consumable hatches a friendly, permanent companion into the room
  // under the user's command (faction "player", no lifetime) — the pet path, as
  // opposed to the time-limited combat Summon spell. A per-owner group cap holds it
  // to one of its kind: hatching another sends the first off into the dark first.
  if (spec.type === "summon") {
    const tmpl = w.mobs[spec.mob];
    const group = spec.group || spec.mob;
    const events = [];
    const existing = state._ownedSummons(player.id, group);
    for (const m of existing) state._dismissSummon(m, "recast", events);
    state._summon({
      roomId: player.location, mobId: spec.mob, count: spec.count || 1,
      faction: "player", ownerId: player.id, summonerId: player.id, group, lifetime: null,
      by: "player", byName: player.name,
    });
    // The hatching (and a replacement made here) is narrated below; forward only
    // a dismissal in ANOTHER room, so onlookers there see the old pet slip away
    // and get their room view refreshed (mirrors castSummon in magic.js).
    for (const ev of events) if (ev.roomId !== player.location) ctx.emit(ev);
    announce(ctx, player, `${player.name} ${verb}s ${t.name}, and ${tmpl.name} wriggles free.`);
    const replaced = existing.length ? ` Your previous ${tmpl.name.replace(/^an? /i, "")} skitters off into the dark.` : "";
    const flavour = t.consumable.flavour ? ` ${t.consumable.flavour}` : "";
    return selfAndViews(state, player, `You ${verb} ${t.name}, and ${tmpl.name} hatches into your keeping.${replaced}${flavour}`);
  }
  state.applyEffect(player, spec);
  roomLog(ctx, player, `${player.name} ${verb}s ${t.name}.`);
  relight(state, ctx, player);
  // An item may carry its own flavour line; otherwise fall back to the effect's.
  const flavourText = t.consumable.flavour || EFFECT_FLAVOUR[spec.type];
  const flavour = flavourText ? ` ${flavourText}` : "";
  return selfAndViews(state, player, `You ${verb} ${t.name}.${flavour}`);
}

// `throw`/`use <bomb>`: detonate a `damage-room` consumable, blasting every
// eligible mob in the room at once. Only hostile (or already-engaged) mobs catch
// the blast, so a stray toss in town won't blow up a peaceful shopkeeper — and
// with nothing to hit the throw is refused and the bomb kept. Per-target damage,
// threat and kills live in state.detonateRoom; this filters, consumes, narrates,
// and sticks the thrower to a survivor so they keep swinging (like a hostile cast).
function throwBomb(state, player, inst, t, spec, ctx, verb) {
  const targets = roomHostiles(state, player);
  if (!targets.length)
    return err(`There's nothing here for ${t.name} to catch — best not waste it.`);

  autoStand(player); // you surge to your feet to make the throw
  consumeOne(player, inst);

  const events = [];
  const results = state.detonateRoom(player, spec, targets, 0, events);
  const killed = results.filter((r) => r.killed);
  const hurt = results.filter((r) => !r.killed && r.damage > 0);
  const poisoned = results.filter((r) => !r.killed && r.dot);
  const xp = killed.reduce((s, r) => s + (r.death.xp || 0), 0);
  const loot = killed.flatMap((r) => r.death.loot || []);

  stickToSurvivor(state, player, results);

  let outcome = "";
  if (hurt.length) outcome += ` It tears into ${hurt.map((r) => `${r.name} for ${r.damage}`).join(", ")}.`;
  if (poisoned.length) outcome += ` The ${spec.cause || "cloud"} clings to ${poisoned.map((r) => r.name).join(", ")}.`;
  if (killed.length) outcome += ` It blasts apart ${killed.map((r) => r.name).join(", ")}!${xp ? ` (+${xp} xp)` : ""}`;
  if (loot.length) outcome += ` They leave behind ${loot.join(", ")}.`;

  const qmsgs = killed.flatMap((r) => questKill(state, player, r.death));
  const burst = t.consumable.burst || "a storm of glimmer-fire and shrapnel";
  announce(ctx, player, `${player.name} hurls ${t.name} and it bursts in ${burst}!`, "combat");
  const flavour = t.consumable.flavour ? ` ${t.consumable.flavour}` : "";
  const out = selfAndViews(state, player, `You hurl ${t.name}.${flavour}${outcome}`, "combat");
  out.push(...qmsgs);
  // Of the resolver's side-effects only the wake-ups need forwarding — the
  // per-target outcome line above already narrates damage and kills (the
  // dispatcher's mob-hurt/death lines would double-narrate them).
  for (const ev of events) if (ev.type === "mob-woke") ctx.emit(ev);
  return out;
}

module.exports = { drink, refuel, toggleLightSource, findLightSource };
