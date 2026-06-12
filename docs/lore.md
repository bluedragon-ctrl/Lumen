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
prospect the Abyss. **Delvers are prospectors** — think claims, rich-seam rumours,
boomtown prices, sudden fortunes, and the many who never come back up. This framing
should colour the tone of all surface content.

## The Rim

The rough boomtown at the mouth of the Abyss, the last settlement before the dark —
where prospectors gather, trade in shards, resupply, and stage expeditions. Trades
in light, rope, steel, broth, and tallow. Established figures: **Maeve** (innkeeper),
**Garrick** (sour quartermaster), **Tobin** (half-mad tinker-smith), **Fenn**
(self-appointed claims-recorder — nobody appointed him, but no claim is real until
it crosses his counter), **Hale** (watchman — an ex-sellsword paid in shards by the
traders to walk the village and be seen; the Rim has no formal law).

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
  third floor.
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

## The threat ladder (escalation by depth)

A legible progression for hanging future content on:

1. **Surface deep** — vermin and lone predators (rats, bats, crawlers, lurkers).
2. **Mid-deep** — **living shadows** and the first mutated horrors; light-vulnerable.
3. **Deeper** — **hostile/mutated Umbral holdouts** (the deep-dwellers).
4. **The deep myth** — the **Glimmer Dragon**: an apex creature so steeped in glimmer
   it has become part-mineral. The Rush's tallest tale; possibly real.

## Deliberately unknown (do not resolve)

These are load-bearing mysteries. Content may *gesture* at them but must not *answer*
them:

- What glimmer truly is, and what the **Dark Star** is.
- How deep the Abyss goes, and what waits at the bottom.
- Whether the Glimmer Dragon is real.

## Consistency rules for content authors

- Surface = prospector boomtown tone (claims, rumours, fortunes, the lost).
- Light relationship is **ecological**; glimmer mutation is a **separate magical**
  cause — don't conflate them.
- Umbrals are friendly-but-distant near the top; the deep twists them. Worked stone
  and wall-reliefs imply Umbral hands.
- Never assert glimmer's true nature or the Dark Star as fact — only as legend.
- No "great delve" as a fixed past event (Maeve's bio to be softened accordingly).
