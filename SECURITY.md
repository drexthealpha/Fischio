# fischio security model and self-audit

This is a self-audit. No third party has reviewed it yet. Everything runs on devnet with test tokens.
Do not put real money in these programs until they are audited. With that said, every
program holds one clear money invariant, and the adversarial tests check it. This document
says what each invariant is, who is allowed to do what, and where the defense lives in the
code.

There are no admin keys. Every authority is a program PDA that signs for its own vault. No
human can move user funds in any program.

## Reporting a vulnerability

If you find a security issue, do not open a public issue or a pull request. Report it
privately to the maintainers at the project's contact address, with enough detail to
reproduce it (the program or service, the accounts or inputs involved, and the impact). We
will acknowledge the report, work with you on a fix, and credit you once it is resolved.
Everything currently runs on devnet with test tokens, so there are no user funds at risk
today, but responsible disclosure keeps it that way as this moves toward mainnet.

## wc-settle (escrow settlement)

Invariant: a wager's vault holds exactly both stakes until it resolves, then pays one party.

Settlement runs in a fixed order, each check placed before the money for a reason. The
oracle CPI proves the data is genuine; everything before it proves the data is about this
bet and that the match is over. Those are separate claims, and conflating them is where
settlement engines break: txoracle will happily verify a perfect proof about the wrong
match.

1. State machine first: the wager must be Active. Double settles, settling before
   acceptance, and settling after refund all die here with a precise error.
2. Party identity, checked in the handler after the state check rather than through an
   Anchor address constraint (a bug fix with a story below).
3. Relevance: the proof's fixture ID and both stat keys must equal the terms stored at
   creation. The submitter chooses only proof bytes, never what is being proven.
4. Finality gate: the proven leaf's period must be in {5, 10, 13} (`NonTerminalPeriod`,
   lib.rs:150). Running totals emitted mid-match, all in-play phases, and mid-shootout
   leaves are rejected, which is what makes a genuine 49th-minute proof worthless to an
   attacker.
5. Same-event binding: two-stat proofs must share one `event_stat_root`
   (`EventRootMismatch`, lib.rs:158), which stops splicing two individually genuine leaves
   from different snapshots into one settlement claim.
6. Oracle account integrity: the daily-roots account passed in must be the canonical
   txoracle PDA for the proof's own day, recomputed on-chain, never taken on faith
   (`WrongDailyRootsAccount`, lib.rs:177).
7. Only now, the CPI: `validate_stat` re-verifies the whole Merkle chain and evaluates the
   predicate. The predicate and operator come from the stored terms, never the submitter.

Money moves last: state flips to Settled before any transfer, so there is no partial-payout
state to reason about. Settlement is permissionless throughout: anyone can submit the proof
and earn a small tip, and the program trusts only the proof, never the submitter.

We measured the CPI cost with real proofs rather than trusting the documented ceiling:
`validate_stat` standalone runs 144,504 to 151,931 CU depending on stat count, about
179,000 CU through our CPI, and the full settle transaction (guards, CPI, payout, tip)
lands at 204,162 CU, about 15 percent of Solana's limit. That number is why the program
CPIs into TxLINE's own verifier instead of reimplementing Merkle verification: the trust
chain runs through their on-chain code and their posted roots, and wc-settle adds only the
escrow state machine and the finality gates on top.

The bug the suite caught: the first implementation pinned payout accounts with an Anchor
`address =` constraint. Constraints evaluate before handler logic, and an unaccepted
wager stores `taker` as `Pubkey::default`, the system program's own address. Refunding a
never-accepted wager was therefore impossible, since the runtime rejects a writable
program account, and maker funds would have been frozen forever on the most boring path in
the program, the one where nothing happened. The suite caught it because it tests
Open-state paths as well as the happy line. The fix moved identity checks into the handler
after the state check (step 2 above): same guarantees, correct precedence. Constraint
evaluation order is part of the money path; audit it like code.

Covered by 20 adversarial tests against the real oracle program and real captured proofs,
including the frozen-refund bug above, a genuine mid-match proof, a genuine mid-shootout
proof, wrong-fixture and wrong-stat proofs, forged terminal periods, cross-event splicing,
and exact-lamport payout and refund accounting.

## market (AMM)

Invariant: vault collateral == YES supply == NO supply, at all times.

- Every split adds equal collateral, YES, and NO; every merge removes them equally; fees
  are split into both pools so they never break the invariant. This is what guarantees
  every winning share is redeemable. Checked after each operation in the 7-case suite.
- Resolution uses the same finality gate and roots-PDA check as wc-settle
  (`NonTerminalPeriod`, `EventRootMismatch`, `WrongDailyRootsAccount`, lib.rs:268-284).
- Losing shares pay zero; redeem before resolve is rejected.

## exchange (on-chain order book)

Invariant: base_vault == sum of base claimable + resting ask size + base credits queued in
the event heap; quote_vault == sum of quote claimable + resting bid notional + quote
credits queued in the heap. Tokens sit in shared vaults; matching only moves claimable
balances, never tokens, so a fill cannot create or destroy value.

- A taker cannot trade against their own order (`SelfTrade`, lib.rs:158).
- Matching does not touch maker accounts. Each fill pushes one credit to a FIFO event heap
  (`push_event`), and a permissionless `consume_events` crank pays makers later. This is why
  a single order can cross any number of makers with no per-fill account limit: the maker
  accounts are not in the `place_order` transaction at all.
