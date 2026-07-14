"use strict";
/**
 * The Scheduler (world-clock-independent timed events), split out of state.js as a
 * mixin (see the `mixin()` note in state.js — the class here is never instantiated;
 * its prototype methods are copied onto GameState.prototype, so every `this` is a
 * GameState).
 *
 * A data-driven list of scheduled entries (data/world/schedule.json) each fire on
 * their own cadence and delegate the effect to an action-type handler
 * (schedule-actions.js). The engine is generic — it owns only the timers; what
 * actually happens is the handler's business — so new timed behaviours are added by
 * writing a handler, not by touching this file. The first action type is `visit`
 * (an NPC arrives, trades a while, then leaves — the visiting trader).
 *
 * Purely in-memory, like the spawners and the Tide: state/tick/mobs are not
 * snapshotted (only players persist), so the schedule resets cleanly on restart.
 */
const { SCHEDULE_ACTIONS } = require("./schedule-actions");

class SchedulerMixin {
  /**
   * Build the live schedule from static config. Each entry keeps two independent
   * countdowns so cadence is a literal "every `everyTicks`": `fireTimer` to the
   * next fire, and (once a duration action is running) `endTimer` to its close.
   * The first fire lands after `firstTicks` (default `everyTicks`), so a fresh
   * world isn't populated the instant it boots.
   */
  _initSchedule() {
    this.scheduled = [];
    for (const cfg of this.world.schedule || []) {
      const first = cfg.firstTicks != null ? cfg.firstTicks : cfg.everyTicks;
      this.scheduled.push({ cfg, fireTimer: first, endTimer: null, active: false, mob: null });
    }
  }

  /**
   * Advance every scheduled entry one tick. A running duration action closes when
   * its `endTimer` runs out; an entry fires when its `fireTimer` runs out (rearmed
   * to `everyTicks` at once). A fire is skipped while the entry is still active —
   * so an `everyTicks` shorter than a visit's `stayTicks` can't stack a second
   * arrival on top of the first. A handler returning a positive duration becomes a
   * duration action (the engine schedules its `end`); anything else is a one-shot.
   */
  _scheduleTick(events) {
    for (const entry of this.scheduled) {
      const handler = SCHEDULE_ACTIONS[entry.cfg.action && entry.cfg.action.type];
      if (!handler) continue; // unknown action type — validator rejects these up front

      if (entry.active && entry.endTimer != null) {
        if (--entry.endTimer <= 0) {
          if (handler.end) handler.end(this, entry, events);
          entry.active = false;
          entry.endTimer = null;
        }
      }

      if (--entry.fireTimer <= 0) {
        entry.fireTimer = entry.cfg.everyTicks;
        if (entry.active) continue; // still mid-action — don't overlap a second fire
        const dur = handler.fire(this, entry, events);
        if (dur > 0) { entry.active = true; entry.endTimer = dur; }
      }
    }
  }
}

module.exports = SchedulerMixin;
