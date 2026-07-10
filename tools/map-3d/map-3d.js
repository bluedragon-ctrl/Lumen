#!/usr/bin/env node
/**
 * Lumen 3D map — a local, browser-based, READ-ONLY view of the whole world as a
 * rotatable / zoomable 3D model. Rooms are nodes (labelled with name + id),
 * exits are edges; depth is the vertical axis. Dependency-free (a tiny vanilla
 * canvas 3D engine), so it also runs as a standalone HTML file offline.
 *
 *   node tools/map-3d/map-3d.js            # serves http://localhost:3945
 *   MAP_3D_PORT                            # override the port
 *
 *   node tools/map-3d/map-3d.js --build    # bake current data into a single
 *                                          # standalone file: tools/map-3d/lumen-map.html
 *
 * This tool never writes to world data — it only reads data/world/rooms.json,
 * and (in --build) emits a self-contained HTML file you can open directly.
 */
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", ".."); // tools/map-3d/ -> repo root
const ROOMS_PATH = path.join(ROOT, "data", "world", "rooms.json");
const FIXTURES_PATH = path.join(ROOT, "data", "world", "fixtures.json");
const PAGE_PATH = path.join(__dirname, "map-3d.html");
const OUT_PATH = path.join(__dirname, "lumen-map.html");
const PORT = Number(process.env.MAP_3D_PORT) || 3945;

function readJSON(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function sendJSON(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

// Resolve door fixtures into a per-room `doorExits` map so the map shows them as
// real connections (the validator treats a door fixture as a graph edge too).
// A door room is otherwise reachable only through the door, so without this it
// would float off on its own; here it links to its neighbour like any exit.
function withDoorExits(rooms) {
  let fixtures = {};
  try { fixtures = readJSON(FIXTURES_PATH); } catch { /* fixtures optional */ }
  for (const room of Object.values(rooms)) {
    const doors = {};
    for (const fid of room.fixtures || []) {
      const f = fixtures[fid];
      if (f && f.door && f.door.to) {
        doors[f.door.dir] = { to: f.door.to, fixture: fid, locked: !!f.door.key };
      }
    }
    if (Object.keys(doors).length) room.doorExits = doors;
  }
  return rooms;
}

// Bake the live data into the page as `window.LUMEN_WORLD` so the result is a
// single, self-contained HTML file (no server, no fetch, works offline).
function buildStandalone() {
  const rooms = withDoorExits(readJSON(ROOMS_PATH));
  const page = fs.readFileSync(PAGE_PATH, "utf8");
  // Escape "<" so no room prose containing "</script>" can break out of the tag
  // (< is valid JSON and parses back to "<").
  const json = JSON.stringify(rooms).replace(/</g, "\\u003c");
  const inject = `<script>window.LUMEN_WORLD = ${json};</script>\n`;
  // Insert just before the first <script> so the data exists before the engine runs.
  const out = page.replace(/<script>/, inject + "<script>");
  fs.writeFileSync(OUT_PATH, out, "utf8");
  console.log(`[map-3d] baked ${Object.keys(rooms).length} rooms into ${path.relative(ROOT, OUT_PATH)}`);
  console.log(`[map-3d] open that file directly in a browser — no server needed.`);
}

const server = http.createServer((req, res) => {
  try {
    if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return void res.end(fs.readFileSync(PAGE_PATH, "utf8"));
    }
    if (req.method === "GET" && req.url === "/api/world") {
      // Always re-read from disk so the map reflects current data on each reload.
      const rooms = withDoorExits(readJSON(ROOMS_PATH));
      return void sendJSON(res, 200, { ok: true, rooms });
    }
    res.writeHead(404).end("Not found");
  } catch (e) {
    sendJSON(res, 500, { ok: false, error: e.message });
  }
});

if (require.main === module) {
  if (process.argv.includes("--build")) {
    buildStandalone();
  } else {
    server.listen(PORT, () => {
      console.log(`[map-3d] reading ${path.relative(ROOT, ROOMS_PATH)} (read-only)`);
      console.log(`[map-3d] open  http://localhost:${PORT}`);
    });
  }
}

module.exports = { server, buildStandalone };
