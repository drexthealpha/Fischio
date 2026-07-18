# fischio API

fischio runs two HTTP services. You can read every price, book, and settlement, and check any
proof, without a wallet and without an account. Only signing in and upgrading the data feed need
credentials.

Everything returns JSON. Timestamps are milliseconds since the epoch. Addresses are base58 Solana
public keys. Prices are between 0 and 1, read as the probability of the yes outcome.

- **Market API** on port `8790`. The markets, books, settlements, and the sign-in flow. This is
  what the app reads.
- **Feed API** on port `8795`. The live TxLINE data and the proof endpoints. This is the
  ingestion service that keeps the last good line from the feed.

Override the ports with the `PORT` (market API) and `INGEST_PORT` (feed API) environment
variables. Examples below use the defaults and `127.0.0.1`.

---

## Market API, `http://127.0.0.1:8790`

### Read endpoints

No auth. Every read is served from a snapshot the service refreshes on a fixed interval, so a
response carries the `ts` it was taken at.

| Method | Path | Returns |
|---|---|---|
| GET | `/health` | `{ ok, rpc, cachedAt, programs: { amm, exchange, multi, settle } }` |
| GET | `/markets` | `{ markets: [...], ts }` every market across the AMM and multi-outcome programs |
| GET | `/markets/:address` | one market, or `404` |
| GET | `/markets/:address/prices` | `{ address, series: [{ ts, price }] }` the yes price over time |
| GET | `/books` | `{ books: [...], ts }` order-book summaries with best bid, best ask, and depth |
| GET | `/books/:address` | one book, or `404` |
| GET | `/settlements` | `{ settlements: [...], ts }` recent resolved markets with the winning side |
| GET | `/trending` | `{ trending: [...] }` markets ranked by recent price movement and depth |

### Traders

On the trade index (port `8792`). Every figure is computed from public on-chain transactions, so
you can recompute any of it yourself rather than trusting the ranking.

| Method | Path | Returns |
|---|---|---|
| GET | `/leaderboard` | `{ traders: [{ wallet, trades, volume, realizedPnl, closedPositions, winRate, marketsTraded, lastTradeAt }] }` |
| GET | `/history/:wallet` | every indexed trade for one wallet |
| GET | `/pnl/:wallet` | per-market cost basis and realised profit |

`?minTrades=N` filters out wallets with too little history to mean anything. Realised profit only:
an open position needs a live price to value, which would move the table for reasons the trader
had nothing to do with.

This is the data behind copy trading. It works here for the same reason it works elsewhere, that
trades are public, plus one thing that is usually missing: the result each trade settled against
carries a Merkle proof, so the record is verifiable end to end rather than asserted by the venue.

```
curl "http://127.0.0.1:8792/leaderboard?minTrades=3"
```

```
curl http://127.0.0.1:8790/markets
curl http://127.0.0.1:8790/markets/AweLznQDPzt9UXKhon6X8iKgvrd5dX4Ru36ddnuRirKZ/prices
```

### Real-time channel

Connect a WebSocket to `ws://127.0.0.1:8790/ws`. On connect you get the current snapshot, then a
new message every time the snapshot changes:

```json
{ "channel": "snapshot", "data": { "markets": [ ... ], "books": [ ... ], "ts": 1737100000000 } }
```

### Sign in with Solana

A wallet proves it owns an address by signing a nonce. Nothing custodial happens, and you can
read everything without this.

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/auth/nonce` | `{ pubkey }` | `{ nonce }` a message to sign |
| POST | `/auth/verify` | `{ pubkey, signature }` | `{ token, pubkey, expiresIn }` |
| GET | `/me` | header `Authorization: Bearer <token>` | `{ pubkey, signedIn }` or `401` |

`signature` is the detached signature of the nonce, base64 encoded. The token is a bearer token
for `/me` and any future protected route.

```
curl -X POST http://127.0.0.1:8790/auth/nonce -H 'content-type: application/json' \
  -d '{"pubkey":"<your-wallet>"}'
