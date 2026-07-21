"use strict";
/**
 * Admin-only commands, prefixed with '@'. A dev affordance, not authored content.
 */
const crypto = require("crypto");
const { buildPlayerView } = require("../render");
const { makeItemInstance } = require("../state");
const accounts = require("../accounts");
const { INVITE_KEY_HASH } = require("../config");
const { ADMIN_HELP_SECTION, helpEntry } = require("./help");
const {
  cap, NOOP_CTX, TRAINABLE, selfAndViews, err, logMsg, announce, announceLevelUps, addToInventory,
} = require("./shared");

function handleAdmin(state, player, verb, arg, ctx = NOOP_CTX) {
  if (!player.isAdmin) return err("You lack the authority for that.");
  switch (verb) {
    case "@create-player": {
      const v = accounts.validateName(arg);
      if (!v.ok) return err(v.reason);
      if (accounts.exists(v.name)) return err(`A delver named "${v.name}" already exists.`);
      accounts.save(state.createCharacter(v.name, {}));
      return logMsg(`Created delver "${v.name}". They may now log in.`);
    }
    case "@list-players":
      return logMsg("Delvers: " + (accounts.listNames().join(", ") || "(none)"));
    case "@shards": {
      const n = parseInt(arg, 10);
      if (!Number.isFinite(n) || n < 0) return err("Usage: @shards <amount>");
      player.shards = n;
      return logMsg(`Your purse now holds ${n} shards.`);
    }
    case "@xp": {
      const n = parseInt(arg, 10);
      if (!Number.isFinite(n) || n < 1) return err("Usage: @xp <amount≥1>");
      const ups = state.awardXp(player, n); // mirrors a kill's award, level-ups and all
      const out = logMsg(`You gain ${n} xp.`);
      announceLevelUps(player, ups, ctx, out);
      out.push(buildPlayerView(state, player));
      return out;
    }
    case "@attr": {
      const [name, raw] = arg.split(/\s+/);
      const attr = (name || "").toLowerCase();
      const n = parseInt(raw, 10);
      if (!TRAINABLE.includes(attr) || !Number.isFinite(n) || n < 1)
        return err(`Usage: @attr <${TRAINABLE.join("|")}> <value≥1>`);
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
        return err(`Usage: @spawn <mobId> [count] [${FACTION_OVERRIDES.join("|")}]. Unknown mob "${mobId || ""}".`);
      const faction = rawFaction ? rawFaction.toLowerCase() : null;
      if (faction && !FACTION_OVERRIDES.includes(faction))
        return err(`Usage: @spawn <mobId> [count] [${FACTION_OVERRIDES.join("|")}]. Unknown faction "${rawFaction}".`);
      const n = Math.max(1, Math.min(10, parseInt(rawN, 10) || 1));
      for (let i = 0; i < n; i++) {
        const m = state._spawnMob(player.location, mobId);
        if (faction) m.faction = faction;
        if (faction === "player") m.ownerId = player.id;
      }
      state.rooms[player.location].light = state.computeRoomLight(player.location); // a luminous mob lights the room
      const t = state.world.mobs[mobId];
      announce(ctx, player, `${cap(t.name)} flickers into being.`);
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
        return err(`Usage: @give <itemId> [count]. Unknown item "${itemId || ""}".`);
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
        return err(`Usage: @teleport <roomId>. Unknown room "${dest || ""}".`);
      if (dest === player.location)
        return logMsg(`You are already in ${dest}.`);
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
      // current phase. A dev affordance, not authored content. Phases come from the
      // resolved tide config, so a re-storied world's phase names still work.
      const PHASES = state.tide.phases;
      const a = (arg || "").trim().toLowerCase();
      if (a === "status")
        return logMsg(`Tide phase: ${state.tidePhase}${state.tideOverride ? " (forced)" : " (auto)"}.`);
      if (a === "" || a === "auto") {
        state.tideOverride = null;
        return logMsg(`Tide clock resumed (auto). Current phase: ${state.tidePhase}.`);
      }
      if (!PHASES.includes(a))
        return err(`Usage: @tide <${PHASES.join("|")}|auto|status>. Unknown phase "${a}".`);
      for (const ev of state.forceTidePhase(a)) ctx.emit(ev);
      return logMsg(`Tide forced to "${a}" (pinned — "@tide auto" to resume the clock).`);
    }
    case "@reset-password": {
      // Clear a player's password so they set a fresh one on next login (the
      // recovery path — there's no email/self-service reset). The player picks
      // their own new password via claim-on-first-login; the admin never handles
      // plaintext. Refused while the target is online (a live snapshot would
      // rewrite the hash back, and they wouldn't need a reset anyway) and for the
      // admin account (its password is managed via the ADMIN_PASSWORD env).
      const v = accounts.validateName(arg);
      if (!v.ok) return err(v.reason);
      if (!accounts.exists(v.name)) return err(`No player named "${v.name}".`);
      const data = accounts.load(v.name);
      if (data.isAdmin) return err("The admin password is managed via the ADMIN_PASSWORD env var, not here.");
      for (const p of state.players.values())
        if (p.name.toLowerCase() === v.name.toLowerCase())
          return err(`"${p.name}" is currently logged in — have them log out before resetting.`);
      if (!accounts.clearPassword(v.name))
        return logMsg(`"${data.name}" has no password set — they'll set one on next login already.`);
      return logMsg(`Reset "${data.name}". Their password is cleared — they set a new one on next login. Have them log in promptly (the account is claimable until they do).`);
    }
    case "@invite-key": {
      // Set / rotate / clear the new-player registration key live, without a
      // restart — useful where the boot env is awkward to change (e.g. Fly.io).
      // A runtime override (accounts.writeInviteHash) wins over the
      // INVITE_KEY_HASH env default; only the hash is stored, so an existing key
      // can be reset but never read back. Subcommands: status | new | set <key> |
      // off. See server/index.js activeInviteHash for the precedence.
      const [sub, ...rest] = (arg || "").trim().split(/\s+/);
      const cmd = (sub || "status").toLowerCase();
      const source = () => (accounts.loadInviteHash() ? "server (@invite-key)" : INVITE_KEY_HASH ? "INVITE_KEY_HASH env" : null);
      if (cmd === "status") {
        const src = source();
        return logMsg(
          src
            ? `Invite gate: ON (${src}). Creating a prospector and claiming an unclaimed one both need the key. The key is stored hashed — it can't be shown, only reset with "@invite-key new". "@invite-key off" clears the server override.`
            : `Invite gate: OFF — registration is open. "@invite-key new" generates a key and turns it on.`
        );
      }
      if (cmd === "new") {
        const key = crypto.randomBytes(12).toString("base64url"); // ~16 shareable chars
        accounts.writeInviteHash(accounts.hashInviteKey(key));
        return logMsg(
          `New invitation key: <#gold>${key}<#reset>\nShare it with invitees — it's stored hashed and won't be shown again. The gate is now ON (server override).`
        );
      }
      if (cmd === "set") {
        const key = rest.join(" ");
        if (key.length < 6) return err('Usage: @invite-key set <key> (min 6 characters).');
        accounts.writeInviteHash(accounts.hashInviteKey(key));
        return logMsg(`Invitation key set (server override). The gate is now ON. New players must present this key.`);
      }
      if (cmd === "off" || cmd === "clear") {
        const had = accounts.clearInviteHash();
        if (INVITE_KEY_HASH)
          return logMsg(`${had ? "Server invite override cleared." : "No server override was set."} The gate falls back to the INVITE_KEY_HASH env key (still ON).`);
        return logMsg(had ? "Invite gate disabled — registration is now open." : "No invitation key was set — registration is already open.");
      }
      return err('Usage: @invite-key <status|new|set <key>|off>.');
    }
    case "@help": {
      const lines = ["<#gold>Admin commands<#reset>", ""];
      for (const e of ADMIN_HELP_SECTION[1]) lines.push(helpEntry(e));
      return logMsg(lines.join("\n"));
    }
    default:
      return err(`Unknown admin command: "${verb}". Try "@help".`);
  }
}

module.exports = { handleAdmin };
