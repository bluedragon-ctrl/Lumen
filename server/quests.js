"use strict";
/**
 * Quest engine. Data-driven goals (data/world/quests.json) a player picks up,
 * works through in ordered steps, and turns in for rewards — DikuMUD-inspired.
 *
 * This is a PURE module: every function takes `(state, player, …)`, mutates
 * `player.quests`, and RETURNS an array of message objects (`{ type, text }`) for
 * the caller (a command handler in commands.js, or the tick event dispatcher in
 * index.js) to deliver. It never touches `ws`/`ctx` itself — so the same progress
 * logic serves both the command path and the combat-tick path.
 *
 *   player.quests = {
 *     active: { [questId]: { step: <int>, progress: <int>, kills: { [mobId]: <int> } } },
 *     done:   [questId, …]                                     // completed at least once
 *   }
 *
 * `progress` is the running count for the current `deliver` step, a 0/1 flag for
 * `use`, and ignored for `collect` (which reads live inventory). `kills` is a
 * per-mob tally that accrues for the *whole quest*, not just the current step — a
 * kill counts toward every `kill` step that names that mob, even one not yet
 * active, so e.g. felling a boss alongside its guards banks credit for a later
 * "slay the boss" step. It is never reset on step advance (unlike `progress`).
 * A quest with a `use`/`enter`/`item`/`talk` start trigger is offered by the
 * matching note/handle hook below; rewards land on completion of the final step
 * (grantRewards).
 */
const { makeItemInstance } = require("./state");

const cap = (s) => (s || "").charAt(0).toUpperCase() + (s || "").slice(1);

// Mirror of commands.addToInventory — kept local so the engine can grant reward
// items without a circular require back into commands.js.
function addToInventory(player, inst, world) {
  const t = world.items[inst.template];
  if (t.stackable) {
    const ex = player.inventory.find((i) => i.template === inst.template);
    if (ex) { ex.qty = (ex.qty || 1) + (inst.qty || 1); return; }
  }
  player.inventory.push(inst);
}

// Total quantity of a template a player carries (sums stacks). Mirror of commands.countItem.
function countItem(player, template) {
  return (player.inventory || []).reduce((n, i) => (i.template === template ? n + (i.qty || 1) : n), 0);
}

// Remove `n` of a specific instance (a stack decrement or a full splice).
function removeInstance(player, inst, n) {
  if (inst.qty != null && inst.qty > n) { inst.qty -= n; return; }
  const idx = player.inventory.indexOf(inst);
  if (idx >= 0) player.inventory.splice(idx, 1);
}

// Ensure the quest container exists (older saves predate it). Idempotent.
function ensure(player) {
  if (!player.quests || typeof player.quests !== "object") player.quests = { active: {}, done: [] };
  if (!player.quests.active || typeof player.quests.active !== "object") player.quests.active = {};
  if (!Array.isArray(player.quests.done)) player.quests.done = [];
  return player.quests;
}

const isActive = (player, qid) => !!ensure(player).active[qid];
const isDone = (player, qid) => ensure(player).done.includes(qid);

// The single objective key on a step (exactly one of these is present).
function objectiveOf(step) {
  for (const k of ["kill", "deliver", "use", "collect"]) if (step[k] != null) return k;
  return null;
}

// Fallback journal text for a step that omits its own `text`.
function stepLabel(state, step) {
  const w = state.world;
  const kind = objectiveOf(step);
  const mob = (id) => (w.mobs[id] ? w.mobs[id].name : id);
  const item = (id) => (w.items[id] ? w.items[id].name : id);
  const fix = (id) => (w.fixtures[id] ? w.fixtures[id].name : id);
  if (kind === "kill") return `Slay ${step.count || 1} × ${mob(step.kill)}`;
  if (kind === "deliver") return `Deliver ${step.count || 1} × ${item(step.deliver)} to ${mob(step.npc)}`;
  if (kind === "collect") return `Gather ${step.count || 1} × ${item(step.collect)}`;
  if (kind === "use") return `Use ${fix(step.use)}`;
  return "…";
}

// Tally banked toward a `kill` objective for `template` — accrued across the whole
// quest (see the file header), so it may already be nonzero on a freshly-revealed step.
function killCount(entry, template) {
  return (entry.kills && entry.kills[template]) || 0;
}

