#!/usr/bin/env node
/**
 * Lumen biome preview — a local, browser-based colour lab for room biomes.
 *
 *   node tools/biome-preview/biome-preview.js   # serves http://localhost:3943
 *   BIOME_PREVIEW_PORT                           # override the port
 *
 * The page links the REAL client/styles.css (served at /styles.css), so the
 * preview pane renders exactly what the game does — the biome mechanism, the
 * light bands, and the shipped biome tokens can never drift out of sync here.
 * On top of that it offers colour pickers and a light-band selector so a new
 * biome's hue can be dialled in and the CSS copied straight into styles.css.
 *
 * READ-ONLY: this tool serves files and writes nothing. To make a biome real,
 * paste the generated CSS into client/styles.css and add its name to BIOMES in
 * tools/validate-data.js (the page reminds you).
 */
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", ".."); // tools/biome-preview/ -> repo root
const PAGE_PATH = path.join(__dirname, "biome-preview.html");
const STYLES_PATH = path.join(ROOT, "client", "styles.css");
const PORT = Number(process.env.BIOME_PREVIEW_PORT) || 3943;

const server = http.createServer((req, res) => {
  try {
    if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return void res.end(fs.readFileSync(PAGE_PATH, "utf8"));
    }
    // Serve the live game stylesheet so the preview mirrors the real client.
    if (req.method === "GET" && req.url === "/styles.css") {
      res.writeHead(200, { "Content-Type": "text/css; charset=utf-8" });
      return void res.end(fs.readFileSync(STYLES_PATH, "utf8"));
    }
    res.writeHead(404).end("Not found");
  } catch (e) {
    res.writeHead(500, { "Content-Type": "text/plain" }).end(String(e && e.message));
  }
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`[biome-preview] linking ${path.relative(ROOT, STYLES_PATH)} (read-only)`);
    console.log(`[biome-preview] open  http://localhost:${PORT}`);
  });
}

module.exports = { server };
