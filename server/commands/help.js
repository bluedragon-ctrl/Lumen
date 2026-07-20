"use strict";
/**
 * The `help` / `?` text and the admin help section.
 *
 * Help is authored as titled sections of `signature — description` entries, then
 * rendered with inline colour markup (see renderMarkup in the client): section
 * titles glow gold, command signatures green, the rest reads in the default ink.
 * `<#reset>` returns to default colour mid-line (any non-palette tag does).
 */
const HELP_SECTIONS = [
  ["Exploration", [
    "look | examine | x [target] — view the room, or look closely at one thing",
    "search — comb the room for hidden ways and things (needs light + Perception)",
    "north / south / east / west / up / down (n/s/e/w/u/d) — move between rooms",
  ]],
  ["Items & gear", [
    "get | take [N.]<item> | all — pick something up off the floor",
    "drop <item> | all — set something down",
    "inventory | inv | i — list what you are carrying",
    "equip | wield | wear <item> — put on gear (a light source kindles as you equip it)",
    "unequip | remove <item|slot> — return equipped gear to your pack",
    "use | switch <target> — work a fixture, or use/light a carried item",
    "drink | quaff | eat <item> — consume a potion or food",
    "refuel | fill <item> — refill a fuelled light (a lantern with oil)",
  ]],
  ["Combat & magic", [
    "attack | kill [N.]<target> — set on a creature (stop to break off)",
    "stop — break off your attack",
    "cast | c <spell> [target] — cast a spell you know",
    "spells — list the spells you know",
  ]],
  ["Gathering & crafting", [
    "mine | dig [vein] — work ore loose from a vein",
    "gather | pick | forage [cluster] — pick moss, mushrooms and crops by hand",
    "fish | angle [water] — work a baited line (spends a grub as bait)",
    "craft | make <recipe> — craft at the matching station here",
    "recipes [word] — list the recipes you know (optionally filtered, e.g. `recipes glimmer`)",
  ]],
  ["People & trade", [
    "talk <npc> — speak with someone (take quests, hear what they need)",
    "give <item> <npc> — hand something over (deliver quest goods)",
    "list | shop [word] — see what a trader sells (optionally filtered, e.g. `list glimmer`)",
    "buy <item> — buy from a trader here",
    "sell <item> | all — sell to a trader here",
    "say <text> — speak to everyone in the room",
    "emote | me <text> — perform an action others can see",
  ]],
  ["Resting", [
    "sit | rest — recover HP/MP slowly (1 per 5 ticks)",
    "sleep — recover faster (1 per 2 ticks), but blind while you do",
    "stand | wake — get up; moving or attacking also stands you",
  ]],
  ["Other", [
    "learn | study <scroll|schematic|book> — learn a spell or recipe (consumes it)",
    "train [attribute] — spend a level-up point (no arg: show progress)",
    "attributes | attr | stats — your character sheet: what each attribute grants and every defence explained",
    "quest | journal — your quest log (in progress / finished)",
    "alias [F1-F4] [command] — bind a function key to a command (no args: list; key only: clear)",
    "quit | logout — leave the game (progress is saved; closing the tab is just as safe)",
    "help | ? — this list",
  ]],
];

const HELP_TIPS = [
  "Commands shorten to any unambiguous prefix (exa→examine, cr→craft).",
  "Target by any word in a name (kill innkeeper, get glimmerstone). When several",
  "match, pick one with a number (kill 2.crawler) or act on all (get all, sell all).",
];

const ADMIN_HELP_SECTION = ["Admin", [
  "@create-player <name> — create a new player account",
  "@reset-password <name> — clear a player's password (they set a new one on next login)",
  "@list-players — list every account",
  "@shards <amount> — grant yourself shards",
  "@xp <amount> — grant yourself experience",
  "@attr <attribute> <value> — set one of your attributes",
  "@spawn <mobId> [count] [wild|player] — spawn mobs in this room",
  "@give <itemId> [count] — conjure an item into your pack",
  "@teleport <roomId> — jump straight to any room by id",
  "@tide <calm|stirring|tide|receding|auto|status> — drive the world clock",
  "@invite-key <status|new|set <key>|off> — manage the registration invite key",
]];

// Colour one "signature — description" entry: green signature, default rest.
function helpEntry(entry) {
  const i = entry.indexOf(" — ");
  if (i < 0) return `  <#green>${entry}<#reset>`;
  return `  <#green>${entry.slice(0, i)}<#reset> — ${entry.slice(i + 3)}`;
}

function renderHelpSections(sections, title) {
  const out = [`<#gold>${title}<#reset>`];
  for (const [heading, entries] of sections) {
    out.push("", `<#cyan>${heading}<#reset>`);
    for (const e of entries) out.push(helpEntry(e));
  }
  return out;
}

// The help text for a given player: the standard sections plus footer tips, and
// the admin section appended only when the player can actually use those verbs.
function buildHelp(player) {
  const lines = renderHelpSections(HELP_SECTIONS, "Commands");
  if (player && player.isAdmin) {
    lines.push("", `<#cyan>${ADMIN_HELP_SECTION[0]}<#reset>`);
    for (const e of ADMIN_HELP_SECTION[1]) lines.push(helpEntry(e));
  }
  lines.push("", ...HELP_TIPS.map((t) => `<#gray>${t}<#reset>`));
  return lines.join("\n");
}

module.exports = { ADMIN_HELP_SECTION, helpEntry, buildHelp };
