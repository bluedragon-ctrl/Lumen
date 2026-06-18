"use strict";
// Mob AI subsystem — the biggest cohesive cluster of the game engine, split out
// of state.js (see PR refactor/split-gamestate-class). Mob decision-making
// (`resolveMobAI`/`_mobAct`), faction targeting, the threat/detection/grudge
// model, cross-room pursuit + BFS pathing, and the mob-side combat actions
// (attack/cast/summon/move) and kill resolution.
//
// These are GameState methods, factored into a mixin: the class below is never
// instantiated — state.js copies its prototype methods onto GameState.prototype
// (see `mixin()` there), so every `this` here is a GameState and `this._foo()`
// reaches methods that live in state.js or the other mixins. Pure relocation —
// no behaviour change.
const { rollDice } = require("./dice");
const { DEFAULT_FACTION } = require("./config");
const { canSee, noticeChance } = require("./light");
const {
  playerDefence, mobDefence, spellScaleBonus, scaledAmount, wardNegates,
  pickWeighted, strike, mobOnDamage, playerOnDamage,
} = require("./combat-math");
const { factionRelation, combatantFaction } = require("./factions");
const { makeItemInstance, addToFloor } = require("./instances");
const { canPerceive, mobVisibleTo } = require("./perception");

// Global damper on ambient `emote` frequency: each emote action's authored
// weight is scaled by this before the per-tick action roll, thinning idle
// chatter without touching every template. Reacts are deliberately exempt —
// they already carry a per-player cooldown and can deliver quest nudges.
const EMOTE_WEIGHT_SCALE = 0.5;
// Aggro detection (see _detectAndDecay): a proactive hunter accrues a
// decaying "notice" meter on each enemy it can perceive, at AGGRO_RATE × the
// light-tier noticeChance per action, capped at AGGRO_ENGAGE; once a target's
// detection reaches AGGRO_ENGAGE the mob engages (clear sight ≈ ENGAGE/RATE
// actions, impaired ≈ 2×, dark never). A target it can no longer perceive for
// AGGRO_GRACE actions decays by AGGRO_RATE/action until forgotten.
const AGGRO_RATE = 1; // detection gained per action at clear sight
const AGGRO_ENGAGE = 2; // detection threshold at which a mob commits to attack
const AGGRO_GRACE = 3; // actions a target stays unperceived before detection decays
// Mob memory (see _pruneAggro / _restoreGrudges): a `remembers` mob does
// not forgive combat threat the way it forgets detection. When a player it has
// traded blows with LEAVES the room, that threat is parked in `mob.grudge` rather
// than dropped; if they return within GRUDGE_TICKS the old ire is restored and the
// mob re-engages on sight. A grudge does NOT keep the mob "alerted" (see _alerted):
// between leaving and returning it wanders and mends as normal — it just won't
// forget the face. The grudge lapses on a timer, or the instant the player dies or
// logs out (a clean slate either way).
const GRUDGE_TICKS = 60; // ticks (~1 min at TICK_MS=1000) a remembered foe is held before forgiven
// Cross-room pursuit (see _pursue): a `pursues` mob with a parked grudge
// against a player who fled goes after them — BFS one room per action toward the
// quarry's current room (DikuMUD `hunt_victim`). The chase is leashed by distance
// from the mob's spawn room (`m.origin.roomId`): it never steps into a room more
// than `pursueRange` rooms (BFS depth) from home. When the grudge is gone (quarry
// dead, logged out, lapsed, or driven past the leash) a stray pursuer heads home —
// for v1, a quiet relocate to its spawn room the moment no one is watching it leave.
const PURSUE_RANGE = 4; // default rooms-from-spawn leash when a `pursues` mob sets no `pursueRange`

// Mixin carrier — see file header. Methods are copied onto GameState.prototype.
class MobAIMixin {
  /** Each mob takes at most one weighted action per tick (attack/emote/flee/idle).
   *  Each `_mobAct` pass freshly prunes that mob's threat/detection tables (drops
   *  combatants who left), so `_recoverMobsTick` MUST run after this in the tick —
   *  it reads the just-pruned `_alerted` state to decide who may mend. */
  resolveMobAI(events) {
    for (const [roomId, rt] of Object.entries(this.rooms)) {
      for (const m of [...rt.mobs]) {
        if (m.hp <= 0) continue; // slain earlier this tick (e.g. mob-vs-mob) but still in the snapshot
        this._decayGrudges(m); // a remembered foe is forgiven on a timer — even while the mob sleeps or rests
        if (m.posture === "sleeping") continue; // a sleeping mob perceives nothing — inert until struck (see _rouse)
        // A *sitting* mob is alert-at-rest: it still runs _mobAct to detect enemies
        // and stands as it engages (it just won't wander/emote — see _mobAct).
        const t = this.world.mobs[m.template];
        const cost = (t.attack && t.attack.actionCost) || 12;
        if (m.energy < cost) continue;
        m.energy -= cost;
        this._mobAct(m, t, roomId, events);
      }
    }
  }

