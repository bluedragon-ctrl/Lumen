# Lumen — World & Lore

> Canon reference for authored and AI-generated content. When writing rooms, mobs,
> items, or quests, stay consistent with this document. It records what is *fixed*,
> what is *deliberately unknown*, and the consistency rules content must follow.
>
> Status: v0.1 — living document.

## Setting

Late-medieval fantasy. Kingdoms, guilds, and magic-as-craft exist in the wider
world, but Lumen takes place on a remote **frontier**, not in its capitals. The
focus is the mouth of a newly discovered hole in the world and the boomtown
clinging to its lip.

## The Abyss

A vast, remote, **recently discovered** underground complex of caves and tunnels,
plunging far deeper than anyone has explored. Its importance is singular: it is the
**only known source of glimmer**. Only its uppermost levels are mapped; everything
below is rumour, and the danger rises with the depth.

## Glimmer

A magical mineral — the essential reagent of the age, worked into potions,
enchanted weapons, and arcane contraptions. Because the Abyss is its sole source,
glimmer is the most coveted substance in the world.

- **Legend** says glimmer is the **frozen light of the Dark Star**. *Nobody knows
  for sure* — its true nature is a deliberate, permanent mystery. (The Dark Star
  itself is unexplained, and should stay that way.)
- It is **magically active**. Prolonged proximity to raw glimmer **influences and
  mutates** living things in the deep — twisting the Abyss's creatures over time.
- **Glimmer shards** are the loose, spendable form and serve as frontier currency.
  Larger **glimmer crystals** are the richer prize broken down from veins.

## Magic — two traditions

Spellcraft in Lumen splits along its source, and the split is the cost:

- **Human magic** is the **standard fantasy tradition** carried down the Abyss from
  the wider world — drawn from the caster's own will and learning, paid for in
  effort (mana) alone. Light cantrips, conjured wards, sleep-hexes, bolts of force:
  the common stock of any hedge-mage or war-wizard. It does **not** consume glimmer.
- **Umbral magic** is **glimmer-craft** — the deep art of the Umbrals, which works
  by spending raw glimmer rather than will. It is hungrier and heavier-hitting, but
  every casting **burns shards** alongside mana; the glimmer is consumed in the weave
  and cannot be reclaimed. Surface mages who learn it pay the same toll. Spell names
  in this tradition tend to wear the word (*Glimmer Spike*, *Glimmerskin*).

Rule of thumb for authored spells: a spell that **consumes shards** (`shardCost`) is
glimmer-craft; one that costs **mana only** is the human tradition — keep its flavour
text clear of glimmer-as-medium.

Both traditions are **learnable** — a delver studies them, pays a cost, and casts at
will. There is a **third kind of magic that is not a tradition at all**: the things of
the deep simply *do* it. A living shadow drinks a room dark; a beast steeped too long in
that dark learns to fling a little of it back. These are **the deep's own workings** —
innate, never taught, never paid for in mana or shards (mob-only spells carry
`manaCost 0` and no `shardCost`: *Snuff*, *Drink the Light*, *Gloom Bolt*). They are not
a school a delver could enrol in but a property of the deep itself, and the further down
you go the more of them you meet. Author them as something a creature *is*, not something
it *knows*; their flavour may **gesture** at the dark as their source but must never
explain it (see *Deliberately unknown*).

## The Glimmer Rush

A gold-rush, in everything but the metal. Word of glimmer has drawn
fortune-seekers, sellswords, alchemists, and the desperate from across the world to
prospect the Abyss. **Delvers are prospectors** — think permits, rich-seam rumours,
boomtown prices, sudden fortunes, and the many who never come back up. This framing
should colour the tone of all surface content.

## The Rim

The rough boomtown at the mouth of the Abyss, the last settlement before the dark —
where prospectors gather, trade in shards, resupply, and stage expeditions. Trades
in light, rope, steel, broth, and tallow. Established figures: **Maeve** (innkeeper),
**Garrick** (sour quartermaster), **Tobin** (half-mad tinker-smith), **Fenn**
(self-appointed reeve — nobody appointed him, but he licenses the descent and the
digging, keeps the register of who goes below, and is the nearest thing to law the
Rim's edge has below the gate), **Hale** (watchman — an ex-sellsword paid in shards
by the traders to walk the village and be seen; the Rim has no formal law).

## The Umbrals

