"use strict";
// Lumen browser client. Renders server messages into the four panes and turns
// typed (and clicked) input into commands. The command system is the single
// source of truth — clicks just inject the equivalent text command.

const $ = (id) => document.getElementById(id);
const logEl = $("log");
const cmdEl = $("cmd");

// Cached state for TAB completion / rendering.
let lastRoom = null;
let lastPlayer = null;

// The entity currently shown in the examine view, and whether it was a thing in
// the room (a mob / floor item / fixture / other player) as opposed to something
// carried or equipped. A reactive room refresh that no longer lists a room-bound
// examined entity means it died / was taken / left — drop the now-stale view.
let examinedId = null;
let examinedRoomBound = false;
function roomHasEntity(room, id) {
  if (!room || !room.contents || id == null) return false;
  const { players, mobs, items, fixtures } = room.contents;
  return [players, mobs, items, fixtures].some((arr) => arr.some((e) => e.id === id));
}

// Inventory filter — persisted across page refreshes.
let invFilter = localStorage.getItem("inv-filter") || "all";
const INV_GROUP = {
  weapon: "gear", armour: "gear", light: "gear",
  consumable: "consumable", scroll: "consumable", recipe: "consumable",
  material: "material", currency: "material", treasure: "material",
};
function filterGroupFor(item) {
  return item.filterGroup ?? INV_GROUP[item.type] ?? "other";
}

// Until authenticated, the command line captures the player's NAME, not commands.
let authed = false;

// --- WebSocket -------------------------------------------------------------
let ws;
// Set when the player `quit`s: a deliberate close, so we don't auto-reconnect.
let loggedOff = false;
function connect() {
  ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host);
  ws.onopen = () => addLine("[connected]", "system");
  ws.onclose = () => {
    authed = false;
    setPrompt();
    if (loggedOff) {
      addLine("[logged off — you may close this tab, or reload the page to return]", "system");
      return; // a deliberate quit: don't auto-retry the connection.
    }
    addLine("[disconnected — retrying in 2s]", "error");
    setTimeout(connect, 2000);
  };
  ws.onmessage = (e) => handle(JSON.parse(e.data));
}
function sendCommand(text) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "command", text }));
  // Clicking a chip/exit/action moves focus to that element; return it to the
  // command line so the player can keep typing without clicking back in.
  cmdEl.focus();
}
function sendLogin(name) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "login", name }));
}
function setPrompt() {
  cmdEl.placeholder = authed
    ? 'type a command — try "look", "down", "light", "help"'
    : 'enter your delver name (or "admin") and press Enter';
}

// --- Message handling ------------------------------------------------------
function handle(msg) {
  switch (msg.type) {
    case "login-required": authed = false; setPrompt(); addLine(msg.text, "system"); break;
    case "authenticated": authed = true; setPrompt(); break;
    case "system": addLine(msg.text, "system"); break;
    case "error": addLine(msg.text, "error"); break;
    case "log": addLine(msg.text, "log"); break;
    case "goodbye": addLine(msg.text, "system"); loggedOff = true; if (ws) ws.close(); break;
    case "combat": addLine(msg.text, "combat"); break;
    case "gold": addLine(msg.text, "gold"); break;
    case "room":
      // A new room id means an actual move (not a look / light flicker) — mark
      // it in the console so the scrollback reads in per-room chapters.
      if (lastRoom && msg.room.id !== lastRoom.id) addRoomDivider(msg.room);
      lastRoom = msg.room;
      renderRoom(msg.room);
      break;
    case "examine": renderExamine(msg.entity); break;
    case "player": lastPlayer = msg.player; renderPlayer(msg.player); break;
    default: addLine(JSON.stringify(msg), "log");
  }
}

// --- Console ---------------------------------------------------------------
// The console is the scrollback (#log) inside its scroll container (#console).
// If the player has scrolled up to read history, new lines must NOT yank the
// view back down (MUD "split scrollback"). Instead we freeze the view and
// surface a "↓ N new messages" pill that jumps to the newest on click.
const consoleEl = logEl.parentElement;
let unreadCount = 0;