  _mobAct(m, t, roomId, events) {
    const rt = this.rooms[roomId];
    const self = { id: m.id, actor: m, kind: "mob", faction: combatantFaction(m, "mob") };
    // Enemies = opposing-faction combatants present (players + opposing mobs).
    let enemies = this._enemiesOf(self, roomId);

    // A hidden mob is normally inert toward any DELVER who hasn't searched it out
    // (reveal-on-find): only players who have revealed it perceive — and provoke —
    // it. An *ambush* mob is the exception: it silently tracks the unaware and
    // strikes when they're helpless, revealing itself with the blow (see
    // _mobAttack), so it skips this filter. Mobs sense each other regardless, so
    // the filter only ever touches player enemies.
    if (m.hidden && !t.ambush) {
      enemies = enemies.filter((c) => c.kind !== "player" || mobVisibleTo(this, c.actor, m));
      if (enemies.length === 0) return;
    }

    // Detection: forget combatants who have left, then a *proactive hunter* (a
    // hostile wild mob, or a player-faction ally) builds a decaying notice meter
    // on each enemy it can perceive. A mob it has actually traded blows with (a
    // live combat-threat entry) is engaged outright — being hit bypasses the ramp.
    this._pruneAggro(m, t, enemies);
    // A `remembers` mob that parked a grudge on a player who left re-engages them
    // the instant they step back in — the old ire returns as live combat threat, so
    // it attacks on sight rather than re-earning the notice from scratch.
    this._restoreGrudges(m, t, enemies, roomId, events);
    // A player's summon is a *defensive guard*, not an independent aggressor: it
    // never proactively hunts (even if its template is `hostile`, as a combat
    // summon is). It engages only what it has traded blows with or what its owner
    // is already fighting (the assist pass below). Wild mobs hunt as ever.
    const hunts = !!t.hostile && self.faction !== "player";
    this._detectAndDecay(m, t, enemies, rt.light, hunts, roomId, events);
    // A sitting mob that engaged stood up in _engageTell; one still seated noticed
    // nobody worth rising for this action — stay at rest (no wander/emote).
    if (m.posture === "sitting") return;
    // A `helper` (and every player-summon — it backs its owner) piles into any
    // fight an allied combatant is in, or steps in when an enemy attacks an ally
    // (see _assistPass). This is how a defensive summon joins the master's fight
    // without ever starting one of its own, and how a rim guard defends a delver.
    if (t.helper || self.faction === "player") this._assistPass(m, t, enemies, rt.light, roomId, events);
    const engagedTargets = enemies.filter((c) => this._isEngaged(m, t, c));
    const inCombat = this._alerted(m); // alerted (combat threat or live detection) → won't wander

    // Wander destinations: "zone" scope confines a mob to its current zone (the
    // village stays in the village, the abyss below); "any" lets it cross zones.
    // On top of scope, an action may gate destinations by room `tags`:
    // `requireTags` admits only rooms carrying *all* listed tags (a cave-fish that
    // keeps to "water" rooms), `forbidTags` rejects any room carrying one (a
    // surface beast that won't enter the "deep-dark"). An untagged room satisfies
    // no requirement and trips no prohibition, so an action with neither field
    // roams exactly as before — tags only ever constrain mobs that ask for them.
    const exits = this.world.rooms[roomId].exits || {};
    const allDirs = Object.keys(exits);
    const roamDirs = this._zoneExits(roomId);
    const tagOk = (dir, a) => {
      const dest = this.world.rooms[exits[dir]];
      if (!dest) return false;
      const tags = dest.tags || [];
      if (a.requireTags && !a.requireTags.every((g) => tags.includes(g))) return false;
      if (a.forbidTags && a.forbidTags.some((g) => tags.includes(g))) return false;
      return true;
    };
    const wanderDirs = (a) => {
      const base = a.scope === "any" ? allDirs : roamDirs;
      return a.requireTags || a.forbidTags ? base.filter((d) => tagOk(d, a)) : base;
    };

    // Skittish prey (grubs, cave-fish): a calm critter that loses its nerve and
    // bolts out of the world entirely — no room-to-room flight, it simply slips
    // out of sight, freeing its spawn slot to repop on the room's timer. It bolts
    // readily once *alarmed* (`chance`) — struck, or spooked by a `helper` ally's
    // fight nearby (see _assistPass); these mobs carry no `attack`, so a cluster
    // that catches the alarm scatters rather than fights, and a delver must be
    // quick to take more than the one they struck. While merely *watched* by a
    // delver it also carries a faint ambient chance (`idle`) to vanish, so a
    // populated bed visibly breathes — a count that drifts under its cap as
    // critters slip away and respawn. Living scenery that won't sit still to farm.
    if (t.skittish) {
      const watched = this.playersIn(roomId).length > 0;
      const p = inCombat ? (t.skittish.chance != null ? t.skittish.chance : 0.4)
              : watched ? (t.skittish.idle || 0) : 0;
      if (p > 0 && Math.random() < p) return this._bolt(m, t, roomId, events, t.skittish.verb);
    }

    // Light-driven flight: a mob with a `flee` action bolts for a random exit the
    // instant the room light rises above its tolerance. This overrides its normal
    // action choice, even combat. With nowhere to run, it stands and acts as usual.
    const flee = (t.actions || []).find((a) => a.type === "flee" && rt.light > (a.lightAbove || 0));
    if (flee) {
      const dirs = wanderDirs(flee);
      if (dirs.length) return this._mobMove(m, t, roomId, events, flee.verb || "flees into the dark", dirs);
    }

    // Cross-room pursuit (DikuMUD `hunt_victim`). With no enemy present here to
    // fight, a `pursues` mob bearing a grudge stalks the fled quarry one room per
    // action toward where they now stand, leashed to `pursueRange` rooms from its
    // spawn (see _pursue). A stray pursuer with nothing left to chase heads home.
    // It only fires when the room is otherwise empty of foes — a present enemy is
    // always dealt with first (detect/engage/attack below), and survival actions
    // (skittish, flee) have already had their say above.
    if (t.pursues && enemies.length === 0 && this._pursue(m, t, roomId, events)) return;

    // A mob attacks if it has *engaged* a present enemy — either a target whose
    // detection meter reached `AGGRO_ENGAGE` (proactively noticed it; clear sight
    // commits in ~AGGRO_ENGAGE actions, impaired ~2×, dark never), or one it has
    // traded blows with (a live combat-threat entry → engaged outright, so being
    // hit always provokes, in any light) — OR if the room light has risen past its
    // `lightAggro` tolerance (a calm creature roused by light — the inverse of
    // `flee`; it lashes at anyone present). Shopkeepers et al. carry no `attack`
    // block, so they stay passive even if hit. Note: above `flee`'s threshold,
    // flight wins (it returned earlier); lightAggro bites between calm and flight.
    const lightProvoked = t.lightAggro && rt.light > (t.lightAggro.above || 0);
    const aggressive = engagedTargets.length > 0 || lightProvoked;
    // Whom to swing at. Light-rage is indiscriminate — it lashes at *anyone*
    // present, so every enemy is a candidate even if the mob already has one
    // engaged (otherwise a single noticed target would shield the rest from a
    // light-maddened creature). Normally a mob swings only at what it has
    // committed to, falling back to anyone present (the light-rage-with-no-threat
    // case). _topThreat still focuses whatever it has actually traded blows with.
    const candidates = lightProvoked ? enemies : (engagedTargets.length ? engagedTargets : enemies);

    let options;
    if (Array.isArray(t.actions) && t.actions.length) {
      options = t.actions.filter((a) => {
        if (a.type === "attack") return aggressive && t.attack && candidates.length > 0;
        if (a.type === "cast") {
          const sp = a.spell && this.world.spells[a.spell];
          if (!aggressive || !sp || !candidates.length) return false;
          // A beneficial self-buff (e.g. Glimmerskin) is only worth a turn if it
          // isn't already crusting the mob — otherwise it would recast forever.
          if (!sp.hostile) return !this._mobHasState(m, (sp.effect && sp.effect.name) || sp.effect && sp.effect.type);
          return true;
        }
        if (a.type === "summon") return aggressive && a.mob && this.world.mobs[a.mob] && candidates.length > 0 && this._broodCount(m.id) < (a.max != null ? a.max : Infinity);
        if (a.type === "wander") return !inCombat && wanderDirs(a).length > 0;
        if (a.type === "react") return Array.isArray(a.reactions) && a.reactions.length > 0 && this.playersIn(roomId).length > 0;
        if (a.type === "emote") return Array.isArray(a.messages) && a.messages.length > 0;
        return a.type === "idle";
      });
      // Thin ambient emotes globally (clone so we never mutate the template).
      options = options.map((a) =>
        a.type === "emote" ? { ...a, weight: (a.weight || 1) * EMOTE_WEIGHT_SCALE } : a
      );
    } else {
      // Default behaviour for mobs without an actions table: attack if able.
      options = aggressive && t.attack && candidates.length ? [{ type: "attack" }] : [];
    }

    const choice = pickWeighted(options);
    if (!choice || choice.type === "idle") return;
    if (choice.type === "attack") return this._mobAttack(m, t, roomId, events, candidates);
    if (choice.type === "cast") return this._mobCast(m, t, roomId, events, candidates, choice.spell);
    if (choice.type === "summon") return this._mobSummon(m, t, roomId, events, choice);
    if (choice.type === "react") return this._mobReact(m, t, roomId, choice, events);
    if (choice.type === "emote") {
      const text = choice.messages[Math.floor(Math.random() * choice.messages.length)];
      events.push({ type: "mob-emote", roomId, mobId: m.id, mobName: t.name, emitsLight: !!t.emitsLight, light: rt.light, text });
      return;
    }
    if (choice.type === "wander") return this._mobMove(m, t, roomId, events, choice.verb || "wanders off", wanderDirs(choice));
  }