- The crank credits only the maker recorded in each event, deserializing its OpenOrders as a
  real program-owned account (`Account::try_from`), so a fake maker cannot be credited. It
  pops strictly in FIFO order and stops at the first maker not supplied, so it never skips a
  queued credit and never fails: any missing maker is simply paid by a later crank.
- The heap rejects a push when full (`EventHeapFull`) rather than dropping a credit, so no
  fill is ever silently lost; the operator cranks and continues.
- Cancel refunds the exact escrow. The 7-case suite checks conservation after every path,
  including one order sweeping two distinct makers and a partial crank with a withheld maker.
- `init_open_orders` takes a rent `payer` separate from the `owner` authority, so an
  onboarding sponsor can pay the rent while a zero-SOL embedded wallet only signs as owner.
  This changes who pays, never who controls: the OpenOrders `owner` is still the signing
  wallet, so the sponsor cannot touch the funds it seeded. Proven by the zero-SOL onboarding
  smoke, where an unfunded generated wallet becomes a live trading account.

## multi (multi-outcome / NegRisk)

Invariant: vault collateral == YES supply == NO supply, for each outcome, plus the convert
identity below.

- One proof resolves the whole market: it verifies the final stats are genuine through the
  oracle CPI, then picks the single outcome whose predicate holds. Exactly one must hold,
  or it will not resolve (`MultipleWinners`, `NoWinningOutcome`, lib.rs:187-191).
- `convert` burns NO on a set of size k and mints YES on the complement, releasing (k-1)
  collateral. This is solvent because a full NO set is worth (k-1): the released collateral
  exactly matches the burned value. Every mint and burn is checked against the real outcome
  PDA for its index, so no substitute token can be used (`WrongOutcomeMint`, lib.rs:274-286).
- Redeem validates the outcome mint against the index and side, and pays only winning
  tokens (`WrongOutcomeMint`, `WorthlessShare`).

## oracle (optimistic resolution)

Invariant: the bond vault holds exactly the posted bonds until resolution, then pays the
winner.

- The arbiter is a single protocol-wide value in `OracleConfig`, set once and immutable
  after (`init_config` uses Anchor `init`, so a second call fails). It is NOT chosen per
  assertion. An earlier version let the asserter name their own arbiter at assert time,
  which let a dishonest asserter nominate an accomplice to judge any dispute against them.
  That was a real bug, and it is fixed: only the protocol arbiter can resolve a dispute
  (`NotArbiter`).
- Every proposer carries a permissionless on-chain accuracy record (`ProposerStats`),
  updated on each resolution: an unchallenged stand and an upheld dispute both count
  correct, an overturned dispute counts wrong. This is the curation ingredient real
  optimistic oracles converged on (UMA moved Polymarket to accuracy-gated proposers after
  running fully open); the record is on-chain now, so a threshold gate is a policy decision
  a later instruction can add without trusting anyone's off-chain claim.
- Only the winner can claim, and only once (`NotWinner`, `AlreadyClaimed`).
- Undisputed assertions can only settle after the window (`WindowOpen`). The 7-case suite
  covers both dispute outcomes, both attacks, the immutable arbiter, and the accuracy record.

## relayer (gasless)

The relayer only pays the network fee. It has no authority over any account and can never
move user funds. Defenses:

- It only co-signs transactions whose instructions all target fischio programs, so nobody
  can drain it paying for arbitrary transactions.
- It refuses to sign if it would be an instruction signer, so it cannot be tricked into
  authorizing a transfer of its own funds.
- Per-IP rate limiting caps how fast its SOL can be spent.

## sponsor (zero-SOL onboarding)

The sponsor pays the account rent a brand-new wallet needs, so a user can start with no SOL.
It spends only on bounded, safe onboarding steps, and it checks every instruction it co-signs:

- It only pays for account creation whose new account the user owns: `init_open_orders` where
  the owner is a different signing key, and associated-token-account creation for that owner.
- It rejects any instruction where it would end up as the owner or authority, so it cannot be
  turned into a general faucet for a caller's own accounts.
- On devnet it also faucets test USDC, which is a token fischio mints for demos. On mainnet
  that step becomes a real on-ramp and the sponsor faucet is removed.
- Per-IP rate limiting caps how fast its SOL can be spent.

## Known limitations

- Unaudited. Devnet and test tokens only.
- The order book is bounded (64 orders a side). Fills settle through an async event heap
  (128 events) drained by a permissionless crank, so one order can cross any number of
  makers; a production version would raise these bounds and shard the book per market.
- The optimistic oracle still uses a single protocol arbiter to resolve disputes. A bonded
  token vote is the eventual replacement. The arbiter is now immutable and can no longer be
  chosen per assertion, and every
  proposer has an on-chain accuracy record, but the final backstop is still one key. A
  production version would replace that key with a bonded token-voting DVM, the way UMA
  does, while keeping the accuracy record this program already tracks.
- Fiat on-ramp and off-ramp need a licensed partner. That is an integration task, and there
  is no program to write for it.
- Score corrections after full time are not handled. The finality gate accepts terminal
  periods {5, 10, 13}; TxLINE's current guidance keys final settlement on `game_finalised`
  (statusId 100). Both anchor on-chain. The open question is corrections: if a result is
  amended after full time (a goal disallowed on review, an abandoned-then-replayed match),
  there is no confirmed guarantee that finalisation is exactly-once per fixture and stat, no
  strictly monotonic timestamp to order a correction after the original, and no documented
  challenge window. fischio settles once at full time and cannot re-settle a correction. An
  institutional version needs a challenge window keyed to a monotonic anchor timestamp, which
  depends on TxODDS confirming those semantics; until they do, monotonic correction ordering
  should not be baked into settlement.
