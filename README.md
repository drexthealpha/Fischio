# fischio

*Il fischio finale* means the final whistle. That is when a match ends, and on fischio it is
when the money moves.

fischio is a decentralized prediction market on Solana for the World Cup. You can bet a
friend head to head, trade YES and NO shares against a pool, or work a real order book. When
the match ends, a signed proof of the score pays the winners on-chain. Five programs run the
whole thing, all deployed to devnet, all reachable straight from your wallet.

The programs do the work themselves. They match orders on-chain and settle on a cryptographic
proof of the real result. Anyone can trigger a payout, and anyone can crank a fill, so the
system keeps running even when every server we run is down.

## The five programs

| Program | Devnet address | What it does |
|---|---|---|
| wc-settle | `FVVSa2AcwxBdmtKxFHiZMmd2ceRWorh7ZDdppvPsPvxb` | Head-to-head escrow. Two people lock stakes on a match, and a proof of the final score pays the winner. |
| market | `AweLznQDPzt9UXKhon6X8iKgvrd5dX4Ru36ddnuRirKZ` | An AMM for YES/NO shares. Trade against a pool any time, even with nobody else online. |
| exchange | `7PtxtGEGwBsSNRcRDsP4pedkQkzpGLZNv92Ndc9WwgrE` | A price-time order book. Rest a limit order, cross the book, or both. |
| multi | `8zVnp7ivs5fSdmjYFHTLChrSzbKnDeKX6mj5nuP1CAgg` | Markets with more than two outcomes. One event, many outcomes, exactly one winner. |
| oracle | `HUXM89x5Uxex2XfTh58i2xXzroeULgtuq7w3tT7zzYpJ` | An optimistic oracle for questions sports data cannot answer. Propose a result, dispute it with a bond, or let the window close. |

Here is a real settlement you can check yourself: wager
`9KS3z6joNRFvLNF1rYck6C3U3xR2CZcNzHvTsCQSwKQq` (USA v Bosnia & Herzegovina, 2-0), settled by
`3wu6mTNQFkQogmJZGMqRaKwAvDAyRcKFk3BYFYXTePK3hWni2tNjV6Qp8hTAvGqATKvyMe1FWkniLAt4jcw7ppKf`.
Open the transaction and you can see the inner call into the oracle that verified the score
before any money moved.

## What you can trade

- **Match result (1X2)**: every match is a three-way market, Home, Draw, and Away, shown side
  by side. Each outcome opens at the live demargined line from TxLINE, not at 50/50, and a
  keeper holds the on-chain price on that line as the odds move. Buy any outcome and the price
  moves with your trade, and you can cash out any time.
- **Props**: total goals, total corners, and total yellow cards, each with an over/under line.
  Every prop reads a TxLINE stat key (goals 1/2, cards 3/4, corners 7/8) and settles on the
  same proof as the match winner. A corners bet resolves from a cryptographic proof in one
  transaction, with no human grader and no waiting period. Polymarket and Kalshi settle the
  same props by human review.
- **Order book**: post a limit order at your own price, or take an order that is already
  resting. Price and time decide who matches, and the rule runs inside the program.
- **Complete sets**: `split` turns one dollar of collateral into one YES share plus one NO
  share, and `merge` turns them back. This lets you mint a set and sell one side on the order
  book, which is how you provide two-sided liquidity by hand. A complete set is always worth
  exactly one dollar, so the vault always covers every share.
- **Multi-outcome events**: back one outcome out of many. A `convert` action turns a full set
  of NO positions into the complement's YES position and frees the rest of your collateral.

## Zero to trading in one click

A first-time visitor needs no extension and no SOL.

- **Instant wallet**: fischio generates an embedded wallet in the browser. It signs in to the
  backend with Sign-In With Solana, so a signature is the whole login and there is no password
  to steal. The design leaves a clean seam to swap in a managed wallet like Privy later.
- **Gasless trading**: a relayer pays the network fee. It signs only as the fee payer and has
  no authority over any account, and it will only pay for fischio instructions.
