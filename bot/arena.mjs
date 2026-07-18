#!/usr/bin/env node
// Agent versus agent: two strategies, one feed, opposite sides, settled on-chain.
//
// Named directly in the Trading Tools track. Two agents read the same TxLINE board, detect the same
// sharp moves, and take opposite sides of them. One follows the move, the other fades it. Neither
// can be right about the same signal, so over a tournament the better view shows up in realised
// profit rather than in a claim.
//
// WHY THE POSITIONS ARE REAL
//
// bot/steam-agent.mjs already journals signals and scores them later, which is honest but
// self-reported: the agent writes its own record. Here each decision becomes a buy in the market
// program, so the position is an on-chain account and the outcome comes from a Merkle proof of the
// real result. The scoreboard is then something anyone can recompute from the chain without
// trusting our journal, which is the whole difference between a claim and a result.
//
// The journal still exists, but only as an index: it stores the transaction signature of every
// trade so a reader can go and look. If the journal disagrees with the chain, the chain is right.
//
// SEPARATE ALLOCATIONS
//
// Each agent gets its own guard file and its own daily ceiling. Sharing one would let a strategy
// on a hot streak starve the other of capital, and a contest where one side cannot trade is not a
// contest. Both support --shadow, which runs the full decision loop and sends nothing.
//
//   node bot/arena.mjs --fixture 18257739 --shadow     decisions only, no transactions
//   node bot/arena.mjs --fixture 18257739              live, both agents trading
//   node bot/arena.mjs --scoreboard                    score every settled position from chain

import "../lib/env.mjs";
import { appendFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { txlineClient, parseMarkets } from "../lib/txline.mjs";
import { loadResultScore } from "../lib/scores.mjs";
import { settleabilityOf, termsOfFeedMarket, termsKey, normalizeTerms } from "../lib/market-link.mjs";
import { predicateHolds } from "../lib/settleable.mjs";
import { marketIdOf } from "../lib/market-id.mjs";
import { STRATEGIES, scorePositions } from "../lib/strategies.mjs";
import { createGuard } from "../lib/guard.mjs";
import { ageVerdict } from "../lib/staleness.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d; };
const SHADOW = process.argv.includes("--shadow");
const FIXTURE = Number(arg("fixture", 0));
const SIZE = Number(arg("size", 50));
const MOVE = Number(arg("move", 0.03));
const WINDOW_S = Number(arg("window", 300));
const INTERVAL = Number(arg("interval", 20000));
const DAILY_CAP = Number(arg("daily-cap", 2000));
const JOURNAL = arg("journal", join(root, "local", "arena-journal.jsonl"));

const U = 1_000_000;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const tx = txlineClient();

const connection = new Connection(process.env.RPC ?? "https://api.devnet.solana.com", "confirmed");
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(
  process.env.KEYPAIR_JSON ?? readFileSync(join(root, "local/devnet-wallet.json"), "utf8"))));
const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(payer), { commitment: "confirmed" });
const market = new anchor.Program(JSON.parse(readFileSync(join(root, "target/idl/fischio_market.json"), "utf8")), provider);
const PID = market.programId;
const seed = (s, m) => PublicKey.findProgramAddressSync([Buffer.from(s), m.toBuffer()], PID)[0];
const BN = anchor.BN;
const CU = anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });

