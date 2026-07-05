# wc-settle: permissionless proof-based settlement of World Cup wagers

Two parties lock SOL on a single-match outcome. When the match ends, **anyone** (any bot,
no privileged resolver) submits TxLINE's Merkle proof of the final score. The program
verifies it against TxODDS's on-chain oracle roots via CPI into `validate_stat` and pays
the winner. No multisig, no admin key, no dispute window: the proof is the settlement.

## v1 market meaning (locked)

A wager means **"maker's side of the predicate holds at the final whistle of 90 minutes
or extra time."** Penalties are excluded: goal totals at the terminal phases include ET
goals but never shootout goals, verified against real data (Netherlands–Morocco ended
1–1 after ET, went to a shootout, and its terminal proof leaf reads `goals 1–1, phase
13`). Under the canonical "P1 beats P2" terms (`stat_a=1, stat_b=2, op=Subtract,
predicate GT 0`), a match that reaches penalties is a draw at the final whistle → the
predicate is false → **the taker collects, even if the maker's team wins the shootout.**
The taker's side of every ticket is literally "P1 fails to win inside 90'+ET"; a
shootout counts as the taker's win. On-chain behavior, tested behavior, and the
ticket's plain-language terms all say the same thing.

## How settlement stays safe

The proven stat leaf is `{key, value, period}` where `period` is the game-phase code,
hashed into TxLINE's Merkle tree. The program only accepts leaves at terminal phases
(5 = full time, 10 = ended after ET, 13 = ended after penalties; all three observed in
real devnet leaves), requires both leaves to come from the same event
snapshot, matches fixture and stat keys against the stored terms, and evaluates the
stored predicate, never the submitter's. Mid-match "running total" proofs (period 0)
and relabeled periods fail cryptographically (`InvalidStatProof` in the oracle).
Full recon and measurements: [RECON.md](RECON.md).

## No trusted operator

Settlement does not depend on any machine we control. The settle instruction is
permissionless: any keypair holding a valid TxLINE proof can execute it and earn the
0.0001 SOL tip from the pot. We run one keeper instance on an always-on host purely
as a convenience, and it has no special authority; if it disappears, any user, judge,
or stranger can settle any wager with the public bot (`bot/settle-bot.mjs`, config via
env or flags). If nobody settles at all, the refund path opens at expiry and either
party recovers stakes. Liveness has three independent fallbacks; correctness never
depends on liveness.

## Layout

- `programs/wc-settle/`: Anchor program with `create_wager`, `accept_wager`, `settle`, `refund`
- `bot/settle-bot.mjs`: permissionless settlement bot; anyone can run it, that is the point
- `app/`: frontend (ticket + live settlement view), design rules in `app/DESIGN.md`
- `tests/`: adversarial suite (real TxLINE proofs vs cloned oracle on a local validator)
- `scripts/start-test-validator.ps1`: local validator with cloned txoracle + roots accounts
- `day1/`: recon scripts and measured evidence (CU costs, finality probes)

## Oracle (TxLINE by TxODDS, devnet)

- Program: `6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J`
- Roots PDA: `["daily_scores_roots", u16_le(epoch_day)]`, one 32-byte root per 5-min interval
- Proofs: `GET /api/scores/stat-validation?fixtureId=&seq=&statKey=&statKey2=`
