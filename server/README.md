# Lumen Server

Authoritative, in-memory game server for Lumen. Loads the static world
(`data/world/`) into memory, runs the living-world tick loop, and serves both
the browser client and the live WebSocket on a single port.

## Running

```sh
# Live server (default port 3737)
npm start
#   → http://localhost:3737

# Test server (adjacent port, throwaway world)
PORT=3738 node server/index.js          # macOS / Linux
$env:PORT=3738; node server\index.js     # Windows PowerShell
```

| Instance | Port | Purpose |
|----------|------|---------|
| Main     | 3737 | Live shared world |
| Test     | 3738 | Throwaway / dev instance |

The port is overridable via the `PORT` environment variable.

Until the real client lands (PR #3), opening the root URL serves a **temporary
dev console** — a bare WebSocket tester so the server is previewable.

## Architecture

- **`config.js`** — ports, tick interval, paths, version.
- **`light.js`** — the light model: `bandOf`, `effectiveLight`, `canSee`, `isHarmedByLight`.
- **`world.js`** — `loadWorld()`: reads static content into a frozen object.
- **`state.js`** — `GameState`: authoritative dynamic state (players, per-room
  mob/item instances), light computation, tick advance, snapshotting.
- **`index.js`** — HTTP + WebSocket server, connection handling, tick loop.

Dynamic state is snapshotted to `data/runtime/` (gitignored) every
`SNAPSHOT_EVERY_TICKS` ticks.

## WebSocket message protocol (v0)

JSON messages over a single socket per player.

**Client → Server**

```json
{ "type": "command", "text": "look" }
```

**Server → Client**

```json
{ "type": "system",  "text": "Welcome to Lumen…" }   // session/world notices
{ "type": "log",     "text": "A lightbug drifts in." } // event feed
{ "type": "error",   "text": "malformed message" }     // problems
```

Richer structured messages (`room`, `player`, light level, entity lists) are
added alongside real command handling in PR #4.
