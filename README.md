# fischio

*Il fischio finale* means the final whistle. That is when a match ends, and on fischio it is when the money moves.

**Live now**

| | |
|---|---|
| App | https://fischio-seven.vercel.app |
| API | http://78.154.103.18:14777 |

No wallet is needed to look. `/health` shows the feed, `/api/markets` returns every on-chain market with its price and reserves, and `/supervisor/health` returns 503 rather than 200 when a service is down.

Devnet, test tokens, nothing audited. Do not put real money in it.

## The problem

You bet that Spain v Argentina will have more than nine corners. The match ends with eleven.

Who decides you won?

On every prediction market you can use today, a person decides. Someone at the company reads the official match report, types the number in, and the market pays out. That is why a corners bet can sit unsettled for hours after the whistle, and why the rules tell you to open a dispute if you disagree with the number. The company is both the house and the referee.

Polymarket and Kalshi both settle sports props this way. It is not laziness. There has never been a way for a program to know the real corner count on its own.

fischio removes the person.

TxODDS, the company that supplies the match data, publishes a fingerprint of that data onto Solana every five minutes. A fingerprint is a short code computed from the data. Change one number anywhere in the data and the code comes out completely different, so the code is a promise about what the data said at that moment.

When the match ends, anyone can send one transaction that carries the corner count plus the maths showing it matches the published fingerprint. The program checks that maths itself and pays the winner. No employee is involved. There is no dispute window. It is one transaction, and it costs about a fifth of a cent in compute.

That is the whole idea. Everything else in this repo exists to make that one thing work.

## Why this is harder than it sounds

Anyone can read a score. Knowing that a score is **final** is the hard part.

Say a striker scores in the 49th minute. Right then, the data honestly says 1-0. A cheat could grab a completely genuine proof of "1-0", wait for nothing, and try to settle a bet with it. The match might still finish 2-0. The proof is real and the settlement is wrong.

Dispute windows and trusted resolvers fix this by adding back a human, which is the thing we are trying to delete.

TxLINE hashes the match phase into every provable record. So one proof carries both the score and the fact that the match is over. Our program only accepts a record from a terminal phase, meaning full time, after extra time, or after penalties. A genuine 49th-minute proof is worthless to an attacker because the program rejects it before it ever looks at the money.

We wrote 20 adversarial tests that attack this exact path with real captured proofs, including that 49th-minute case and a mid-shootout case. They all pass.

## Three things we can prove

**The match.** Before you stake anything, that this is a real fixture, with those two teams, in that competition, kicking off at that time. This one is easy to skip and it matters more than it looks. Proving a score is worth nothing if the match was invented. Anyone can list a game that was never scheduled, take your money, and then settle it from a genuine proof of a different game. Every hash checks out and you still lose. So the schedule gets proven too.

**The price.** Every market shows you odds. Where did those odds come from? Today you take the operator's word for it. TxLINE publishes a fingerprint of its odds as well, and the on-chain oracle exposes a `validate_odds` check against it. So fischio can prove the price you traded was the genuine line at that moment, and not a number we made up.

**The result.** Covered above. The score, the corner count, the cards, all settled from a proof.

## Check it yourself

Do not take our word for any of the three. Check them:

```
npx fischio verify fixture 18257739   # is that a real match?
npx fischio verify price 18257739     # is that the real price?
npx fischio verify result 18241006    # is that the real score?
npx fischio verify all 18257739       # all three
```

Each command sends a transaction to a program TxODDS deployed, which fischio does not own and cannot change. It folds the proof against the fingerprint TxODDS published before you asked, and prints the transaction so anyone can repeat it. If our servers lie, these fail. If our servers are switched off, these still work.

```
$ fischio verify result 18241006
England v Argentina  1-2  (full time)

Checking the claim "Argentina won" against the record TxODDS published on Solana.

  verified  Argentina won, 1-2
            https://explorer.solana.com/tx/4SjZ6L3g8CCH8sUJdxhJkUfpSqzx5Cj2wqabiM6tCqAfCZR1e3qNhXFY71vtLCSomAkQwhgocKKXGLiWe4U2tbcg?cluster=devnet
```

That transaction took the two goal totals, subtracted one from the other, and checked the answer against the fingerprint. No person graded that match, and we could not have changed the answer.

