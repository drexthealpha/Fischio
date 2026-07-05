# DESIGN.md: locked direction. Every component follows this or gets rejected.

## Direction

Real football wagers settled trustlessly by cryptographic proof. The aesthetic comes from
that subject: **stadium data board meets verifiable paper ticket**. Two visual registers,
used deliberately:

1. **Scoreboard register**: fixture names, scores, match phase. Condensed grotesque,
   heavy weights, tabular numerals, tight tracking. Information density like a stadium
   board, not marketing air.
2. **Receipt register**: everything on-chain: pubkeys, signatures, proof hashes, lamports.
   Mono, hairline rules, the visual language of a printed betting slip / cryptographic
   receipt. A wager IS a ticket; render it as one.

The signature moment is settlement: proof resolves → funds move. One orchestrated state
change: the ticket "stamps" from PENDING to SETTLED BY PROOF. Ceremonial, brief, earned.
Everything else sits still.

## Hard bans (AI-slop tells, reject on sight)

No purple/indigo/violet. No gradients (background, text, orbs, blobs). No glassmorphism or
frosted cards. No centered-hero + 3-feature-cards. No uniform rounded-2xl + soft shadow on
everything. No colored left-border card strips. No Inter, no Space Grotesk. No emoji-as-
icons. No fade-in-up-on-everything. No dark mode (the ticket is paper; paper is light).
Litmus test for every choice: "would this appear in a totally different product?" If yes,
it's a default; replace it with something derived from tickets/scoreboards.

## Tokens (nothing improvised)

### Type
- Display / scoreboard: **IBM Plex Sans Condensed** 600/700, tracking -1% to -2%,
  `font-variant-numeric: tabular-nums` everywhere numbers appear.
- Body / labels: **IBM Plex Sans** 400/600.
- Data / on-chain / proof: **JetBrains Mono** 400/500 for ALL pubkeys, sigs, hashes,
  lamports, seqs, stat keys. No exceptions.
- Scale (px): 12, 13, 15, 18, 24, 32, 44, 60. Weight contrast is extreme by design:
  700 condensed display against 400 body, nothing in between except 600 labels.
- Micro-labels (ticket field names): 12px, uppercase, +8% tracking, gray-6.

### Color
Neutrals carry the UI. Warm paper-and-ink ramp (hierarchy must read in grayscale first):
```
--g0 #FBFAF7  paper (app bg)          --g5 #8A8578  disabled / hairline dark
--g1 #F4F2EC  ticket bg               --g6 #6B675C  tertiary text
--g2 #E9E6DD  rules / borders         --g7 #4A4740  secondary text
--g3 #D6D2C4  perforation / dividers  --g8 #262420  primary text
--g4 #B3AEA0  faint text on paper     --g9 #141310  ink (display type)
```
ONE accent: **pitch green `--pitch #1B7A3D`** (hover `#166332`, tint bg `#EAF3ED`).
Reserved exclusively for: interactive elements, the LIVE indicator, and the settled state.
Never decorative. Match-phase red cards etc. use ink, not extra hues.

### Spacing
4 / 8 / 12 / 16 / 24 / 32 / 48 / 64 only. Internal padding < external gaps.
Ticket internals are dense (8/12); page-level whitespace is generous (48/64).

### Depth (3 levels, that's all)
- L0 flat on paper, separated by hairline rules (`1px solid --g2`).
- L1 the ticket: `1px solid --g3` + `0 1px 2px rgb(20 19 16 / 0.06)`.
- L2 the settlement stamp/modal moment: `0 4px 16px rgb(20 19 16 / 0.12)`.
Corners: 2px on tickets/buttons (paper cut, not pill). Perforation between ticket body
and stub: dashed `--g3` with punched semicircles.

### Motion
< 300ms, ease-out, and only:
- interactive feedback (100–150ms color/border)
- live feed rows appearing (150ms translate 4px, feed only)
- THE settlement moment: one orchestrated sequence (~900ms total, stamp scale-in 200ms +
  rule draw + green state commit), used once per settlement, never looped.
Nothing else moves.

## Language

NEVER use em dashes (—) or spaced hyphens as punctuation. Use a colon to introduce, a comma or
parentheses for an aside, or a period/semicolon to join clauses. This applies to ALL generated
text: UI copy, docs, comments, commit messages. En dashes only for numeric ranges (2-0, 90-120).
Plain football-bettor English on the ticket ("USA to beat Bosnia & Herzegovina: 90
minutes + extra time, penalties excluded"). Cryptography speaks in the receipt register
("SETTLED BY PROOF: no oracle, no admin, no human signature"). Real data always: real
fixtures, real pubkeys, real signatures from our devnet/local validator. NO lorem ipsum,
no placeholder-looking strings.
