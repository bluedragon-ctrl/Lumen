"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

const { PORT, TICK_MS, SNAPSHOT_EVERY_TICKS, CLIENT_DIR, VERSION } = require("./config");
const { loadWorld } = require("./world");
const { GameState } = require("./state");
const { buildRoomView, buildPlayerView, buildExamineView } = require("./render");
const { execute } = require("./commands");
const quests = require("./quests");
const { canSee } = require("./light");
const accounts = require("./accounts");

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
// Can this player make out the mob — room bright enough for them, or it's self-lit?
const canSeeMob = (player, light, emitsLight) => !!emitsLight || canSee(player.perception, light);

// ---------------------------------------------------------------------------
// World + state
// ---------------------------------------------------------------------------
const world = loadWorld();
const state = new GameState(world);
const connections = new Map(); // playerId -> ws
console.log(
  `[lumen] world loaded: ${Object.keys(world.rooms).length} rooms, ` +
    `${Object.keys(world.mobs).length} mob templates, ${Object.keys(world.items).length} items.`
);

// The default admin account is always present (auto-created if missing).
if (!accounts.exists("admin")) {
  accounts.save(state.createCharacter("admin", { isAdmin: true }));
  console.log('[lumen] created default admin account ("admin").');
}

function send(ws, msg) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}
function sendAll(ws, msgs) {
  for (const m of msgs) send(ws, m);
}
function sendToPlayer(playerId, msg) {
  send(connections.get(playerId), msg);
}
// Send an already-serialized frame, so a message broadcast to N players is
// stringified once rather than once per recipient.
function sendRawToPlayer(playerId, data) {
  const ws = connections.get(playerId);
  if (ws && ws.readyState === ws.OPEN) ws.send(data);
}

// --- Per-burst view coalescing ---------------------------------------------
// Room and vitals views are idempotent snapshots, and a single tick (or command)
// often fires several events touching the same room — each previously rebuilt and
// resent every onlooker's full view. Instead, reactive refreshes mark a view dirty
// and `flushViews` rebuilds each dirty view exactly once, after the dispatch burst,
// so it reflects end-of-burst state. Direct command responses are unaffected; only
// event/effect-driven refreshes (handlers + roomCtx.refreshRoom) route through here.
const dirtyRoomViews = new Set(); // playerIds needing a fresh room view
const dirtyPlayerViews = new Set(); // playerIds needing a fresh vitals view
const markRoomView = (playerId) => dirtyRoomViews.add(playerId);
const markPlayerView = (playerId) => dirtyPlayerViews.add(playerId);
const markViews = (playerId) => { dirtyRoomViews.add(playerId); dirtyPlayerViews.add(playerId); };

function flushViews() {
  for (const id of dirtyRoomViews) {
    const p = state.players.get(id);
    if (p) sendToPlayer(id, buildRoomView(state, p));
  }
  for (const id of dirtyPlayerViews) {
    const p = state.players.get(id);
    if (p) sendToPlayer(id, buildPlayerView(state, p));
  }
  dirtyRoomViews.clear();
  dirtyPlayerViews.clear();
}

// Broadcast context handed to commands so effects reach OTHER players in a room.
const roomCtx = {
  toRoom(roomId, msg, exceptId) {
    const data = JSON.stringify(msg); // identical for every recipient — serialize once
    for (const p of state.playersIn(roomId)) if (p.id !== exceptId) sendRawToPlayer(p.id, data);
  },
  refreshRoom(roomId, exceptId) {
    for (const p of state.playersIn(roomId)) if (p.id !== exceptId) markRoomView(p.id);
  },
  emit(ev) { dispatchEvent(ev); },
};

// ---------------------------------------------------------------------------
// HTTP: serve the client, falling back to a dev page if it's missing.
// ---------------------------------------------------------------------------
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };

function serveClient(req, res) {
  let urlPath = req.url.split("?")[0];
  if (urlPath === "/") urlPath = "/index.html";
  const filePath = path.join(CLIENT_DIR, urlPath);
  if (!filePath.startsWith(CLIENT_DIR)) return void res.writeHead(403).end("Forbidden");
  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (urlPath === "/index.html") res.writeHead(200, { "Content-Type": "text/html" }).end(DEV_PAGE);
      else res.writeHead(404).end("Not found");
      return;
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
    res.end(data);
  });
}
const httpServer = http.createServer(serveClient);