A subterranean humanoid race native to the Abyss — there long before the Rush.

- **Disposition:** friendly-ish but largely **incurious** about humans; they
  tolerate the newcomers rather than welcome them.
- **Adaptations:** dark- and deep-adapted bodies, **partial bioluminescence**, and
  slow, sparse speech / low-bandwidth communication with outsiders. *(These are
  ordinary underground-ecosystem traits — NOT caused by glimmer.)*
- **Culture:** they craft with glimmer and are quiet masters of **stonemasonry**,
  carving reliefs into the cave walls. This explains the worked passages, old
  stonework, and carvings delvers find below.
- **Settlements:** Umbral **villages** lie deeper in the Abyss. The first Umbral a
  delver meets on the descent is **Mallki the qhatuq** (trader), who keeps a
  lamp-lit hollow and a tended fungus garden beside the underground river of the
  third floor. Far below, past the warded sanctuary and its kept fields, the deepest
  known village was **lost to the dark** (see *The Hollowing*) — a place the surviving
  Umbrals ward themselves away from and do not speak of.
- **Language:** the Umbral tongue draws on **Quechua** roots for its flavour —
  soft, rounded, sparse. A few words surface in their speech and place-names
  (*qhatuq* — trader; *paqcha* — waterfall; *yaku-runa* — "water-folk", their name
  for the delvers who follow the river down). Keep it to a word or two; Umbrals
  speak little to outsiders, and content should never render a whole translated
  sentence.
- **The quiet tension:** glimmer matters to the Umbrals too. The Rush is, unspoken,
  an intrusion on their resource — the deeper humans mine, the more they take what
  was the Umbrals'. A slow-burn source of future conflict; not open hostility yet.

### The Mutated (deep-dwellers)

Deep in the Abyss, long exposure to raw glimmer **warps Umbrals** into hostile,
degenerate kin: tall, gaunt, grey, light-pained things that speak only broken scraps
of a once-shared tongue. They are what the deep does to the Umbrals' own — a tragedy
the surface Umbrals do not speak of. The friendly Umbrals near the top and these
mutated deep-dwellers are the **same people at two ends of glimmer's influence.**

### The Hollowing (the dark-taken)

Where glimmer works on the **body**, the deep's own dark works on the **self**. Spend
too long in the true dark of the Abyss — light gone, and not relit — and the dark
begins to *take* you. It is slow, and it is one-way. This is **the Hollowing**, and it
claims Umbral and human alike: the lost prospector whose torch died far down is as fair
a prize for the dark as any deep-dweller. These are the **"things the dark makes"** that
the deep Umbrals ward their kept places against.

It comes in stages — the same way the friendly Umbral and the Mutated are one people at
two ends:

1. **The husk.** The body still holds, but the self is thinning, memory down to dim,
   fraying echoes. The dark-taken go on through the motions of the life they had —
   working a cold forge, gathering at a dead hearth, waiting at a door — reacting only
   dimly, and only when disturbed, or when light comes near.
2. **The fading.** The dark begins to eat the body itself: a hand gone to shadow, a face
   going featureless, edges that no longer hold. Memory narrows to a single repeated
   gesture.
3. **The shadow.** Body and memory both gone. What remains is a **living shadow** —
   mindless, and hungry only for light. The living shadows of the mid-deep (see the
   threat ladder) are the end of this road; this is the long, sad history behind them.

The dark-taken **drink light** and are **harmed by bright light** — the deep's own
workings, made flesh and then made un-flesh (their feeding is *Drink the Light*; carrying
a bright lamp into their dark both reveals them and wounds them).

**Why the dark takes some and not others is unknown**, and whether it is the same force
as glimmer's warping of the body or a different hand entirely, no one who has gone far
enough to learn has come back to say (see *Deliberately unknown*). Content may **gesture**
at the Hollowing as the dark's own slow work; it must never **explain** it.

#### The lost village

Deepest of the worked places — below the warded gate beneath the Umbral fields — lies an
**Umbral village the dark took whole**: streets of close-set stone, lamp-niches long
cold, reliefs cut by hands that are now shadows on their own walls. Nothing slaughtered
it; the Hollowing thinned it out, household by household, until none were left to leave.
It is **abandoned** by the living and **inhabited** by its own dead — husks still
shuffling through their chores, faded things half-gone at the edges, and mindless shadows
pooled in the dark corners: the whole slow arc of the Hollowing under one roof. The
surface Umbrals know of it and **will not speak of it**; the sanctuary and its wards above
stand, in part, against what the village became — and it is the reason a warded gate stands
shut. The largest worked-stone complex in the deep, kept by no one, kept *out* by the
living.