// "(x/n)" for the current step, or "" for objectives without a count (use).
function stepProgress(state, player, quest, entry) {
  const step = quest.steps[entry.step];
  const kind = objectiveOf(step);
  if (kind === "kill") return `${Math.min(killCount(entry, step.kill), step.count || 1)}/${step.count || 1}`;
  if (kind === "deliver") return `${Math.min(entry.progress || 0, step.count || 1)}/${step.count || 1}`;
  if (kind === "collect") return `${Math.min(countItem(player, step.collect), step.count || 1)}/${step.count || 1}`;
  return "";
}

function progressLine(state, player, quest, entry) {
  const step = quest.steps[entry.step];
  const prog = stepProgress(state, player, quest, entry);
  return { type: "log", text: `Quest "${quest.name}": ${step.text || stepLabel(state, step)}${prog ? ` (${prog})` : ""}` };
}

// Is the active quest's current step satisfied?
function stepComplete(state, player, quest, entry) {
  const step = quest.steps[entry.step];
  const kind = objectiveOf(step);
  if (kind === "kill") return killCount(entry, step.kill) >= (step.count || 1);
  if (kind === "deliver") return (entry.progress || 0) >= (step.count || 1);
  if (kind === "collect") return countItem(player, step.collect) >= (step.count || 1);
  if (kind === "use") return (entry.progress || 0) >= 1;
  return true;
}

// Pay out a finished quest's rewards onto the player. Pushes a reward summary and,
// for xp, the gold xp line plus any level-up hails. Reuses state.awardXp.
function grantRewards(state, player, quest, msgs) {
  const w = state.world;
  const r = quest.rewards || {};
  const parts = [];
  if (r.shards) { player.shards = (player.shards || 0) + r.shards; parts.push(`${r.shards} shards`); }
  for (const it of r.items || []) {
    addToInventory(player, makeItemInstance({ template: it.template, qty: it.qty || 1 }, w), w);
    const t = w.items[it.template];
    parts.push(it.qty && it.qty > 1 ? `${t.name} ×${it.qty}` : t.name);
  }
  if (r.recipes && r.recipes.length) {
    if (!player.knownRecipes) player.knownRecipes = [];
    for (const rid of r.recipes) if (!player.knownRecipes.includes(rid)) {
      player.knownRecipes.push(rid);
      parts.push(`recipe: ${w.recipes[rid] ? (w.recipes[rid].name || rid) : rid}`);
    }
  }
  if (r.spells && r.spells.length) {
    if (!player.knownSpells) player.knownSpells = [];
    for (const sid of r.spells) if (!player.knownSpells.includes(sid)) {
      player.knownSpells.push(sid);
      parts.push(`spell: ${w.spells[sid] ? w.spells[sid].name : sid}`);
    }
  }
  if (parts.length) msgs.push({ type: "log", text: `Reward: ${parts.join(", ")}.` });
  if (r.xp) {
    const ups = state.awardXp(player, r.xp);
    msgs.push({ type: "gold", text: `Quest reward: +${r.xp} xp.` });
    for (const up of ups) msgs.push({ type: "gold", text: `You reach level ${up.level}! (+${up.points} attribute points — spend with "train")` });
  }
}

// Advance an active quest past every currently-satisfied step, narrating each new
// step and completing (with rewards) when the last step clears. Looping handles a
// freshly-revealed step that's already met (e.g. a `collect` you already hold).
function advanceIfComplete(state, player, qid, msgs) {
  const q = ensure(player);
  const quest = state.world.quests[qid];
  const entry = q.active[qid];
  if (!quest || !entry) return;
  while (entry.step < quest.steps.length && stepComplete(state, player, quest, entry)) {
    entry.step += 1;
    entry.progress = 0;
    if (entry.step >= quest.steps.length) {
      delete q.active[qid];
      if (!q.done.includes(qid)) q.done.push(qid);
      msgs.push({ type: "gold", text: `Quest complete: ${quest.name}!` });
      grantRewards(state, player, quest, msgs);
      return;
    }
    const step = quest.steps[entry.step];
    msgs.push({ type: "log", text: `Quest "${quest.name}": ${step.text || stepLabel(state, step)}` });
  }
}

/** Start a quest if the player is eligible (not already active; not done unless
 *  repeatable — a finished one is offered silently, so `talk` can fall through
 *  to a `react` answer). Auto-advances a first step that's already satisfied. */
