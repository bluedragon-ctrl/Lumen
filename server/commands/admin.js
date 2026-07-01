"use strict";
/**
 * Admin-only commands, prefixed with '@'. A dev affordance, not authored content.
 */
const { buildPlayerView } = require("../render");
const { makeItemInstance } = require("../state");
const accounts = require("../accounts");
const { ADMIN_HELP_SECTION, helpEntry } = require("./help");
const {
  cap, NOOP_CTX, TRAINABLE, selfAndViews, announceLevelUps, addToInventory,
} = require("./shared");

function handleAdmin(state, player, verb, arg, ctx = NOOP_CTX) {
  if (!player.isAdmin) return [{ type: "error", text: "You lack the authority for that." }];
  switch (verb) {
    case "@create-player": {
      const v = accounts.validateName(arg);
      if (!v.ok) return [{ type: "error", text: v.reason }];
      if (accounts.exists(v.name)) return [{ type: "error", text: `A delver named "${v.name}" already exists.` }];
      accounts.save(state.createCharacter(v.name, {}));
      return [{ type: "log", text: `Created delver "${v.name}". They may now log in.` }];
    }
    case "@list-players":
      return [{ type: "log", text: "Delvers: " + (accounts.listNames().join(", ") || "(none)") }];
    case "@shards": {
      const n = parseInt(arg, 10);
      if (!Number.isFinite(n) || n < 0) return [{ type: "error", text: "Usage: @shards <amount>" }];
      player.shards = n;
      return [{ type: "log", text: `Your purse now holds ${n} shards.` }];
    }
    case "@xp": {
      const n = parseInt(arg, 10);
      if (!Number.isFinite(n) || n < 1) return [{ type: "error", text: "Usage: @xp <amount≥1>" }];
      const ups = state.awardXp(player, n); // mirrors a kill's award, level-ups and all
      const out = [{ type: "log", text: `You gain ${n} xp.` }];
      announceLevelUps(player, ups, ctx, out);
      out.push(buildPlayerView(state, player));
      return out;
    }
    case "@attr": {
      const [name, raw] = arg.split(/\s+/);
      const attr = (name || "").toLowerCase();
      const n = parseInt(raw, 10);
      if (!TRAINABLE.includes(attr) || !Number.isFinite(n) || n < 1)
        return [{ type: "error", text: `Usage: @attr <${TRAINABLE.join("|")}> <value≥1>` }];
      player.attributes[attr] = n;
      state.deriveStats(player); // recompute maxHp/maxMana/sight from the new attributes
      player.hp = Math.min(player.hp, player.maxHp);
      player.mana = Math.min(player.mana || 0, player.maxMana);
      return selfAndViews(state, player, `Your ${attr} is now ${n}.`);
    }
    case "@spawn": {
      // Drop a mob (by template id) into the admin's current room — a testing aid
      // for mobs not yet placed in any room's spawn list. By default the instance
      // takes its template faction; an optional trailing faction
      // (wild|player|rim|fauna) overrides it so any side can be exercised live (a
      // "player" override also stamps ownerId = admin). A dev affordance, not
      // authored content.
      const FACTION_OVERRIDES = ["wild", "player", "rim", "fauna", "umbral", "outlaw"];
      const [mobId, rawN, rawFaction] = arg.split(/\s+/);
      if (!mobId || !state.world.mobs[mobId])
        return [{ type: "error", text: `Usage: @spawn <mobId> [count] [${FACTION_OVERRIDES.join("|")}]. Unknown mob "${mobId || ""}".` }];
      const faction = rawFaction ? rawFaction.toLowerCase() : null;
      if (faction && !FACTION_OVERRIDES.includes(faction))
        return [{ type: "error", text: `Usage: @spawn <mobId> [count] [${FACTION_OVERRIDES.join("|")}]. Unknown faction "${rawFaction}".` }];
      const n = Math.max(1, Math.min(10, parseInt(rawN, 10) || 1));
      for (let i = 0; i < n; i++) {
        const m = state._spawnMob(player.location, mobId);
        if (faction) m.faction = faction;
        if (faction === "player") m.ownerId = player.id;
      }
      state.rooms[player.location].light = state.computeRoomLight(player.location); // a luminous mob lights the room
      const t = state.world.mobs[mobId];
      ctx.toRoom(player.location, { type: "log", text: `${cap(t.name)} flickers into being.` }, player.id);
      ctx.refreshRoom(player.location, player.id);
      const tag = faction === "player" ? " (player-allied)" : "";
      return selfAndViews(state, player, `Spawned ${n}× ${t.name}${tag} here.`);
    }
    case "@give": {
      // Drop an item (by template id) straight into the admin's pack — a testing
      // aid for gear/consumables/materials you'd otherwise have to craft or grind
      // for. `count` stacks for stackables, else mints that many instances; it is
      // clamped to a sane ceiling.
      const [itemId, rawN] = arg.split(/\s+/);
      if (!itemId || !state.world.items[itemId])
        return [{ type: "error", text: `Usage: @give <itemId> [count]. Unknown item "${itemId || ""}".` }];
      const t = state.world.items[itemId];
      const n = Math.max(1, Math.min(99, parseInt(rawN, 10) || 1));
      if (t.stackable) {
        addToInventory(player, makeItemInstance({ template: itemId, qty: n }, state.world), state.world);
      } else {
        for (let i = 0; i < n; i++) addToInventory(player, makeItemInstance({ template: itemId }, state.world), state.world);
      }
      return selfAndViews(state, player, `Conjured ${n}× ${t.name} into your pack.`);
    }
    case "@teleport": {
      // Jump straight to any room by id — a dev affordance for reaching deep or
      // out-of-the-way rooms without walking the whole descent. Minimal by design:
      // it seats the player (the same setPlayerLocation used to place a freshly
      // created delver), recomputes light for both rooms, and refreshes bystanders.
      // No exploration xp, quest triggers, or summon-follow — that's what walking
      // is for. A dev affordance, not authored content.
      const dest = (arg || "").trim();
      if (!dest || !state.world.rooms[dest])
        return [{ type: "error", text: `Usage: @teleport <roomId>. Unknown room "${dest || ""}".` }];
      if (dest === player.location)
        return [{ type: "log", text: `You are already in ${dest}.` }];
      const from = player.location;
      player.pending = null; // a jump breaks off any attack
      state.clearRevealedMobs(player.id); // leaving re-hides any lurkers you'd spotted
      ctx.toRoom(from, { type: "log", text: `${player.name} vanishes.` }, player.id);
      state.setPlayerLocation(player, dest);
      state.rooms[dest].light = state.computeRoomLight(dest);
      state.rooms[from].light = state.computeRoomLight(from);
      ctx.refreshRoom(from, player.id);
      ctx.toRoom(dest, { type: "log", text: `${player.name} appears out of nowhere.` }, player.id);
      ctx.refreshRoom(dest, player.id);
      return selfAndViews(state, player, `You blink to ${dest}.`);
    }
    case "@tide": {
      // Drive the world clock by hand for testing (see state.forceTidePhase /
      // world-clock.js). `auto` resumes the automatic cycle; `status` reports the
      // current phase. A dev affordance, not authored content.
      const PHASES = ["calm", "stirring", "tide", "receding"];
      const a = (arg || "").trim().toLowerCase();
      if (a === "status")
        return [{ type: "log", text: `Tide phase: ${state.tidePhase}${state.tideOverride ? " (forced)" : " (auto)"}.` }];
      if (a === "" || a === "auto") {
        state.tideOverride = null;
        return [{ type: "log", text: `Tide clock resumed (auto). Current phase: ${state.tidePhase}.` }];
      }
      if (!PHASES.includes(a))
        return [{ type: "error", text: `Usage: @tide <${PHASES.join("|")}|auto|status>. Unknown phase "${a}".` }];
      for (const ev of state.forceTidePhase(a)) ctx.emit(ev);
      return [{ type: "log", text: `Tide forced to "${a}" (pinned — "@tide auto" to resume the clock).` }];
    }
    case "@help": {
      const lines = ["<#gold>Admin commands<#reset>", ""];
      for (const e of ADMIN_HELP_SECTION[1]) lines.push(helpEntry(e));
      return [{ type: "log", text: lines.join("\n") }];
    }
    default:
      return [{ type: "error", text: `Unknown admin command: "${verb}". Try "@help".` }];
  }
}

module.exports = { handleAdmin };
