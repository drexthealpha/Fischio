# TxLINE Recon: verifiable-settlement track (deadline 2026-07-19)

Recon date: 2026-07-02. Sources: txline.txodds.com docs (fetched live, not JS-blocked).
Full doc index: https://txline-docs.txodds.com/llms.txt

## Networks

| | Mainnet | Devnet |
|---|---|---|
| Program ID (`txoracle` v1.5.2, Anchor) | `9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA` | `6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J` |
| TxL mint | `Zhw9TVKp68a1QrftncMSd6ELXKDtpVMNuMGr1jNwdeL` | `4Zao8ocPhmMgq7PdsYWyxvqySMGx7xb9cMftPMkEokRG` |
| USDT mint | `Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB` | `ELWTKspHKCnCfCiCiqYw1EDH77k8VCP74dK9qytG2Ujh` (has `request_devnet_faucet` ix) |
| API | `https://txline.txodds.com/api/` | `https://txline-dev.txodds.com/api/` |

IDL pages: /documentation/programs/mainnet and /documentation/programs/devnet
OpenAPI: https://txline.txodds.com/docs/docs.yaml

## validate_stat (REAL, in the published IDL)

```
validate_stat(
  ts: i64,
  fixture_summary: ScoresBatchSummary,   // { fixture_id: i64, update_stats: {update_count,min_ts,max_ts}, events_sub_tree_root: [u8;32] }
  fixture_proof: Vec<ProofNode>,         // ProofNode = { hash: [u8;32], is_right_sibling: bool }
  main_tree_proof: Vec<ProofNode>,
  predicate: TraderPredicate,            // { threshold: i32, comparison: GT|LT|EQ }
  stat_a: StatTerm,                      // { stat_to_prove: ScoreStat{key:u32,value:i32,period:i32}, event_stat_root:[u8;32], stat_proof: Vec<ProofNode> }
  stat_b: Option<StatTerm>,
  op: Option<BinaryExpression>           // Add | Subtract
) -> bool
Accounts: daily_scores_merkle_roots (read-only PDA, seed "daily_scores_roots" + epoch_day)
```

- Docs example calls it via Anchor `.view()` with ~1.4M CU budget. It's a normal instruction with return
  data; CPI-able in principle, but 1.4M CU budget is at the tx limit → **measure real CU cost on day 1**.
- Their oracle posts roots via `insert_scores_root` every 5 minutes into daily PDAs.
- Proof payload comes from `GET /api/scores/stat-validation?fixtureId=&seq=&statKeys=` →
  { ts, statToProve, eventStatRoot, summary, statProof, subTreeProof, mainTreeProof }.
- Relevant errors: 6003 InvalidSubTreeProof, 6004 InvalidMainTreeProof, 6005 TimeSlotMismatch,
  6007 RootNotAvailable, 6021 PredicateFailed.

## CRITICAL FINDING: their program already has escrow + settlement

txoracle includes: `create_trade` (2 signers lock stakes vs terms_hash), `settle_trade` (winner submits
Merkle proof, internal verification, payout), plus an intent/matching system (`create_intent`,
`execute_match`, `settle_matched_trade`), `claim_via_resolution`, `audit_trade_result`, refunds.
So the settlement primitive is not aspirational; it's live enough to have an IDL. But it also means a
bare escrow clone adds nothing; differentiation must come from product/UX/composition.

## Stat encoding (soccer)

stat_key = period_multiplier + base_key. Base: 1/2 goals P1/P2, 3/4 yellows, 5/6 reds, 7/8 corners
(odd = participant1). Multipliers: 0 = full match, 1000 = H1, 2000 = H2, 3000/4000 = ET, 5000 = pens.
Game phases 1–19 (5 = match ended). Example predicate "P1 wins": stat_a key1 minus stat_b key2 > 0
(Subtract + GreaterThan 0): exactly what validate_stat's two-stat mode supports.

## Data access (free for World Cup)

- Free service levels: 1 (60s delayed) and 12 (real-time) for World Cup 2026 + friendlies. No payment;
  still must run `subscribe()` on-chain (4-week min) then activate token.
- Auth: POST /auth/guest/start → JWT; POST /api/token/activate {txSig, walletSignature} → X-Api-Token.
- Feeds: GET /api/scores/snapshot/{fixtureId}?asOf=, /api/scores/updates/{epochDay}/{hour}/{interval},
  SSE /api/scores/stream?fixtureId=.
- npm deps used in docs: @coral-xyz/anchor, @solana/web3.js, @solana/spl-token, axios, tweetnacl.

## Day-1 verification checklist: DONE 2026-07-02