  // --- Targeted NPC reactions (the `react` action) ---------------------------
  // A social mob singles out one player it can see and addresses them directly —
  // a quest-delivery nudge, a comment on their wounds or gear, or plain small
  // talk. Reactions are authored on the template (`reactions`, ordered: first
  // entry with a matching player wins); a per-player cooldown on the instance
  // keeps the NPC from pestering anyone and rotates it between players.

  /** Does `player` match a reaction's `if` conditions? All keys must hold (AND);
   *  no `if` at all is the unconditional small-talk fallback. */
  _reactMatches(player, cond, npcTemplateId) {
    if (!cond) return true;
    // Lazy require: quests.js requires state.js at load time, so a top-level
    // require back would leave one side half-initialised. By call time both are loaded.
    if (cond.delivery && !require("./quests").hasPendingDelivery(this, player, npcTemplateId)) return false;
    if (cond.hpBelow != null && !(player.hp < player.maxHp * cond.hpBelow)) return false;
    if (cond.slotEmpty && player.equipment && player.equipment[cond.slotEmpty]) return false;
    if (cond.equipped && !Object.values(player.equipment || {}).some((i) => i && i.template === cond.equipped)) return false;
    return true;
  }

  /** Resolve one `react` action: pick a visible, off-cooldown player matching the
   *  highest-priority reaction and push a `mob-react` event. Silently degrades to
   *  idle when nobody qualifies. Cooldowns live on the instance (`reactCd`,
   *  playerId -> lapse tick), in-memory only, pruned of absent/expired entries. */
  _mobReact(m, t, roomId, action, events) {
    const rt = this.rooms[roomId];
    if (!canSee(t.perception, rt.light)) return; // too dark for the NPC to make anyone out
    if (!m.reactCd) m.reactCd = {};
    const present = this.playersIn(roomId).filter((p) => p.hp > 0);
    for (const id of Object.keys(m.reactCd))
      if (m.reactCd[id] <= this.tick || !present.some((p) => p.id === id)) delete m.reactCd[id];
    const ready = present.filter((p) => m.reactCd[p.id] == null);
    if (!ready.length) return;
    for (const r of action.reactions || []) {
      const matches = ready.filter((p) => this._reactMatches(p, r.if, m.template));
      if (!matches.length) continue;
      const target = matches[Math.floor(Math.random() * matches.length)];
      const msg = r.messages[Math.floor(Math.random() * r.messages.length)];
      m.reactCd[target.id] = this.tick + (action.cooldown || 120);
      events.push({
        type: "mob-react", roomId, mobId: m.id, mobName: t.name, emitsLight: !!t.emitsLight,
        light: rt.light, targetId: target.id, targetName: target.name,
        textTarget: msg.target, textRoom: msg.room,
      });
      return;
    }
  }

  /** Command-side reaction: the in-character answer when a player TALKS to this
   *  mob — the first reaction matching that player. The cooldown gate is ignored
   *  (a direct address always earns an answer) but still stamped, so the tick
   *  roll doesn't pile on right after. Returns { textTarget, textRoom } or null
   *  (mob has no react action / no reaction matches). */
  reactToPlayer(mob, player) {
    const t = this.world.mobs[mob.template];
    const action = (t.actions || []).find((a) => a.type === "react" && Array.isArray(a.reactions) && a.reactions.length);
    if (!action || player.hp <= 0) return null;
    for (const r of action.reactions) {
      if (!this._reactMatches(player, r.if, mob.template)) continue;
      const msg = r.messages[Math.floor(Math.random() * r.messages.length)];
      if (!mob.reactCd) mob.reactCd = {};
      mob.reactCd[player.id] = this.tick + (action.cooldown || 120);
      return { textTarget: msg.target, textRoom: msg.room };
    }
    return null;
  }

  /** Exit directions whose destination room shares this room's zone (roamable). */
  _zoneExits(roomId) {
    const room = this.world.rooms[roomId];
    const zone = room.zone;
    return Object.entries(room.exits || {})
      .filter(([, dest]) => this.world.rooms[dest] && this.world.rooms[dest].zone === zone)
      .map(([dir]) => dir);
  }

  // --- Combatants & factions ------------------------------------------------
  // A combatant is any living actor that can fight — a player or a mob. Each is
  // described uniformly as { id, actor, kind, faction } so the threat table and
  // the combat loop can treat players and mobs the same. Faction defines sides
  // (differing factions are enemies); `hostile`/provocation still gate whether a
  // creature actually engages (see _mobAct).

  /** Living combatants in a room: every up player plus every up mob, as uniform
   *  { id, actor, kind, faction } descriptors. */
  _combatantsIn(roomId) {
    const out = [];
    for (const p of this.playersIn(roomId)) if (p.hp > 0) out.push({ id: p.id, actor: p, kind: "player", faction: "player" });
    for (const m of this.rooms[roomId].mobs) if (m.hp > 0) out.push({ id: m.id, actor: m, kind: "mob", faction: combatantFaction(m, "mob") });
    return out;
  }

  /** Two combatants are enemies iff their factions differ. */
  _areEnemies(a, b) {
    return factionRelation(a.faction, b.faction) === "enemy";
  }

  /** Living opposing-faction combatants of `self` in `roomId`. For a wild mob this
   *  is players + player-faction (allied) mobs; for a player-faction mob, wild mobs. */
  _enemiesOf(self, roomId) {
    return this._combatantsIn(roomId).filter((c) => c.id !== self.id && this._areEnemies(self, c));
  }

  /** Resolve a combatant to the player who should receive kill credit for its
   *  actions: a player credits itself; a player-faction mob credits its owner (if
   *  that owner is a live player); anything else credits no one. */
  _killerPlayerFor(combatant) {
    if (!combatant) return null;
    if (combatant.kind === "player") return combatant.actor;
    const owner = combatant.actor && combatant.actor.ownerId ? this.players.get(combatant.actor.ownerId) : null;
    return owner && owner.hp > 0 ? owner : null;
  }