- **Sponsored onboarding**: a new wallet still needs rent for its own accounts. An onboarding
  sponsor pays that rent for the specific account-creation steps a user authorizes, and those
  accounts belong to the user. We proved the whole path on devnet: an unfunded generated
  wallet became a live trading account while its balance stayed at zero.

## Why finality is the hard part

Anyone can read a score. Knowing it is final is the hard part. A real proof of "1-0" pulled
in the 49th minute is dangerous to an escrow, because the match can still end 2-0. The usual
fixes, dispute windows and challenge bonds and trusted resolvers, all add back the trust that
an escrow is meant to remove.

fischio settles on data from TxLINE (TxODDS). TxLINE anchors match data to Solana with Merkle
roots every five minutes and hashes the live match phase into every provable leaf. One proof
carries both the score and the fact that the match is over. The program accepts a leaf only
from a terminal phase (full time, after extra time, after penalties). It rejects everything
else before the oracle call runs: a wrong fixture, a wrong stat, a mid-match total, a
mid-shootout leaf, a spliced event, the wrong roots account. A tampered value dies inside the
oracle's own Merkle check. Twenty adversarial tests attack the money path with real captured
proofs, and all twenty pass.

## No trusted operator

Every settlement path in every program is open to anyone. Whoever submits a valid proof
settles the wager or resolves the market, and earns a small tip for doing it. The exchange
goes further: matching pushes each fill credit into an on-chain queue, so one order can cross
any number of resting orders, and a permissionless crank pays the queue out later. We run a
keeper for convenience, and it holds no special power. If our keeper goes down, any wallet can
call the same instructions by hand. If nobody settles at all, wc-settle's refund path opens at
expiry and both sides get their stakes back. Correctness never depends on us staying online.

## An autonomous market maker

`bot/inplay-mm.mjs` reads the live TxLINE score, works out a fair probability that the home
side wins in 90 minutes plus extra time, and quotes two-sided prices on the order book. When a
goal lands or the clock ticks, the fair value moves and the bot re-quotes. It runs on the real
feed or on a simulated match for offline demos, and it logs every decision. Every quote it
makes is a public on-chain order.

## The live data layer

fischio runs an always-on ingestion service that holds TxLINE's odds and scores streams open
and polls its snapshots, so the platform stays live to within the feed's own refresh. It uses
every one of TxLINE's 18 endpoints for a real purpose, and exposes a status page at `/endpoints`
that reports the last call and result for all 18, so "we use all of TxLINE" is something you
can check rather than take on trust.

The odds-keeper reads the demargined 1X2 line for each match and trades the AMM back onto it
whenever the odds move, so the price you see is the live consensus and never a stale 50/50. It
is permissionless: it holds no special key, and every correction is a public on-chain trade.

The TxLINE endpoints fischio uses, all 18:

- **Live feeds**: fixtures snapshot and updates; odds snapshot, per-fixture and windowed odds
  updates, and the odds stream; scores snapshot, per-fixture and windowed scores updates, the
  scores stream, and historical scores.
- **Verification**: fixtures validation and batch validation, odds validation, and stat
  validation, the Merkle-proof primitive that settles every market.
- **Access**: guest sign-in, plus token activation and purchase quote, which unlock other
  leagues beyond the free World Cup tier.

## Run it

Front end (Vite and React, browse with no server):

    cd app && npm install && npm run dev

Settle any active wager yourself, which is the whole point of an open settle instruction:

    npm install
    node bot/settle-bot.mjs --wager <address> --rpc https://api.devnet.solana.com

Resolve a prediction market the same way, by proof, the moment its match ends:

    node bot/settle-market.mjs --market <address> --rpc https://api.devnet.solana.com

Run the in-play market maker:

    node bot/inplay-mm.mjs --fixture <id>    # live TxLINE feed
    node bot/inplay-mm.mjs --sim             # simulated match, offline

Keep every AMM price on the live line (with the ingestion service running):

    node bot/odds-keeper.mjs                 # trades the AMM back to the TxLINE line as odds move