1. ✔ Guest auth + free-tier subscribe on devnet; World Cup fixtures flow on devnet API.
2. ✔ validate_stat simulated with a real proof → returned `true`.
3. ✔ CU measured: **151,931 two-stat / 144,504 single-stat** → CPI is viable.
4. ✔ On-chain IDL fetched (day1/txoracle-devnet-idl.json): deployed devnet program is v1.4.2
   (31 instructions; docs page shows 1.5.2/39; intent/matching ixs may be newer than deployment).

# DAY-1 RESULTS (measured on devnet, 2026-07-02, all real, no assumptions)

## Verdict: CPI into validate_stat. Direct Merkle reimplementation unnecessary.

| Measurement | Value |
|---|---|
| validate_stat CU, two-stat (goals A − goals B vs threshold) | **151,931** (151,781 program) |
| validate_stat CU, single-stat | 144,504 |
| Tampered stat value | rejected, `InvalidStatProof` (6023) after 76,976 CU |
| Honest proof, false predicate | returns `false` cleanly (no error), 144,506 CU |
| ix data size (real two-stat proof) | 584 bytes |
| full 1-signer tx | 827 / 1232 bytes → ~400 B headroom for escrow accounts |
| proof depths (live WC interval) | statProof=2, subTreeProof=7, mainTreeProof=1 |
| Return value | bool via Solana return data (`AQ==` = true); CPI caller reads via `get_return_data()` |

Budget for settle tx: ~152k (CPI) + escrow logic + token transfer ≈ **<250k CU of the 1.4M limit**.
The documented 1.4M budget is a ceiling, not the cost.

## validate_stat: exact call contract (verified against deployed program)

Program (devnet): `6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J`
Accounts: exactly one, `daily_scores_merkle_roots`, read-only, PDA:
```
seeds = [ b"daily_scores_roots", u16_le(epoch_day) ]      // epoch_day = floor(ts_ms / 86_400_000)
```
Args (borsh, in order):
```
ts: i64                     // MUST equal summary.updateStats.minTimestamp (ms). Anything else →
                            // TimestampMismatch 6010. The API's top-level `ts` field is NOT it.
fixture_summary: { fixture_id: i64, update_stats: { update_count: i32, min_timestamp: i64,
                   max_timestamp: i64 }, events_sub_tree_root: [u8;32] }
fixture_proof: Vec<{hash:[u8;32], is_right_sibling:bool}>   // = API `subTreeProof`
main_tree_proof: Vec<ProofNode>                             // = API `mainTreeProof`
predicate: { threshold: i32, comparison: GreaterThan|LessThan|EqualTo }
stat_a: { stat_to_prove: {key:u32, value:i32, period:i32}, event_stat_root:[u8;32],
          stat_proof: Vec<ProofNode> }
stat_b: Option<StatTerm>
op: Option<Add|Subtract>    // two-stat mode: evaluates (a op b) vs predicate
Returns bool via set_return_data. Predicate-false is a `false` RETURN, not an error.
```
Verification stages (from logs): account integrity → find root for 5-min interval → fixture-level
(summary ∈ daily root) → R2 → stat ∈ event tree → predicate. Failure modes seen live: 6010
TimestampMismatch, 6023 InvalidStatProof.

## API wire format (devnet, live World Cup data)

- `GET /api/scores/snapshot/{fixtureId}?asOf=<ms>` → array of Scores; fields incl. `Seq` (int),
  `Score`, `Stats`, `GameState`, `StatusId`, `Clock`. Latest `Seq` feeds stat-validation.
- `GET /api/scores/stat-validation?fixtureId=&seq=&statKey=1&statKey2=2` →
  `{ ts, statToProve{key,value,period}, statToProve2, eventStatRoot, summary{fixtureId,
  updateStats{updateCount,minTimestamp,maxTimestamp}, eventStatsSubTreeRoot}, statProof,
  statProof2, subTreeProof, mainTreeProof }`. **All 32-byte hashes arrive as raw JSON byte
  arrays** (not hex/base64). Proof nodes: `{hash:[...], isRightSibling:bool}`.
- statKey semantics in proofs: base key (1=P1 goals, 2=P2 goals) with `period` a separate field
  (0=FT, 2=H2-in-play observed live). The `period*1000+key` encoding is for trade terms.
- Live fixtures confirmed on devnet free tier (SL 1): 13 World Cup fixtures incl.
  Spain–Austria 18179551 (proof pulled live mid-match), Argentina–Cape Verde 18175918 (Jul 3),
  Brazil–Norway 18187298 (Jul 5), USA–Belgium 18193785 (Jul 7).

## Operational gotchas (cost us hours; don't rediscover)

1. `api.devnet.solana.com` serves an EXPIRED TLS cert (since 2025-12-23). Fails solana CLI, Node,
   PowerShell. Workaround: `NODE_TLS_REJECT_UNAUTHORIZED=0` for devnet probe scripts (throwaway
   wallet only). For the build: get a free Helius/QuickNode devnet key. TODO.