Every one of the 29 markets we quote on the final can be checked the same way, not only the headline one:

```
fischio verify price 18257739 --all
```

## See it settle

Here is a real settlement on devnet. Paraguay 0-1 France, fixture 18188721, settled by transaction
`4aUjDEjNj56dpduQwR7ctHk4r14E1axV7jxYctEbRYUHMQSrc4DaqQ7fLcHcisM7n37bKDDLK8FwbpakYrJizKxw`.

Open it and you can see the inner call into the TxODDS oracle that checked the score before any money moved. The wallet that submitted it has no special permission. It earned a small tip for doing the work.

The app goes further. On the Settlement page, click "verify this settlement in your browser" on any result. It pulls the proof out of the settlement transaction, hashes the score in your own browser using the crypto built into your machine, and shows it landing on the exact fingerprint TxODDS published. Then change a goal in the panel and watch the code stop matching. That is why a forged score cannot take the money.

## What you can trade

- **Match result.** Home, Draw, or Away, priced from the live demargined TxLINE line. Each outcome opens at the real line, never at a flat 50/50, and a keeper holds the on-chain price on that line as the odds move.
- **Props.** Total goals, total corners, total yellow cards, each with an over or under line. Every prop reads a TxLINE stat key and settles on the same proof as the match result. This is the sharpest thing here: a corners bet resolves from a proof in one transaction, with no human grader and no waiting.
- **Head to head.** Lock a stake against one other person on one match. The final whistle pays the winner.
- **Complete sets.** Turn one dollar into one Yes share plus one No share, and back again. A complete set is always worth exactly one dollar, so the vault always covers every share.

## Run it

The command line tool, which needs no wallet for anything that only reads:

    npm install

    fischio matches                    # what is on, and when
    fischio board 18257739             # every price we quote on a match
    fischio quote 18257739 --type totals --line 2.5 --side over --stake 50   # what a bet costs and pays
    fischio replay 18257739 --as-of 3h # the same board as it stood three hours ago
    fischio traders                    # who is profitable, computed from public trades
    fischio health                     # is the data feed answering

    fischio verify fixture 18257739    # is this a real match, with these teams and this kickoff
    fischio verify schedule            # is a whole hour of the schedule real, in one proof
    fischio verify price 18257739      # is this the price TxODDS published, or one we made up
    fischio verify result 18241006     # is this the score, once the match is over
    fischio verify all 18257739        # all three at once

`replay` is worth a moment. The feed lets you ask what the board looked like at any past instant, so you can see how the price moved into a goal rather than only where it landed. Add `--json` to any command to pipe it somewhere.

The same reads are an HTTP API if you would rather not use the terminal. Every market, book, settlement, and proof is a plain JSON route, with a WebSocket for live updates. See [API.md](API.md).

The agents, which run on the same data and take no instruction once started:

    node bot/inplay-mm.mjs --fixture 18257739 --shadow    # quote both sides off the real line
    node bot/steam-agent.mjs                              # flag sharp line moves, journal them
    node bot/steam-agent.mjs --score                      # score that journal against proven results
    node bot/backtest.mjs --fixture 18241006              # replay a match and score the forecasts
    node bot/copy-agent.mjs --leaderboard                 # who is profitable, from public trades
    node bot/copy-agent.mjs --leader <wallet> --allocation 500 --shadow

`--shadow` on any of them logs every decision and sends nothing, so you can watch what an agent
would do before it is allowed to do it. The market maker and the copy agent hold a durable spend
cap and a circuit breaker that survive a restart, because a limit kept only in memory resets to
zero on the reboot that made it matter.

Copy trading is worth a note. It works elsewhere because trades are public. What is usually
missing is the other half: a leader's wins were decided by a resolver you have to trust. Here the
trade is an on-chain transaction and the result it settled against carries a proof, so a track
record is arithmetic over public data rather than a claim this project makes about a trader.

The app:

    cd app && npm install && npm run dev

Settle any active wager yourself, which is the point of an open settle instruction:

    npm install
    node bot/settle-bot.mjs --wager <address> --rpc https://api.devnet.solana.com

