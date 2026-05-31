"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

const { PORT, TICK_MS, SNAPSHOT_EVERY_TICKS, CLIENT_DIR, VERSION } = require("./config");
const { loadWorld } = require("./world");
const { GameState } = require("./state");
const { bandOf } = require("./light");

// ---------------------------------------------------------------------------
// World + state
// ---------------------------------------------------------------------------
const world = loadWorld();
const state = new GameState(world);
console.log(
  `[lumen] world loaded: ${Object.keys(world.rooms).length} rooms, ` +
    `${Object.keys(world.mobs).length} mob templates, ${Object.keys(world.items).length} items.`
);

// ---------------------------------------------------------------------------
// HTTP: serve the client (when it exists) or a temporary dev page.
// ---------------------------------------------------------------------------
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };

function serveClient(req, res) {
  let urlPath = req.url.split("?")[0];
  if (urlPath === "/") urlPath = "/index.html";
  const filePath = path.join(CLIENT_DIR, urlPath);
  // Prevent path traversal outside the client dir.
  if (!filePath.startsWith(CLIENT_DIR)) {
    res.writeHead(403).end("Forbidden");
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      // No client yet (PR #3) — fall back to the dev page at root.
      if (urlPath === "/index.html") {
        res.writeHead(200, { "Content-Type": "text/html" }).end(DEV_PAGE);
      } else {
        res.writeHead(404).end("Not found");
      }
      return;
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
    res.end(data);
  });
}

const httpServer = http.createServer(serveClient);

// ---------------------------------------------------------------------------
// WebSocket: live connection per player.
// ---------------------------------------------------------------------------
const wss = new WebSocketServer({ server: httpServer });

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

wss.on("connection", (ws) => {
  const player = state.createPlayer(`Delver-${state.players.size + 1}`);
  ws.playerId = player.id;

  const room = world.rooms[player.location];
  const light = state.rooms[player.location].light;
  send(ws, { type: "system", text: `Welcome to Lumen v${VERSION}, ${player.name}.` });
  send(ws, {
    type: "system",
    text: `You stand in ${room.name} — light: ${bandOf(light)} (${light}).`,
  });
  console.log(`[lumen] ${player.name} connected (${state.players.size} online).`);

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      send(ws, { type: "error", text: "malformed message (expected JSON)" });
      return;
    }
    // Command handling proper arrives in PR #4; for now, echo as a log line.
    if (msg.type === "command" && typeof msg.text === "string") {
      send(ws, { type: "log", text: `(echo) you typed: ${msg.text}` });
    } else {
      send(ws, { type: "error", text: `unhandled message type: ${msg.type}` });
    }
  });

  ws.on("close", () => {
    state.removePlayer(ws.playerId);
    console.log(`[lumen] ${player.name} disconnected (${state.players.size} online).`);
  });
});

// ---------------------------------------------------------------------------
// Tick loop — the heartbeat of the living world (DESIGN.md §3.4, §4).
// ---------------------------------------------------------------------------
const tickTimer = setInterval(() => {
  state.advance();
  if (state.tick % SNAPSHOT_EVERY_TICKS === 0) {
    try {
      state.snapshot();
    } catch (e) {
      console.error("[lumen] snapshot failed:", e.message);
    }
  }
}, TICK_MS);

httpServer.listen(PORT, () => {
  console.log(`[lumen] listening on http://localhost:${PORT}  (tick ${TICK_MS}ms)`);
});

// Graceful shutdown.
function shutdown() {
  console.log("\n[lumen] shutting down…");
  clearInterval(tickTimer);
  wss.close();
  httpServer.close(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// ---------------------------------------------------------------------------
// Temporary dev page (replaced by the real client in PR #3).
// ---------------------------------------------------------------------------
const DEV_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Lumen — dev</title>
<style>
  body{background:#0b0d10;color:#cdd3da;font:14px/1.5 monospace;margin:0;padding:1rem}
  h1{font-size:1rem;color:#7fb0d0;margin:0 0 .5rem}
  #log{white-space:pre-wrap;border:1px solid #232a31;padding:.5rem;height:60vh;overflow:auto;background:#070809}
  #cmd{width:100%;margin-top:.5rem;background:#070809;color:#cdd3da;border:1px solid #232a31;padding:.4rem;font:inherit}
  .sys{color:#7fb0d0}.err{color:#d07f7f}.log{color:#cdd3da}
</style></head><body>
<h1>Lumen v${VERSION} — temporary dev console (real UI lands in PR #3)</h1>
<div id="log"></div>
<input id="cmd" placeholder="type a command and press Enter…" autofocus>
<script>
  const log=document.getElementById('log'), cmd=document.getElementById('cmd');
  const add=(t,c)=>{const d=document.createElement('div');d.className=c||'log';d.textContent=t;log.appendChild(d);log.scrollTop=log.scrollHeight;};
  const ws=new WebSocket('ws://'+location.host);
  ws.onopen=()=>add('[connected]','sys');
  ws.onclose=()=>add('[disconnected]','err');
  ws.onmessage=e=>{const m=JSON.parse(e.data);add(m.text||JSON.stringify(m), m.type==='error'?'err':m.type==='system'?'sys':'log');};
  cmd.addEventListener('keydown',ev=>{if(ev.key==='Enter'&&cmd.value.trim()){ws.send(JSON.stringify({type:'command',text:cmd.value.trim()}));add('> '+cmd.value,'log');cmd.value='';}});
</script></body></html>`;