  // --- Aggro / threat tables (combatant-keyed) ---------------------------------
  // A mob holds two per-enemy maps, both keyed by any combatant id (a player OR a
  // mob): `aggro` is *combat* threat (from trading blows — drives kill-XP credit
  // and outright engagement), `detect` is the decaying *detection* meter a hunter
  // builds on enemies it can perceive (see _detectAndDecay). A mob is engaged once
  // a target has combat threat or detection ≥ AGGRO_ENGAGE; it stays to fight (won't
  // wander) while alerted, and targets the highest *combined* threat.
  // Later: per-action threat weighting, cross-room pursuit hook here.

  /** Add `amount` combat threat toward a combatant (from trading blows — drives
   *  XP credit and outright engagement). 0 just ensures an entry exists. Detection
   *  (mere noticing) lives in the separate, decaying `mob.detect` map so that being
   *  seen never counts as participation for kill XP. */
  _addThreat(mob, combatantId, amount) {
    if (!mob.aggro) mob.aggro = {};
    mob.aggro[combatantId] = (mob.aggro[combatantId] || 0) + amount;
  }

  /** A combatant is *engaged* by a mob once it has either traded blows (a live
   *  combat-threat entry, any amount → being hit provokes instantly, in any light
   *  or posture) or been noticed up to the detection threshold (`AGGRO_ENGAGE`).
   *  An `ambush` mob holds its proactive (detection-driven) strike until the target
   *  is a *sleeping* delver — it preys only on the helpless — but still fights back
   *  outright once blows are traded. */
  _isEngaged(mob, t, c) {
    if (mob.aggro && mob.aggro[c.id] > 0) return true;
    if (!(mob.detect && mob.detect[c.id] >= AGGRO_ENGAGE)) return false;
    if (t.ambush) return c.kind === "player" && c.actor.posture === "sleeping";
    return true;
  }

  /** A `helper` mob piles into a fight a same-faction ally is already in: for each
   *  present enemy that another same-faction combatant in the room holds combat
   *  threat on (a mob's `aggro`, or a player ally's `pending` target), the helper
   *  engages it too — seeding combat threat so it commits and stays in. Gated by
   *  the helper's own sight (it must perceive the enemy — no joining a fight in the
   *  dark, asleep), and announced once per enemy it newly joins on. */
  _assistPass(mob, t, enemies, light, roomId, events) {
    if (mob.posture === "sleeping" || noticeChance(t.perception, light) <= 0) return;
    const myFaction = combatantFaction(mob, "mob");
    const allies = this._combatantsIn(roomId).filter((c) => c.id !== mob.id && factionRelation(myFaction, c.faction) === "ally");
    if (!allies.length) return;
    for (const e of enemies) {
      if (mob.aggro && mob.aggro[e.id] > 0) continue; // already in this fight — no re-announce
      // Pile in when an ally is already trading blows with this enemy...
      const allyFighting = allies.some((a) =>
        (a.kind === "mob" && a.actor.aggro && a.actor.aggro[e.id] > 0) ||
        (a.kind === "player" && a.actor.pending && a.actor.pending.targetId === e.id));
      // ...or when the enemy is the aggressor against an ally who hasn't (or can't)
      // fight back — a guard steps in for a passive victim (penned fauna, a delver
      // not yet retaliating, an Umbral trader being robbed). A mob aggressor names
      // its target in its aggro table; a player aggressor in `pending.targetId`.
      const enemyTargetsAlly = allies.some((a) =>
        (e.kind === "mob" && e.actor.aggro && e.actor.aggro[a.id] > 0) ||
        (e.kind === "player" && e.actor.pending && e.actor.pending.targetId === a.id));
      if (!allyFighting && !enemyTargetsAlly) continue;
      this._addThreat(mob, e.id, AGGRO_ENGAGE); // join the fight — committed like a full notice
      events.push({
        type: "mob-assist", roomId, mobId: mob.id, mobName: t.name,
        targetId: e.id, targetKind: e.kind,
        targetName: e.kind === "player" ? e.actor.name : this.world.mobs[e.actor.template].name,
        light: this.rooms[roomId].light, emitsLight: !!t.emitsLight,
      });
    }
  }

  /** Alerted = holds any combat threat or any live detection. An alerted mob is
   *  "in combat" and won't wander; an un-alerted hostile roams normally. A parked
   *  `grudge` is deliberately NOT counted: a mob that remembers an absent foe still
   *  wanders and mends between encounters (see GRUDGE_TICKS) — it only re-commits
   *  when that foe is back in the room and the grudge is restored to live `aggro`. */
  _alerted(mob) {
    if (mob.aggro && Object.keys(mob.aggro).length) return true;
    if (mob.detect) for (const v of Object.values(mob.detect)) if (v > 0) return true;
    return false;
  }

  /** Per-action detection pass. A proactive `hunts`er accrues a notice meter on
   *  each enemy it can perceive (mob posture + sight vs room light, via
   *  `canPerceive`/`noticeChance`), capped at `AGGRO_ENGAGE`; the first time a
   *  PLAYER target crosses that cap (and isn't already engaged via blows) the mob
   *  emits its engage tell (and stands if seated). Any enemy it can no longer
   *  perceive — too dark, or the mob itself blinded — decays after `AGGRO_GRACE`
   *  unperceived actions until forgotten. Detection of mob targets (a summon's
   *  wild quarry, or a wild mob noticing a summon) builds silently. */
  _detectAndDecay(mob, t, enemies, light, hunts, roomId, events) {
    if (!mob.detect) mob.detect = {};
    if (!mob._unseen) mob._unseen = {};
    // A mob's sight band lives on its template; a sleeping mob perceives nothing
    // (resolveMobAI already skips it — this is belt-and-suspenders).
    const nc = mob.posture === "sleeping" ? 0 : noticeChance(t.perception, light);
    for (const c of enemies) {
      const id = c.id;
      if (hunts && nc > 0) {
        mob._unseen[id] = 0;
        const before = mob.detect[id] || 0;
        if (before < AGGRO_ENGAGE) {
          const now = Math.min(AGGRO_ENGAGE, before + nc * AGGRO_RATE);
          mob.detect[id] = now;
          // An ambush mob fires no "spotted" tell — its strike from hiding is the
          // reveal (see _mobAttack); a normal mob announces the moment it commits.
          if (now >= AGGRO_ENGAGE && c.kind === "player" && !t.ambush && !(mob.aggro && mob.aggro[id] > 0)) {
            this._engageTell(mob, t, c, roomId, events);
          }
        }
      } else if (mob.detect[id] > 0) {
        // Can't perceive this enemy (dark, or not a hunter): grace, then decay.
        mob._unseen[id] = (mob._unseen[id] || 0) + 1;
        if (mob._unseen[id] > AGGRO_GRACE) {
          const v = mob.detect[id] - AGGRO_RATE;
          if (v > 0) mob.detect[id] = v;
          else { delete mob.detect[id]; delete mob._unseen[id]; }
        }
      }
    }
  }