```

---

## Feed API, `http://127.0.0.1:8795`

The ingestion service. It streams and polls all eighteen TxLINE endpoints and holds the last good
value, so these routes answer even between feed updates. The free World Cup tier runs about 60
seconds behind live, and every response that carries a price also carries its age so you can judge
it.

### Live data

| Method | Path | Returns |
|---|---|---|
| GET | `/health` | `{ ok, tracked, fixtures, endpointsExercised, pollMs }` |
| GET | `/live` | the tracked fixtures with their latest implied 1X2 line |
| GET | `/live/:id` | one fixture's live state |
| GET | `/markets/:id` | `{ fixtureId, count, pricedAt, ageSeconds, serviceLevel, markets }` the whole board for a match. `?group=1` nests by type and period, `?type=` and `?period=` filter |
| GET | `/score/:id` | `{ home, away, statusId, final }` the live or final score |
| GET | `/movers` | markets whose price moved most recently |
| GET | `/goals` | a ticker of recent goals across tracked matches |
| GET | `/endpoints` | `{ ts, exercised, total, endpoints: [{ name, calls, ageSeconds, status, note }] }` the health of all 18 feed endpoints |

```
curl "http://127.0.0.1:8795/markets/18257739?group=1"
curl http://127.0.0.1:8795/endpoints
```

### Proofs

These return the Merkle package TxODDS published on Solana, the same one the CLI and the settle
bots submit on chain. Use them to check a price, a fixture, or a score yourself.

| Method | Path | Query | Returns |
|---|---|---|---|
| GET | `/verify/fixture/:id` | | the fixture-validation package |
| GET | `/verify/odds` | `messageId`, `ts` | `{ odds, summary, subTreeProof, mainTreeProof }` |
| GET | `/verify/stat` | `fixtureId`, `seq`, `statKey`, and optionally `statKey2` or `statKeys` | the stat-validation package |

```
curl "http://127.0.0.1:8795/verify/odds?messageId=<id>&ts=<ts>"
```

### Data-feed session

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/pricing` | query passthrough | a purchase quote for a higher service level |
| POST | `/activate` | the activation body | the activated token |

---

## From the terminal

Every read here is also a `fischio` command, so you can check the same data without writing any
HTTP. See [the CLI](cli/fischio.mjs): `fischio board <id>`, `fischio quote <id>`,
`fischio verify price <id>`, `fischio health`.

## Errors

A failed read returns a non-200 with `{ "error": "<reason>" }`. A missing market or book is a
`404`. A proof route that the feed cannot answer right now is a `502` with the reason. Auth
failures are `400` for a bad request and `401` for a bad or expired session.

## Multi-stat proofs (V3)

`validate_stat` carries a separate sibling path for every stat, so proving a whole prop board
costs one transaction per market. `validate_stat_v3` sends the shared hashes once and says where
each leaf sits, so the match result and every goals-derived prop on a fixture settle against a
single root check.

    fischio verify stats 18241006            # prove the goal stats in one transaction
    fischio verify stats 18241006 --stats 1,2,7,8   # add corners

Three details cost real time to find, so they are written down here:

- The timestamp is `summary.updateStats.minTimestamp` from the validation response, and it is used
  twice: to derive the epoch day for the roots account, and as `payload.ts`. They must be the same
  value or the program answers `TimestampMismatch`.
- V3 reads the same `daily_scores_roots` account as V1 and V2. There is no separate V3 account.
- The program field is `events_sub_tree_root`; the API calls the same value `eventStatsSubTreeRoot`.
  Naming the key after the API serialises it into the wrong field and the program reports
  `InvalidMainTreeProof`, which reads like a bad proof rather than a bad field name.

The compression is visible in the response: on a settled match the per-leaf `statProof` arrays come
back empty and a handful of `multiproof.hashes` cover every leaf.