*(Place-name provisional, pending sign-off — an Umbral/Quechua name in the vein of the
existing* qhatuq / paqcha / yaku-runa, *e.g.* **Tuta Llaqta** *— "night-town." See the
language note under The Umbrals.)*

## The Deep & its ecosystem

Only partially explored; hazards scale with depth.

- A genuine **underground ecosystem** sorted by its relationship to light: creatures
  that are **light-fearing**, light-sensitive, or wholly **light-independent**. This
  is the world's mechanical signature. *(Light adaptation is natural ecology; glimmer
  mutation is a separate, magical overlay on top of it.)*
- Scattered prospector **camps** deeper down — some clinging on, many **abandoned**
  (environmental storytelling and loot).
- **Major lurking dangers**, half-legend until met — see below.

## Top-floor fauna & the lit food web

Vegetation in the Abyss is scarce and **grows only where there is light** — moss and
fungus cluster under bioluminescent fixtures and glowing mushrooms. This single fact
orders the whole upper ecosystem:

- **Grazers come to the light to feed** (pillbugs, grubs), so prey concentrates in lit
  patches.
- **Hunters follow the prey** — but the light-fearing ones (gloom-crawlers, centipedes)
  work the **dim margins** where grazers stray, never the bright centre.
- **Almost everything is an opportunist.** Most creatures are omnivores that will prey on
  the **weak** — the wounded, the dying, and above all **outsiders** drifting down with
  the Rush. The Abyss eats the newcomers.

Light adaptation here is ordinary **ecology**, not glimmer's work (that mutation is a
separate, deeper overlay). Creatures sort into the light-tolerant, the light-fearing,
and surface animals gone feral:

- **Outsiders (top floor):** giant rats, cave bats, feral mongrels.
- **Grazers & cleaners:** stonebugs (and bristling thornbugs), grubs, scour-slugs.
- **Hunters:** cave centipedes, cave lurkers, gloom-crawlers.
- **Pool life:** pale crayfish, blind cave-fish.
- **Light-fearing:** pale salamanders, tremor-moles.
- **Luminous:** lightbugs (partially farmed at the Rim).

Most fauna yield **materials** — chitin plate, spikes, venom glands, slug slime, grubs,
salamander tails, luminescent glands — the biological half of the crafting economy,
beside the mineral half (iron, glimmer).

### River flora

**Weeping Chasm-Moss** is a predatory, bioluminescent moss found at depth, wherever
water runs or hot vents breathe moisture into the air. It clings to ceilings and rock
faces above abyssal rivers and drops long, hair-fine tendrils into the current to catch
drifting organic matter — a passive filter-feeder that glows faintly blue-white.
It does **not** require external light; it is self-luminous, and is one of the rare plants
that thrives in total darkness. Harvested and dried, its fibres can be processed at an
alchemist's bench into **gloom-silk**, a fine, faintly luminous thread — the raw material
for deep-made cloth and woven gear. Exception to the light-dependent flora rule:
it carries its own light with it.

## The Gloaming — the hot-spring hollows

Below the fifth floor, east of the Gullet, the Abyss changes its character. The cold dry
dark gives way to **warmth and wet**: hot vents breathe steam into the air, water runs and
gathers into steaming pools, and overhead the rock vanishes behind a **canopy of light**.
To a delver climbing out of the black it looks like nothing so much as daylight under a
green sky — the one place in the deep that looks *alive*, and *kind*. It is neither. Delvers
call it **the Gloaming**, for the standing dusk-light that fills it and never breaks into a
true day.

**The false sky.** The canopy is Weeping Chasm-Moss — the same predatory filter-feeder that
fringes the river-caves (see *River flora*) — but fed by the endless warm damp of the vents
it has grown across a whole cavern roof, a hanging forest of itself glowing soft and
overcast blue-white. It is not the sun and it is not glimmer; it is a plant, carrying its
own light as its kind always has. Spread wide enough it *reads* as a sky: a dawn that never
climbs and never sets. And it lowers the same hair-fine tendrils it always does — only here
in their thousands, drifting down into the warm air. The ceiling that lights the hollow is
also feeding on what the light draws up to it.