// ---------------------------------------------------------------------------
// WebSocket: one connection per player.
// ---------------------------------------------------------------------------
const wss = new WebSocketServer({ server: httpServer });

function login(ws, rawName) {
  const v = accounts.validateName(rawName);
  if (!v.ok) return void send(ws, { type: "error", text: v.reason });
  for (const p of state.players.values()) {
    if (p.name.toLowerCase() === v.name.toLowerCase())
      return void send(ws, { type: "error", text: `"${p.name}" is already logged in.` });
  }
  if (!accounts.exists(v.name)) {
    return void send(ws, {
      type: "error",
      text: `No delver named "${v.name}". Ask an admin to create your account.`,
    });
  }
  const player = state.admit(accounts.load(v.name));
  ws.playerId = player.id;
  connections.set(player.id, ws);
  state.rooms[player.location].light = state.computeRoomLight(player.location);

  send(ws, { type: "authenticated", name: player.name, admin: !!player.isAdmin });
  send(ws, {
    type: "system",
    text: `Welcome to Lumen v${VERSION}, ${player.name}.${player.isAdmin ? " [admin]" : ""} Type "help".`,
  });
  send(ws, buildPlayerView(state, player));
  send(ws, buildRoomView(state, player));
  console.log(`[lumen] ${player.name} logged in (${state.players.size} online).`);
}

wss.on("connection", (ws) => {
  ws.playerId = null; // null until authenticated
  send(ws, { type: "login-required", text: 'Enter your delver name (or "admin"):' });

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return void send(ws, { type: "error", text: "malformed message (expected JSON)" });
    }
    // Login phase: the first input is the player's name.
    if (!ws.playerId) {
      const name = msg.type === "login" ? msg.name : msg.type === "command" ? msg.text : null;
      if (name == null) return void send(ws, { type: "error", text: "Please enter your name." });
      return void login(ws, name);
    }
    const player = state.players.get(ws.playerId);
    if (msg.type === "command" && typeof msg.text === "string") {
      sendAll(ws, execute(state, player, msg.text, roomCtx));
      flushViews(); // a command may have marked bystanders' rooms dirty via roomCtx
    } else {
      send(ws, { type: "error", text: `unhandled message type: ${msg.type}` });
    }
  });

  ws.on("close", () => {
    if (ws.playerId) {
      const player = state.players.get(ws.playerId);
      if (player) {
        accounts.saveAsync(player).catch((e) => console.error("[lumen] account save failed:", e.message));
        console.log(`[lumen] ${player.name} disconnected (${state.players.size - 1} online).`);
      }
      for (const ev of state.removePlayer(ws.playerId)) dispatchEvent(ev);
      flushViews(); // the departing player may have left bystanders' rooms dirty
      connections.delete(ws.playerId);
    }
  });
});

// ---------------------------------------------------------------------------
// Event dispatch — render tick/command events into client messages.
// ---------------------------------------------------------------------------
// Small helpers shared by the handlers below. Together they absorb the three
// patterns that recur across nearly every event: the light-gated mob name, the
// "get the live player or bail" guard, the room + vitals view refresh, and the
// "narrate one line to everyone in the room" broadcast.

// Light-gated name of an event's mob from one observer's point of view.
const mobNameFor = (o, ev) => (canSeeMob(o, ev.light, ev.emitsLight) ? ev.mobName : "something");

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
  for (const o of state.playersIn(roomId)) {
    const text = lineFor(mobNameFor(o, ev), o);
    if (text != null) {
      let data = frames.get(text);
      if (data === undefined) { data = JSON.stringify({ type, text }); frames.set(text, data); }
      sendRawToPlayer(o.id, data);
    }
    if (refreshRoom) markRoomView(o.id);
  }
}