Resolve a prediction market the same way, the moment its match ends:

    node bot/settle-market.mjs --market <address> --rpc https://api.devnet.solana.com

Run the in-play market maker on a real fixture. It takes its fair value from the demargined TxLINE line, quotes both sides on the order book, and re-quotes when the line moves:

    node bot/inplay-mm.mjs --fixture <id>

Hold every pool price on the live line:

    node bot/odds-keeper.mjs

The backend services, or all of them at once with the supervisor:

    node deploy/start-all.mjs          # ingest, api, keeper, seed, relayer, sponsor, indexer
    node services/ingest/server.mjs    # TxLINE ingestion on :8795

Adversarial suites, one program at a time, against a local validator:

    scripts/start-test-validator.ps1      && node --test tests/adversarial.test.mjs
    scripts/start-market-validator.ps1    && node --test tests/market.test.mjs
    scripts/start-exchange-validator.ps1  && node --test tests/exchange.test.mjs
    scripts/start-multi-validator.ps1     && node --test tests/multi.test.mjs
    scripts/start-oracle-validator.ps1    && node --test tests/oracle.test.mjs

## Getting in with no wallet

A first-time visitor needs no browser extension and no SOL.

Click "Start instantly" and fischio makes a wallet inside your browser. That wallet is your account, so there is no email, no password, and no signup form. A relayer pays the network fee, and a sponsor pays the small rent a new account needs on Solana. We proved the whole path on devnet: an unfunded wallet became a live trading account while its balance stayed at zero.

The relayer can only pay fees. It has no authority over any account and it refuses to sign anything that is not a fischio instruction.

## How it works

Five programs, all deployed to devnet, all reachable straight from a wallet.

| Program | Devnet address | What it does |
|---|---|---|
| wc-settle | `FVVSa2AcwxBdmtKxFHiZMmd2ceRWorh7ZDdppvPsPvxb` | Head to head escrow. Two people lock stakes, a proof of the final score pays the winner. |
| market | `AweLznQDPzt9UXKhon6X8iKgvrd5dX4Ru36ddnuRirKZ` | The pool you trade against. Buy an outcome any time, even with nobody else online. |
| exchange | `7PtxtGEGwBsSNRcRDsP4pedkQkzpGLZNv92Ndc9WwgrE` | A price-time order book, matched on-chain. |
| multi | `8zVnp7ivs5fSdmjYFHTLChrSzbKnDeKX6mj5nuP1CAgg` | Events with more than two outcomes. Exactly one winner. |
| oracle | `HUXM89x5Uxex2XfTh58i2xXzroeULgtuq7w3tT7zzYpJ` | A fallback for questions the match data cannot answer. Propose a result, dispute it with a bond. |

Nobody has an admin key. Every authority is a program address that signs for its own vault, so no human can move user funds in any program. `SECURITY.md` states the one money invariant each program holds and how it is enforced.

Settlement is open to anyone in every program. Whoever submits a valid proof settles the market and earns a small tip. We run a keeper because it is convenient, and it holds no special power. If every server we run goes down, any wallet can call the same instructions by hand, and if nobody settles at all, the refund path opens at expiry and both sides get their stakes back.

## The data underneath

fischio reads TxLINE, the TxODDS feed. An always-on service holds the odds and scores streams open, polls the snapshots, and serves the app.

We use all 18 TxLINE endpoints, and each one has a job:

- **Live feeds.** Fixtures snapshot and updates. Odds snapshot, per-fixture and windowed odds updates, and the odds stream. Scores snapshot, per-fixture and windowed scores updates, the scores stream, and historical scores.
- **Verification.** Fixtures validation and batch validation, odds validation, and stat validation. Stat validation is the one that settles every market.
- **Access.** Guest sign-in, token activation, and the purchase quote for service levels above the free World Cup tier.

You do not have to take that on trust. The ingestion service exposes `/endpoints`, which reports the last call and result for all 18.

Getting a reliable list of finished matches and their scores is the part that quietly breaks most projects, because the live stream and snapshot go quiet once a match is over. The final record moves to the historical endpoint. So fischio reads a result from the live feed while a match is on, and from historical once it has ended, which is also how anyone can verify a settled game hours or days later.