The backend services (point them at your RPC with the `RPC` env var; see `.env.example`):

    node services/ingest/server.mjs    # TxLINE ingestion, all 18 endpoints, live, on :8795
    node services/api/server.mjs       # discovery, depth, settlements, trending, on :8790
    node services/indexer/server.mjs   # trade history and PnL, on :8792
    node services/relayer/server.mjs   # gasless fee-payer relay, on :8791
    node services/sponsor/server.mjs   # onboarding rent sponsor, on :8793
    node services/rewards/server.mjs   # maker liquidity-rewards scorer, on :8794
    node services/keeper/server.mjs    # crank that pays out queued exchange fills

Adversarial suites, one program at a time, against a local validator:

    scripts/start-test-validator.ps1      && node --test tests/adversarial.test.mjs
    scripts/start-market-validator.ps1    && node --test tests/market.test.mjs
    scripts/start-exchange-validator.ps1  && node --test tests/exchange.test.mjs
    scripts/start-multi-validator.ps1     && node --test tests/multi.test.mjs
    scripts/start-oracle-validator.ps1    && node --test tests/oracle.test.mjs

## Repository map

    programs/wc-settle/   escrow state machine, finality gates, oracle call
    programs/market/      the AMM for YES/NO shares, and every prop market type
    programs/exchange/    order book, price-time matching, async fill queue
    programs/multi/       multi-outcome markets, convert, single-winner resolve
    programs/oracle/      optimistic resolution: propose, dispute, arbitrate, claim
    services/ingest/      TxLINE ingestion: all 18 endpoints, live streams, /endpoints proof page
    services/api/         discovery, depth, settlements, trending, over REST and WebSocket
    services/indexer/     persisted trade history and per-market cost-basis PnL
    services/relayer/     gasless fee-payer relay
    services/sponsor/     onboarding rent sponsor for zero-SOL embedded wallets
    services/rewards/     scores resting maker liquidity by tightness and size
    services/keeper/      crank that pays out queued exchange fills
    bot/settle-bot.mjs    open wc-settle keeper, runs anywhere
    bot/inplay-mm.mjs     autonomous in-play market maker on the TxLINE feed
    bot/odds-keeper.mjs   keeps every AMM price on the live TxLINE 1X2 line
    bot/settle-market.mjs permissionless proof-settlement for the AMM markets, fires at full time
    bot/live-relay.mjs    read-only log tail and chain reads for the live UI
    app/                  markets, order book, portfolio, and settlement views
    deploy/               always-on supervisor and the Wispbyte deploy guide
    tests/                adversarial suites, one file per program
    SECURITY.md           the money invariant each program holds, and how to report a bug

The wc-settle settle transaction costs 204,162 compute units, about 15 percent of Solana's
limit, with proof verification and payout included.

## Status

Devnet beta. Every program is deployed and covered by an adversarial suite: 20 cases for
wc-settle, 7 for the AMM, 8 for the exchange, 4 for multi-outcome, and 6 for the oracle. All
pass. Stakes are devnet SOL and test tokens, and nothing is audited yet, so keep real money
out of it for now. fischio uses TxLINE by TxODDS for verified match data. TxLINE's credit
token is used only to authorize data access, and it never touches user funds.

Live now: three-way match-result markets that open at the demargined TxLINE line, a keeper that
holds each price on that line as the odds move, and the ingestion service using all 18 TxLINE
endpoints. Still open: a full visual pass on the app, an always-on deploy, and mainnet USDC
behind an audit. The settlement and matching engines do not change for any of it.

## Contributing and license

Read [CONTRIBUTING.md](CONTRIBUTING.md) for the dev setup and the house rules, and
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) before taking part. Copy [.env.example](.env.example)
for the configuration you need, and never commit a filled-in one.

fischio is released under the [Business Source License 1.1](LICENSE). The source is public,
and you may read it, self-host it, and contribute. You may not run it as a competing
commercial prediction market until the change date, when it converts to Apache 2.0.