// Constant flavour tables, hoisted out of the per-event handlers.
const HURT_SRC = {
  light: "the searing light",
  spikes: "the spines",
  venom: "venom",
  bleed: "your wounds",
  darkness: "the creeping dark",
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
    const msg = ev.effectType === "emit-light" ? "The light beneath your skin fades." : `Your ${ev.name} fades.`;
    sendToPlayer(ev.playerId, { type: "log", text: msg });
    refreshViews(player);
    // Others in the room may notice a glow going out / the room dimming.
    roomCtx.refreshRoom(player.location, ev.playerId);
  }),

  "effect-applied": (ev) => withPlayer(ev.playerId, (player) => {
    // A trigger (e.g. a venomous bite) just landed a status effect on a player.
    sendToPlayer(ev.playerId, { type: "log", text: `The ${ev.name} takes hold.` });
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

  "mob-effect-applied": (ev) =>
    // A player's on-hit effect (e.g. a venom-coated weapon) took hold on a mob.
    broadcastRoom(ev.roomId, ev, (n) => `The ${ev.name} takes hold of ${n}.`),

  "mob-effect-expired": (ev) => {
    // A status effect (venom/bleed/glow) wore off a mob — mirror of player effect-expired.
    const line = ev.effectType === "emit-light"
      ? (n) => `The glow fades from ${n}.`
      : (MOB_EFFECT_EXPIRED_FLAVOUR[ev.name] || ((n) => `The ${ev.name} fades from ${n}.`));
    broadcastRoom(ev.roomId, ev, line);
  },

  "attack": (ev) => {
    if (ev.by === "player") {
      // The attacker targeted it, so they always know what it is.
      const verb = ev.hit
        ? `hit ${ev.targetName} for ${ev.damage}`
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
          ? `${cap(an)} strikes ${tn} for ${ev.damage}.${ev.crit ? " A critical hit!" : ""}`
          : `${cap(an)} ${ev.sighted ? `swings at ${tn} and misses` : `lunges at ${tn} in the dark and misses`}.`;
        sendToPlayer(o.id, { type: "combat", text: line });
      }
    } else {
      const target = state.players.get(ev.targetId);
      const seen = target && canSeeMob(target, ev.light, ev.attackerEmitsLight);
      const who = seen ? ev.attackerName : "something";
      const youLine = ev.hit
        ? `${cap(who)} hits you for ${ev.damage}!${ev.crit ? " A critical hit!" : ""}`
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
    else if (ev.effectName) youLine = `${cap(who)} casts ${ev.spellName} on you — the ${ev.effectName} takes hold.`;
    else youLine = `${cap(who)} blasts you with ${ev.spellName} for ${ev.damage}!`;
    sendToPlayer(ev.targetId, { type: "combat", text: youLine });
    if (target) markPlayerView(ev.targetId);
    for (const o of state.playersIn(ev.roomId)) {
      if (o.id === ev.targetId) continue;
      const an = mobNameFor(o, ev);
      const line = ev.doused
        ? `${cap(an)} reaches for ${ev.targetName} and snuffs their light.`
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

  "combat-stop": (ev) => sendToPlayer(ev.playerId, { type: "log", text: ev.reason }),

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

  "mob-spawn": (ev) =>
    broadcastRoom(ev.roomId, ev, (n) => (n === "something"
      ? "Something stirs in the dark."
      : `${cap(ev.mobName)} appears.`), { refreshRoom: true }),

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

function dispatchEvent(ev) {
  const handler = EVENT_HANDLERS[ev.type];
  if (handler) handler(ev);
}

// ---------------------------------------------------------------------------
// Tick loop — the heartbeat of the living world (DESIGN.md §3.4, §4).
// ---------------------------------------------------------------------------
const tickTimer = setInterval(() => {
  for (const ev of state.advance()) dispatchEvent(ev);
  flushViews(); // coalesce a tick's worth of view refreshes into one send per player
  if (state.tick % SNAPSHOT_EVERY_TICKS === 0) {
    // Periodic snapshot — fire async writes off the event loop, skipping players
    // whose data is unchanged, so disk I/O never stalls the tick.
    for (const player of state.players.values()) {
      accounts.saveAsync(player).catch((e) => console.error("[lumen] account save failed:", e.message));
    }
  }
}, TICK_MS);

httpServer.listen(PORT, () => {
  console.log(`[lumen] listening on http://localhost:${PORT}  (tick ${TICK_MS}ms)`);
});

function shutdown() {
  console.log("\n[lumen] shutting down…");
  clearInterval(tickTimer);
  for (const player of state.players.values()) {
    try {
      accounts.save(player);
    } catch (e) {
      console.error("[lumen] account save failed:", e.message);
    }
  }
  wss.close();
  httpServer.close(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// ---------------------------------------------------------------------------
// Minimal fallback dev page (used only if the client/ files are missing).
// ---------------------------------------------------------------------------
const DEV_PAGE = `<!doctype html><meta charset="utf-8"><title>Lumen</title>
<body style="background:#0b0d10;color:#cdd3da;font:14px monospace;padding:1rem">
<p>Lumen v${VERSION} server is running, but the client files were not found.</p>
<p>Expected client at: <code>${CLIENT_DIR}</code></p></body>`;