**The one lush place.** Vegetation in the Abyss grows only where there is light, and here
for once there is light in plenty — constant, generous, green. So things *grow*: fungi the
size of trees, whose aged stalks harden into workable timber; soft ferns thick in the warm
damp; pale luminous fruit on the canopy's lower fronds. It is the closest the deep comes to
a garden, and it keeps a gentler trade than the rest of the Abyss — a place delvers come to
**forage, gather, and weave** (its Chasm-Moss is the richest source of gloom-silk known)
rather than to mine and kill.

**The light is a lie.** The warmth and the glow are not sanctuary; they are **bait**. Where
the cave-dark runs on light-*fearing* things, the Gloaming runs on light-*loving* ones —
grazers that come to bask and feed, and hunters grown fat on what the standing dusk lures
into the open. The vents that sweeten the air will **scald** the careless, and the canopy
itself feeds. A delver reads the green light as safety and lets their guard down; the hollow
is built, root and branch, to punish exactly that. Its danger sits *beside* the depth-ladder
rather than on it — not the Hollowing, not glimmer's work, but plain hungry **ecology**
wearing the face of a refuge.

**It keeps the Abyss's hours.** When the **Tide** rises — the slow dark that comes and goes
through the deep, drowning its lights — even the gloaming answers to it: the glow guttering
out across the roof until the warm garden lies in full dark. Whether the moss draws its
light inward or the rising dark simply reaches it too, no one can say. Delvers know only
that the safest-seeming place in the deep does not stay lit, and that to be caught beneath
the dead canopy when the light goes is to learn what the warmth was gathering all along.

**Its creatures.** The fauna are a deliberate change of pace — not the pale eyeless horrors
of the deep but ordinary animals grown strange in a warm, lit pocket: heavy basking newts,
big slow insects on glassy wings, water-lizards, a scorpion of the scalding pools. Unusual
for the Abyss, but *animals* — not the dark-taken, not the glimmer-warped. The Gloaming's
threat is what they *do* in the light, not what the deep has made of them. *(Species names
provisional.)*

**Downward.** The Gloaming is not one room but a descent — hollows stacked down the wall of
a great steaming gulf, the growth thickening and the air growing hotter the lower you go,
toward warm water somewhere below. How far its own floor lies — and whether it has one, or
simply opens onto the deeper dark like everywhere else — no one has followed it to learn.
What waits at the foot of the Gloaming stays, for now, unspoken.

## The threat ladder (escalation by depth)

A legible progression for hanging future content on:

1. **Surface deep** — vermin and lone predators (rats, bats, crawlers, lurkers).
2. **Mid-deep** — **living shadows** (the end-stage of the Hollowing — *see above*) and
   the first mutated horrors; light-vulnerable.
3. **Deeper** — **hostile/mutated Umbral holdouts** (the deep-dwellers), and below them
   the **lost village** of the dark-taken — husks, fading things, and pooled shadows in
   the streets of a settlement the Hollowing thinned to nothing.
4. **The deep myth** — the **Glimmer Dragon**: an apex creature so steeped in glimmer
   it has become part-mineral. The Rush's tallest tale; possibly real.

## Deliberately unknown (do not resolve)

These are load-bearing mysteries. Content may *gesture* at them but must not *answer*
them:

- What glimmer truly is, and what the **Dark Star** is.
- How deep the Abyss goes, and what waits at the bottom.
- Whether the Glimmer Dragon is real.
- What the dark is, why the **Hollowing** takes some and spares others, and whether it is
  the same force as glimmer's mutation of the body or a different hand entirely.

## Consistency rules for content authors

- Surface = prospector boomtown tone (permits, rich-seam rumours, fortunes, the lost).
- Light relationship is **ecological**; glimmer mutation is a **separate magical**
  cause — don't conflate them.
- Umbrals are friendly-but-distant near the top; the deep twists them. Worked stone
  and wall-reliefs imply Umbral hands.
- **Glimmer warps the body; the dark Hollows the self.** Living shadows and the husks of
  the lost village are **dark-taken**, not glimmer-mutated — keep the two causes distinct
  even as you let them rhyme, and never state which (if either) is behind the other.
- Never assert glimmer's true nature or the Dark Star as fact — only as legend.
- No "great delve" as a fixed past event (Maeve's bio to be softened accordingly).
