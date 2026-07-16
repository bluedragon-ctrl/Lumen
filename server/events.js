"use strict";
// Event rendering — turn engine events (tick loop + commands) into client
// messages. The sibling of render.js: that file builds the idempotent room/
// vitals VIEWS, this one narrates the moment-to-moment EVENTS. index.js calls
// `createDispatcher` once at startup with its transport helpers (send, room
// broadcast, dirty-view marks); the returned `dispatchEvent` is the single
// entry point for every event the engine emits.
const quests = require("./quests");
const { buildExamineView } = require("./render");
const { canSee } = require("./light");
const { mobVisibleTo } = require("./perception");

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
// A damage-type tag for combat lines. Physical is the unspoken default, so only a
// non-physical blow is flagged (" (magical)") — that's the type a delver can't
// otherwise tell apart from a normal hit, so it's the one worth naming.
const dmgTag = (ev) => (ev.damageType && ev.damageType !== "physical" ? ` (${ev.damageType})` : "");
// Can this player make out the mob — room bright enough for them, or it's self-lit?
const canSeeMob = (player, light, emitsLight) => !!emitsLight || canSee(player.perception, light);

// Light-gated name of an event's mob from one observer's point of view.
const mobNameFor = (o, ev) => (canSeeMob(o, ev.light, ev.emitsLight) ? ev.mobName : "something");

// Constant flavour tables, hoisted out of the per-event handlers.
const HURT_SRC = {
  light: "the searing light",
  spikes: "the spines",
  venom: "venom",
  bleed: "your wounds",
  darkness: "the creeping dark",
  heat: "the searing heat",
};
const MOB_HURT_FLAVOUR = {
  light: (n, d) => `${cap(n)} recoils, seared by the light. (-${d})`,
  bleed: (n, d) => `${cap(n)} bleeds. (-${d})`,
  venom: (n, d) => `${cap(n)} shudders as the venom bites. (-${d})`,
  spikes: (n, d) => `The spines bite back at ${n} for ${d}. (-${d})`,
};
const MOB_EFFECT_EXPIRED_FLAVOUR = {
  venom: (n) => `The venom drains from ${n}.`,
  bleed: (n) => `${cap(n)}'s wounds close.`,
};
// Both the room line and the killer's slay line are keyed by the kill's cause.
const MOB_DEATH_VERB = {
  light: { room: "shrivels and dies in the light", slay: "The light destroys" },
  bleed: { room: "bleeds out and dies", slay: "Your wounds finish off" },
  venom: { room: "succumbs to the venom and dies", slay: "Your venom finishes off" },
  spikes: { room: "is impaled on its own spines and dies", slay: "Your thorns finish off" },
};