  /** The Diku-style "spotted you" tell, fired once as a player target crosses the
   *  detection threshold. A seated mob stands as it commits (`rose`). Light-gated
   *  by the renderer like other mob events. `remembered` marks a grudge re-engage
   *  (the mob recognises a returning foe rather than noticing a fresh one), so the
   *  renderer can word it accordingly. */
  _engageTell(mob, t, target, roomId, events, remembered = false) {
    let rose = false;
    if (mob.posture === "sitting") { mob.posture = "standing"; rose = true; }
    events.push({
      type: "aggro-engage", roomId, mobId: mob.id, mobName: t.name,
      targetId: target.id, targetName: target.actor.name, rose, remembered,
      light: this.rooms[roomId].light, emitsLight: !!t.emitsLight,
    });
  }

  /** Award `xp` to every PLAYER who earned a mob's death — the finisher (always,
   *  even if a remote DoT landed the blow; for an allied-mob kill this is its
   *  owner, resolved by the caller) plus any player who traded blows (a live combat
   *  threat entry) and is still present and alive. A threat key that is a *mob* id
   *  is an allied **summon** that helped: it credits its owner (owner-share), so a
   *  delver whose pet did the work shares the kill even when something else lands
   *  the final blow. Model A: each participant gets the FULL value (co-op, no
   *  division). Returns [{ playerId, levelUps }]. */
  _awardKillXp(mob, primaryKiller, xp, roomId) {
    const out = [];
    const credited = new Set();
    if (primaryKiller) {
      out.push({ playerId: primaryKiller.id, levelUps: this.awardXp(primaryKiller, xp) });
      credited.add(primaryKiller.id);
    }
    for (const id of Object.keys(mob.aggro || {})) {
      if (!(mob.aggro[id] > 0)) continue; // participation requires traded blows, not mere detection
      let pl = this.players.get(id);
      if (!pl) {
        // A mob-id key — an allied summon that helped. Credit its owner instead.
        const helper = this.rooms[roomId].mobs.find((x) => x.id === id);
        if (helper && helper.faction === "player" && helper.ownerId) pl = this.players.get(helper.ownerId);
      }
      if (!pl || credited.has(pl.id) || pl.hp <= 0 || pl.location !== roomId) continue; // present, alive, once
      out.push({ playerId: pl.id, levelUps: this.awardXp(pl, xp) });
      credited.add(pl.id);
    }
    return out;
  }

  /** Forget combatants no longer present across every per-enemy table. `present`
   *  is the current candidate list ({ id } descriptors). Detection and its unseen
   *  counters are pure room-local perception — an enemy who leaves is no longer
   *  noticed, full stop. Combat threat normally drops the same way, EXCEPT for a
   *  `remembers` OR `pursues` mob (template flags): the grudge of a PLAYER who
   *  merely left (still online and alive) is parked in `mob.grudge`. A `remembers`
   *  mob re-engages on sight if they return within GRUDGE_TICKS; a `pursues` mob
   *  reads the same grudge to go after them (see _pursue / _restoreGrudges /
   *  _decayGrudges). Allied summon (mob-id) keys and dead/offline players still drop
   *  outright. In-room decay of detection is handled separately by `_detectAndDecay`. */
  _pruneAggro(mob, t, present) {
    const ids = new Set(present.map((c) => c.id));
    for (const map of [mob.detect, mob._unseen]) {
      if (!map) continue;
      for (const cid of Object.keys(map)) if (!ids.has(cid)) delete map[cid];
    }
    if (!mob.aggro) { mob.aggro = {}; return; }
    for (const cid of Object.keys(mob.aggro)) {
      if (ids.has(cid)) continue; // still here — leave the live threat intact
      if ((t.remembers || t.pursues) && mob.aggro[cid] > 0) {
        const pl = this.players.get(cid); // grudges are held only against players
        if (pl && pl.hp > 0) {
          if (!mob.grudge) mob.grudge = {};
          mob.grudge[cid] = { threat: mob.aggro[cid], ttl: GRUDGE_TICKS };
        }
      }
      delete mob.aggro[cid];
    }
  }

  /** Restore a parked grudge when its quarry re-enters: any present enemy the mob
   *  still bears a grudge against gets that combat threat re-seeded (engaged on
   *  sight — `_isEngaged` treats any `aggro > 0` as committed), and a "remembers
   *  you" tell fires for a player target, mirroring the detection-commit tell. */
  _restoreGrudges(mob, t, enemies, roomId, events) {
    if (!mob.grudge) return;
    for (const c of enemies) {
      const g = mob.grudge[c.id];
      if (!g) continue;
      const fresh = !(mob.aggro && mob.aggro[c.id] > 0);
      this._addThreat(mob, c.id, g.threat);
      delete mob.grudge[c.id];
      if (fresh && c.kind === "player" && !t.ambush) this._engageTell(mob, t, c, roomId, events, true);
    }
  }

  /** Age every grudge one tick (runs for all mobs each tick, see resolveMobAI):
   *  forgive the timed-out, and the gone — a quarry that died or logged out is
   *  dropped at once, a clean slate either way. */
  _decayGrudges(mob) {
    if (!mob.grudge) return;
    for (const id of Object.keys(mob.grudge)) {
      const pl = this.players.get(id);
      if (!pl || pl.hp <= 0 || --mob.grudge[id].ttl <= 0) delete mob.grudge[id];
    }
  }

  /** Cross-room pursuit step for a `pursues` mob with no enemy present (called from
   *  _mobAct). Picks the grudge target it most wants — highest parked threat, player
   *  online, alive, and in another room — and steps one room along the shortest path
   *  toward them, PROVIDED that step keeps it within `pursueRange` rooms (BFS depth)
   *  of its spawn room (the leash). If the next step would slip the leash, or the
   *  quarry is unreachable, it abandons that grudge. With nothing left to chase and
   *  itself away from home, a stray pursuer slips back to its spawn room (v1 give-up:
   *  a quiet relocate, not a room-by-room walk-back). Returns true if it acted. */
  _pursue(mob, t, roomId, events) {
    const range = t.pursueRange != null ? t.pursueRange : PURSUE_RANGE;
    if (mob.grudge) {
      const quarry = this._pursuitQuarry(mob, roomId);
      if (quarry) {
        const dir = this._bfsNextDir(roomId, quarry.room);
        const dest = dir && this.world.rooms[roomId].exits[dir];
        if (dest && this._bfsDist(mob.origin ? mob.origin.roomId : roomId, dest) <= range) {
          this._mobMove(mob, t, roomId, events, t.pursueVerb || "stalks off, hunting", [dir]);
          return true;
        }
        delete mob.grudge[quarry.playerId]; // unreachable, or the next step breaks the leash — let it go
      }
    }
    return this._returnHome(mob, t, roomId, events); // nothing to chase: drift home if astray
  }

