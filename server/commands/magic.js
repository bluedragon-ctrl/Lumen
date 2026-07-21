"use strict";
/**
 * Spellcasting: the `spells` listing and `cast` (single-target, area, support,
 * summon). Resolution (Ward resist, scaling, threat, kills) lives in state.js;
 * this handles targeting and narration.
 */
const { effectiveAttributes, spellScaleBonus, durationScaleBonus } = require("../state");
const { canSee } = require("../light");
const {
  selfAndViews, err, logMsg, announce, matchesQuery, closestName, findMobInRoom, hostileToward, questKill,
  autoStand, roomHostiles, stickToSurvivor, joinList,
} = require("./shared");

// Effect types each player cast path can resolve, checked before any cost is
// spent so an authoring mistake (e.g. a scroll teaching a mob-only spell like
// Snuff) reads as a refusal, not a half-cast that eats mana and does nothing.
// tools/validate-data.js enforces the same sets on learnable spells at build time.
const HOSTILE_EFFECTS = ["damage", "damage-over-time", "sleep", "damage-room", "drain"];
const SUPPORT_EFFECTS = ["restore", "protect", "cleanse", "heal-over-time", "emit-light"];

// Fill a spell narration template (`spell.messages`, see docs/data-model.md):
// {caster}, {target}, {spell} (proper name), {verb} (lower-cased name),
// {damage}. An unknown placeholder renders literally.
function fillTemplate(tpl, vars) {
  return tpl.replace(/\{(\w+)\}/g, (ph, k) => (vars[k] != null ? String(vars[k]) : ph));
}

