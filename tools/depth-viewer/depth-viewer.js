#!/usr/bin/env node
/**
 * Lumen depth viewer — a local, browser-based, READ-ONLY inspector for the world
 * laid out by depth. Pick a depth and see every room on it: description, exits
 * (hidden ones flagged), ground items, fixtures, and spawns resolved to mob
 * names (with population cap and respawn cadence).
 *
 *   node tools/depth-viewer/depth-viewer.js   # serves http://localhost:3944
 *   DEPTH_VIEWER_PORT                          # override the port
 *
 * This tool never writes anything — it only reads data/world/*.json. To EDIT
 * spawn rules use tools/room-editor/; to edit mob stats use tools/mob-editor/.
 */
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", ".."); // tools/depth-viewer/ -> repo root
const ROOMS_PATH = path.join(ROOT, "data", "world", "rooms.json");
const MOBS_PATH = path.join(ROOT, "data", "world", "mobs.json");
const ITEMS_PATH = path.join(ROOT, "data", "world", "items.json");
const PAGE_PATH = path.join(__dirname, "depth-viewer.html");
const PORT = Number(process.env.DEPTH_VIEWER_PORT) || 3944;

function readJSON(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function sendJSON(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

const server = http.createServer((req, res) => {
  try {
    if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return void res.end(fs.readFileSync(PAGE_PATH, "utf8"));
    }
    if (req.method === "GET" && req.url === "/api/world") {
      const rooms = readJSON(ROOMS_PATH);
      const mobs = readJSON(MOBS_PATH);
      // Items are optional context for resolving ground-item names.
      let items = {};
      try { items = readJSON(ITEMS_PATH); } catch { /* items file optional */ }
      // Slim the mob/item maps to just what the viewer renders.
      const mobInfo = {};
      for (const [id, m] of Object.entries(mobs)) {
        mobInfo[id] = { name: m.name || id, maxHp: m.maxHp, hostile: !!m.hostile, faction: m.faction || null };
      }
      const itemInfo = {};
      for (const [id, it] of Object.entries(items)) {
        itemInfo[id] = { name: it.name || id };
      }
      return void sendJSON(res, 200, { ok: true, rooms, mobInfo, itemInfo });
    }
    res.writeHead(404).end("Not found");
  } catch (e) {
    sendJSON(res, 500, { ok: false, error: e.message });
  }
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`[depth-viewer] reading ${path.relative(ROOT, ROOMS_PATH)} (read-only)`);
    console.log(`[depth-viewer] open  http://localhost:${PORT}`);
  });
}

module.exports = { server };
