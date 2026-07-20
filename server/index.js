"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

const { PORT, TICK_MS, SNAPSHOT_EVERY_TICKS, CLIENT_DIR, VERSION, SHOW_ADMIN_LOGIN } = require("./config");
const { loadWorld } = require("./world");
const { GameState } = require("./state");
const { buildRoomView, buildPlayerView } = require("./render");
const { execute } = require("./commands");
const { createDispatcher } = require("./events");
const accounts = require("./accounts");

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

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

// The default admin account is always present (auto-created if missing). On a
// public deploy, set ADMIN_PASSWORD in the environment so the admin can't be
// claimed by the first visitor to reach the login screen; it's stamped onto the
// account at boot (creating or rotating the password). In local dev you can
// leave it unset and claim a password on first login like any other account.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!accounts.exists("admin")) {
  const admin = state.createCharacter("admin", { isAdmin: true });
  if (ADMIN_PASSWORD) Object.assign(admin, accounts.hashPassword(ADMIN_PASSWORD));
  accounts.save(admin);
  console.log('[lumen] created default admin account ("admin").');
} else if (ADMIN_PASSWORD) {
  const admin = accounts.load("admin");
  Object.assign(admin, accounts.hashPassword(ADMIN_PASSWORD));
  accounts.save(admin);
  console.log("[lumen] admin password set from ADMIN_PASSWORD.");
}
if (SHOW_ADMIN_LOGIN && !accounts.hasPassword(accounts.load("admin"))) {
  console.warn(
    "[lumen] WARNING: the admin account has no password — the first visitor can claim it. " +
      "Set ADMIN_PASSWORD before a public deploy (or SHOW_ADMIN_LOGIN=0 to hide admin login)."
  );
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

// Push the current Tide status to every connected delver (the HUD indicator on
// the shards line). Sent on each phase change and on a slow heartbeat so the
// bar creeps forward between phases; it's a tiny frame, not a view rebuild.
function broadcastTide() {
  const data = JSON.stringify({ type: "tide", ...state.tideStatus() });
  for (const ws of connections.values()) if (ws && ws.readyState === ws.OPEN) ws.send(data);
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
    if (!p) continue;
    const view = buildRoomView(state, p);
    view.room.reactive = true; // a passive refresh — must not steal an open examine view
    sendToPlayer(id, view);
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

// Event rendering (tick/command events -> client messages) lives in events.js;
// hand it this file's live state and transport helpers. `dispatchEvent` is safe
// to reference above — nothing emits until the server is listening.
const dispatchEvent = createDispatcher({
  state,
  world,
  roomCtx,
  sendToPlayer,
  sendRawToPlayer,
  broadcastTide,
  markRoomView,
  markPlayerView,
  markViews,
});

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

// The login-screen roster: pickable prospectors, plus whether an admin login is
// on offer. Admin accounts are never listed among the prospectors — they're
// reached only via the separate (config-hideable) admin option, whose name we
// hand back so the client's one-click button knows who to log in as.
function accountsPayload(notice) {
  const prospectors = [];
  let adminName = null, adminNeedsPassword = false;
  for (const a of accounts.summaries()) {
    // `needsPassword` rides each entry so the client's modal opens in the right
    // mode — "set a password to claim" for a hash-less account, "enter password"
    // otherwise — without a round-trip to discover which.
    if (a.isAdmin) {
      if (adminName == null) { adminName = a.name; adminNeedsPassword = a.needsPassword; }
    } else prospectors.push({ name: a.name, level: a.level, needsPassword: a.needsPassword });
  }
  prospectors.sort((a, b) => a.name.localeCompare(b.name));
  return {
    type: "accounts",
    accounts: prospectors,
    showAdmin: SHOW_ADMIN_LOGIN && adminName != null,
    adminName: SHOW_ADMIN_LOGIN ? adminName : null,
    adminNeedsPassword: SHOW_ADMIN_LOGIN ? adminNeedsPassword : false,
    notice: notice || null,
  };
}

// Reject a name that's currently logged in (shared by login/create/claim/delete).
// Returns true (and sends the error) when the name is in play.
function refuseIfOnline(ws, name, verb) {
  for (const p of state.players.values()) {
    if (p.name.toLowerCase() === name.toLowerCase()) {
      send(ws, { type: "error", text: `"${p.name}" is currently logged in — can't ${verb} them.` });
      return true;
    }
  }
  return false;
}

// Drop an authenticated character into the world: admit, wire the socket, and
// send the opening frames. Callers own authentication (password / claim); this
// is the shared "you're in" path for login, create, and claim.
function enterGame(ws, data) {
  const player = state.admit(data);
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
  send(ws, { type: "tide", ...state.tideStatus() }); // seed the HUD tide indicator
  console.log(`[lumen] ${player.name} logged in (${state.players.size} online).`);
}

// Create a fresh character from the login screen (open registration), setting
// its password in the same step, then drop the creator straight into the world —
// they've just proven intent by choosing the password. Mirrors admin `@create-player`.
function createAccount(ws, rawName, password) {
  const v = accounts.validateName(rawName);
  if (!v.ok) return void send(ws, { type: "error", text: v.reason });
  if (accounts.exists(v.name))
    return void send(ws, { type: "error", text: `A prospector named "${v.name}" already exists.` });
  const pv = accounts.validatePassword(password);
  if (!pv.ok) return void send(ws, { type: "error", text: pv.reason });
  const data = state.createCharacter(v.name, {});
  Object.assign(data, accounts.hashPassword(password));
  accounts.save(data);
  console.log(`[lumen] created prospector "${v.name}" from the login screen.`);
  enterGame(ws, data);
}

// Claim a pre-password account by setting its password on first login (the
// migration path). Refuses accounts that already have a password — only an
// unclaimed account can be claimed — then logs the claimer in.
function claimPassword(ws, rawName, password) {
  const v = accounts.validateName(rawName);
  if (!v.ok) return void send(ws, { type: "error", text: v.reason });
  if (!accounts.exists(v.name))
    return void send(ws, { type: "error", text: `No prospector named "${v.name}".` });
  if (refuseIfOnline(ws, v.name, "claim")) return;
  const data = accounts.load(v.name);
  if (accounts.hasPassword(data))
    return void send(ws, { type: "error", text: `"${data.name}" already has a password — log in instead.` });
  if (data.isAdmin && !SHOW_ADMIN_LOGIN)
    return void send(ws, { type: "error", text: "Admin login is disabled." });
  const pv = accounts.validatePassword(password);
  if (!pv.ok) return void send(ws, { type: "error", text: pv.reason });
  Object.assign(data, accounts.hashPassword(password));
  accounts.save(data);
  console.log(`[lumen] "${data.name}" claimed a password (first login).`);
  enterGame(ws, data);
}

// Permanently delete a character from the login screen. The account's password
// is required — this is the most destructive unauthenticated action. Also guarded
// against the two cases that would corrupt live state: an admin account (never
// deletable here) and a prospector who is currently logged in.
function deleteAccount(ws, rawName, password) {
  const v = accounts.validateName(rawName);
  if (!v.ok) return void send(ws, { type: "error", text: v.reason });
  if (!accounts.exists(v.name))
    return void send(ws, { type: "error", text: `No prospector named "${v.name}".` });
  const data = accounts.load(v.name);
  if (data.isAdmin)
    return void send(ws, { type: "error", text: "The admin account can't be deleted." });
  if (refuseIfOnline(ws, v.name, "delete")) return;
  const chk = accounts.checkPassword(data, password);
  if (!chk.ok)
    return void send(ws, {
      type: "error",
      text: chk.reason === "needs-claim"
        ? `"${data.name}" has no password set yet — claim it (log in and set one) before it can be deleted.`
        : "Incorrect password.",
    });
  accounts.remove(v.name);
  console.log(`[lumen] deleted prospector "${v.name}" from the login screen.`);
  send(ws, accountsPayload(`Deleted prospector "${v.name}".`));
}

function login(ws, rawName, password) {
  const v = accounts.validateName(rawName);
  if (!v.ok) return void send(ws, { type: "error", text: v.reason });
  if (!accounts.exists(v.name))
    return void send(ws, { type: "error", text: `No prospector named "${v.name}".` });
  if (refuseIfOnline(ws, v.name, "log in as")) return;
  const data = accounts.load(v.name);
  // Admin logins can be switched off in config; the account still exists and
  // boots, but it can't be entered from the client.
  if (data.isAdmin && !SHOW_ADMIN_LOGIN)
    return void send(ws, { type: "error", text: "Admin login is disabled." });
  const chk = accounts.checkPassword(data, password);
  if (!chk.ok)
    return void send(ws, {
      type: "error",
      text: chk.reason === "needs-claim"
        ? `"${data.name}" has no password yet — set one to claim this prospector.`
        : "Incorrect password.",
    });
  enterGame(ws, data);
}

wss.on("connection", (ws) => {
  ws.playerId = null; // null until authenticated
  send(ws, accountsPayload()); // seed the login screen with the current roster

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return void send(ws, { type: "error", text: "malformed message (expected JSON)" });
    }
    // Login phase: the socket drives the login screen (pick / create / delete)
    // until a successful login attaches a playerId.
    if (!ws.playerId) {
      switch (msg.type) {
        case "login":
          if (typeof msg.name !== "string") return void send(ws, { type: "error", text: "Please choose a prospector." });
          return void login(ws, msg.name, msg.password);
        case "claim-password":
          return void claimPassword(ws, msg.name, msg.password);
        case "create-account":
          return void createAccount(ws, msg.name, msg.password);
        case "delete-account":
          return void deleteAccount(ws, msg.name, msg.password);
        default:
          return void send(ws, { type: "error", text: "Please choose or create a prospector first." });
      }
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
      // Remember where they stood before removal so we can darken/announce the
      // room for whoever is left — a departing delver may have been its only light.
      let leftRoom = null, leftName = null;
      if (player) {
        leftRoom = player.location;
        leftName = player.name;
        accounts.saveAsync(player).catch((e) => console.error("[lumen] account save failed:", e.message));
        console.log(`[lumen] ${player.name} disconnected (${state.players.size - 1} online).`);
      }
      for (const ev of state.removePlayer(ws.playerId)) dispatchEvent(ev);
      if (leftRoom) {
        // Recompute now that they (and their light) are gone, then tell and refresh
        // the room — both quit and a dropped tab land here, so they read alike.
        state.rooms[leftRoom].light = state.computeRoomLight(leftRoom);
        roomCtx.toRoom(leftRoom, { type: "log", text: `${cap(leftName)} slips away into the dark.` });
        roomCtx.refreshRoom(leftRoom);
      }
      flushViews(); // flush the departing player's room refresh (and any from removePlayer events)
      connections.delete(ws.playerId);
    }
  });
});

// ---------------------------------------------------------------------------
// Tick loop — the heartbeat of the living world (DESIGN.md §3.4, §4).
// ---------------------------------------------------------------------------
const tickTimer = setInterval(() => {
  for (const ev of state.advance()) dispatchEvent(ev);
  flushViews(); // coalesce a tick's worth of view refreshes into one send per player
  if (state.tick % 5 === 0) broadcastTide(); // creep the HUD tide bar forward between phase turns
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