// "Pinned" = the player is at (or within a hair of) the bottom, i.e. following
// the live feed. 40px of slack absorbs sub-pixel rounding and line height.
function atBottom() {
  return consoleEl.scrollHeight - consoleEl.scrollTop - consoleEl.clientHeight < 40;
}

function jumpToBottom() {
  consoleEl.scrollTop = consoleEl.scrollHeight;
  unreadCount = 0;
  updateJumpPill();
}

function updateJumpPill() {
  const pill = $("jump-pill");
  if (!pill) return;
  if (unreadCount > 0) {
    pill.textContent = `↓ ${unreadCount} new message${unreadCount === 1 ? "" : "s"}`;
    pill.hidden = false;
  } else {
    pill.hidden = true;
  }
}

function appendToLog(el) {
  const pinned = atBottom();
  logEl.appendChild(el);
  if (pinned) {
    consoleEl.scrollTop = consoleEl.scrollHeight;
  } else {
    unreadCount++;
    updateJumpPill();
  }
}

function addLine(text, kind) {
  const div = document.createElement("div");
  div.className = "line-" + (kind || "log");
  renderMarkup(div, text);
  appendToLog(div);
}

// Inline colour markup: `<#name>` tints the rest of its line with the named
// colour (see .mk-* in styles.css). Colour resets at every newline, so a stray
// tag can never bleed past one line. A non-palette tag (`<#reset>`) is dropped
// and returns the run to the default ink — used to colour just part of a line.
// Other unknown names are dropped silently too. Server
// content uses this (e.g. greyed-out recipes you can't afford, a rainbow boss);
// player-authored text has its tags stripped server-side, so this stays trusted
// styling — we still build spans via textContent, never innerHTML.
const MARKUP_COLOURS = new Set([
  "gray", "grey", "red", "green", "gold", "blue", "cyan", "magenta", "rainbow",
]);
function renderMarkup(parent, text) {
  const re = /<#([a-z0-9-]+)>/gi;
  text.split("\n").forEach((line, i) => {
    if (i > 0) parent.appendChild(document.createTextNode("\n"));
    let idx = 0, cls = null, m;
    const flush = (str) => {
      if (!str) return;
      if (cls) {
        const span = document.createElement("span");
        span.className = cls;
        span.textContent = str;
        parent.appendChild(span);
      } else {
        parent.appendChild(document.createTextNode(str));
      }
    };
    re.lastIndex = 0;
    while ((m = re.exec(line))) {
      flush(line.slice(idx, m.index));
      const name = m[1].toLowerCase() === "grey" ? "gray" : m[1].toLowerCase();
      cls = MARKUP_COLOURS.has(m[1].toLowerCase()) ? "mk-" + name : null;
      idx = re.lastIndex;
    }
    flush(line.slice(idx));
  });
}

// A muted "chapter break" in the console marking arrival in a new room. Inserted
// only on an actual move (room id change), never on look / light flicker.
function addRoomDivider(room) {
  const div = document.createElement("div");
  div.className = "room-divider";
  const span = document.createElement("span");
  span.textContent = room.depth != null ? `${room.name} · depth ${room.depth}` : room.name;
  div.appendChild(span);
  appendToLog(div);
}

// Re-pin (and clear the unread badge) once the player scrolls back to the bottom.
consoleEl.addEventListener("scroll", () => {
  if (atBottom() && unreadCount > 0) {
    unreadCount = 0;
    updateJumpPill();
  }
});

