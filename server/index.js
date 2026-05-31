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

// Broadcast context handed to commands so effects reach OTHER players in a room.
const roomCtx = {
  toRoom(roomId, msg, exceptId) {
    for (const p of state.playersIn(roomId)) if (p.id !== exceptId) sendToPlayer(p.id, msg);
  },
  refreshRoom(roomId, exceptId) {
    for (const p of state.playersIn(roomId)) if (p.id !== exceptId) sendToPlayer(p.id, buildRoomView(state, p));
  },
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
    } else {
      send(ws, { type: "error", text: `unhandled message type: ${msg.type}` });
    }
  });

  ws.on("close", () => {
    if (ws.playerId) {
      const player = state.players.get(ws.playerId);
      if (player) {
        try {
          accounts.save(player);
        } catch (e) {
          console.error("[lumen] account save failed:", e.message);
        }
        console.log(`[lumen] ${player.name} disconnected (${state.players.size - 1} online).`);
      }
      state.removePlayer(ws.playerId);
      connections.delete(ws.playerId);
    }
  });
});

// ---------------------------------------------------------------------------
// Tick loop — the heartbeat of the living world (DESIGN.md §3.4, §4).
// ---------------------------------------------------------------------------
function dispatchEvent(ev) {
  if (ev.type === "light-out") {
    const player = state.players.get(ev.playerId);
    if (!player) return;
    sendToPlayer(ev.playerId, { type: "log", text: `${world.items[ev.item].name} gutters out. Darkness closes in.` });
    sendToPlayer(ev.playerId, buildRoomView(state, player));
    sendToPlayer(ev.playerId, buildPlayerView(state, player));
    return;
  }

  if (ev.type === "attack") {
    if (ev.by === "player") {
      // The attacker targeted it, so they always know what it is.
      const verb = ev.hit
        ? `hit ${ev.targetName} for ${ev.damage}`
        : ev.sighted
          ? `swing at ${ev.targetName} and miss`
          : `flail at ${ev.targetName} in the dark and miss`;
      sendToPlayer(ev.attackerId, { type: "log", text: `You ${verb}.` });
      // Bystanders only learn the mob's name if they can see it.
      for (const o of state.playersIn(ev.roomId)) {
        if (o.id === ev.attackerId) continue;
        const tn = canSeeMob(o, ev.light, ev.targetEmitsLight) ? ev.targetName : "something";
        sendToPlayer(o.id, { type: "log", text: `${ev.attackerName} ${ev.hit ? "strikes" : "lunges at"} ${tn}.` });
      }
      const attacker = state.players.get(ev.attackerId);
      if (attacker && ev.targetHp > 0) {
        const view = buildExamineView(state, attacker, ev.targetId);
        if (view) sendToPlayer(ev.attackerId, view);
      }
    } else {
      const target = state.players.get(ev.targetId);
      const seen = target && canSeeMob(target, ev.light, ev.attackerEmitsLight);
      const who = seen ? ev.attackerName : "something";
      const youLine = ev.hit
        ? `${cap(who)} hits you for ${ev.damage}!`
        : seen
          ? `${cap(who)} ${ev.sighted ? "misses you" : "lunges out of the dark and misses"}.`
          : "Something lunges out of the dark and misses.";
      sendToPlayer(ev.targetId, { type: "log", text: youLine });
      if (target) sendToPlayer(ev.targetId, buildPlayerView(state, target));
      for (const o of state.playersIn(ev.roomId)) {
        if (o.id === ev.targetId) continue;
        const an = canSeeMob(o, ev.light, ev.attackerEmitsLight) ? ev.attackerName : "something";
        sendToPlayer(o.id, { type: "log", text: `${cap(an)} attacks ${ev.targetName}.` });
      }
    }
    return;
  }

  if (ev.type === "combat-stop") {
    sendToPlayer(ev.playerId, { type: "log", text: ev.reason });
    return;
  }

  if (ev.type === "death" && ev.victimKind === "mob") {
    const lootTxt = ev.loot.length ? ` It leaves behind ${ev.loot.join(", ")}.` : "";
    roomCtx.toRoom(ev.roomId, { type: "log", text: `${ev.victimName} dies.${lootTxt}` }, ev.killerId);
    const killer = state.players.get(ev.killerId);
    if (killer) {
      sendToPlayer(ev.killerId, { type: "log", text: `You slay ${ev.victimName}!${ev.xp ? ` (+${ev.xp} xp)` : ""}${lootTxt}` });
      sendToPlayer(ev.killerId, buildRoomView(state, killer));
      sendToPlayer(ev.killerId, buildPlayerView(state, killer));
    }
    roomCtx.refreshRoom(ev.roomId, ev.killerId);
    return;
  }

  if (ev.type === "death" && ev.victimKind === "player") {
    const victim = state.players.get(ev.victimId);
    sendToPlayer(ev.victimId, { type: "system", text: "You have fallen in the dark. You awaken at the rim." });
    if (victim) {
      sendToPlayer(ev.victimId, buildRoomView(state, victim));
      sendToPlayer(ev.victimId, buildPlayerView(state, victim));
    }
    roomCtx.toRoom(ev.roomId, { type: "log", text: `${ev.victimName} falls.` }, ev.victimId);
    roomCtx.refreshRoom(ev.roomId, ev.victimId);
    roomCtx.refreshRoom(ev.respawnRoom, ev.victimId);
  }
}

const tickTimer = setInterval(() => {
  for (const ev of state.advance()) dispatchEvent(ev);
  if (state.tick % SNAPSHOT_EVERY_TICKS === 0) {
    for (const player of state.players.values()) {
      try {
        accounts.save(player);
      } catch (e) {
        console.error("[lumen] account save failed:", e.message);
      }
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
