"use strict";
// Room-graph pathfinding — pure functions over the static room map (`world.rooms`,
// a `{ roomId: { exits: { dir: destRoomId } } }` shape). No runtime/`this` state,
// so they're unit-testable in isolation and shared by anything that walks the
// exit graph. Currently drives mob cross-room pursuit (see state-mobai.js
// `_pursue`): the first-step direction toward a quarry and the leash distance from
// a mob's spawn room. Directed — exits are followed exactly as authored, so a
// pursuer paths the way a delver actually walked (a one-way drop isn't a path back).

/** First step (exit direction) along a shortest path from `from` to `to` over the
 *  room exit graph, or null if `to` is unreachable or equals `from`. */
function bfsNextDir(rooms, from, to) {
  if (from === to) return null;
  const seen = new Set([from]);
  const queue = [];
  for (const [dir, dest] of Object.entries(rooms[from].exits || {})) {
    if (!rooms[dest] || seen.has(dest)) continue;
    seen.add(dest);
    if (dest === to) return dir;
    queue.push({ room: dest, first: dir });
  }
  while (queue.length) {
    const { room, first } = queue.shift();
    for (const dest of Object.values(rooms[room].exits || {})) {
      if (!rooms[dest] || seen.has(dest)) continue;
      seen.add(dest);
      if (dest === to) return first;
      queue.push({ room: dest, first });
    }
  }
  return null;
}

/** Shortest-path room count from `from` to `to` over the exit graph (0 if equal,
 *  Infinity if unreachable). Leashes pursuit to a range of rooms from home. */
function bfsDist(rooms, from, to) {
  if (from === to) return 0;
  const seen = new Set([from]);
  let frontier = [from], dist = 0;
  while (frontier.length) {
    dist++;
    const next = [];
    for (const room of frontier) {
      for (const dest of Object.values(rooms[room].exits || {})) {
        if (!rooms[dest] || seen.has(dest)) continue;
        if (dest === to) return dist;
        seen.add(dest);
        next.push(dest);
      }
    }
    frontier = next;
  }
  return Infinity;
}

module.exports = { bfsNextDir, bfsDist };
