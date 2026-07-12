# Contributing to fischio

Thanks for wanting to help build fischio. This is a decentralized prediction market on
Solana, so most changes touch either an on-chain program (Rust/Anchor), the app (React), or
one of the off-chain services (Node). This guide gets you from a clone to a passing test.

## What you need

- Rust with the Solana platform tools (SBF toolchain), Anchor 0.31.1
- Agave / solana-test-validator on your PATH (the test scripts expect it)
- Node 20 or newer
- A funded devnet keypair at `day1/devnet-wallet.json` for anything that touches devnet
- TxLINE access (free World Cup tier). The proof packages, score snapshots, daily-roots
  dumps, and the cloned oracle binary under `test-fixtures/` are licensed TxLINE Data, so
  they are not committed. Regenerate them locally under your own access with the `day1/`
  fetch scripts before running the proof-settlement suites.

## Layout

- `programs/` five Anchor programs: `wc-settle`, `market`, `exchange`, `multi`, `oracle`
- `app/` the React front end (Vite)
- `services/` the off-chain layer: `ingest` (all 18 TxLINE endpoints), `api`, `indexer`, `relayer`, `sponsor`, `rewards`
- `bot/` the permissionless keepers and the in-play market maker
- `tests/` one adversarial suite per program, run against a local validator
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
`VITE_RPC` in `app/.env.local`. See `.env.example`.

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