// ---- scoreboard: recompute from chain, never from the agent's own claims ---------------------
if (process.argv.includes("--scoreboard")) {
  if (!existsSync(JOURNAL)) { console.log(`No trades yet at ${JOURNAL}.`); process.exit(0); }
  const rows = readFileSync(JOURNAL, "utf8").split("\n").filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

  // Group by fixture so each result is proven once rather than per trade.
  const fixtures = [...new Set(rows.map((r) => r.fixtureId))];
  const results = new Map();
  for (const id of fixtures) {
    const { score } = await loadResultScore(tx, id).catch(() => ({ score: null }));
    results.set(id, score?.final ? score : null);
  }

  console.log(`\nArena scoreboard, ${rows.length} trades across ${fixtures.length} fixture(s)\n`);
  for (const name of Object.keys(STRATEGIES)) {
    const mine = rows.filter((r) => r.agent === name);
    const settled = mine.map((r) => {
      const score = results.get(r.fixtureId);
      if (!score) return { ...r, won: undefined };
      // predicateHolds returns null when the score lacks the statistic this market settles on. A
      // missing number must stay unscored rather than being read as nil-nil.
      // The proposition is in the terms, so the result is applied to the terms rather than to a
      // label. YES wins when the predicate held on the final score.
      const won = predicateHolds(r.terms, score);
      if (won == null) return { ...r, won: undefined };
      return { ...r, won: r.side === "yes" ? won : !won };
    });
    const s = scorePositions(settled);
    const open = mine.length - s.n;
    console.log(`  ${name.padEnd(10)} trades ${String(mine.length).padStart(4)}  settled ${String(s.n).padStart(4)}  open ${String(open).padStart(4)}`);
    console.log(`  ${" ".repeat(10)} hit rate ${s.hitRate == null ? "n/a" : `${(s.hitRate * 100).toFixed(1)}%`}  realised ${s.realised.toFixed(2)}  max drawdown ${s.maxDrawdown.toFixed(2)}`);
  }
  console.log(`\nEvery trade above carries its transaction signature in ${JOURNAL}, so this can be recomputed from chain.`);
  process.exit(0);
}


if (!FIXTURE) { console.error("usage: node bot/arena.mjs --fixture <id> [--shadow]"); process.exit(1); }

// ---- setup ------------------------------------------------------------------------------------
const agents = Object.values(STRATEGIES).map((s) => ({
  strategy: s,
  guard: createGuard({
    path: join(root, "local", `arena-${s.name}-${FIXTURE}.json`),
    dailyCap: DAILY_CAP * U,
    maxFailures: 5,
  }),
  positions: new Map(), // termsKey -> shares, signed: positive YES, negative NO
}));

log(`arena on fixture ${FIXTURE} | ${SHADOW ? "SHADOW, nothing sent" : "LIVE, real positions"}`);
for (const a of agents) log(`  ${a.strategy.name}: ${a.strategy.description}`);
log(`signal: a move of ${(MOVE * 100).toFixed(1)} points inside ${WINDOW_S}s | size ${SIZE} shares | ceiling ${DAILY_CAP}/day each`);

mkdirSync(dirname(JOURNAL), { recursive: true });

// on-chain markets for this fixture, canonical only
const onChain = new Map();
for (const { publicKey, account } of await market.account.market.all()) {
  if (Number(account.terms.fixtureId) !== FIXTURE) continue;
  const terms = normalizeTerms(account.terms);
  const k = termsKey(terms);
  let derived = null;
  try { derived = marketIdOf(FIXTURE, terms); } catch { /* not settleable */ }
  if (derived == null || BigInt(account.marketId.toString()) !== derived) continue; // skip legacy
  onChain.set(k, { address: publicKey, terms });
}
log(`${onChain.size} canonical market(s) on this fixture`);

const history = new Map(); // termsKey -> [{ ts, prob }]

async function buy(agent, m, decision, onchain) {
  const collateral = Math.round(decision.size * (decision.side === "yes" ? m.prob : 1 - m.prob) * U);
  const allowed = agent.guard.canSpend(collateral);
  if (!allowed.ok) { log(`  ${agent.strategy.name} cannot trade: ${allowed.why}`); return null; }

  const yesMint = seed("yes", onchain.address), noMint = seed("no", onchain.address);
  const col = (await getOrCreateAssociatedTokenAccount(connection, payer, new PublicKey(JSON.parse(readFileSync(join(root, "local/devnet-usdc.json"), "utf8")).mint), payer.publicKey)).address;
  const yes = (await getOrCreateAssociatedTokenAccount(connection, payer, yesMint, payer.publicKey)).address;
  const no = (await getOrCreateAssociatedTokenAccount(connection, payer, noMint, payer.publicKey)).address;

  const sig = await market.methods.buy(new BN(collateral), decision.side === "yes" ? { yes: {} } : { no: {} }, new BN(0))
    .accountsPartial({
      trader: payer.publicKey, market: onchain.address, yesMint, noMint,
      vault: seed("vault", onchain.address), yesPool: seed("yes_pool", onchain.address), noPool: seed("no_pool", onchain.address),
      traderCollateral: col, traderYes: yes, traderNo: no, tokenProgram: TOKEN_PROGRAM_ID,
    }).preInstructions([CU]).rpc();

  agent.guard.recordSpend(collateral); // only after the transaction confirmed
  return { sig, collateral };
}