// --- Inspect (room) --------------------------------------------------------
function renderRoom(room) {
  // A reactive refresh (mob entered, someone healed, light flickered) must not
  // yank the Inspect window out of an examine view the player opened. Skip the
  // repaint while examining; lastRoom is already cached for the divider logic,
  // and "look" / the ex-back button re-fetch a fresh room when they return.
  // Exception: if the examined thing was in the room and is now gone from a room
  // we can still see (it died, was picked up, walked off), fall through and
  // repaint so the view doesn't dwell on something that no longer exists.
  if (room.reactive && !$("examine-view").hidden) {
    const vanished = examinedRoomBound && room.canSee && !roomHasEntity(room, examinedId);
    if (!vanished) return;
  }

  // Receiving a room view (on move / look / light change) returns the Inspect
  // window from any examine view back to the live room.
  $("examine-view").hidden = true;
  $("room-view").hidden = false;
  const inspect = $("inspect");
  inspect.className = "pane light-" + room.light.band;
  $("room-name").textContent = room.name;
  $("light-meter").textContent =
    `light: ${room.light.band} (${room.light.value})` +
    (room.light.band === "void" ? " ⚠ blind" : "") +
    (room.harmed ? " ⚠ harsh" : "");

  const desc = $("room-desc");
  if (room.canSee) {
    desc.className = "room-desc";
    desc.textContent = room.description || "";
  } else {
    desc.className = "room-desc placeholder";
    desc.textContent = "It is too dark to see. You can make out nothing here — a light source would help.";
  }

  // Exits
  const exits = $("room-exits");
  exits.innerHTML = "";
  if (room.exits.length) {
    exits.appendChild(label("exits:"));
    for (const e of room.exits) exits.appendChild(chip(e.to ? `${e.dir} → ${e.to}` : e.dir, "exit", () => sendCommand(e.dir)));
  }

  // Contents
  const c = $("room-contents");
  c.innerHTML = "";
  const { players, mobs, items, fixtures } = room.contents;
  // Clicks address entities by their unique id (unambiguous), not by name.
  // A posture tag (e.g. "Bob (asleep)") surfaces sit/sleep to others in the room.
  const posture = (e) => (e.posture ? ` (${e.posture})` : "");
  for (const p of players) c.appendChild(chip(p.name + posture(p), "player" + (p.luminous ? " luminous" : ""), () => sendCommand("look " + p.id)));
  for (const m of mobs) {
    // Your own summons read friendly (blue), overriding the enemy-red tint.
    const cls = "mob" + (m.owned ? " owned" : m.hostile ? " hostile" : "") + (m.luminous ? " luminous" : "");
    c.appendChild(chip(m.name + posture(m), cls, () => sendCommand("look " + m.id)));
  }
  for (const it of items) {
    const cls = "item" + (it.rarity && it.rarity !== "common" ? " rarity-" + it.rarity : "");
    c.appendChild(chip(it.qty != null ? `${it.name} ×${it.qty}` : it.name, cls, () => sendCommand("look " + it.id)));
  }
  for (const f of fixtures) c.appendChild(chip(f.name, "fixture" + (f.lit ? " luminous" : ""), () => sendCommand("look " + f.id)));
  if (!players.length && !mobs.length && !items.length && !fixtures.length && room.canSee) {
    c.appendChild(label("nothing of note here."));
  }
}

