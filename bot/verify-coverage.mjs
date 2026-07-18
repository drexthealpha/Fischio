// Does the board on chain match the board the feed publishes?
//
// This is the audit behind any coverage claim fischio makes. It reads the TxLINE catalogue for a
// fixture, works out which lines can settle trustlessly, and checks each one against what is
// actually on chain. It reports a gap rather than rounding it off, in either direction.
//
// WHAT THE CATEGORIES MEAN
//
//   live       a canonical market with liquidity. This is coverage.
//   unfunded   a canonical market with empty pools. Created but not tradeable, so NOT coverage.
//              Usually a run interrupted between create_market and add_liquidity.
//   duplicate  a second FUNDED pool on a proposition that already has one. A real problem:
//              liquidity splits, the two quote different prices, and nothing arbitrages them.
//   retired    a legacy pool that has been drained to zero. Harmless. The account stays because
//              the program has no close instruction, but it holds nothing and quotes nothing.
//   missing    a settleable line with no market at all.
//
// The distinction between duplicate and retired is the point. An earlier version of this counted
// every legacy account as a duplicate, which made a cleaned-up board look broken; the version
// before that keyed a Map by terms and collapsed rival pools into one row, which made a broken
// board look clean. Both are the same failure: a number that does not mean what it says.
//
//   node bot/verify-coverage.mjs --fixture 18257739
//
// Exits non-zero when coverage is incomplete, so it can gate a deploy.

import "../lib/env.mjs";
import { readFileSync } from "node:fs";
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { txlineClient, parseMarkets } from "../lib/txline.mjs";
import { onChainMarketsOf, settleabilityOf } from "../lib/settleable.mjs";
import { marketIdOf } from "../lib/market-id.mjs";
import { normalizeTerms, termsKey } from "../lib/market-link.mjs";

const argv = process.argv.slice(2);
const flag = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d; };
const FIXTURE = Number(flag("fixture", process.env.FIXTURE ?? 18257739));

const connection = new Connection(process.env.RPC ?? "https://api.devnet.solana.com", "confirmed");
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(
  process.env.KEYPAIR_JSON ?? readFileSync("local/devnet-wallet.json", "utf8"))));
const marketIdl = JSON.parse(readFileSync("target/idl/fischio_market.json", "utf8"));
const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(payer), { commitment: "confirmed" });
const market = new anchor.Program(marketIdl, provider);
const exchange = new anchor.Program(JSON.parse(readFileSync("target/idl/fischio_exchange.json", "utf8")), provider);

const U = 1_000_000;
const pool = async (addr, which, pid) => {
  try {
    const a = PublicKey.findProgramAddressSync([Buffer.from(which), addr.toBuffer()], pid)[0];
    return BigInt((await connection.getTokenAccountBalance(a)).value.amount);
  } catch { return 0n; }
};

const board = parseMarkets((await txlineClient().oddsSnapshot(FIXTURE)) ?? []);
if (!board.length) { console.log(`no odds on fixture ${FIXTURE}`); process.exit(1); }
const settleable = board.filter((m) => settleabilityOf(m).settleable);
const plan = onChainMarketsOf(board);

// every market account on this fixture, grouped by proposition so rivals are visible
const byTerms = new Map();
for (const { publicKey, account } of await market.account.market.all()) {
  if (Number(account.terms.fixtureId) !== FIXTURE) continue;
  const terms = normalizeTerms(account.terms);
  const k = termsKey(terms);
  if (!k) continue;
  let derived = null;
  try { derived = marketIdOf(FIXTURE, terms); } catch { /* unsettleable terms have no derived id */ }
  const canonical = derived != null && BigInt(account.marketId.toString()) === derived;
  const liq = (await pool(publicKey, "yes_pool", market.programId)) + (await pool(publicKey, "no_pool", market.programId));
  (byTerms.get(k) ?? byTerms.set(k, []).get(k)).push({ address: publicKey, canonical, liq, account });
}

// every order book, so coverage means tradeable rather than merely existing
const books = new Map();
for (const { publicKey, account } of await exchange.account.book.all()) {
  books.set(account.market.toBase58(), { address: publicKey });
}

console.log(`fixture ${FIXTURE}`);
console.log(`  feed lines ${board.length}, settleable ${settleable.length}, propositions on chain ${plan.length}\n`);

const tally = { live: 0, unfunded: 0, duplicate: 0, retired: 0, missing: 0, booked: 0 };
for (const p of plan) {
  const hits = (byTerms.get(p.termsKey) ?? []).sort((a, b) => Number(b.canonical) - Number(a.canonical));
  if (!hits.length) { console.log(`  MISSING   ${p.termsKey}`); tally.missing++; continue; }

  const funded = hits.filter((h) => h.liq > 0n);
  for (const h of hits) {
    const isRival = !h.canonical && h.liq > 0n && funded.length > 1;
    const kind = h.canonical
      ? (h.liq > 0n ? "live" : "unfunded")
      : (h.liq > 0n ? (isRival ? "duplicate" : "live") : "retired");
    tally[kind]++;
    if (kind === "retired") continue; // drained legacy accounts are noise, counted but not printed

    const book = books.get(h.address.toBase58());
    if (kind === "live" && book) tally.booked++;
    const y = await pool(h.address, "yes_pool", market.programId);
    const n = await pool(h.address, "no_pool", market.programId);
    const price = h.liq > 0n ? `${((Number(n) / Number(y + n)) * 100).toFixed(1)}%` : "  n/a";
    console.log(`  ${kind.toUpperCase().padEnd(9)} ${p.termsKey.padEnd(30)} ${h.address.toBase58().slice(0, 8)}  yes=${price}  liq=${String(Math.round(Number(h.liq) / 2 / U)).padStart(5)}  book=${book ? "yes" : "NO "}`);
  }
}

const extra = [...byTerms.keys()].filter((k) => !plan.some((p) => p.termsKey === k));
for (const k of extra) console.log(`  EXTRA     ${k} (on chain, prices no current feed line)`);

console.log(`\nCOVERAGE  ${tally.live} of ${plan.length} propositions live, ${tally.booked} with an order book`);
console.log(`GAPS      unfunded ${tally.unfunded}, duplicate ${tally.duplicate}, missing ${tally.missing}, extra ${extra.length}`);
console.log(`NOISE     retired ${tally.retired} drained legacy account(s), holding nothing`);

const clean = tally.live === plan.length && !tally.unfunded && !tally.duplicate && !tally.missing;
console.log(clean ? "\nEvery settleable line has exactly one funded market." : "\nCoverage is incomplete. The gaps above are named, not rounded off.");
process.exit(clean ? 0 : 1);