  /** The grudge target a pursuer most wants right now: highest parked threat whose
   *  player is online, alive, and in another (valid) room. Returns { playerId, room }
   *  or null. A grudge whose player is dead/offline is left for _decayGrudges; one
   *  whose player is back in this room is ignored (already re-seeded as live aggro by
   *  _restoreGrudges this same action). */
  _pursuitQuarry(mob, roomId) {
    let best = null, bestThreat = -1;
    for (const id of Object.keys(mob.grudge)) {
      const pl = this.players.get(id);
      if (!pl || pl.hp <= 0 || pl.location === roomId || !this.rooms[pl.location]) continue;
      if (mob.grudge[id].threat > bestThreat) { bestThreat = mob.grudge[id].threat; best = { playerId: id, room: pl.location }; }
    }
    return best;
  }

  /** Slip a stray pursuer back to its spawn room (v1 give-up). Only when the mob is
   *  away from home AND no living player is in its current room — so no one witnesses
   *  it vanish; any watchers in the home room just see it "slink in", lights recomputed
   *  both ends. A spawner-less mob (no `origin`), one already home, or one being watched
   *  does nothing (it stays put and tries again once the room empties). Returns true if
   *  it relocated. */
  _returnHome(mob, t, roomId, events) {
    const home = mob.origin && mob.origin.roomId;
    if (!home || home === roomId || !this.rooms[home]) return false;
    if (this.playersIn(roomId).some((p) => p.hp > 0)) return false; // watched — wait for an empty room
    const rt = this.rooms[roomId];
    const idx = rt.mobs.indexOf(mob);
    if (idx < 0) return false;
    rt.mobs.splice(idx, 1);
    this.rooms[home].mobs.push(mob);
    rt.light = this.computeRoomLight(roomId);
    this.rooms[home].light = this.computeRoomLight(home);
    events.push({
      type: "mob-move", mobId: mob.id, mobName: t.name, from: roomId, to: home, dir: null,
      verb: "slips away into the dark", emitsLight: !!t.emitsLight,
      lightFrom: rt.light, lightTo: this.rooms[home].light,
    });
    return true;
  }

  /** First step (exit direction) along a shortest path from `from` to `to` over the
   *  room exit graph, or null if `to` is unreachable or equals `from`. Directed —
   *  follows exits as laid, so a pursuer paths the way a delver actually walked. */
  _bfsNextDir(from, to) {
    if (from === to) return null;
    const seen = new Set([from]);
    const queue = [];
    for (const [dir, dest] of Object.entries(this.world.rooms[from].exits || {})) {
      if (!this.world.rooms[dest] || seen.has(dest)) continue;
      seen.add(dest);
      if (dest === to) return dir;
      queue.push({ room: dest, first: dir });
    }
    while (queue.length) {
      const { room, first } = queue.shift();
      for (const dest of Object.values(this.world.rooms[room].exits || {})) {
        if (!this.world.rooms[dest] || seen.has(dest)) continue;
        seen.add(dest);
        if (dest === to) return first;
        queue.push({ room: dest, first });
      }
    }
    return null;
  }

  /** Shortest-path room count from `from` to `to` over the exit graph (0 if equal,
   *  Infinity if unreachable). Leashes pursuit to `pursueRange` rooms of home. */
  _bfsDist(from, to) {
    if (from === to) return 0;
    const seen = new Set([from]);
    let frontier = [from], dist = 0;
    while (frontier.length) {
      dist++;
      const next = [];
      for (const room of frontier) {
        for (const dest of Object.values(this.world.rooms[room].exits || {})) {
          if (!this.world.rooms[dest] || seen.has(dest)) continue;
          if (dest === to) return dist;
          seen.add(dest);
          next.push(dest);
        }
      }
      frontier = next;
    }
    return Infinity;
  }

  /** The present combatant a mob is most angry at (a { id, actor, kind } descriptor),
   *  or null. Targeting is *tiered*, not additive: anyone the mob has actually
   *  traded blows with (combat threat > 0) outranks anyone it has merely noticed,
   *  regardless of magnitude — within each tier the higher score wins (combat
   *  threat among the engaged, detection among the rest). This keeps "focus who's
   *  hitting me" a property of the code rather than an accident of `AGGRO_ENGAGE`
   *  being small (an additive sum would let a freshly-noticed target outweigh one
   *  struck once if that cap were ever raised). `candidates` are the targets to
   *  weigh among. */
  _topThreat(mob, candidates) {
    let best = null, bestScore = 0, bestEngaged = false;
    for (const c of candidates) {
      const combat = (mob.aggro && mob.aggro[c.id]) || 0;
      const engaged = combat > 0; // traded blows → hard priority tier over mere detection
      const score = engaged ? combat : ((mob.detect && mob.detect[c.id]) || 0);
      if (score <= 0) continue;
      // An engaged target beats any merely-detected one; otherwise higher score wins.
      if ((engaged && !bestEngaged) || (engaged === bestEngaged && score > bestScore)) {
        best = c; bestScore = score; bestEngaged = engaged;
      }
    }
    return best;
  }

  /** Defender descriptor for a MOB being struck, for `applyHitOutcome`. `attacker`
   *  is the striking combatant ({ id, kind, actor }); landing the kill credits its
   *  resolved player (a player attacker, or an allied mob's owner — see
   *  `_killerPlayerFor`). Shared by the player-attack path and mob-vs-mob combat. */
  _mobDefender(mob, mt, roomId, attacker, events) {
    return {
      actor: mob, kind: "mob", id: mob.id, name: mt.name, emitsLight: !!mt.emitsLight, roomId,
      onDamage: mobOnDamage(mt),
      sourceId: null, // a mob defender's retaliatory DoT credits no one
      deal: (dmg) => {
        this._addThreat(mob, attacker.id, Math.max(1, dmg)); // being hit earns the striker its ire
        mob.hp -= dmg;
        if (mob.hp <= 0) {
          const d = this._killMobAt(mob, roomId, this._killerPlayerFor(attacker));
          events.push(d);
          if (attacker.kind === "player") attacker.actor.pending = null; // quarry slain — stop swinging
          return d;
        }
        return null;
      },
      hurt: (dmg, cause) => this._hurtMob(mob, roomId, dmg, events, { cause }), // self-damage onDamage (rare)
    };
  }

  /** Defender descriptor for a PLAYER being struck, for `applyHitOutcome`. */
  _playerDefender(player, roomId, events) {
    return {
      actor: player, kind: "player", id: player.id, name: player.name, emitsLight: false, roomId,
      onDamage: playerOnDamage(this.world, player), // player armour triggers (none seeded yet)
      sourceId: player.id, // a player's reflected DoT credits them
      deal: (dmg) => {
        player.hp -= dmg;
        if (player.hp <= 0) { const d = this._respawn(player, roomId, events); events.push(d); return d; }
        return null;
      },
      hurt: (dmg, cause) => this._hurtPlayer(player, dmg, events, { cause }), // self-damage onDamage (rare)
    };
  }