async function tick() {
  const rows = await tx.oddsSnapshot(FIXTURE).catch(() => null);
  const board = parseMarkets(rows ?? []);
  if (!board.length) { log("no odds this tick"); return; }

  const boardTs = board.map((m) => m.ts).filter(Boolean);
  const boardAge = boardTs.length ? Math.round((Date.now() - Math.max(...boardTs)) / 1000) : null;

  for (const m of board) {
    const s = settleabilityOf(m);
    if (!s.settleable) continue;
    for (const leg of s.legs) {
      const terms = termsOfFeedMarket(m, leg);
      const k = termsKey(terms);
      const onchain = onChain.get(k);
      if (!onchain) continue; // no market to trade against

      const idx = m.type === "1X2_PARTICIPANT_RESULT" ? ["home", "draw", "away"].indexOf(leg) : 0;
      const prob = m.outcomes[idx]?.prob;
      if (!(prob > 0.02 && prob < 0.98) || !m.ts) continue;

      // The same freshness rule the market maker uses. An agent taking a position on a line the
      // feed has abandoned is the same mistake as quoting one.
      const verdict = ageVerdict(Math.round((Date.now() - m.ts) / 1000), boardAge, false);
      if (!verdict.quote) continue;

      const h = history.get(k) ?? [];
      if (!h.length || h[h.length - 1].ts !== m.ts) h.push({ ts: m.ts, prob });
      history.set(k, h.slice(-200));

      for (const agent of agents) {
        const position = agent.positions.get(k) ?? 0;
        const d = agent.strategy.decide({ history: h, position, params: { minMove: MOVE, windowSeconds: WINDOW_S, size: SIZE }, now: Date.now() });
        if (d.action !== "buy") continue;

        const label = `${m.type.split("_")[0]} ${m.period}${m.line != null ? ` ${m.line}` : ""}${idx ? ` ${leg}` : ""}`;
        if (SHADOW) {
          log(`  [shadow] ${agent.strategy.name} ${d.side} ${d.size} on ${label}: ${d.reason} | proof ${m.messageId}`);
          agent.positions.set(k, position + (d.side === "yes" ? d.size : -d.size));
          continue;
        }
        try {
          const done = await buy(agent, { prob }, d, onchain);
          if (!done) continue;
          agent.positions.set(k, position + (d.side === "yes" ? d.size : -d.size));
          appendFileSync(JOURNAL, JSON.stringify({
            at: Date.now(), agent: agent.strategy.name, fixtureId: FIXTURE, termsKey: k, terms,
            market: onchain.address.toBase58(), side: d.side, size: d.size,
            entryPrice: d.side === "yes" ? prob : 1 - prob,
            reason: d.reason, signal: d.signal,
            // the two handles that make this trade checkable by someone else
            messageId: m.messageId, oddsTs: m.ts, signature: done.sig,
          }) + "\n");
          log(`  ${agent.strategy.name} ${d.side} ${d.size} on ${label}: ${d.reason} | tx ${done.sig.slice(0, 12)} | proof ${m.messageId}`);
          agent.guard.ok();
        } catch (e) {
          const tripped = agent.guard.fail(`${label}: ${String(e.message ?? e)}`);
          log(`  ${agent.strategy.name} failed on ${label}: ${String(e.message ?? e).slice(0, 120)}`);
          if (tripped) log(`  ${agent.strategy.name} breaker tripped: ${agent.guard.reason}`);
        }
      }
    }
  }
}

await tick();
setInterval(tick, INTERVAL);