// Build the event dispatcher over index.js's live state and transport helpers.
// Small helpers first, shared by the handlers below. Together they absorb the
// patterns that recur across nearly every event: the light-gated mob name, the
// "get the live player or bail" guard, the room + vitals view refresh, and the
// "narrate one line to everyone in the room" broadcast.
function createDispatcher({
  state,
  world,
  roomCtx,
  sendToPlayer,
  sendRawToPlayer,
  broadcastTide,
  markRoomView,
  markPlayerView,
  markViews,
}) {
  // Run fn with the live player record, or do nothing if they've already gone.
  function withPlayer(id, fn) {
    const p = state.players.get(id);
    if (p) fn(p);
  }

  // Mark the room + vitals panels of one player dirty (flushed once per burst).
  function refreshViews(p) {
    markViews(p.id);
  }

  // Narrate one line to everyone in a room, light-gating the mob's name per
  // observer (`lineFor(name, observer)`), and optionally mark each onlooker's
  // room view dirty. A null/undefined line for an observer sends nothing to them.
  function broadcastRoom(roomId, ev, lineFor, { type = "log", refreshRoom = false } = {}) {
    const frames = new Map(); // text -> serialized frame; light-gating yields only a few distinct lines
    // A hidden mob's ambient narration (emote, targeted reaction, …) must not leak
    // to a delver who hasn't found it — a stray emote would give the ambush away.
    // Reveal is per-player and ephemeral (search, or an ambush strike; see
    // GameState.revealedMobs), so gate per observer: those who've revealed it still
    // read the line, the unaware get nothing. Non-hidden mobs are unaffected. If the
    // actor has already left the room (e.g. a slink-out event), the lookup misses and
    // we fall back to the plain light-gated broadcast.
    const rt = state.rooms[roomId];
    const actor = ev.mobId != null && rt ? rt.mobs.find((x) => x.id === ev.mobId) : null;
    const gateHidden = !!(actor && actor.hidden);
    for (const o of state.playersIn(roomId)) {
      if (gateHidden && !mobVisibleTo(state, o, actor)) {
        if (refreshRoom) markRoomView(o.id);
        continue;
      }
      const text = lineFor(mobNameFor(o, ev), o);
      if (text != null) {
        let data = frames.get(text);
        if (data === undefined) { data = JSON.stringify({ type, text }); frames.set(text, data); }
        sendRawToPlayer(o.id, data);
      }
      if (refreshRoom) markRoomView(o.id);
    }
  }

  // A mob died: narrate to the room, reward the killer, then share XP / level-ups /
  // quest progress with every participant (Model A — full value to all).
  function handleMobDeath(ev) {
    const lootTxt = ev.loot.length ? ` It leaves behind ${ev.loot.join(", ")}.` : "";
    const verbs = MOB_DEATH_VERB[ev.cause];
    const deathVerb = verbs ? verbs.room : "dies";
    roomCtx.toRoom(ev.roomId, { type: "combat", text: `${ev.victimName} ${deathVerb}.${lootTxt}` }, ev.killerId);
    withPlayer(ev.killerId, (killer) => {
      const slayVerb = verbs ? verbs.slay : "You slay";
      sendToPlayer(ev.killerId, { type: "combat", text: `${slayVerb} ${ev.victimName}!${ev.xp ? ` (+${ev.xp} xp)` : ""}${lootTxt}` });
      markRoomView(ev.killerId);
    });
    // The finisher already saw their xp in the slay line; co-fighters get an assist
    // note. A kill may push anyone over a level threshold — hail them and the room.
    for (const a of ev.participants || []) {
      const pl = state.players.get(a.playerId);
      if (!pl) continue;
      if (a.playerId !== ev.killerId && ev.xp) sendToPlayer(a.playerId, { type: "combat", text: `You help bring down ${ev.victimName}. (+${ev.xp} xp)` });
      for (const up of a.levelUps || []) {
        sendToPlayer(a.playerId, { type: "gold", text: `You reach level ${up.level}! (+${up.points} attribute points — spend with "train")` });
        roomCtx.toRoom(ev.roomId, { type: "gold", text: `${pl.name} reaches level ${up.level}!` }, a.playerId);
      }
      // Quest progress for this kill (melee / DoT path). A spell or bomb kill is
      // credited inline in commands.js instead, so a kill never counts twice.
      for (const m of quests.noteKill(state, pl, ev.victimTemplate)) sendToPlayer(a.playerId, m);
      markPlayerView(a.playerId);
    }
    roomCtx.refreshRoom(ev.roomId, ev.killerId);
  }

  // Death phase 2 — the wake. _wakeAtRim has relocated them; tell them where they are.
  function handlePlayerDeath(ev) {
    sendToPlayer(ev.victimId, { type: "system", text: "You wake at the rim, whole again but in the dark. A light source would help — `equip` one." });
    withPlayer(ev.victimId, refreshViews);
    roomCtx.refreshRoom(ev.roomId, ev.victimId); // the body is gone from the death room
    roomCtx.refreshRoom(ev.respawnRoom, ev.victimId);
  }

  // One handler per event type. Each is invoked with the raw event; the dispatcher
  // below looks it up in O(1). Unknown types are silently ignored, as before.
  const EVENT_HANDLERS = {
    "light-out": (ev) => withPlayer(ev.playerId, (player) => {
      const itemName = world.items[ev.item].name;
      const text = ev.consumed
        ? `${itemName} gutters out, burns to ash, and crumbles away. Darkness closes in.`
        : `${itemName} gutters out. Darkness closes in.`;
      sendToPlayer(ev.playerId, { type: "log", text });
      refreshViews(player);
    }),

    "vitals": (ev) => markPlayerView(ev.playerId),

    "regen-tick": (ev) => {
      // A heal-over-time pulse mended a player — climb the bar and note the gain.
      sendToPlayer(ev.playerId, { type: "log", text: `${ev.name} knits your wounds. (+${ev.amount})` });
      markPlayerView(ev.playerId);
    },

    "mob-regen": (ev) =>
      // A heal-over-time pulse mended a mob (e.g. a regenerating troll) — onlookers
      // see its wounds close; refresh the room so its HP bar climbs.
      broadcastRoom(ev.roomId, ev, (n) => `${cap(n)}'s wounds close over. (+${ev.amount})`, { refreshRoom: true }),

    "effect-expired": (ev) => withPlayer(ev.playerId, (player) => {
      const msg = ev.effectType === "emit-light" ? "The light beneath your skin fades."
        : ev.effectType === "immobilize" ? "The grip on you slackens — you can move again."
        : ev.effectType === "slow" ? "The drag lifts from your limbs — you move freely again."
        : `Your ${ev.name} fades.`;
      sendToPlayer(ev.playerId, { type: "log", text: msg });
      refreshViews(player);
      // Others in the room may notice a glow going out / the room dimming.
      roomCtx.refreshRoom(player.location, ev.playerId);
    }),

    "effect-applied": (ev) => withPlayer(ev.playerId, (player) => {
      // A trigger (e.g. a venomous bite) just landed a status effect on a player.
      const text = ev.effectType === "immobilize"
        ? "Thorned coils clamp around you — you're held fast and can't leave!"
        : ev.effectType === "slow"
        ? "Coils lash tight around your limbs — every movement drags."
        : `The ${ev.name} takes hold.`;
      sendToPlayer(ev.playerId, { type: "log", text });
      markPlayerView(ev.playerId);
    }),

    "room-effect": (ev) => withPlayer(ev.playerId, (player) => {
      // A room acted on a player (douse / regen / drain). Show the flavour line and
      // refresh their views; if the room dimmed (a douse), refresh it for others too.
      if (ev.text) sendToPlayer(ev.playerId, { type: "log", text: ev.text });
      refreshViews(player);
      if (ev.dimsRoom) roomCtx.refreshRoom(player.location, ev.playerId);
    }),

    "room-effect-room": (ev) => {
      // The bystander side of a room effect: an optional line to the others present,
      // plus a room refresh when the effect dimmed the room.
      if (ev.text) roomCtx.toRoom(ev.roomId, { type: "log", text: ev.text }, ev.exceptId);
      if (ev.dimsRoom) roomCtx.refreshRoom(ev.roomId, ev.exceptId);
    },

    "trigger-restore": (ev) => withPlayer(ev.playerId, (player) => {
      // A defender-side onDamage `restore` (e.g. armour that draws mana off a blow).
      const parts = [];
      if (ev.hp) parts.push(`${ev.hp} health`);
      if (ev.mana) parts.push(`${ev.mana} mana`);
      if (parts.length) {
        sendToPlayer(ev.playerId, { type: "log", text: `The blow feeds you ${parts.join(" and ")}.` });
        markPlayerView(ev.playerId);
      }
    }),

    "mob-effect-applied": (ev) => {
      // A player's on-hit effect (e.g. a venom-coated weapon, a slowing lash) took hold on a mob.
      const line = ev.effectType === "slow"
        ? (n) => `Coils lash tight around ${n} — its movements drag and slow.`
        : (n) => `The ${ev.name} takes hold of ${n}.`;
      broadcastRoom(ev.roomId, ev, line);
    },

    "mob-effect-expired": (ev) => {
      // A status effect (venom/bleed/glow/slow) wore off a mob — mirror of player effect-expired.
      const line = ev.effectType === "emit-light"
        ? (n) => `The glow fades from ${n}.`
        : ev.effectType === "slow"
        ? (n) => `${cap(n)} shakes off the drag and quickens again.`
        : (MOB_EFFECT_EXPIRED_FLAVOUR[ev.name] || ((n) => `The ${ev.name} fades from ${n}.`));
      broadcastRoom(ev.roomId, ev, line);
    },

    "attack": (ev) => {
      if (ev.by === "player") {
        // The attacker targeted it, so they always know what it is.
        const verb = ev.hit
          ? `hit ${ev.targetName} for ${ev.damage}${dmgTag(ev)}`
          : ev.sighted
            ? `swing at ${ev.targetName} and miss`
            : `flail at ${ev.targetName} in the dark and miss`;
        sendToPlayer(ev.attackerId, { type: "combat", text: `You ${verb}.${ev.crit ? " A critical hit!" : ""}` });
        // Bystanders only learn the mob's name if they can see it.
        for (const o of state.playersIn(ev.roomId)) {
          if (o.id === ev.attackerId) continue;
          const tn = canSeeMob(o, ev.light, ev.targetEmitsLight) ? ev.targetName : "something";
          sendToPlayer(o.id, { type: "combat", text: `${ev.attackerName} ${ev.hit ? "strikes" : "lunges at"} ${tn}.` });
        }
        const attacker = state.players.get(ev.attackerId);
        if (attacker && ev.targetHp > 0) {
          const view = buildExamineView(state, attacker, ev.targetId);
          if (view) sendToPlayer(ev.attackerId, view);
        }
      } else if (ev.targetKind === "mob") {
        // Mob-vs-mob (an enemy and an allied creature trading blows). No player is
        // the attacker or target, so there is no private view to push — just narrate
        // to onlookers, light-gating both creatures' names. HP shows on `examine`;
        // the eventual death event refreshes the room.
        for (const o of state.playersIn(ev.roomId)) {
          const an = canSeeMob(o, ev.light, ev.attackerEmitsLight) ? ev.attackerName : "something";
          const tn = canSeeMob(o, ev.light, ev.targetEmitsLight) ? ev.targetName : "something";
          const line = ev.hit
            ? `${cap(an)} strikes ${tn} for ${ev.damage}${dmgTag(ev)}.${ev.crit ? " A critical hit!" : ""}`
            : `${cap(an)} ${ev.sighted ? `swings at ${tn} and misses` : `lunges at ${tn} in the dark and misses`}.`;
          sendToPlayer(o.id, { type: "combat", text: line });
        }
      } else {
        const target = state.players.get(ev.targetId);
        const seen = target && canSeeMob(target, ev.light, ev.attackerEmitsLight);
        const who = seen ? ev.attackerName : "something";
        const youLine = ev.hit
          ? `${cap(who)} hits you for ${ev.damage}${dmgTag(ev)}!${ev.crit ? " A critical hit!" : ""}`
          : seen
            ? `${cap(who)} ${ev.sighted ? "misses you" : "lunges out of the dark and misses"}.`
            : "Something lunges out of the dark and misses.";
        sendToPlayer(ev.targetId, { type: "combat", text: youLine });
        if (target) markPlayerView(ev.targetId);
        for (const o of state.playersIn(ev.roomId)) {
          if (o.id === ev.targetId) continue;
          const an = canSeeMob(o, ev.light, ev.attackerEmitsLight) ? ev.attackerName : "something";
          sendToPlayer(o.id, { type: "combat", text: `${cap(an)} attacks ${ev.targetName}.` });
        }
      }
    },

    "mob-cast": (ev) => {
      // A mob threw a hostile spell at a player (see state._mobCast). The damage/
      // death is already applied; this just narrates and refreshes views.
      if (ev.targetKind === "mob") {
        // Mob-vs-mob spell: narrate to onlookers only, light-gating both names.
        for (const o of state.playersIn(ev.roomId)) {
          const an = mobNameFor(o, ev);
          const tn = canSeeMob(o, ev.light, ev.targetEmitsLight) ? ev.targetName : "something";
          let line;
          if (ev.resisted) line = `${cap(an)} hurls ${ev.spellName} at ${tn}, but its ward turns it aside.`;
          else if (ev.effectName) line = `${cap(an)} casts ${ev.spellName} on ${tn} — the ${ev.effectName} takes hold.`;
          else line = `${cap(an)} blasts ${tn} with ${ev.spellName} for ${ev.damage}.`;
          sendToPlayer(o.id, { type: "combat", text: line });
        }
        return;
      }
      const target = state.players.get(ev.targetId);
      const seen = target && canSeeMob(target, ev.light, ev.emitsLight);
      const who = seen ? ev.mobName : "something";
      let youLine;
      if (ev.resisted) youLine = `${cap(who)} hurls ${ev.spellName} at you, but your ward turns it aside.`;
      else if (ev.doused) youLine = `${cap(who)} reaches out, and your light gutters and dies — the dark rushes in.`;
      else if (ev.manaDrain) youLine = ev.manaDrained > 0
        ? `${cap(who)} settles against you and drinks — the warmth of your will drains away (-${ev.manaDrained} mana).`
        : `${cap(who)} settles against you and drinks, but finds no warmth left to take.`;
      else if (ev.effectName) youLine = `${cap(who)} casts ${ev.spellName} on you — the ${ev.effectName} takes hold.`;
      else youLine = `${cap(who)} blasts you with ${ev.spellName} for ${ev.damage}!`;
      if (ev.drained > 0) youLine += ` Your stolen warmth closes ${seen ? "its" : "their"} wounds.`;
      sendToPlayer(ev.targetId, { type: "combat", text: youLine });
      if (target) markPlayerView(ev.targetId);
      for (const o of state.playersIn(ev.roomId)) {
        if (o.id === ev.targetId) continue;
        const an = mobNameFor(o, ev);
        const line = ev.doused
          ? `${cap(an)} reaches for ${ev.targetName} and snuffs their light.`
          : ev.manaDrain
          ? `${cap(an)} settles against ${ev.targetName} and drinks.`
          : `${cap(an)} hurls ${ev.spellName} at ${ev.targetName}.`;
        sendToPlayer(o.id, { type: "combat", text: line });
      }
    },

    "mob-cast-self": (ev) => {
      // A mob wove a beneficial spell over itself (e.g. Yana's Glimmerskin), or — when
      // `darkened` — drank the room's light into a darkness aura. The effect is already
      // applied; narrate to everyone present, light-gating the name, and on a darkening
      // refresh each onlooker's view so the room visibly goes black.
      for (const o of state.playersIn(ev.roomId)) {
        const an = mobNameFor(o, ev);
        const line = ev.darkened
          ? `${cap(an)} swells, and the light is drawn out of the air — the dark closes over everything.`
          : `${cap(an)} draws ${ev.spellName} about itself.`;
        sendToPlayer(o.id, { type: "combat", text: line });
        if (ev.darkened) markPlayerView(o.id);
      }
    },

    "mob-cast-room": (ev) =>
      // A mob wove a room-wide support spell over its whole side (see
      // state._mobCastRoomSupport). One line for the beat; each mended delver
      // also got a personal take-hold via its own effect-applied event.
      broadcastRoom(ev.roomId, ev, (n) => `${cap(n)} weaves ${ev.spellName.toLowerCase()} wide over its own, and a soft light settles across them.`, { type: "combat", refreshRoom: true }),

    "combat-stop": (ev) => sendToPlayer(ev.playerId, { type: "log", text: ev.reason }),

    "tide-phase": (ev) => {
      // The world clock turned. Announce it to every connected delver and refresh
      // each view — the world has darkened (or lifted) under everyone at once, so
      // even an idle player watches their room change. Mob spawn/flee events from
      // the same transition narrate the predators per-room on their own.
      const text = state.tide.phaseMessages[ev.phase];
      for (const p of state.players.values()) {
        if (text) sendToPlayer(p.id, { type: "system", text });
        markViews(p.id);
      }
      broadcastTide(); // refresh the HUD indicator the instant the phase turns
    },

    "tide-lamp": (ev) => {
      // NPCs lit (or snuffed) this room's lamps as the Tide turned. Narrate to
      // anyone present; the room refresh rides the tide-phase view sweep above.
      const lamp = state.tide.lamp || {};
      const text = ev.on ? lamp.onMessage : lamp.offMessage;
      if (text) roomCtx.toRoom(ev.roomId, { type: "log", text });
    },

    "tide-emote": (ev) =>
      // The Tide itself performs an ambient atmospheric line in a room (see
      // state._tideEmoteTick). Felt, not seen — sent to everyone present.
      roomCtx.toRoom(ev.roomId, { type: "log", text: ev.text }),

    "aggro-engage": (ev) => {
      // A mob committed to attack (see state._engageTell): either it proactively
      // noticed a delver, or — `remembered` — a `remembers` mob recognised a foe it
      // bears a grudge against stepping back in. One tell at the moment of engagement,
      // light-gated like other mob lines; `rose` when a seated creature stood to do it.
      const target = state.players.get(ev.targetId);
      const seen = target && canSeeMob(target, ev.light, ev.emitsLight);
      const who = seen ? ev.mobName : "something";
      let youLine;
      if (ev.remembered) {
        youLine = seen
          ? `${cap(who)} ${ev.rose ? "stirs — it remembers you" : "remembers you"}, and its old hate rekindles.`
          : "Something in the dark remembers you, and stirs with old hate.";
      } else {
        youLine = seen
          ? `${cap(who)} ${ev.rose ? "stirs, its gaze locking" : "fixes its gaze"} onto you.`
          : "Something stirs in the dark, fixing on you.";
      }
      sendToPlayer(ev.targetId, { type: "combat", text: youLine });
      for (const o of state.playersIn(ev.roomId)) {
        if (o.id === ev.targetId) continue;
        const n = mobNameFor(o, ev);
        const otherLine = ev.remembered
          ? `${cap(n)} ${ev.rose ? "stirs, remembering" : "remembers"} ${ev.targetName}.`
          : `${cap(n)} ${ev.rose ? "stirs and fixes" : "fixes"} its gaze on ${ev.targetName}.`;
        sendToPlayer(o.id, { type: "combat", text: otherLine });
      }
    },

    "mob-ambush": (ev) => {
      // A hidden ambusher burst from concealment onto a (sleeping) delver — see
      // state._mobAttack. Pushed just before the strike, so this appearance line
      // reads first, then the attack/wake lines follow. Light-gated like other mobs.
      const target = state.players.get(ev.targetId);
      const seen = target && canSeeMob(target, ev.light, ev.emitsLight);
      sendToPlayer(ev.targetId, { type: "combat", text: seen
        ? `${cap(ev.mobName)} drops from its hiding place onto you!`
        : "Something drops from the dark onto you!" });
      for (const o of state.playersIn(ev.roomId)) {
        if (o.id === ev.targetId) continue;
        const n = mobNameFor(o, ev);
        sendToPlayer(o.id, { type: "combat", text: `${cap(n)} bursts from hiding onto ${ev.targetName}!` });
      }
    },

    "mob-assist": (ev) => {
      // A `helper` mob piled into a fight to defend a same-faction ally (see
      // state._assistPass). One heads-up the moment it joins, light-gated.
      const target = ev.targetKind === "player" ? state.players.get(ev.targetId) : null;
      if (target) {
        const seen = canSeeMob(target, ev.light, ev.emitsLight);
        sendToPlayer(ev.targetId, { type: "combat", text: seen
          ? `${cap(ev.mobName)} rushes to join the attack on you!`
          : "Something rushes at you out of the dark!" });
      }
      for (const o of state.playersIn(ev.roomId)) {
        if (target && o.id === ev.targetId) continue;
        const n = mobNameFor(o, ev);
        sendToPlayer(o.id, { type: "combat", text: `${cap(n)} rushes to join the attack on ${ev.targetName}.` });
      }
    },

    "combat-auto-start": (ev) =>
      // Auto-retaliation kicked in (struck, or hit by a hostile spell) — tell the
      // player they've engaged, so the swings on following ticks aren't a mystery.
      sendToPlayer(ev.playerId, { type: "combat", text: `You turn on ${ev.targetName} and fight back!` }),

    "player-woke": (ev) => withPlayer(ev.playerId, (player) => {
      // A blow jolted a resting/sleeping delver to their feet (see state._mobAttack).
      sendToPlayer(ev.playerId, { type: "log", text: "The blow jolts you awake — you scramble to your feet!" });
      refreshViews(player); // sight returns now they're up
    }),

    "mob-woke": (ev) =>
      // A struck dozing creature rouses; everyone who can see it learns it's awake.
      broadcastRoom(ev.roomId, ev, (n) => `${cap(n)} wakes, roused by the attack!`, { refreshRoom: true }),

    "mob-emote": (ev) => broadcastRoom(ev.roomId, ev, (n) => `${cap(n)} ${ev.text}.`),

    "mob-react": (ev) => {
      // An NPC singled out one player (the `react` action): the target reads the
      // second-person line, bystanders the third-person one, both light-gated.
      // Reaction lines may carry their own punctuation (quoted speech), so the
      // closing period is only added when missing — unlike bare emote fragments.
      const punct = (s) => (/["!?.]$/.test(s) ? s : `${s}.`);
      broadcastRoom(ev.roomId, ev, (n, o) => o.id === ev.targetId
        ? punct(`${cap(n)} ${ev.textTarget}`)
        : punct(`${cap(n)} ${ev.textRoom.replace(/\{name\}/g, ev.targetName)}`));
    },

    "mob-move": (ev) => {
      for (const o of state.playersIn(ev.from)) {
        const n = canSeeMob(o, ev.lightFrom, ev.emitsLight) ? ev.mobName : "something";
        sendToPlayer(o.id, { type: "log", text: `${cap(n)} ${ev.verb}.` });
        markRoomView(o.id);
      }
      for (const o of state.playersIn(ev.to)) {
        const n = canSeeMob(o, ev.lightTo, ev.emitsLight) ? ev.mobName : "something";
        sendToPlayer(o.id, { type: "log", text: `${cap(n)} slinks in.` });
        markRoomView(o.id);
      }
    },

    "summon": (ev) =>
      // A creature was conjured into the room (player Summon spell or a mob's
      // reinforcement action). A mob summoner narrates its `verb`; a player summon
      // is narrated by the cast command, so the tick path here is mainly for mobs.
      broadcastRoom(ev.roomId, ev, (n) => (ev.verb && ev.byName
        ? `${cap(ev.byName)} ${ev.verb}.`
        : `${cap(n)} coalesces from the gloom.`), { refreshRoom: true }),

    "summon-end": (ev) =>
      // A summon unravelled (timer expired, recast, or owner gone) — no corpse/loot.
      broadcastRoom(ev.roomId, ev, (n) => `${cap(n)} unravels into motes and is gone.`, { refreshRoom: true }),

    "mob-flee": (ev) =>
      // A skittish critter slipped out of sight (no corpse/loot) — narrate the
      // vanish to onlookers and refresh the room so the count updates.
      broadcastRoom(ev.roomId, ev, (n) => `${cap(n)} ${ev.verb}.`, { refreshRoom: true }),

    "mob-spawn": (ev) => {
      // A creature's arrival flavour is its own (mobs.json `spawnMessage`, with
      // `{name}`/`{Name}` for the light-gated name), reused by every spawn path
      // (respawn, Tide creep, onset roster). Without one, a generic line — the
      // name light-gated so an unseen arrival reads as "something".
      const tpl = (ev.mobTemplate && world.mobs[ev.mobTemplate]) || {};
      const custom = tpl.spawnMessage;
      broadcastRoom(ev.roomId, ev, (n) => (custom
        ? custom.replace(/\{name\}/g, n).replace(/\{Name\}/g, cap(n))
        : n === "something"
        ? "Something stirs in the dark."
        : `${cap(ev.mobName)} appears.`), { refreshRoom: true });
    },

    "item-regrow": (ev) => {
      for (const o of state.playersIn(ev.roomId)) {
        if (canSee(o.perception, state.rooms[ev.roomId].light)) {
          sendToPlayer(o.id, { type: "log", text: `${cap(ev.itemName)} has grown here.` });
          markRoomView(o.id);
        }
      }
    },

    "vein-recover": (ev) => {
      const text = ev.kind === "fish"
        ? `The water stirs — the fish are biting at ${ev.fixtureName} again.`
        : ev.kind === "growth"
        ? `Fresh caps have grown back across ${ev.fixtureName}.`
        : `${cap(ev.fixtureName)} has fresh ore to work again.`;
      for (const o of state.playersIn(ev.roomId)) {
        if (canSee(o.perception, state.rooms[ev.roomId].light)) {
          sendToPlayer(o.id, { type: "log", text });
        }
      }
    },

    "mob-hurt": (ev) => {
      const line = MOB_HURT_FLAVOUR[ev.cause] || ((n, d) => `${cap(n)} is hurt. (-${d})`);
      broadcastRoom(ev.roomId, ev, (n) => line(n, ev.damage));
    },

    "player-hurt": (ev) => {
      const src = HURT_SRC[ev.cause] || ev.cause || "an unseen hurt";
      sendToPlayer(ev.playerId, { type: "log", text: `You take ${ev.damage} damage from ${src}.` });
      markPlayerView(ev.playerId);
    },

    "death": (ev) => {
      if (ev.victimKind === "mob") handleMobDeath(ev);
      else if (ev.victimKind === "player") handlePlayerDeath(ev);
    },

    // Death phase 1 — the fall. The delver drops where they died and lies dying for a
    // few ticks (see _beginDeath/_dyingTick). A loud, coloured beat so it registers.
    "death-begin": (ev) => {
      if (ev.victimKind !== "player") return;
      sendToPlayer(ev.victimId, { type: "combat", text: "<#red>The dark closes over you. You are dying…<#reset>" });
      markPlayerView(ev.victimId); // HP bar to zero
      roomCtx.toRoom(ev.roomId, { type: "combat", text: `${ev.victimName} falls.` }, ev.victimId);
    },

    // The dying countdown — one line per tick while the dark draws in.
    "dying": (ev) =>
      sendToPlayer(ev.victimId, { type: "combat", text: `<#red>The dark presses closer… (${ev.remaining})<#reset>` }),
  };

  return function dispatchEvent(ev) {
    const handler = EVENT_HANDLERS[ev.type];
    if (handler) handler(ev);
  };
}

module.exports = { createDispatcher };
