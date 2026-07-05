# wc-settle: technical documentation

TxLINE World Cup hackathon, verifiable-settlement track.
Program (devnet): `FVVSa2AcwxBdmtKxFHiZMmd2ceRWorh7ZDdppvPsPvxb`
Oracle: TxODDS txoracle `6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J`
Stakes settle in SOL. The TxLINE credit token is used only for what it is for:
on-chain data authorization via `subscribe()`. It never touches user funds.

## Core idea

Two parties escrow SOL on a World Cup match outcome. When the match ends, anyone
(any keypair, no oracle role, no admin, no house) submits TxLINE's Merkle proof of
the final score. The escrow program verifies the proof on-chain by CPI into
txoracle `validate_stat` and pays the winner in the same transaction. A flat
0.0001 SOL tip from the pot goes to whoever lands the proof first, so settlement is
a permissionless race with an incentive, not an operational duty owed by anyone.

This is live on devnet, not simulated. Example journey, verifiable end to end:
wager `9KS3z6joNRFvLNF1rYck6C3U3xR2CZcNzHvTsCQSwKQq` on USA v Bosnia & Herzegovina
(fixture 18172379) settled by signature
`3wu6mTNQFkQogmJZGMqRaKwAvDAyRcKFk3BYFYXTePK3hWni2tNjV6Qp8hTAvGqATKvyMe1FWkniLAt4jcw7ppKf`
in slot 473906358: 204,162 compute units for proof verification plus payout, winner
paid the pot minus tip, vault drained to zero lamports.

## The hard problem is finality, and the leaf already solves it

Any settlement engine can check a score. The dangerous question is whether the
score is FINAL. A genuine, cryptographically perfect proof of "USA 1-0" pulled in
the 49th minute is poison to an escrow: the match later ended 2-0, and a naive
contract that accepted the mid-match proof would have paid the right team by luck
and the wrong amount of certainty by design. Oracle systems usually patch this with
dispute windows, challenge bonds, or a trusted resolver who decides when a result
is official. All of those reintroduce the trust the escrow was built to remove.

TxLINE's leaf encoding makes the patch unnecessary. Every provable stat leaf is
`{key, value, period}`, and `period` is the live game-phase code at the moment the
update was recorded, hashed into the Merkle leaf itself. A proof therefore does not
say "the score was 2-0". It says "the score was 2-0 AND the match state was X", and
X cannot be altered without breaking the Merkle path. We verified that directly: a
mid-match leaf relabeled from period 0 to period 5 fails inside txoracle with
InvalidStatProof (6023). Outcome and finality arrive in one atomic proof, so
settlement needs no waiting period, no challenger, and no resolver.

The terminal phase codes were confirmed from real feed data, not assumed from docs:

- 5 (full time): USA v Bosnia 2-0, England v Congo DR 2-1, and others.
- 10 (ended after extra time): Belgium v Senegal 3-2, terminal leaf at period 10
  with ET goals included.
- 13 (ended after penalties): the docs stop at "12 = shootout in progress", so we
  walked the full status history of Netherlands v Morocco (June 30, decided on
  penalties). The feed runs 9, then 11 (awaiting shootout), 12 (shootout live),
  13 (ended). The terminal leaf reads goals 1-1, period 13, and the goal keys
  exclude shootout goals. Mid-shootout leaves carry period 12 and are rejected by
  our gate as non-terminal, which closes the settle-during-shootout race.

That period-13 discovery also fixed the market semantics for free: a pens-decided
match is provably a draw at the final whistle, so under "maker's team wins in 90
minutes plus extra time" terms the taker collects, even if the maker's team wins
the shootout. The ticket states this before any stake is locked.

## The settle instruction, in execution order

The track invites "independent, custom check gates" on top of the validation
primitive. Our settle instruction is exactly that: seven ordered checks, each
placed before the money for a reason. The oracle CPI proves the data is genuine;
the gates prove the data is about this bet and that the match is over. Those are
orthogonal claims, and conflating them is where settlement engines break: txoracle
will happily verify a perfect proof about the wrong match.

1. State machine first: the wager must be Active. Double settles, settles before
   acceptance, and settles after refund all die here with a precise error.
2. Party identity, checked in the handler AFTER the state check rather than by
   Anchor address constraints. This ordering is a bug fix with a story (below).
3. Relevance: the proof's fixture_id and both stat keys must equal the terms stored
   at creation. The submitter chooses only proof bytes, never what is being proven.
4. Finality gate: the proven leaf's period must be in {5, 10, 13}. Period 0
   (running totals emitted during AND after the match), all in-play phases, and
   period 12 are rejected. This is the check that makes a genuine 49th-minute proof
   worthless to an attacker.