// Format a tick count as m:ss for narration (one tick = one second). Mirrors
// render.js's fmtDuration so spoken durations match the status panel countdown.
function fmtTicks(ticks) {
  const s = Math.max(0, ticks | 0);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// Describe a `{ base?, scale? }` amount spec for the `spells` listing, e.g.
// `1+intellect/4` or `intellect`. A bare number renders as itself.
function fmtAmount(spec) {
  if (spec == null) return "0";
  if (typeof spec === "number") return String(spec);
  // `per` is a divisor in spellScaleBonus, so per>1 reads "attr/N" (1 point per N attr);
  // a sub-1 `per` (used to grant several points per attr, e.g. Halo's voidward) reads
  // as a "×M" multiplier so the spellbook shows "intellect×5", not "intellect/0.2".
  let scTail = "";
  if (spec.scale && spec.scale.attr && spec.scale.per && spec.scale.per !== 1) {
    scTail = spec.scale.per < 1 ? `×${Math.round(1 / spec.scale.per)}` : `/${spec.scale.per}`;
  }
  const sc = spec.scale && spec.scale.attr ? `${spec.scale.attr}${scTail}` : "";
  if (spec.base && sc) return `${spec.base}+${sc}`;
  return sc || String(spec.base || 0);
}

function spellList(state, player) {
  const w = state.world;
  const known = player.knownSpells || [];
  if (!known.length) return logMsg("You know no spells. Study a scroll to learn one.");
  const lines = ["<#gold>Spells<#reset>", ""];
  for (const id of known) {
    const s = w.spells[id];
    if (!s) continue;
    let tail = "";
    const e = s.effect || {};
    if (e.type === "damage") {
      const bonus = e.scale ? spellScaleBonus(effectiveAttributes(w, player), e.scale) : 0;
      tail = ` — ${e.damage} ${bonus ? `+${bonus} ` : ""}${e.damageType || "physical"} damage` +
        (e.scale ? ` (${e.scale.attr}/${e.scale.per})` : "");
    }
    else if (e.type === "heal-over-time") {
      const dur = (e.duration || 0) + durationScaleBonus(effectiveAttributes(w, player), e.durationScale);
      tail = ` — heals ${fmtAmount({ base: e.magnitude, scale: e.scale })} HP every ${e.interval || 1} tick${(e.interval || 1) === 1 ? "" : "s"} for ${fmtTicks(dur)}${e.durationScale ? ` (${e.durationScale.attr})` : ""}`;
    }
    else if (e.type === "protect") {
      const parts = [];
      if (e.armour) parts.push(`armour ${fmtAmount(e.armour)}`);
      if (e.ward) parts.push(`spellward ${fmtAmount(e.ward)}`);
      if (e.voidWard) parts.push(`voidward ${fmtAmount(e.voidWard)}`);
      if (e.emitLight) parts.push(`sheds ${e.emitLight} light`);
      const dur = (e.duration || 0) + durationScaleBonus(effectiveAttributes(w, player), e.durationScale);
      tail = ` — ${parts.join(", ")} for ${fmtTicks(dur)}${e.durationScale ? ` (${e.durationScale.attr})` : ""}`;
    }
    else if (e.type === "damage-over-time") {
      const dur = (e.duration || 0) + durationScaleBonus(effectiveAttributes(w, player), e.durationScale);
      const ds = e.durationScale ? ` (${e.durationScale.attr})` : "";
      tail = ` — ${e.damage} ${e.damageType || "magical"} burn per tick for ${fmtTicks(dur)}${ds}${e.emitLight ? `, sheds ${e.emitLight} light` : ""} (resisted by Ward)`;
    }
    else if (e.type === "damage-room") {
      const bonus = e.scale ? spellScaleBonus(effectiveAttributes(w, player), e.scale) : 0;
      tail = ` — ${e.damage} ${bonus ? `+${bonus} ` : ""}${e.damageType || "magical"} to every foe in the room` +
        (e.scale ? ` (${e.scale.attr}/${e.scale.per})` : "");
      if (e.dot) {
        const dur = (e.dot.duration || 0) + durationScaleBonus(effectiveAttributes(w, player), e.dot.durationScale);
        tail += `, then ${e.dot.damage} burn per tick for ${fmtTicks(dur)}${e.dot.durationScale ? ` (${e.dot.durationScale.attr})` : ""}${e.dot.emitLight ? `, sheds ${e.dot.emitLight} light` : ""}`;
      }
    }
    else if (e.type === "emit-light") {
      const dur = (e.duration || 0) + durationScaleBonus(effectiveAttributes(w, player), e.durationScale);
      tail = ` — sheds ${e.magnitude || 1} light for ${fmtTicks(dur)}${e.durationScale ? ` (${e.durationScale.attr})` : ""}`;
    }
    else if (e.type === "sleep")
      tail = ` — lulls a foe to sleep (resisted by Ward, broken by any blow)`;
    else if (e.type === "summon") {
      const sm = w.mobs[e.mob];
      const life = (e.duration || 0) + durationScaleBonus(effectiveAttributes(w, player), e.durationScale);
      const span = life ? ` for ${fmtTicks(life)}${e.durationScale ? ` (${e.durationScale.attr})` : ""}` : "";
      tail = ` — conjures ${sm ? sm.name : e.mob}${span}`;
    }
    // A non-default support shape gets a targeting hint (a hostile room spell
    // already says "every foe in the room" in its own tail).
    if (!s.hostile && e.type !== "summon") {
      if (s.target === "self") tail += " (self only)";
      else if (s.target === "room") tail += " (you and every ally present)";
    }
    // Material components (e.g. a chitin plate for Glimmer Husk) are listed after mana/shards as `name (qty)`.
    const comps = (s.itemCost || []).map((c) => `${w.items[c.template] ? w.items[c.template].name : c.template} (${c.qty || 1})`);
    const cost = [`${s.manaCost || 0} mana`, s.shardCost ? `${s.shardCost} shards` : null, ...comps].filter(Boolean).join(" + ");
    lines.push(`  <#green>${s.name}<#reset>: ${cost}${tail}`);
  }
  lines.push("", `<#gray>Mana: ${Math.floor(player.mana || 0)}/${player.maxMana}.<#reset>`);
  return logMsg(lines.join("\n"));
}

// `cast <spell> [at] <target>`: spend mana to hurl a known spell at a creature
// you can perceive. Resolution (Ward resist, Intellect-scaled damage, threat,
// kill) lives in state.castSpell; this handles targeting and narration. A spell
// may reflavour its landed-hit lines via `messages` ({self, room} templates).
function cast(state, player, arg, ctx) {
  const w = state.world;
  if (!arg) return err("Cast what? Try `spells`.");
  const tokens = arg.trim().split(/\s+/);
  // Match the longest leading run of tokens that names a known spell (spell
  // names are usually one word); the remainder is the target.
  const known = player.knownSpells || [];
  let spellId = null;
  let rest = tokens.slice();
  for (let n = Math.min(3, tokens.length); n >= 1 && !spellId; n--) {
    const phrase = tokens.slice(0, n).join(" ").toLowerCase();
    const hit = known.find((id) => {
      const s = w.spells[id];
      return s && matchesQuery(phrase, s.name, s.keywords, id);
    });
    if (hit) { spellId = hit; rest = tokens.slice(n); }
  }
  if (!spellId) {
    // Quote everything up to an `at` as the attempted name — a multi-word spell
    // name can't be told apart from a bare target tail, so this is the honest guess.
    const atIdx = tokens.findIndex((tk) => tk.toLowerCase() === "at");
    const tried = (atIdx > 0 ? tokens.slice(0, atIdx) : tokens).join(" ");
    // A typo, most likely — offer the nearest spell the caster knows. The first
    // word alone is checked too, since the tail may be a target name.
    const close = closestName(tried, known.map((id) => w.spells[id]).filter(Boolean))
      || closestName(tokens[0], known.map((id) => w.spells[id]).filter(Boolean));
    return err(`You don't know any spell called "${tried}".${close ? ` Did you mean ${close}?` : ""} Try \`spells\`.`);
  }
  const spell = w.spells[spellId];
  const eff = spell.effect || {};

  // Refuse an effect type this path can't resolve — an authoring error — before
  // any cost is spent; a half-cast that eats mana and does nothing is worse than
  // a refusal. The validator enforces the same sets on the data at build time.
  if (eff.type !== "summon" && !(spell.hostile ? HOSTILE_EFFECTS : SUPPORT_EFFECTS).includes(eff.type)) {
    console.warn(`[lumen] spell ${spellId}: no ${spell.hostile ? "hostile" : "support"} cast path for effect type "${eff.type}"`);
    return err(`You reach for ${spell.name}, but the weave slips from your grasp and comes to nothing.`);
  }

  if (rest[0] && rest[0].toLowerCase() === "at") rest = rest.slice(1); // `cast spark at lightbug`
  const targetQ = rest.join(" ");

  // Mana, shards, and any material component are priced in one place (state.costShortfall);
  // refuse here, before anything is spent, if the caster can't pay.
  const short = state.costShortfall(player, spell);
  if (short) return err(short);

  autoStand(player); // rouse before casting, so a sleeping caster regains sight to aim

  // Summon spells are self-centred (no creature target) — conjure at the caster.
  if (eff.type === "summon") return castSummon(state, player, spell, ctx);

  // Beneficial spells (no `hostile` flag) mend rather than harm. `target` picks
  // the shape: "room" lays the weave across the caster's whole side at once;
  // "self" refuses any other name (see castSupport); "creature" is the classic
  // self-by-default / ally / any-creature targeting.
  if (!spell.hostile) {
    if (spell.target === "room") return castSupportAll(state, player, spell, ctx);
    return castSupport(state, player, spell, targetQ, ctx, spell.target === "self");
  }

  // Area spells (Arc Flash) blast every eligible foe in the room at once — no
  // single target to name. Eligibility/narration live in castBurst. (The
  // effect-type check is a fallback for unvalidated in-memory spells.)
  if (spell.target === "room" || eff.type === "damage-room") return castBurst(state, player, spell, ctx);

  let mob;
  if (targetQ) {
    // A hostile cast prefers the mobs out for your blood, mirroring `attack`.
    mob = findMobInRoom(state, player, targetQ, false, hostileToward(player));
    if (!mob) return err(`You see no "${targetQ}" here to target.`);
  } else {
    // No explicit target: fall back to the foe you're already engaged with — the
    // pending attack target shown in the Inspect pane — so `cast spark` mid-fight
    // strikes the current foe without having to name it again.
    const pendId = player.pending && player.pending.type === "attack" ? player.pending.targetId : null;
    mob = pendId ? state.rooms[player.location].mobs.find((m) => m.id === pendId) : null;
    if (!mob) return err(`Cast ${spell.name} at what?`);
  }

  const mt = w.mobs[mob.template];
  const verb = spell.name.toLowerCase();
  const events = [];
  const res = state.castSpell(player, spell, mob, events);
  const msgs = spell.messages || {};
  // State the damage type on the caster's line too, so every damage number in the
  // game carries its type (see events.dmgTag for the melee/mob-cast side).
  const typeTag = res.damageType ? ` (${res.damageType})` : "";

  let roomText, selfText;
  const tail = []; // quest messages, appended after the views
  if (res.resisted) {
    roomText = `${player.name}'s ${verb} crackles against ${mt.name} and fizzles.`;
    selfText = `You cast ${spell.name} at ${mt.name}, but its ward turns the bolt aside.`;
  } else if (res.slept) {
    // Don't let the caster's own queued swing instantly rouse the sleeper.
    if (player.pending && player.pending.targetId === mob.id) player.pending = null;
    roomText = `${player.name} weaves a drowsy hush over ${mt.name}, and it sinks into slumber.`;
    selfText = `You weave ${spell.name} over ${mt.name}; its limbs go slack and it sinks into a deep slumber.`;
  } else if (res.dot) {
    const span = res.duration ? ` for ${fmtTicks(res.duration)}` : "";
    roomText = `${player.name}'s ${verb} catches on ${mt.name}, and it begins to smoulder.`;
    selfText = `You set ${spell.name} alight in ${mt.name}; a clinging glimmer-burn takes hold and will gnaw at it${span}.`;
  } else if (res.killed) {
    const d = res.death;
    const lootTxt = d.loot && d.loot.length ? ` It leaves behind ${d.loot.join(", ")}.` : "";
    tail.push(...questKill(state, player, d));
    roomText = `${player.name}'s ${verb} blasts ${mt.name} apart, and it dies.${lootTxt}`;
    selfText = `Your ${verb} blasts ${mt.name} apart for ${res.damage}${typeTag}! You slay ${mt.name}.${d.xp ? ` (+${d.xp} xp)` : ""}${lootTxt}`;
  } else {
    // A landed, non-lethal hit — the one beat a spell may reflavour via `messages`.
    const vars = { caster: player.name, target: mt.name, spell: spell.name, verb, damage: `${res.damage}${typeTag}` };
    roomText = fillTemplate(msgs.room || "{caster} hurls a crackling {verb} at {target}.", vars);
    selfText = fillTemplate(msgs.self || "You hurl {spell} at {target} for {damage} damage.", vars);
  }

  announce(ctx, player, roomText, "combat");
  const out = selfAndViews(state, player, selfText, "combat");
  out.push(...tail);
  // Deliver castSpell's side-effects: a rousted sleeper broadcasts through the
  // dispatcher; auto-engage is caster-directed, so it's appended here instead,
  // to land AFTER the cast line (the dispatcher would deliver it first). The
  // death event is dropped — the kill is already narrated (and quest-credited)
  // inline above, so the dispatcher's death lines would double-narrate it.
  for (const ev of events) {
    if (ev.type === "combat-auto-start") out.push({ type: "combat", text: `You turn on ${ev.targetName} and fight back!` });
    else if (ev.type !== "death") ctx.emit(ev);
  }
  return out;
}

// Per-damage-type default flavour for a room burst (hitVerb/killVerb/room/wave/
// self); anything without a row (magical light-spells like Arc Flash) falls to
// the default. A new damage type adds a row here rather than another boolean.
// A spell's own `messages` still wins piece-by-piece over these defaults (see
// castBurst) — the table just spares an author from restating the obvious for
// a spell that's happy with its damage type's stock wording (Iron Blast needs
// none of its own).
const BURST_FLAVOUR = {
  fire: { hitVerb: "scorches", killVerb: "burns apart", room: "a roaring", wave: "flame rolls through the room", self: "fire rolls through the chamber" },
  physical: { hitVerb: "shreds", killVerb: "tears apart", room: "a screaming", wave: "iron shrapnel tears through the room", self: "shrapnel tears through the chamber" },
};
const DEFAULT_BURST_FLAVOUR = { hitVerb: "sears", killVerb: "burns apart", room: "a blinding", wave: "the room erupts in white light", self: "light floods the chamber" };

// Cast a hostile area spell (Arc Flash): sear every eligible foe in the room at once.
// Eligibility mirrors throwBomb — only hostile (or already-engaged) mobs catch the
// burst, so a cast in town won't sear a peaceful shopkeeper, and with nothing to hit
// the cast is refused and the mana kept. Per-target damage, Intellect scaling, threat
// and kills live in state.castRoomSpell; this filters, narrates, and sticks the caster
// to a survivor so they keep swinging (mirrors a single-target hostile cast). The
// loosing lines and per-target verbs default to the spell's damageType row in
// BURST_FLAVOUR above; a spell reflavours any piece via `messages` ({self, room,
// hitVerb, killVerb} — see Glimmer Spike for the single-target equivalent).
function castBurst(state, player, spell, ctx) {
  const targets = roomHostiles(state, player);
  if (!targets.length)
    return err(`There's nothing here for ${spell.name} to catch — best save the mana.`);

  const verb = spell.name.toLowerCase();
  const msgs = spell.messages || {};
  const flav = BURST_FLAVOUR[spell.effect && spell.effect.damageType] || DEFAULT_BURST_FLAVOUR;
  const events = [];
  const results = state.castRoomSpell(player, spell, targets, events);
  const killed = results.filter((r) => r.killed);
  const hurt = results.filter((r) => !r.killed && r.damage > 0);
  const burning = results.filter((r) => !r.killed && r.dot);
  const resisted = results.filter((r) => r.resisted);
  const xp = killed.reduce((s, r) => s + (r.death.xp || 0), 0);
  const loot = killed.flatMap((r) => r.death.loot || []);

  stickToSurvivor(state, player, results);

  // Every target of one burst shares the spell's damage type; state it once per name.
  const typeTag = ` (${(spell.effect && spell.effect.damageType) || "magical"})`;
  let outcome = "";
  if (hurt.length) outcome += ` It ${msgs.hitVerb || flav.hitVerb} ${hurt.map((r) => `${r.name} for ${r.damage}${typeTag}`).join(", ")}.`;
  if (burning.length) outcome += ` ${burning.map((r) => r.name).join(", ")} ${burning.length === 1 ? "catches" : "catch"} alight, left to burn.`;
  if (killed.length) outcome += ` It ${msgs.killVerb || flav.killVerb} ${killed.map((r) => r.name).join(", ")}!${xp ? ` (+${xp} xp)` : ""}`;
  if (resisted.length) outcome += ` ${resisted.map((r) => r.name).join(", ")} ${resisted.length === 1 ? "shrugs" : "shrug"} the burst off, warded.`;
  if (loot.length) outcome += ` They leave behind ${loot.join(", ")}.`;

  const qmsgs = killed.flatMap((r) => questKill(state, player, r.death));
  const vars = { caster: player.name, spell: spell.name, verb };
  const roomText = fillTemplate(msgs.room || `{caster} looses ${flav.room} {verb} and ${flav.wave}!`, vars);
  const selfText = fillTemplate(msgs.self || `You loose {spell}; ${flav.self}.`, vars) + outcome;
  announce(ctx, player, roomText, "combat");
  const out = selfAndViews(state, player, selfText, "combat");
  out.push(...qmsgs);
  // Of the resolver's side-effects only the wake-ups need forwarding — the
  // per-target outcome line above already narrates damage and kills (the
  // dispatcher's mob-hurt/death lines would double-narrate them).
  for (const ev of events) if (ev.type === "mob-woke") ctx.emit(ev);
  return out;
}

// Cast a beneficial spell. Resolution (mana, magnitude scaling, applying the
// effect) lives in state.castBeneficial; this resolves the target and narrates.
// Target precedence: an explicit self word (or no target) → the caster; else an
// ally delver in the room; else a creature. A `selfOnly` spell (target: "self")
// refuses any other name outright — a typo should read as a refusal, not
// silently land on the caster. Per-pulse effects (Regeneration) then surface
// their healing over the following ticks via `regen-tick` events.
function castSupport(state, player, spell, targetQ, ctx, selfOnly = false) {
  const w = state.world;
  const rt = state.rooms[player.location];
  const see = canSee(player.perception, rt.light);
  const ql = (targetQ || "").trim().toLowerCase();
  const selfWords = ["", "self", "me", "myself", player.name.toLowerCase()];
  if (selfOnly && !selfWords.includes(ql))
    return err(`${spell.name} can only be laid on your own skin.`);

  let target = null;
  if (selfWords.includes(ql)) {
    target = { kind: "player", actor: player, id: player.id, name: "yourself", isSelf: true };
  } else {
    const other = [...state.playersIn(player.location)].find(
      (o) => o.id !== player.id && o.hp > 0 && matchesQuery(ql, o.name, null, o.id)
    );
    if (other) {
      if (!see) return err("It is too dark to make out your target.");
      target = { kind: "player", actor: other, id: other.id, name: other.name };
    } else {
      const mob = rt.mobs.find((m) => {
        const t = w.mobs[m.template];
        return (see || t.emitsLight > 0) && matchesQuery(ql, t.name, t.keywords, m.id);
      });
      if (mob) {
        const mt = w.mobs[mob.template];
        target = { kind: "mob", actor: mob, id: mob.id, name: mt.name, roomId: player.location, emitsLight: mt.emitsLight > 0 };
      }
    }
  }
  if (!target) return err(`You see no "${targetQ}" here to mend.`);

  const events = [];
  const res = state.castBeneficial(player, spell, target, events);
  const verb = spell.name.toLowerCase();
  const targetName = target.isSelf ? "themselves" : target.name; // for the room's view

  announce(ctx, player, `${player.name} weaves ${verb} over ${targetName}, and a soft light settles in.`);
  // Forward the take-hold only when it landed on an ALLY — it confirms the buff
  // and refreshes their vitals panel at once. A self-cast (or a mob target) is
  // already fully narrated by the lines above and below.
  for (const ev of events) if (ev.type === "effect-applied" && ev.playerId !== player.id) ctx.emit(ev);

  const onWhom = target.isSelf ? "yourself" : target.name;

  if (res.effect === "restore") {
    const parts = [];
    if (res.restored.hp) parts.push(`${res.restored.hp} health`);
    if (res.restored.mana) parts.push(`${res.restored.mana} mana`);
    const tail = parts.length ? ` restoring ${parts.join(" and ")}` : "";
    return selfAndViews(state, player, `You cast ${spell.name} on ${target.name}${tail}.`);
  }
  if (res.effect === "protect") {
    const parts = [];
    if (res.armour) parts.push(`+${res.armour} armour`);
    if (res.ward) parts.push(`+${res.ward} spellward`);
    if (res.voidWard) parts.push(`+${res.voidWard} voidward`);
    if (res.light) parts.push(`${res.light} light`);
    const grant = parts.length ? parts.join(", ") : "a faint sheen";
    const sheath = res.light ? "a wreath of cold glimmer-light" : "a lattice of hardened light";
    return selfAndViews(state, player, `You cast ${spell.name} on ${onWhom}; ${sheath} grants ${grant} for ${fmtTicks(res.duration)}.`);
  }
  if (res.effect === "emit-light") {
    return selfAndViews(state, player, `You cast ${spell.name} on ${onWhom}; a mote of light kindles overhead, shedding ${res.perPulse} light for ${fmtTicks(res.duration)}.`);
  }
  if (res.effect === "cleanse") {
    const tail = res.removed > 0
      ? `; ${res.removed} clinging affliction${res.removed === 1 ? "" : "s"} burn${res.removed === 1 ? "s" : ""} away`
      : "; but nothing clings to burn away";
    return selfAndViews(state, player, `You cast ${spell.name} on ${onWhom}${tail}.`);
  }
  return selfAndViews(state, player, `You cast ${spell.name} on ${onWhom}; ${res.perPulse} HP will knit every ${res.interval} tick${res.interval === 1 ? "" : "s"}.`);
}

// Cast a room-wide support spell (`target: "room"`): lay the weave on yourself
// and every ally beside you — co-located delvers and creatures of factions
// allied to yours (your wisp, a rim warden). Cost is paid once; every recipient
// gets the full caster-baked effect. Resolution and per-ally healer-aggro live
// in state.castRoomBeneficial; this gathers the side and narrates.
function castSupportAll(state, player, spell, ctx) {
  const events = [];
  const friends = state._friendliesInRoom(player.location, "player").filter((f) => f.id !== player.id);
  const targets = [
    { kind: "player", actor: player, id: player.id, name: "yourself", isSelf: true },
    ...friends,
  ];
  const results = state.castRoomBeneficial(player, spell, targets, events);
  const verb = spell.name.toLowerCase();

  announce(ctx, player, `${player.name} weaves ${verb} wide over everyone beside them, and a soft light settles across the room.`);
  // Forward each ally delver's take-hold (confirmation + a prompt vitals
  // refresh); the caster and allied creatures are narrated right here instead.
  for (const ev of events) if (ev.type === "effect-applied" && ev.playerId !== player.id) ctx.emit(ev);

  const res = results[0].res; // caster-baked, so every recipient's numbers match
  const over = friends.length ? `yourself and ${joinList(friends.map((f) => f.name))}` : "yourself";
  let clause;
  if (res.effect === "restore") {
    const hp = results.reduce((s, r) => s + (r.res.restored.hp || 0), 0);
    const mana = results.reduce((s, r) => s + (r.res.restored.mana || 0), 0);
    const parts = [];
    if (hp) parts.push(`${hp} health`);
    if (mana) parts.push(`${mana} mana`);
    clause = parts.length ? `restoring ${parts.join(" and ")} in all` : "but nothing was wanting";
  } else if (res.effect === "protect") {
    const parts = [];
    if (res.armour) parts.push(`+${res.armour} armour`);
    if (res.ward) parts.push(`+${res.ward} spellward`);
    if (res.voidWard) parts.push(`+${res.voidWard} voidward`);
    if (res.light) parts.push(`${res.light} light`);
    clause = `a lattice of hardened light grants each ${parts.length ? parts.join(", ") : "a faint sheen"} for ${fmtTicks(res.duration)}`;
  } else if (res.effect === "cleanse") {
    const removed = results.reduce((s, r) => s + r.res.removed, 0);
    clause = removed > 0
      ? `${removed} clinging affliction${removed === 1 ? "" : "s"} burn${removed === 1 ? "s" : ""} away`
      : "but nothing clings to burn away";
  } else if (res.effect === "emit-light") {
    clause = `motes of light kindle overhead, shedding ${res.perPulse} light each for ${fmtTicks(res.duration)}`;
  } else {
    clause = `${res.perPulse} HP will knit into each every ${res.interval} tick${res.interval === 1 ? "" : "s"}`;
  }
  return selfAndViews(state, player, `You weave ${spell.name} over ${over}; ${clause}.`);
}

// Cast a summon spell. Resolution (mana, recast-replace, conjuring) lives in
// state.castSummon; this narrates. The summon is self-centred — it appears in the
// caster's room and fights autonomously via the faction AI.
function castSummon(state, player, spell, ctx) {
  const w = state.world;
  const events = [];
  const res = state.castSummon(player, spell, events);
  // The conjuring (and a replacement made here) is narrated below; forward only
  // a recast dismissal in ANOTHER room, so onlookers there see the old summon
  // unravel and get their room view refreshed. (The `summon` event itself is
  // never forwarded — the dispatcher expects player summons narrated here.)
  for (const ev of events) if (ev.type === "summon-end" && ev.roomId !== player.location) ctx.emit(ev);
  const name = res.mob.name;
  const bare = name.replace(/^an? /i, ""); // "a Wisp" -> "Wisp" for the possessive clause
  // A construct built from a material component (Glimmer Husk) is forged, not conjured.
  const comp = (spell.itemCost || [])[0];
  const compName = comp && w.items[comp.template] ? w.items[comp.template].name.replace(/^an? /i, "") : null;
  if (compName) {
    announce(ctx, player, `${player.name} sets a ${compName} down and works glimmer into it until it shudders and stands: ${name}.`);
    const replaced = res.replaced ? ` Your previous ${bare} slumps into dead shell.` : "";
    return selfAndViews(state, player, `You bind raw glimmer into the ${compName}, and ${name} grinds upright to stand watch.${replaced}`);
  }
  announce(ctx, player, `${player.name} traces a binding-glyph, and ${name} coalesces from the gloom.`);
  const replaced = res.replaced ? ` Your previous ${bare} unravels into motes.` : "";
  return selfAndViews(state, player, `You weave the glimmer into shape, and ${name} answers your call.${replaced}`);
}

module.exports = { spellList, cast };
