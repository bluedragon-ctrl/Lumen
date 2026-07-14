"use strict";
/**
 * Scheduler action-type registry (see state-scheduler.js for the engine).
 *
 * The Scheduler is generic: it owns the timers and delegates the actual effect to
 * a handler keyed by `entry.action.type`. Each handler is `{ fire, end? }`:
 *   • `fire(state, entry, events)` runs when the entry's cadence elapses. Return a
 *     positive number of ticks to make it a DURATION action (the engine calls
 *     `end` after that many ticks); return null/0 for a one-shot (fire and rearm).
 *   • `end(state, entry, events)` (optional) closes a duration action.
 * The handler may stash runtime on `entry` (e.g. the spawned mob) between the two.
 *
 * Adding a new timed behaviour = add one handler here (and document its JSON
 * params in docs/data-model.md); no engine changes. The validator imports
 * SCHEDULE_ACTION_TYPES so its whitelist stays in lockstep with this registry.
 */
const { makeMobInstance } = require("./instances");

const SCHEDULE_ACTIONS = {
  /**
   * `visit` — a scheduled arrival: place a mob in a room, then remove it after
   * `stayTicks`. The mob is an ordinary instance (a `shop` template makes it a
   * trader via the usual trade path), tagged `visitor` and carrying NO spawner
   * `origin`, so it never repops or counts against a room's spawn cap. Arrival /
   * departure flavour is the mob's own (`spawnMessage` / `despawnVerb`), reusing
   * the same `mob-spawn` / `mob-flee` events as repop and the Tide.
   */
  visit: {
    fire(state, entry, events) {
      const a = entry.cfg.action;
      const rt = state.rooms[a.room];
      if (!rt) return null; // room removed since authoring (validator guards this)
      const m = makeMobInstance(a.mob, state.world);
      m.visitor = entry.cfg.id; // a scheduled visitor: no `origin`, never repops
      rt.mobs.push(m);
      entry.mob = m;
      const t = state.world.mobs[a.mob];
      const light = (rt.light = state.computeRoomLight(a.room));
      events.push({ type: "mob-spawn", roomId: a.room, mobId: m.id, mobTemplate: a.mob, mobName: t.name, emitsLight: t.emitsLight > 0, light });
      return a.stayTicks; // duration → the engine ends the visit after this many ticks
    },
    end(state, entry, events) {
      const m = entry.mob;
      entry.mob = null;
      if (!m) return;
      // Find the mob wherever it stands (a passive shopkeeper won't wander, but be
      // defensive) and sweep it out like a skittish critter — no corpse, loot, or XP.
      for (const [roomId, rt] of Object.entries(state.rooms)) {
        const idx = rt.mobs.indexOf(m);
        if (idx < 0) continue;
        rt.mobs.splice(idx, 1);
        m.hp = 0; // mark gone for any lingering reference
        const t = state.world.mobs[m.template];
        const light = (rt.light = state.computeRoomLight(roomId));
        events.push({ type: "mob-flee", roomId, mobName: t.name, emitsLight: t.emitsLight > 0, light, verb: t.despawnVerb || "slips away" });
        return;
      }
      // Already gone (killed mid-visit): nothing to remove, and no departure line.
    },
  },
};

const SCHEDULE_ACTION_TYPES = Object.keys(SCHEDULE_ACTIONS);

module.exports = { SCHEDULE_ACTIONS, SCHEDULE_ACTION_TYPES };
