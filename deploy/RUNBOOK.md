# Runbook

How to run fischio unattended, how to tell when it is unhealthy, and what to do about each way it
fails. Written for whoever is on the box at three in the morning, which may not be the person who
wrote it.

## Start

```
node deploy/start-all.mjs
```

That runs the read-only set: ingest, api, indexer, relayer, sponsor, keeper, seed. None of them
commit collateral, so this is safe to leave running and safe to restart at any point.

Agents that spend money are opt-in and never start by default:

```
FISCHIO_SERVICES=ingest,api,indexer,maker FISCHIO_FIXTURE=18257739 node deploy/start-all.mjs
```

Booting a spending agent automatically on every container restart is how an unattended box drains a
wallet after a crash nobody noticed. Start them deliberately, once you have checked the balance and
the parameters.

## Environment

| Variable | What it does |
|---|---|
| `RPC` | Solana RPC. Helius devnet is verified to allow `getProgramAccounts`, which api and indexer need. Public devnet works and rate limits under load. |
| `INGEST` | Where agents read the live line. Defaults to the local ingest port. |
| `TXLINE_JWT`, `TXLINE_API_TOKEN` | Feed credentials. Alternatively place `local/credentials.json` on the box. |
| `KEYPAIR_JSON` | The trading wallet as JSON, if you would rather not upload a file. |
| `FISCHIO_SERVICES` | Comma separated subset. Omit for the read-only set. |
| `FISCHIO_FIXTURE` | Fixture id for agents that need one. |
| `HEALTH_PORT` | Health endpoint, default 8799. |

Secrets are never committed. `local/` and `test-fixtures/` are gitignored and stay that way.

## Is it healthy

```
curl localhost:8799/health
```

Returns **200** only when every service is up. Returns **503** when anything has given up or is
between restarts, so an uptime monitor pointed here fails on a degraded box rather than passing.

The response names each service, its uptime, its restart count, and its last exit. The `summary`
field is written to be read directly:

```
all 7 service(s) running
2 service(s) restarting: maker, arena
1 service(s) gave up and need attention: arena
```

Logs are one JSON object per line. To watch what the supervisor is deciding:

```
node deploy/start-all.mjs | grep -E '"event":"(gave_up|restarting|warning)"'
```

## Restart policy

In `lib/supervision.mjs`, tested in `test/supervision.test.mjs`.

- A crash restarts the service with a delay that doubles, capped at 30 seconds.
- A run of 60 seconds or more counts as the service having worked, and **resets the backoff**. An
  earlier version doubled forever, so a service that ran healthily for six hours and then died once
  came back carrying a delay earned by unrelated failures.
- Eight crashes in a row without ever reaching 60 seconds and the supervisor **gives up** on that
  service and reports it. Restarting forever on a five second cycle looks identical in the logs to a
  service that is fine.

A service that has given up will not come back on its own. That is deliberate. Fix the cause and
restart the supervisor.

## Failure modes

### The TxLINE feed stops

**Looks like:** ingest still running, `/endpoints` shows growing `ageSeconds`, the market maker logs
`the feed itself has gone quiet` and pulls its quotes.

**What happens automatically:** the maker stops quoting rather than resting orders on prices it
cannot vouch for. The streams reconnect on their own, resuming from the last event id so nothing in
the gap is lost.

**What to do:** nothing, unless it lasts. Check `curl localhost:8795/endpoints` to see which
endpoints are failing and what error they return.

### One line goes quiet but the feed is fine

**Looks like:** `the feed is live but has not repriced this line in 478 min, so quoting wider`.

**This is not a fault.** Peripheral lines sit for hours because nobody trades them. Measured on one
fixture: the freshest market was 6 minutes old while four markets were over 6 hours old. Those
markets are quoted at a wider spread rather than refused, because the price is still the price and
the extra width pays for the higher chance of being picked off.

### The RPC fails

**Looks like:** repeated `failed this tick` entries naming an RPC error, or services crash-looping
at boot.

**What happens automatically:** per-market failures are caught, counted through the guard, and the
breaker trips after five in a row rather than the agent retrying forever.

**What to do:** check the RPC is reachable and not rate limiting. Public devnet rate limits under
`getProgramAccounts` load, which is why Helius is the default.

### The wallet runs out

**Looks like:** the factory refuses to start with `not enough collateral. Fund the wallet or lower
--liquidity. Refusing to open a partial board silently.` Agents log `cannot trade: daily cap
reached`.

**What happens automatically:** nothing is half-opened. The factory checks the balance covers the
whole plan before sending anything.

**What to do:** fund the wallet, or lower `--liquidity`, or reduce the number of matches in
`bot/tournament.mjs`.

### A breaker trips

**Looks like:** `circuit breaker tripped: 5 consecutive failures, last: ...` and the agent stops
quoting.

**Deliberately manual to clear.** Something went wrong five times in a row and a person should look
at it before money moves again. The state is in `local/*-guard-*.json`. Delete the file or call
`reset()` once you know why it tripped.

### A restart lands mid-operation

**Looks like:** a market that exists with empty pools, or a book with no inventory.

**What happens automatically:** both are detected and resumed rather than skipped. The factory funds
a market it finds unfunded; the maker reads actual on-chain balances on resume instead of assuming a
deposit happened. Spend is only recorded against the daily cap after a transaction confirms, so a
crash between sending and confirming does not consume budget for money that never moved.

**What to do:** re-run the factory. It is idempotent and identifies markets by their terms, so it
cannot open a duplicate.

### Duplicate pools appear

**Looks like:** `bot/verify-coverage.mjs` reports `duplicate N`.

**What to do:** `node bot/retire-legacy-markets.mjs --fixture <id> --dry-run`, then without the flag.
It only touches markets whose stored id differs from the id derived from their own terms, so it
cannot drain a canonical pool.

## Stopping safely

Stop the supervisor and every child stops with it. Nothing is left half-done: resting orders stay on
the books and can be cancelled from the CLI or the app, and open positions settle from proofs
whether or not any fischio process is running. Settlement is permissionless, so anyone can trigger
it if we are offline.

To pull quotes without stopping the process, trip the breaker or set the daily cap to zero.

## Checking coverage

```
node bot/verify-coverage.mjs --fixture 18257739
```

Exits non-zero when coverage is incomplete, so it works as a deploy gate. It counts unfunded,
duplicate, missing and extra separately, and names each gap rather than rounding it off.