5. Same-event binding: for two-stat markets (goals A minus goals B), stat_b must
   carry the same period AND the same event_stat_root as stat_a. Without root
   equality, a submitter could splice two individually genuine leaves from
   different snapshot events into one settlement claim. Period equality alone
   leaves a residual splice between distinct terminal-phase events; requiring the
   shared event root pins both leaves to one atomic snapshot. Cheap check, whole
   attack class closed before the CPI.
6. Oracle account integrity: the daily roots account passed in must be the
   canonical txoracle PDA for the epoch day derived from the proof's own
   minTimestamp, recomputed on-chain with find_program_address. A submitter cannot
   point verification at a different day or a fabricated account; txoracle then
   validates the account contents against the timestamp internally.
7. Only now, the CPI: `validate_stat` re-verifies the entire Merkle chain (stat
   leaf into event tree, event into batch summary, summary into the posted 5-minute
   interval root) and evaluates the predicate. The predicate and operator come from
   the STORED terms, never from the submitter, and `ts` is derived from the summary
   rather than accepted as an argument. One less forgeable input each.

Money moves last: state flips to Settled before a single lamport transfer,
predicate true pays the maker, false pays the taker, the tip pays the settler, and
the vault drains to exactly zero. There is no partial-payout state to reason about.

## The bug the adversarial suite caught

The first implementation pinned the maker and taker payout accounts with Anchor
`address =` constraints. Declarative constraints evaluate before handler logic, and
an unaccepted wager stores taker as Pubkey::default, which is the system program's
address. Consequence: refunding a never-accepted wager was impossible, because the
only account satisfying the constraint had to be passed writable and the runtime
rejects writable program accounts. Maker funds would have been frozen forever on
the most boring path in the program, the one where nothing happened.

The suite caught it because it tests Open-state paths, not just the happy line. The
fix moved identity checks into the handler after the state check: same guarantees,
correct precedence, and the state machine now answers before account plumbing can
mask it. The general lesson we would offer any Anchor team: constraint evaluation
order is part of your money path, audit it like code.

## CPI versus direct verification: decided by measurement

The docs invoke validate_stat with a 1,400,000 CU budget, which is the transaction
ceiling. Taken at face value that makes CPI composition impossible and forces every
integrator to re-implement Merkle verification locally. We measured instead, with
real proofs on devnet, on day one:

- validate_stat standalone: 151,931 CU (two-stat), 144,504 CU (single-stat)
- via CPI from our program: ~179,000 CU
- full settle transaction (guards, CPI, payout, tip): 204,162 CU, 15% of the limit

So the documented budget is a ceiling, not a cost, and the architecture followed
from the number: CPI into the deployed oracle program rather than reimplementing
its verification. The trust chain runs through TxODDS's own on-chain code and its
posted roots; wc-settle adds only the escrow state machine and the finality gates.
Callers must request an explicit compute budget (about 400k CU), since the 200k
default fails mid-CPI. Failed verification aborts the whole transaction, so no
partial state can exist by construction.

## Verified against the sponsor's own examples

After TxODDS published their tx-on-chain examples repo, we re-verified the engine
against it and against the deployed devnet binary, by probe rather than by docs.

Instruction choice. The deployed devnet program contains both `validate_stat` and
`validate_stat_v2` (confirmed by discriminator probe: both instructions answer, a
random discriminator does not), and v1 remains in the latest published IDL (1.5.5)
and in the sponsor's current examples. Our CPI targets a current, supported
instruction; every settlement signature in this document proves it verifies. The
v2 instruction adds N-stat payloads with strategy expressions (indexed single and
binary predicates, plus geometric distance). Our two-stat market is exactly v2's
binary predicate, and v2 is the native vehicle for the parlay roadmap item:
multi-leg positions become one proof with one strategy, no engine redesign.

Finality method. The sponsor's recipe resolves outcomes off-chain from the feed
record with Action = game_finalised. We compared both methods on three real
fixtures (USA v Bosnia, Netherlands v Morocco after penalties, Paraguay v France):
identical outcomes on all three. The difference is that game_finalised is a
seq-picking recipe, while our gate is enforced on-chain, and it is stricter:
proofs at the game_finalised seq carry period 0 leaves, which on-chain are
indistinguishable from mid-match running totals, so our program rejects them by
design. That strictness is the settle-early exploit staying closed. Our method
also fires earlier in practice: Paraguay v France hit its terminal phase-5 record
about ten minutes before its game_finalised marker.

One new observation from that comparison, logged honestly: recent matches emit a
post-match confirmation status 100 after the terminal phase. In all observed data
it follows a 5/10/13 record and never replaces one, so the allow-list is
unchanged; if the feed ever finalizes a match without a preceding terminal phase,
the fix is one constant plus one test.

## Testing: 20 adversarial cases against the real oracle