function offer(state, player, qid) {
  const msgs = [];
  const quest = state.world.quests[qid];
  if (!quest) return msgs;
  if (isActive(player, qid)) return msgs;
  if (isDone(player, qid) && !quest.repeatable) return msgs;
  ensure(player).active[qid] = { step: 0, progress: 0, kills: {} };
  // offerText is authored verbatim (quote NPC speech in the data; leave descriptive
  // item/enter triggers unquoted), shown muted.
  if (quest.start && quest.start.offerText) msgs.push({ type: "log", text: `<#gray>${quest.start.offerText}` });
  msgs.push({ type: "gold", text: `New quest: ${quest.name}${quest.description ? ` — ${quest.description}` : ""}` });
  const step = quest.steps[0];
  msgs.push({ type: "log", text: `  ${step.text || stepLabel(state, step)}` });
  advanceIfComplete(state, player, qid, msgs);
  return msgs;
}

/** A kill credited to `player` — bank it against every `kill` step in each active
 *  quest that names this mob (current or not yet reached, e.g. a boss felled
 *  alongside its guards), then advance the current step if that cleared it. */
function noteKill(state, player, mobTemplate) {
  const msgs = [];
  const q = ensure(player);
  for (const [qid, entry] of Object.entries(q.active)) {
    const quest = state.world.quests[qid];
    if (!quest || !quest.steps.some((s) => objectiveOf(s) === "kill" && s.kill === mobTemplate)) continue;
    entry.kills = entry.kills || {};
    entry.kills[mobTemplate] = (entry.kills[mobTemplate] || 0) + 1;
    const step = quest.steps[entry.step];
    if (objectiveOf(step) === "kill" && step.kill === mobTemplate && !stepComplete(state, player, quest, entry))
      msgs.push(progressLine(state, player, quest, entry));
    advanceIfComplete(state, player, qid, msgs);
  }
  return msgs;
}

/** `player` acquired one of `template` — fire an `item` start trigger and advance
 *  any active `collect` step for that item. */
function noteAcquire(state, player, template) {
  const msgs = [];
  for (const [qid, quest] of Object.entries(state.world.quests))
    if (quest.start && quest.start.trigger === "item" && quest.start.item === template) msgs.push(...offer(state, player, qid));
  const q = ensure(player);
  for (const [qid, entry] of Object.entries(q.active)) {
    const quest = state.world.quests[qid];
    if (!quest) continue;
    const step = quest.steps[entry.step];
    if (objectiveOf(step) !== "collect" || step.collect !== template) continue;
    if (!stepComplete(state, player, quest, entry)) msgs.push(progressLine(state, player, quest, entry));
    advanceIfComplete(state, player, qid, msgs);
  }
  return msgs;
}

/** `player` used the fixture `fixtureTemplate` — fire a `use` start trigger and
 *  advance any active `use` step for that fixture. */
function noteUse(state, player, fixtureTemplate) {
  const msgs = [];
  for (const [qid, quest] of Object.entries(state.world.quests))
    if (quest.start && quest.start.trigger === "use" && quest.start.fixture === fixtureTemplate) msgs.push(...offer(state, player, qid));
  const q = ensure(player);
  for (const [qid, entry] of Object.entries(q.active)) {
    const quest = state.world.quests[qid];
    if (!quest) continue;
    const step = quest.steps[entry.step];
    if (objectiveOf(step) !== "use" || step.use !== fixtureTemplate) continue;
    entry.progress = 1;
    advanceIfComplete(state, player, qid, msgs);
  }
  return msgs;
}

/** `player` entered `roomId` for the first time — fire an `enter` start trigger. */
function noteEnter(state, player, roomId) {
  const msgs = [];
  for (const [qid, quest] of Object.entries(state.world.quests))
    if (quest.start && quest.start.trigger === "enter" && quest.start.room === roomId) msgs.push(...offer(state, player, qid));
  return msgs;
}

/** `talk <npc>` — offer this NPC's talk-started quests and nudge any pending
 *  delivery they're owed. Returns [] when there is no quest business; the talk
 *  command supplies the fallback (an in-character `react` answer, or a shrug). */