// --- Examine (single entity in the Inspect window) -------------------------
function renderExamine(e) {
  // Remember what we're examining so a reactive room refresh can tell whether it
  // has since vanished (room-bound) or is safely in hand (carried / equipped).
  examinedId = e.id;
  examinedRoomBound = roomHasEntity(lastRoom, e.id);

  // Tint the examine view by the current room's light band, so detail text reads
  // gray in dim → washed/shimmering in searing, aligned with the room view.
  $("inspect").className = "pane light-" + (lastRoom ? lastRoom.light.band : "unknown");
  $("room-view").hidden = true;
  $("examine-view").hidden = false;

  $("ex-name").textContent = e.name;
  $("ex-kind").textContent = e.kind;

  // Rarity badge (items only). Capitalised tier name, tinted by the rarity
  // palette — color plus the word, so it reads without relying on hue alone.
  const rar = $("ex-rarity");
  if (e.rarity) {
    rar.hidden = false;
    rar.className = "rarity-badge rarity-" + e.rarity;
    rar.textContent = e.rarity[0].toUpperCase() + e.rarity.slice(1);
  } else {
    rar.hidden = true;
  }
  $("ex-desc").textContent = e.description || "";

  const bars = $("ex-bars");
  bars.innerHTML = "";
  for (const b of e.bars || []) {
    const pct = b.max > 0 ? Math.max(0, Math.min(100, (b.value / b.max) * 100)) : 0;
    const span = document.createElement("span");
    span.className = "stat";
    span.innerHTML = `<label>${b.label}</label><span class="bar"><i style="width:${pct}%"></i></span><b>${b.value}/${b.max}</b>`;
    bars.appendChild(span);
  }

  const lines = $("ex-lines");
  lines.innerHTML = "";
  for (const l of e.lines || []) {
    const li = document.createElement("li");
    li.textContent = l;
    lines.appendChild(li);
  }

  const hints = $("ex-hints");
  hints.innerHTML = "";
  for (const h of e.hints || []) {
    const span = document.createElement("span");
    span.className = "hint";
    span.textContent = h;
    hints.appendChild(span);
  }

  const actions = $("ex-actions");
  actions.innerHTML = "";
  for (const a of e.actions || []) {
    const btn = document.createElement("button");
    btn.className = "ex-action";
    btn.textContent = a.label;
    btn.addEventListener("click", () => sendCommand(a.command));
    actions.appendChild(btn);
  }
}

// Back to the live room view.
document.getElementById("ex-back").addEventListener("click", () => sendCommand("look"));

// Jump-to-newest pill: snap to the bottom and clear the unread badge, then return
// focus to the command line so the player can keep typing.
$("jump-pill").addEventListener("click", () => {
  jumpToBottom();
  cmdEl.focus();
});

// --- Player panel ----------------------------------------------------------
function renderPlayer(p) {
  $("p-name").textContent = p.name + (p.posture && p.posture !== "standing" ? ` · ${p.posture}` : "");
  // Unspent training points only show when you have some, in gold so they catch
  // the eye (prompting a visit to `train`).
  const pts = p.unspentPoints
    ? ` · <span class="train-pts">${p.unspentPoints} pt${p.unspentPoints === 1 ? "" : "s"}</span>`
    : "";
  $("p-level").innerHTML = `Lv ${p.level}${pts} · ${p.xp} xp`;
  $("p-shards").textContent = `${p.shards || 0} shards`;

  // States
  const states = $("p-states");
  states.innerHTML = "";
  for (const s of p.states || []) {
    const el = document.createElement("span");
    el.className = "state-chip" + (s.good ? " good" : "");
    el.textContent = s.name || s;
    states.appendChild(el);
  }

  // Attributes, then derived stats: defences (Armour vs physical, Ward vs
  // magical), evasion (dodge from Wits) and crit chance (from Perception).
  const attrs = $("p-attrs");
  attrs.innerHTML = "";
  for (const [k, v] of Object.entries(p.attributes)) {
    const wrap = document.createElement("div");
    wrap.innerHTML = `<dt>${k}</dt><dd>${v}</dd>`;
    attrs.appendChild(wrap);
  }
  const pct = (f) => `${Math.round((f || 0) * 100)}%`;
  [["armour", p.armour || 0], ["ward", p.ward || 0], ["evasion", pct(p.evasion)], ["crit", pct(p.crit)]].forEach(([k, v], i) => {
    const wrap = document.createElement("div");
    wrap.className = "defence" + (i === 0 ? " first" : "");
    wrap.innerHTML = `<dt>${k}</dt><dd>${v}</dd>`;
    attrs.appendChild(wrap);
  });

  // Equipment
  const equip = $("p-equip");
  equip.innerHTML = "";
  for (const [slot, item] of Object.entries(p.equipment)) {
    const li = document.createElement("li");
    if (item) {
      let sub = slot;
      if (item.type === "light") sub += item.lit ? ` · lit · fuel ${Math.floor(item.fuel)}/${item.fuelMax}` : ` · unlit · fuel ${Math.floor(item.fuel)}/${item.fuelMax}`;
      li.innerHTML = `<span>${item.name}</span><span class="sub">${sub}</span>`;
    } else {
      li.className = "empty";
      li.innerHTML = `<span>— ${slot} —</span>`;
    }
    equip.appendChild(li);
  }

  // Inventory
  lastPlayer = p;
  const inv = $("p-inv");
  inv.innerHTML = "";

  // Update filter bar active state.
  document.querySelectorAll(".inv-filter").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.group === invFilter);
  });

  const visible = invFilter === "all"
    ? p.inventory
    : p.inventory.filter(item => filterGroupFor(item) === invFilter);

  if (!visible.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = p.inventory.length ? "(none in this category)" : "(empty)";
    inv.appendChild(li);
  }
  for (const item of visible) {
    const li = document.createElement("li");
    const qty = item.qty != null ? ` ×${item.qty}` : "";
    const fuel = item.type === "light" ? ` <span class="sub">fuel ${Math.floor(item.fuel)}/${item.fuelMax}</span>` : "";
    li.innerHTML = `<span>${item.name}${qty}</span>${fuel}`;
    inv.appendChild(li);
  }

  // Status strip. (Energy/action-points are tracked server-side and drive combat
  // tempo, but the bar is hidden until actions have player-chosen costs that make
  // it actionable; Speed conveys tempo for now.)
  setBar("hp", p.hp, p.maxHp);
  setBar("mp", p.mana, p.maxMana);
  $("sp-val").textContent = p.speed;
}