The suite runs against a local validator loaded with the real txoracle binary and
real daily-roots accounts dumped from devnet, using real captured proof packages:
USA v Bosnia at full time, Belgium v Senegal after ET, Netherlands v Morocco after
penalties, a genuine 49th-minute mid-match proof, a genuine mid-shootout proof, and
a genuine corners proof for the wrong-stat case. Every negative test models a
plausible wrong implementation rather than mirroring ours: settle before accept,
double settle, double refund, a genuine proof for the WRONG fixture (the oracle
alone accepts it; only gate 3 stands in the way), wrong stat keys, period-0 totals
carrying the correct final score, forged terminal periods, cross-event stat_b,
wrong roots PDA, tampered values (killed inside the oracle, proving the layered
defense), expiry races, and exact-lamport payout and refund accounting. 20 of 20
pass. Money-path behavior is deterministic: same proof, same terms, same result,
every time, with no clocks or randomness in the settle path.

## TxLINE endpoints used

- `POST /auth/guest/start`; on-chain `subscribe()` (free World Cup tier, service
  level 1); `POST /api/token/activate` with the signed `txSig:leagues:jwt` binding
- `GET /api/fixtures/snapshot?startEpochDay=` (fixture ids, names, kickoffs)
- `GET /api/scores/snapshot/{fixtureId}` and `GET /api/scores/historical/{fixtureId}`
  (live phase detection from StatusId; full record sequence for finished matches)
- `GET /api/scores/stat-validation?fixtureId=&seq=&statKey=1&statKey2=2` (the proof
  package: two leaves, event stat root, batch summary, three Merkle paths)
- On-chain: CPI into `validate_stat`; daily roots PDA
  `["daily_scores_roots", u16_le(epoch_day)]`, epoch_day floor-divided from the
  proof's own minTimestamp in milliseconds

## No trusted operator

Settlement liveness does not depend on us. The settle instruction is permissionless
and tip-incentivized, so three independent actors can release funds: the hosted
keeper we run as a convenience (an ordinary keypair on a third-party Node host, no
authority), any user or judge running the public bot with one command, or, if
nobody settles at all, the expiry refund path that returns both stakes. The
laptop-off question has a one-line answer: the program does not know or care who
submits the proof.

## Product surface

Paper-ticket UI over the engine: Markets (open wagers as tickets, real on-chain
reads), create/accept through a standard Solana wallet adapter (the existing
instructions are the only money paths; no custody, no deposit flow, no signup),
Account (pure reads of the wallet's wager PDAs; settled outcomes derived from the
settle transaction's balance deltas since the program deliberately stores no
winner), and the Settlement view: a live tail of the permissionless bot with the
proof receipt, plus an honestly labeled replay of a recorded devnet run as the
guaranteed demo path. The live view never fabricates: if the devnet oracle has not
posted the interval root yet, the UI says so and waits, visibly.

## Feedback for TxODDS

Best design decision in the system: the phase code living inside the hashed leaf.
Finality proofs fall out of it for free, and our whole engine is built on that one
property. Also good: proof responses arrive as raw byte arrays shaped exactly for
on-chain submission, and stat-validation's seq parameter makes historical terminal
proofs reproducible forever, which made honest testing possible.

Friction, in the order we hit it:

- The activation gateway returned 500s, then a 503 window, on July 2; activation
  succeeded on retry minutes later. Clearer error bodies or a status endpoint would
  save integrators an anxious hour.
- `subscribe()` requires the user's TxL token account to exist even at zero cost
  (AccountNotInitialized 3012). Undocumented; we fixed it with an idempotent
  create-ATA pre-instruction. Worth one line in the quickstart.
- The terminal phase code for penalties-decided matches (13) is undocumented; the
  docs stop at 12. We confirmed 13 from Netherlands v Morocco's real feed. A full
  phase-code table marking which codes are terminal would save every settlement
  integrator a day of forensics.
- The `ts` argument to validate_stat must equal summary.updateStats.minTimestamp;
  the response's top-level `ts` is a different timestamp and fails with
  TimestampMismatch 6010. One sentence in the docs prevents this trap.
- The scores snapshot endpoint window-limits records, which hid the true terminal
  record of a finished match during our finality research; the historical endpoint
  has the full sequence. The distinction matters for settlement engines.
- Not TxODDS's infrastructure, but it shaped two days: api.devnet.solana.com served
  an expired TLS certificate July 2-3 (rotated July 4). Devnet integrators may
  appreciate a known-issues note when it happens.

## Repository map

`programs/wc-settle` Anchor program: escrow, finality gates, CPI verification.
`bot/settle-bot.mjs` permissionless settler (anyone can run it; that is the point).
`bot/live-relay.mjs` read-only log tail and chain reads for the live UI.
`app/` markets, account, settlement views; design system in app/DESIGN.md.
`tests/` the 20-case adversarial suite. `RECON.md` verified oracle facts with
measurements. `MATCHDAY.md` the live-capture runbook.