TxLINE's access flow runs on Solana, which is what the hackathon means by signing up through Solana. You submit an on-chain subscribe transaction, activate it, and use the API token it returns. Requests then carry two headers, and expired tokens fail quietly with a 401, so our client caches tokens and re-mints them automatically.

## Honest limitations

We would rather you read this than find it out yourself.

- **Nothing here is audited, and it runs on devnet with test tokens.** Do not put real money in it.
- **The free World Cup tier is delayed by about 60 seconds** (service level 1). Real time needs service level 12. Where the app says a price is live, it is as live as the feed allows, and the app shows the real age of the data so you can judge it.
- **Score corrections after full time are not handled.** If a goal is disallowed on review after the whistle, fischio has already settled and cannot re-settle. Doing this properly needs a challenge window keyed to a timestamp that only ever moves forward, and that depends on TxODDS confirming those semantics.
- **The order book is bounded** at 64 orders a side. Fills settle through a queue that anyone can crank, so one order can cross any number of makers, but a production version would raise these bounds and shard the book.
- **The optimistic oracle still has one arbiter** deciding disputes. It is immutable and every proposer carries an on-chain accuracy record, and the eventual replacement is a bonded token vote.
- **Fiat on and off ramps need a licensed partner.** That is an integration, and there is no program to write for it.
- **Player markets are not listed, and this one is not a matter of time.** The record that goes into the fingerprint holds three numbers, a stat key, a value and a period, and a player id is not one of them. So a player market could only ever settle on our say-so, which is the exact thing this product exists to remove. There is a second reason on top of that one: on the free World Cup tier the per-event player fields are not populated anyway. We checked a full finished match and none of its 964 score records carried a scorer or card id. The team lineups do come through, with names, shirt numbers and positions, so a lineup view is real, but "who scored" as provable data is not there. We would rather list fewer markets than list one we have to be trusted on.
- **Quarter lines carry no fair price.** On an Asian handicap ending in .25 or .75 your stake splits across two lines, and TxODDS publishes no single demargined percentage for them. Around a third of the board is quarter lines. We show the odds and say the fair price is unpublished rather than inventing one.
- **Nine of the 29 lines on a fixture get a pool, and they become 11 markets.** A market here is binary, so a line qualifies only if it has a genuinely two-way outcome: the three result legs, and the half lines on totals and handicaps, for both the full match and the first half. A three-way result is one row on the feed and three separate markets on chain, which is where 9 becomes 11. Handicap -0.5 is the same proposition as the home leg, so it collapses into it rather than opening a second pool for one bet. A whole-goal line like over 2.0 refunds on exactly two goals and a yes or no market cannot hand a stake back, and a quarter line splits the stake across two outcomes. Both stay on the board as reference prices with the reason attached. `lib/settleable.mjs` is the single place that decides, and `bot/verify-coverage.mjs` reconciles settleable count against market count against book count and names any gap rather than rounding it off.
- **The settlement works for any sport, but we can only show it on football.** The proof checks a stat key, a value and a period, and that is the same shape whether the number is goals, points or touchdowns, so the programs would settle a basketball or an NFL market with no new code. We cannot demonstrate that here, because the free tier only carries the World Cup and a few friendlies. We would rather say this plainly than seed a market on data we cannot pull.
- **Batched settlement works, and it took a correction from TxODDS to get there.** An earlier version of this file said the deployed oracle exposed no instruction for the multi-stat package. That was wrong. `validate_stat_v3` is on the same devnet program as V1 and V2, sharing the same `daily_scores_roots` account, and it is landed and verified: two leaves, no per-leaf proofs, four shared hashes, settled in two transactions. The detail that makes it work is that both the epoch day and `payload.ts` have to come from `summary.updateStats.minTimestamp` rather than from the response's own `ts`. Proving the schedule batches too: `fischio verify schedule` checks every fixture in an hour in one proof.

## Contributing and license

Read [CONTRIBUTING.md](CONTRIBUTING.md) for the dev setup and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) before taking part. Copy [.env.example](.env.example) for configuration, and never commit a filled-in one.

fischio is released under the [Business Source License 1.1](LICENSE). The source is public. You may read it, self-host it, and contribute. You may not run it as a competing commercial prediction market until the change date, when it converts to Apache 2.0.