  /** A mob makes one melee attack against its highest-threat enemy — a player OR
   *  an opposing-faction mob (an allied summon, etc.). `enemies` is the candidate
   *  set from `_mobAct`. Reuses `strike`/`applyHitOutcome` via the shared defender
   *  builders, so contact triggers (onHit/onDamage/spikes) fire identically in both
   *  directions. Player targets also rouse from rest and auto-retaliate. */
  _mobAttack(m, t, roomId, events, enemies) {
    const rt = this.rooms[roomId];
    const target = this._topThreat(m, enemies) || enemies[Math.floor(Math.random() * enemies.length)];
    if (!target) return;
    this._addThreat(m, target.id, 1); // attacking sticks the mob to its quarry
    const isPlayer = target.kind === "player";
    // Ambush: a hidden mob striking a delver who never found it bursts from
    // concealment — reveal it to that player (ephemerally, like `search`) and
    // announce the appearance just before the blow lands.
    if (m.hidden && isPlayer && !mobVisibleTo(this, target.actor, m)) {
      let set = this.revealedMobs.get(target.actor.id);
      if (!set) { set = new Set(); this.revealedMobs.set(target.actor.id, set); }
      set.add(m.id);
      events.push({ type: "mob-ambush", roomId, mobId: m.id, mobName: t.name,
        targetId: target.id, light: rt.light, emitsLight: !!t.emitsLight });
    }
    const tmt = isPlayer ? null : this.world.mobs[target.actor.template];
    const targetName = isPlayer ? target.actor.name : tmt.name;
    const targetEmitsLight = isPlayer ? false : !!tmt.emitsLight;
    const defence = isPlayer
      ? playerDefence(this.world, target.actor)
      : mobDefence(tmt, target.actor);
    const attacker = {
      band: t.perception,
      hitBonus: (t.attack.hitBonus) || 0, // a keen-eyed mob (data-driven, default 0)
      dmgBonus: (t.attack.bonus) || 0,
      crit: (t.attack.crit) || 0, // mirrors player crit; default 0 → no live change
    };
    const r = strike(attacker, defence, rt.light, t.attack.damage, t.attack.type || "physical");
    const attackEvent = {
      type: "attack", by: "mob", attackerId: m.id, attackerName: t.name, roomId,
      targetId: target.id, targetName, targetKind: target.kind, hit: r.hit, sighted: r.sighted,
      damage: r.damage, crit: r.crit, targetHp: Math.max(0, target.actor.hp - r.damage), targetMaxHp: target.actor.maxHp,
      light: rt.light, attackerEmitsLight: !!t.emitsLight, targetEmitsLight,
    };
    const defender = isPlayer
      ? this._playerDefender(target.actor, roomId, events)
      : this._mobDefender(target.actor, tmt, roomId, { id: m.id, kind: "mob", actor: m }, events);
    this.applyHitOutcome({
      r, events, attackEvent,
      attacker: {
        actor: m, kind: "mob", id: m.id, name: t.name, emitsLight: !!t.emitsLight, roomId,
        onHit: t.attack.onHit,
        sourceId: null, // a mob's venom credits no one
        // Reflect/retaliate lands on the mob; the struck defender's owner (a player,
        // if it's a delver or an allied mob still up) gets the credit.
        hurt: (dmg, cause) => this._hurtMob(m, roomId, dmg, events, { cause, killer: target.actor.hp > 0 ? this._killerPlayerFor(target) : null }),
      },
      defender,
    });

    if (!isPlayer) return; // mob-vs-mob: no rouse-from-rest or player auto-retaliate
    const p = target.actor;
    // A blow rouses a resting target — you can't sleep through being hit. (A
    // sleeping delver is blind, so the first they know of a threat is this strike.)
    if (p.hp > 0 && this._rouse(p)) events.push({ type: "player-woke", playerId: p.id });
    // Auto-retaliate: if the player isn't already attacking something, target this mob
    if (!p.pending && p.hp > 0) {
      p.pending = { type: "attack", targetId: m.id };
      events.push({ type: "combat-auto-start", playerId: p.id, targetId: m.id, targetName: t.name });
    }
  }

  /** A mob summons reinforcements (the `summon` action). Conjures up to its
   *  `count`, never exceeding the living-brood `max`, on the mob's own faction
   *  (allies that fight alongside it, not each other). Permanent, spoil-less. */
  _mobSummon(m, t, roomId, events, action) {
    const max = action.max != null ? action.max : Infinity;
    const room = this._broodCount(m.id);
    const count = Math.min(action.count || 1, max - room);
    if (count <= 0) return;
    this._summon({
      roomId, mobId: action.mob, count, faction: m.faction || DEFAULT_FACTION,
      ownerId: null, summonerId: m.id, group: null, lifetime: null,
      by: "mob", byName: t.name, verb: action.verb || null,
    }, events);
  }

  /** A mob casts a hostile spell at its highest-threat enemy — a player OR an
   *  opposing-faction mob (mirror of _mobAttack for the `cast` action). The target's
   *  Ward gets a wholesale negation roll (see wardNegates); a spell that lands deals
   *  magical damage scaled by the mob's own attributes, or applies a hostile status
   *  effect. No mana bookkeeping for mobs — cadence is gated by action energy. Pushes
   *  a `mob-cast` event the server narrates; a player target also rouses/retaliates. */
  _mobCast(m, t, roomId, events, enemies, spellId) {
    const rt = this.rooms[roomId];
    const spell = this.world.spells[spellId];
    if (!spell) return;
    if (!spell.hostile) return this._mobCastSelf(m, t, roomId, events, spell); // a beneficial weave lands on the caster
    const eff = spell.effect || {};
    const target = this._topThreat(m, enemies) || enemies[Math.floor(Math.random() * enemies.length)];
    if (!target) return;
    this._addThreat(m, target.id, 1); // casting sticks the mob to its quarry
    const isPlayer = target.kind === "player";
    const tmt = isPlayer ? null : this.world.mobs[target.actor.template];
    const targetName = isPlayer ? target.actor.name : tmt.name;

    const ward = isPlayer ? (playerDefence(this.world, target.actor).ward || 0) : (mobDefence(tmt, target.actor).ward || 0);
    const resisted = wardNegates(ward);
    let damage = 0, killed = false, death = null, effectName = null, doused = false;
    if (!resisted) {
      if (eff.type === "damage") {
        damage = Math.max(1, rollDice(eff.damage) + spellScaleBonus(t.attributes || {}, eff.scale));
        this._addThreat(m, target.id, damage); // mirror melee: damage stokes threat
        target.actor.hp -= damage;
        if (target.actor.hp <= 0) {
          killed = true;
          death = isPlayer
            ? this._respawn(target.actor, roomId, events)
            : this._killMobAt(target.actor, roomId, this._killerPlayerFor({ id: m.id, kind: "mob", actor: m }));
        }
      } else if (eff.type === "douse") {
        // Snuff the target's carried light — a shadow's signature reach. Only a player
        // wields a doused-able lit source (a mob's glow is innate, not a kindled flame),
        // so it no-ops on a mob target. The delver must relight (a turn) or fight blind;
        // the room darkens immediately, recomputed below so the band is fresh.
        if (isPlayer) {
          const li = target.actor.equipment && target.actor.equipment.light;
          if (li && li.lit) { li.lit = false; doused = true; }
        }
        effectName = eff.name || "Douse";
      } else {
        // A hostile status effect (debuff). Stamp no sourceId — a mob credits no one.
        this.applyEffect(target.actor, { ...eff });
        effectName = eff.name || eff.type;
      }
    }
    if (doused) rt.light = this.computeRoomLight(roomId); // the snuffed flame leaves the room darker
    events.push({
      type: "mob-cast", roomId, mobId: m.id, mobName: t.name, emitsLight: !!t.emitsLight, light: rt.light,
      targetId: target.id, targetName, targetKind: target.kind, targetEmitsLight: isPlayer ? false : !!tmt.emitsLight,
      spellName: spell.name, resisted, damage, effectName, doused, killed,
      targetHp: Math.max(0, target.actor.hp), targetMaxHp: target.actor.maxHp,
    });
    if (death) events.push(death);

    if (!isPlayer || killed || target.actor.hp <= 0) return;
    const p = target.actor;
    if (this._rouse(p)) events.push({ type: "player-woke", playerId: p.id });
    if (!p.pending) {
      p.pending = { type: "attack", targetId: m.id };
      events.push({ type: "combat-auto-start", playerId: p.id, targetId: m.id, targetName: t.name });
    }
  }

