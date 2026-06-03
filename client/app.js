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

// Until authenticated, the command line captures the player's NAME, not commands.
let authed = false;

// --- WebSocket -------------------------------------------------------------
let ws;
function connect() {
  ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host);
  ws.onopen = () => addLine("[connected]", "system");
  ws.onclose = () => {
    authed = false;
    setPrompt();
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
    case "gold": addLine(msg.text, "gold"); break;
    case "room": lastRoom = msg.room; renderRoom(msg.room); break;
    case "examine": renderExamine(msg.entity); break;
    case "player": lastPlayer = msg.player; renderPlayer(msg.player); break;
    default: addLine(JSON.stringify(msg), "log");
  }
}

// --- Console ---------------------------------------------------------------
function addLine(text, kind) {
  const div = document.createElement("div");
  div.className = "line-" + (kind || "log");
  div.textContent = text;
  logEl.appendChild(div);
  logEl.parentElement.scrollTop = logEl.parentElement.scrollHeight;
}

// --- Inspect (room) --------------------------------------------------------
function renderRoom(room) {
  // Receiving a room view (on move / look / light change) returns the Inspect
  // window from any examine view back to the live room.
  $("examine-view").hidden = true;
  $("room-view").hidden = false;
  const inspect = $("inspect");
  inspect.className = "pane light-" + room.light.band;
  $("room-name").textContent = room.name;
  $("light-meter").textContent = `light: ${room.light.band} (${room.light.value})` + (room.harmed ? " ⚠ harsh" : "");

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
    for (const dir of room.exits) exits.appendChild(chip(dir, "exit", () => sendCommand(dir)));
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
    const cls = "mob" + (m.hostile ? " hostile" : "") + (m.luminous ? " luminous" : "");
    c.appendChild(chip(m.name + posture(m), cls, () => sendCommand("look " + m.id)));
  }
  for (const it of items) c.appendChild(chip(it.qty != null ? `${it.name} ×${it.qty}` : it.name, "item", () => sendCommand("look " + it.id)));
  for (const f of fixtures) c.appendChild(chip(f.name, "fixture" + (f.lit ? " luminous" : ""), () => sendCommand("look " + f.id)));
  if (!players.length && !mobs.length && !items.length && !fixtures.length && room.canSee) {
    c.appendChild(label("nothing of note here."));
  }
}