function setBar(prefix, val, max) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (val / max) * 100)) : 0;
  $(prefix + "-fill").style.width = pct + "%";
  $(prefix + "-val").textContent = `${Math.round(val)}/${max}`;
}

// --- Helpers ---------------------------------------------------------------
function chip(text, cls, onClick) {
  const el = document.createElement("span");
  el.className = "chip " + cls;
  el.textContent = text;
  if (onClick) el.addEventListener("click", onClick);
  return el;
}
function label(text) {
  const el = document.createElement("span");
  el.className = "label";
  el.textContent = text;
  return el;
}
// --- Command input: history ------------------------------------------------
const history = [];
let histIdx = -1;

// Safety net: if focus has drifted off the command line (a click elsewhere, a
// blur), pull it back the instant the player types a printable character — so the
// keystroke lands in the input rather than being lost. Modifier combos
// (Ctrl/Cmd+C to copy log text, etc.) are left alone.
document.addEventListener("keydown", (ev) => {
  if (document.activeElement === cmdEl) return;
  if (ev.ctrlKey || ev.metaKey || ev.altKey || ev.key.length !== 1) return;
  cmdEl.focus();
});

cmdEl.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") {
    const text = cmdEl.value.trim();
    if (!text) return;
    if (!authed) {
      addLine("> " + text, "echo");
      sendLogin(text);
      cmdEl.value = "";
      return;
    }
    addLine("> " + text, "echo");
    sendCommand(text);
    history.push(text);
    histIdx = history.length;
    cmdEl.value = "";
  } else if (ev.key === "ArrowUp") {
    ev.preventDefault();
    if (histIdx > 0) cmdEl.value = history[--histIdx];
  } else if (ev.key === "ArrowDown") {
    ev.preventDefault();
    if (histIdx < history.length - 1) cmdEl.value = history[++histIdx];
    else { histIdx = history.length; cmdEl.value = ""; }
  }
});

// Inventory filter button clicks.
$("inv-filters").addEventListener("click", e => {
  const btn = e.target.closest(".inv-filter");
  if (!btn) return;
  invFilter = btn.dataset.group;
  localStorage.setItem("inv-filter", invFilter);
  if (lastPlayer) renderPlayer(lastPlayer);
});

setPrompt();
connect();