function handleTalk(state, player, mob) {
  const msgs = [];
  const w = state.world;
  const npc = mob.template;
  const npcName = w.mobs[npc] ? w.mobs[npc].name : "they";
  for (const [qid, quest] of Object.entries(w.quests)) {
    if (!quest.start || quest.start.trigger !== "talk" || quest.start.npc !== npc) continue;
    msgs.push(...offer(state, player, qid));
  }
  const q = ensure(player);
  for (const [qid, entry] of Object.entries(q.active)) {
    const quest = w.quests[qid];
    if (!quest) continue;
    const step = quest.steps[entry.step];
    if (objectiveOf(step) !== "deliver" || step.npc !== npc) continue;
    const item = w.items[step.deliver];
    const short = item ? item.name.replace(/^(a|an|the)\s+/i, "") : step.deliver;
    msgs.push({ type: "log", text: `${cap(npcName)} is waiting on ${step.text || stepLabel(state, step)}. (hand it over with \`give ${short} ${npcName.replace(/^(a|an|the)\s+/i, "").split(/\s+/)[0]}\`)` });
  }
  return msgs;
}

/** `give <item> <npc>` — apply `itemInst` toward an active `deliver` step for that
 *  NPC. Returns `{ msgs, accepted }`; on accept, the items are consumed here. */
function handleGive(state, player, mob, itemInst) {
  const w = state.world;
  const npc = mob.template;
  const template = itemInst.template;
  const q = ensure(player);
  for (const [qid, entry] of Object.entries(q.active)) {
    const quest = w.quests[qid];
    if (!quest) continue;
    const step = quest.steps[entry.step];
    if (objectiveOf(step) !== "deliver" || step.npc !== npc || step.deliver !== template) continue;
    const msgs = [];
    const need = (step.count || 1) - (entry.progress || 0);
    const give = Math.min(need, itemInst.qty || 1);
    removeInstance(player, itemInst, give);
    entry.progress = (entry.progress || 0) + give;
    const itemName = w.items[template].name;
    const npcName = w.mobs[npc].name;
    msgs.push({ type: "log", text: `You hand ${give}× ${itemName} to ${npcName}.${entry.progress < (step.count || 1) ? ` (${entry.progress}/${step.count})` : ""}` });
    advanceIfComplete(state, player, qid, msgs);
    return { msgs, accepted: true };
  }
  return { msgs: [], accepted: false };
}

/** The console quest log: In progress (with per-step progress) and Finished. */
function log(state, player) {
  const w = state.world;
  const q = ensure(player);
  // Mirrors the `help` palette: gold title, cyan headings, green active-quest
  // names; finished quests read muted grey. (See renderMarkup in the client.)
  const lines = ["<#gold>Quests<#reset>", "", "<#cyan>In progress<#reset>"];
  const active = Object.entries(q.active).filter(([qid]) => w.quests[qid]);
  if (!active.length) lines.push("  <#gray>(none)<#reset>");
  for (const [qid, entry] of active) {
    const quest = w.quests[qid];
    const step = quest.steps[entry.step];
    const prog = stepProgress(state, player, quest, entry);
    lines.push(`  <#green>${quest.name}<#reset> — ${step.text || stepLabel(state, step)}${prog ? ` (${prog})` : ""}`);
  }
  lines.push("", "<#cyan>Finished<#reset>");
  const done = q.done.filter((id) => w.quests[id]);
  if (!done.length) lines.push("  <#gray>(none)<#reset>");
  for (const id of done) lines.push(`  <#gray>${w.quests[id].name} ✓<#reset>`);
  return [{ type: "log", text: lines.join("\n") }];
}

/** True if any of `player`'s active quests is sitting on a `deliver` step aimed
 *  at `npcTemplate` — the "you owe me something" check NPC reactions use.
 *  Read-only; mirrors the delivery scan in handleTalk. */
function hasPendingDelivery(state, player, npcTemplate) {
  const q = ensure(player);
  for (const [qid, entry] of Object.entries(q.active)) {
    const quest = state.world.quests[qid];
    if (!quest) continue;
    const step = quest.steps[entry.step];
    if (step && objectiveOf(step) === "deliver" && step.npc === npcTemplate) return true;
  }
  return false;
}

module.exports = { offer, noteKill, noteAcquire, noteUse, noteEnter, handleTalk, handleGive, hasPendingDelivery, log };
