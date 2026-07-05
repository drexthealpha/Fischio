# fischio

*Il fischio finale*: the final whistle. The moment a match ends and, on fischio, the
moment money moves.

fischio is a settlement layer for sports wagers on Solana. Two parties escrow funds
on a match outcome. When the match ends, a cryptographic proof of the final score
releases the pot to the winner. No bookmaker grades the bet. No oracle committee
votes. No support ticket decides. A Merkle proof either verifies on-chain or it
does not, and the funds follow.

Live on Solana devnet against real World Cup 2026 data, with real settlements to
show for it. Verify one yourself:

- Program: `FVVSa2AcwxBdmtKxFHiZMmd2ceRWorh7ZDdppvPsPvxb`
- A real settlement: wager `9KS3z6joNRFvLNF1rYck6C3U3xR2CZcNzHvTsCQSwKQq`
  (USA v Bosnia & Herzegovina, 2-0) settled by
  `3wu6mTNQFkQogmJZGMqRaKwAvDAyRcKFk3BYFYXTePK3hWni2tNjV6Qp8hTAvGqATKvyMe1FWkniLAt4jcw7ppKf`.
  The transaction's inner instructions show the CPI into the oracle program that
  verified the score before a single lamport moved.

## Why this is hard, and how fischio solves it

Anyone can check a score. The dangerous question is whether the score is final. A
genuine proof of "1-0" pulled in the 49th minute is poison to an escrow; the match
can end 2-0. The industry patches this with dispute windows, challenge bonds, or a
trusted resolver, which reintroduce the trust the escrow was meant to remove.

fischio settles on data from TxLINE (TxODDS), which anchors match data to Solana
with Merkle roots every five minutes and hashes the live match phase into every
provable leaf. One proof therefore carries the outcome AND the fact that the match
is over, atomically. The program accepts only leaves from terminal phases (full
time, after extra time, after penalties, all confirmed from real match data) and
rejects everything else before the oracle CPI runs: wrong fixture, wrong stat,
mid-match totals, mid-shootout leaves, spliced events, wrong roots account. A
tampered value dies inside the oracle's own Merkle verification. 20 adversarial
tests attack the money path with real captured proofs; 20 pass.

## No trusted operator

Settlement does not depend on any machine we control. The settle instruction is
permissionless: any keypair holding a valid proof can execute it and earns a tip
from the pot for doing so. We run one always-on keeper as a convenience; it holds
no special authority. If every keeper on earth goes dark, any user can settle with
one command, and if nobody settles at all, the refund path opens at expiry and both
sides recover their stakes. Correctness never depends on liveness.

## Product

A betting slip you can verify, not a dashboard you have to trust:

- Markets: open wagers on real fixtures, rendered as tickets. Terms in plain
  bettor English, down to the shootout edge case, shown before any stake locks.
- Wallet-native: connect a Solana wallet, stake into the wager vault directly.
  There is no deposit account, no custody, no signup. The wager IS the account.
- Portfolio: your tickets read straight from on-chain state. Settled outcomes are
  derived from the settle transaction itself; the app stores nothing.
- Settlement, live: watch the keeper detect full time, pull the proof, and stamp
  the ticket SETTLED BY PROOF, with the transaction signature as the receipt.

## Run it

Frontend (Vite + React, static, no server):

    cd app && npm install && npm run dev

Settle any active wager yourself (this is the whole point):

    npm install
    node bot/settle-bot.mjs --wager <address> --rpc https://api.devnet.solana.com

Adversarial suite (local validator with the real oracle program and real roots
accounts cloned from devnet):

    scripts/start-test-validator.ps1
    node --test tests/

## Architecture

    programs/wc-settle/   Anchor program: escrow state machine, finality gates,
                          CPI verification into TxLINE's validate_stat
    bot/settle-bot.mjs    permissionless keeper; env or CLI config, runs anywhere
    bot/live-relay.mjs    read-only log tail + chain reads for the live UI
    app/                  markets, portfolio, settlement views (design: app/DESIGN.md)
    tests/                20-case adversarial suite with real captured proofs
    docs/SUBMISSION.md    technical deep dive: gate ordering, CU measurements,
                          the fund-freeze bug the suite caught, oracle forensics
    RECON.md              verified facts about the oracle stack, with measurements

Full settle transaction: 204,162 compute units, about 15% of Solana's limit,
proof verification and payout included.

## Roadmap

The settle instruction answers one question: did a verified stat cross a line when
the match ended. Everything a sportsbook sells is composition on top of that
primitive. Next, in order: more market types on the same stats (totals, corners,
cards are already provable leaves), multi-leg parlays as chained predicates,
pooled counterparties instead of 1v1 matching, and USDC stakes on mainnet behind
an audit. The engine does not change; the products stack on it.

## Status

Devnet beta. Stakes are devnet SOL. The program is intentionally frozen while the
World Cup 2026 data window is live. Built on TxLINE by TxODDS for verified match
data; TxLINE's credit token is used only for data authorization and never touches
user funds.
