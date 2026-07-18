# Contributing to fischio

Thanks for wanting to help build fischio. This is a decentralized prediction market on
Solana, so most changes touch either an on-chain program (Rust/Anchor), the app (React), or
one of the off-chain services (Node). This guide gets you from a clone to a passing test.

## What you need

- Rust with the Solana platform tools (SBF toolchain), Anchor 0.31.1
- Agave / solana-test-validator on your PATH (the test scripts expect it)
- Node 20 or newer
- A funded devnet keypair at `local/devnet-wallet.json` for anything that touches devnet
- TxLINE access (free World Cup tier). The proof packages, score snapshots, daily-roots
  dumps, and the cloned oracle binary under `test-fixtures/` are licensed TxLINE Data, so
  they are not committed. Regenerate them locally under your own access with the `local/`
  fetch scripts before running the proof-settlement suites.

## Layout

- `programs/` five Anchor programs: `wc-settle`, `market`, `exchange`, `multi`, `oracle`
- `app/` the React front end (Vite)
- `services/` the off-chain layer: `ingest` (all 18 TxLINE endpoints), `api`, `indexer`, `relayer`, `sponsor`, `rewards`
- `bot/` the permissionless keepers and the agents: `inplay-mm` (market maker), `steam-agent`
  (sharp-movement detector), `backtest` (replays a match and scores the forecasts), `copy-agent`
  (follow a trader), `settle-bot` and `settle-market`, `prove-odds`
- `lib/` the shared logic the bots, services and CLI all read, so none of them can disagree about
  what the feed said: `txline` (feed client), `scores`, `markets`, `market-link` (feed market to
  on-chain market), `amm`, `scoring`, `guard` (durable spend caps and breakers), and the proof
  marshalling for stats, odds, fixtures and V3 multiproofs
- `cli/fischio.mjs` the command line tool
- `tests/` one adversarial suite per program, run against a local validator
- `test/` the suite that needs no validator, which is what CI runs
- `scripts/` local validator launchers, seeders, and one-off tools

## Build and test a program

Each program builds to SBF and runs its suite against a local validator that has the real
TxLINE oracle and roots cloned in where needed. Example for the exchange:

    cargo +solana build --release --target sbf-solana-solana -p fischio-exchange
    anchor idl build -p fischio_exchange -o target/idl/fischio_exchange.json
    scripts/start-exchange-validator.ps1        # in another terminal
    node --test tests/exchange.test.mjs

The other suites follow the same shape (`start-market-validator.ps1` and
`tests/market.test.mjs`, and so on). A change to a money path is not done until its suite is
green, and that includes the adversarial cases as well as the happy path.

## Run the app and services

    cd app && npm install && npm run dev          # front end on :5173
    node services/api/server.mjs                  # data layer on :8790

The app reads market and book lists from the API, so a client never needs an RPC that allows
`getProgramAccounts`. Point services at your own RPC with the `RPC` env var, and the app with
`VITE_RPC` in `app/.env.local`. See `.env.example`. A gitignored `.env` at the repo root is loaded
by `lib/env.mjs`, and anything already in the environment wins over it, so a shell export or a
deploy panel always overrides the file.

## Run the agents

Every agent takes `--shadow`, which logs each decision and sends nothing. Use it first.

    node bot/inplay-mm.mjs --fixture <id> --shadow     # quote both sides off the real line
    node bot/steam-agent.mjs                           # journal sharp line moves
    node bot/steam-agent.mjs --score                   # score that journal against proven results
    node bot/backtest.mjs --fixture <id>               # replay a match, score the forecasts
    node bot/copy-agent.mjs --leaderboard              # rank traders by realised profit

The two agents that commit money, the market maker and the copy agent, hold a daily ceiling and a
circuit breaker in `lib/guard.mjs` that persist to disk. That is deliberate: a limit kept only in
memory resets to zero on the restart that made it matter, so a crash loop would re-fund every
market on each boot. If you add an agent that spends, give it a guard.

The fastest test loop needs no validator and no chain:

    npm test            # the CI suite
    npm run test:amm    # the AMM property and fuzz suite on its own

## House rules

- Real data only. No mock markets, no placeholder scores, no lorem ipsum. Every number the UI
  shows should come from chain or from the TxLINE feed.
- Money code gets adversarial tests before it is trusted. Write a test that a naive version
  of the code would fail, so the suite proves the behavior and not just the happy case.
- Keep the invariant. Each program holds one clear money invariant (see `SECURITY.md`);
  a change that could break it needs a test that proves it does not.
- Plain language in copy, comments, and commits. Write for a bettor. Assume the reader does
  not know the protocol internals.
- Never commit a keypair, an API token, or a `.env` file. The `.gitignore` guards against the
  common cases; do not work around it.

## Pull requests

Keep a PR to one coherent change. Say what money path it touches and which suite proves it.
If it changes an on-chain program, note whether it needs a redeploy and an IDL rebuild. If it
adds a service or a flag, update `README.md` in the same PR so the docs never lag the code.

## Reporting a security issue

Do not open a public issue for a vulnerability. See `SECURITY.md` for how to disclose it
privately.