  /** A mob casts a beneficial spell on *itself* — the support side of mob casting
   *  (e.g. an Umbral glimmer-singer crusting Glimmerskin over its own hide before
   *  it spikes you). Mobs pay no mana/shards; defence/heal magnitudes are baked
   *  from the mob's own attributes, mirroring castBeneficial. Reusable for future
   *  warder/healer mobs. The _mobAct filter gates a refresh-buff so it isn't recast
   *  while already up. */
  _mobCastSelf(m, t, roomId, events, spell) {
    const rt = this.rooms[roomId];
    const eff = spell.effect || {};
    const attrs = t.attributes || {};
    if (eff.type === "protect") {
      const armour = scaledAmount(attrs, eff.armour);
      const ward = scaledAmount(attrs, eff.ward);
      this.applyEffect(m, { type: "protect", name: eff.name || "protect", armour, ward, duration: eff.duration, refresh: eff.refresh, good: true });
    } else if (eff.type === "restore") {
      this.applyRestore(m, eff);
    } else {
      const bonus = spellScaleBonus(attrs, eff.scale);
      const raw = (eff.magnitude || 0) + bonus;
      // A *darkness* aura is an emit-light effect authored with a negative magnitude
      // (it drinks the room's light rather than sheds it — see computeRoomLight, which
      // sums a source's output be it positive or negative). Preserve the negative; a
      // positive light weave still floors at 1 so a scaling source always shows.
      const magnitude = raw < 0 ? raw : Math.max(eff.scale ? 1 : 0, raw);
      this.applyEffect(m, { ...eff, magnitude });
      if (eff.type === "emit-light") rt.light = this.computeRoomLight(roomId);
    }
    events.push({
      type: "mob-cast-self", roomId, mobId: m.id, mobName: t.name,
      emitsLight: !!t.emitsLight, light: rt.light, spellName: spell.name, effectName: eff.name || eff.type,
      // A negative emit-light weave is a darkness aura, not a self-buff — the client
      // narrates it as the room being swallowed rather than something drawn "about itself".
      darkened: eff.type === "emit-light" && ((eff.magnitude || 0) < 0),
    });
  }

  /** True if a mob currently carries an active state by name (used to gate a
   *  refresh self-buff so it isn't recast while still up). */
  _mobHasState(m, name) {
    return !!name && (m.states || []).some((s) => s.name === name);
  }

  _mobMove(m, t, roomId, events, verb, exits) {
    const dir = exits[Math.floor(Math.random() * exits.length)];
    const dest = this.world.rooms[roomId].exits[dir];
    const rt = this.rooms[roomId];
    const idx = rt.mobs.indexOf(m);
    if (idx >= 0) rt.mobs.splice(idx, 1);
    this.rooms[dest].mobs.push(m);
    rt.light = this.computeRoomLight(roomId);
    this.rooms[dest].light = this.computeRoomLight(dest);
    events.push({
      type: "mob-move", mobId: m.id, mobName: t.name, from: roomId, to: dest, dir, verb,
      emitsLight: !!t.emitsLight, lightFrom: rt.light, lightTo: this.rooms[dest].light,
    });
  }

  /**
   * Drop a slain mob's loot roll and shard roll onto `roomId`'s floor; returns
   * the list of names dropped (shards as "N shards"). Shards merge into an
   * existing pile rather than littering separate stacks. Shared by every death
   * path — a direct kill, the room itself, a bleed tick.
   */
  _dropSpoils(mob, roomId) {
    if (mob.noSpoils) return [];
    const t = this.world.mobs[mob.template];
    const rt = this.rooms[roomId];
    const dropped = [];
    for (const l of t.loot || []) {
      if (Math.random() < l.chance) {
        addToFloor(rt, makeItemInstance({ template: l.template }, this.world), this.world);
        dropped.push(this.world.items[l.template].name);
      }
    }
    if (t.shards) {
      const shards = rollDice(t.shards);
      if (shards > 0) {
        addToFloor(rt, makeItemInstance({ template: "shards", qty: shards }, this.world), this.world);
        dropped.push(`${shards} shards`);
      }
    }
    return dropped;
  }

  /** A direct kill by a player (melee/spell): removes the mob, drops spoils, and
   *  awards xp to the killer. Non-combat deaths go through `_hurtMob` instead. */
  _killMob(mob, killer) {
    return this._killMobAt(mob, killer.location, killer);
  }

  /** Remove a mob killed by a direct hit in `roomId`, drop its spoils, and award
   *  XP. `killerPlayer` is the player to credit as finisher (a player attacker, or
   *  the OWNER of an allied mob that landed the blow — resolved by the caller) or
   *  null when no player struck the killing blow (e.g. an ownerless ally's kill);
   *  other players who held threat are still credited via `_awardKillXp`. Returns
   *  the `death` event. Shared by the player-attack path and mob-vs-mob combat. */
  _killMobAt(mob, roomId, killerPlayer, cause = "hit") {
    const t = this.world.mobs[mob.template];
    const idx = this.rooms[roomId].mobs.indexOf(mob);
    if (idx >= 0) this.rooms[roomId].mobs.splice(idx, 1);
    this._adjustOwned(mob, -1);
    const loot = this._dropSpoils(mob, roomId);
    const xp = t.xp || 0;
    const participants = mob.noSpoils ? [] : this._awardKillXp(mob, killerPlayer, xp, roomId); // shared credit (Model A); summons award nothing
    this.rooms[roomId].light = this.computeRoomLight(roomId); // a luminous mob dying changes the room
    return { type: "death", victimKind: "mob", victimId: mob.id, victimName: t.name, victimTemplate: mob.template, roomId, killerId: killerPlayer ? killerPlayer.id : null, loot, xp: participants.length ? xp : 0, cause, participants };
  }
}

module.exports = MobAIMixin;