2. `subscribe` requires the user's TxL Token-2022 ATA to exist even for the free tier
   (AccountNotInitialized 3012 otherwise). Create idempotently first; keep the subscribe tx clean.
3. TxLINE activation backend is FLAKY: 500 "Could not issue custom API token" for ~40 min, then
   503/504 gateway outage, then recovered. Retry loop wins. Token: 30-day JWT + long-lived
   `txoracle_api_*`; cache both (day1/credentials.json, gitignored).
4. Devnet pricing matrix has exactly ONE row (SL 1, price 0, real-time sampling). SL 12 is
   mainnet-only despite the docs' "free tiers" framing.
5. Devnet oracle posts roots only for intervals with score updates (36/288 slots filled on match
   day) and lagged mainnet by ~45 min at one point. Mainnet posts every ~5 min during matches.
   Settlement demo must handle "root not yet posted" (RootNotAvailable 6007) with retry.
6. Deployed devnet program = 1.4.2, docs = 1.5.2. validate_stat/create_trade/settle_trade args
   match the docs IDL exactly (verified from chain); newer intent/matching ixs may differ, refetch
   IDL before relying on them.
7. Mainnet txoracle usage last ~14 h: exclusively oracle root inserts + a few subscribes. Nobody
   is using create_trade/settle_trade yet; the escrow/trade layer is deployed but unused.

# MATCH-ENDED FINALITY MECHANISM (verified on real finished devnet fixtures, 2026-07-02)

## The signal: ScoreStat.period IS the phase code, hashed into the Merkle leaf

Every provable stat leaf is {key, value, period} where `period` = the game-phase code of the
update the leaf belongs to. Verified from real proofs across a match lifecycle (USA–Bosnia
18172379, 1058 updates):

| seq | match state | proven leaf (key=1, P1 goals) |
|---|---|---|
| 5 | pre-match (NS) | period=1 value=0 |
| 16 | kickoff | period=2 value=0 |
| 446 | mid-H1 score update | **period=0** value=1 (running total!) |
| 1051 | seconds before FT | period=4 value=2 |
| 1054 | full-time transition | **period=5 value=2 (FINAL)** |
| 1057+ | post-match records | period=0 value=2 |

Cross-checks: England–Congo DR final = period=5, 2–1. Belgium–Senegal went to extra time:
terminal proof period=10, 3–2 (so "ended after ET" = 10). Phase codes match the soccer-feed
docs (1 NS, 2 H1, 3 HT, 4 H2, 5 F; ET/pens codes higher).

On-chain verification (devnet simulations):
- Genuine phase-5 final proof (goals A − goals B > 0): true, 179,188 CU.
- Mid-match proof relabeled period 0→5: REJECTED, InvalidStatProof 6023 → period cannot be
  forged; it is part of the hashed leaf.

## The trap: period=0 is "running total", NOT "full time"

Score-action records (StatusId undefined in the feed) produce period=0 leaves DURING the match:
seq 446 proves "1–0, period 0" from the 49th minute of a match that could have flipped. Any
settle logic that accepts period=0 as final is exploitable by early settlement on a temporary
lead. Post-match records also carry period=0, same encoding, indistinguishable by period alone.

## Settle rule (safe, single CPI)

validate_stat proves the leaves are genuine and evaluates the value predicate; it does NOT care
about period. Finality is enforced by OUR program checking the args before CPI:
```
require stat_a.stat_to_prove.period == stat_b.stat_to_prove.period
require period ∈ terminal allow-list {5, 10, 13}
require stat keys, fixture_id match wager terms
CPI validate_stat(...) → bool decides winner
```
One call proves outcome + finality together: the phase-5/10 leaf only exists in the Merkle tree
once the scout feed emits the terminal transition, and its `value` at that seq IS the final score.

RESOLVED 2026-07-04: penalties codes confirmed from real data (Netherlands–Morocco 18172280,
Jun 30, decided on penalties after 1–1): status walk `… 9 → 11@1376 → 12@1381 → 13@1425`, so
11 = awaiting shootout, 12 = shootout in progress, **13 = ended after penalties (terminal)**.
Terminal leaf at seq 1425: {key:1, value:1, period:13} / {key:2, value:1, period:13}; goals are
ET-inclusive, shootout goals EXCLUDED (pens keys 5001/5002 read 0 even at terminal). Mid-shootout
leaves carry period 12. Allow-list extended to {5, 10, 13}; adversarial suite covers pens-decided
settles (taker paid on the ET draw) and rejects period-12 proofs. 20/20 green.
EQ-draw-at-ET (pens pending) settles as "predicate false" side under GT terms; document per-market.