// --- Examine (single entity in the Inspect window) -------------------------
function renderExamine(e) {
  // Tint the examine view by the current room's light band, so detail text reads
  // gray in dim → washed/shimmering in searing, aligned with the room view.
  $("inspect").className = "pane light-" + (lastRoom ? lastRoom.light.band : "unknown");
  $("room-view").hidden = true;
  $("examine-view").hidden = false;

  $("ex-name").textContent = e.name;
  $("ex-kind").textContent = e.kind;
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

// --- Player panel ----------------------------------------------------------
function renderPlayer(p) {
  $("p-name").textContent = p.name + (p.posture && p.posture !== "standing" ? ` · ${p.posture}` : "");
  const pts = p.unspentPoints ? ` · ${p.unspentPoints} pt${p.unspentPoints === 1 ? "" : "s"}` : "";
  $("p-level").textContent = `Lv ${p.level}${pts} · ${p.xp} xp · ${p.shards || 0} shards`;

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
      if (item.type === "light") sub += item.lit ? ` · lit · fuel ${item.fuel}/${item.fuelMax}` : ` · unlit · fuel ${item.fuel}/${item.fuelMax}`;
      li.innerHTML = `<span>${item.name}</span><span class="sub">${sub}</span>`;
    } else {
      li.className = "empty";
      li.innerHTML = `<span>— ${slot} —</span>`;
    }
    equip.appendChild(li);
  }

  // Inventory
  const inv = $("p-inv");
  inv.innerHTML = "";
  if (!p.inventory.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "(empty)";
    inv.appendChild(li);
  }
  for (const item of p.inventory) {
    const li = document.createElement("li");
    const qty = item.qty != null ? ` ×${item.qty}` : "";
    const fuel = item.type === "light" ? ` <span class="sub">fuel ${item.fuel}/${item.fuelMax}</span>` : "";
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
// Strip a leading article and take the last word — used for TAB-completion
// candidates so players can type "lightbug" / "sword" instead of an id.
const lastWord = (s) => s.replace(/^(a|an|the)\s+/i, "").split(/\s+/).pop();

// --- Command input: history + TAB completion -------------------------------
const VERBS = ["look", "examine", "go", "move", "get", "take", "drop", "inventory", "say", "emote",
  "attack", "kill", "stop", "sit", "sleep", "stand", "wake", "rest", "cast", "learn", "study", "spells", "equip", "wield", "wear", "unequip", "remove",
  "light", "douse", "extinguish", "ignite", "list", "shop", "buy", "sell",
  "drink", "quaff", "use", "switch", "toggle", "flip", "refuel", "fill", "craft", "make", "recipes", "train", "help",
  "north", "south", "east", "west", "up", "down"];
const history = [];
let histIdx = -1;
let tabState = null; // { base, matches, idx }

// Context-aware completion: the first token completes commands; the argument
// completes from what THAT command can act on (equipped gear for remove, mobs
// for attack, ground items for get, etc.).
function completionCandidates(value) {
  const parts = value.split(/\s+/);
  if (parts.length <= 1) return VERBS;
  return [...new Set(argCandidates(parts[0].toLowerCase()))];
}

function argCandidates(cmd) {
  const room = lastRoom;
  const p = lastPlayer;
  const names = (arr) => (arr || []).map((x) => lastWord(x.name));
  const equipped = () => (p ? Object.values(p.equipment).filter(Boolean) : []);
  switch (cmd) {
    case "look": case "l": case "examine": case "exam": case "x": {
      const out = [];
      if (room) out.push(...names(room.contents.mobs), ...names(room.contents.items), ...names(room.contents.fixtures), ...names(room.contents.players));
      if (p) out.push(...names(p.inventory), ...names(equipped()));
      return out;
    }
    case "get": case "take": return room ? names(room.contents.items) : [];
    case "drop": case "sell": return p ? names(p.inventory) : [];
    case "drink": case "quaff":
      return p ? p.inventory.filter((i) => i.type === "consumable").map((i) => lastWord(i.name)) : [];
    case "use": case "switch": case "toggle": case "flip": {
      const out = room ? names(room.contents.fixtures) : [];
      if (p) out.push(...p.inventory.filter((i) => i.type === "consumable").map((i) => lastWord(i.name)));
      return out;
    }
    case "craft": case "make": return p ? (p.recipes || []).map((r) => lastWord(r)) : [];
    case "train": return ["might", "vitality", "intellect", "wits", "perception"];
    case "equip": case "wield": case "wear": case "hold":
      return p ? p.inventory.filter((i) => i.slot).map((i) => lastWord(i.name)) : [];
    case "unequip": case "remove":
      return p ? [...names(equipped()), ...Object.keys(p.equipment)] : [];
    case "attack": case "kill": case "k": return room ? names(room.contents.mobs) : [];
    case "cast": case "c": {
      // Spell names first, then targetable creatures (cast <spell> <target>).
      const out = p ? (p.spells || []).map((s) => lastWord(s)) : [];
      if (room) out.push(...names(room.contents.mobs));
      return out;
    }
    case "learn": case "study":
      return p ? p.inventory.filter((i) => i.type === "scroll").map((i) => lastWord(i.name)) : [];
    case "light": case "ignite": {
      const out = p ? p.inventory.filter((i) => i.type === "light").map((i) => lastWord(i.name)) : [];
      if (p && p.equipment.light) out.push(lastWord(p.equipment.light.name));
      return out;
    }
    case "refuel": case "fill": {
      const out = p ? p.inventory.filter((i) => i.type === "light").map((i) => lastWord(i.name)) : [];
      if (p && p.equipment.light) out.push(lastWord(p.equipment.light.name));
      return out;
    }
    case "go": case "move": return room ? room.exits.slice() : [];
    default: return []; // say / emote / douse / stop / help — free text or no arg
  }
}

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
    tabState = null;
  } else if (ev.key === "ArrowUp") {
    ev.preventDefault();
    if (histIdx > 0) cmdEl.value = history[--histIdx];
  } else if (ev.key === "ArrowDown") {
    ev.preventDefault();
    if (histIdx < history.length - 1) cmdEl.value = history[++histIdx];
    else { histIdx = history.length; cmdEl.value = ""; }
  } else if (ev.key === "Tab") {
    ev.preventDefault();
    handleTab();
  } else {
    tabState = null;
  }
});

function handleTab() {
  const value = cmdEl.value;
  const head = value.slice(0, value.lastIndexOf(" ") + 1);
  const token = value.slice(head.length).toLowerCase();
  if (tabState && tabState.base === value) {
    // cycle
    tabState.idx = (tabState.idx + 1) % tabState.matches.length;
    cmdEl.value = head + tabState.matches[tabState.idx] + " ";
    return;
  }
  const matches = completionCandidates(value).filter((c) => c.startsWith(token));
  if (!matches.length) return;
  if (matches.length === 1) {
    cmdEl.value = head + matches[0] + " ";
    tabState = null;
  } else {
    cmdEl.value = head + matches[0] + " ";
    tabState = { base: cmdEl.value, matches, idx: 0 };
  }
}

setPrompt();
connect();
