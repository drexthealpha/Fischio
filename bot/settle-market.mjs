#!/usr/bin/env node
// AMM market settlement bot: PERMISSIONLESS, the same trustless engine as the wager settle-bot
// but for the prediction markets. It reads a market's terms, watches the TxLINE feed until the
// match reaches a terminal phase, pulls the Merkle proof, and calls the market program's resolve
// instruction, which CPIs into TxLINE validate_stat. No admin, no oracle role: whoever submits a
// valid proof resolves the market, and holders then redeem winning shares for one dollar each.
//
//   node bot/settle-market.mjs --market <pubkey> [--rpc <url>] [--keypair <path>] [--api <origin>]
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import {
  TXORACLE_ID, TERMINAL_PERIODS, summaryOf, statA, statB, epochDayOf, rootsPda, nodes,
} from "../lib/proof-marshal.mjs";
import { fullTimeRow, latest, statusNow } from "../lib/scores.mjs";

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  if (i > -1) return process.argv[i + 1];
  return process.env[name.toUpperCase().replaceAll("-", "_")] ?? dflt;
};
const MARKET = new PublicKey(arg("market"));
const RPC = arg("rpc", "http://127.0.0.1:8899");
const KEYPAIR = arg("keypair", "local/devnet-wallet.json");
const API = arg("api", "https://txline-dev.txodds.com");
const IDL_PATH = arg("idl", "target/idl/fischio_market.json");
const POLL_MS = 20_000;
const ROOT_LAG_MS = 5 * 60_000; // devnet oracle posts roots lazily

const fileCreds = (() => { try { return JSON.parse(readFileSync("local/credentials.json", "utf8")); } catch { return {}; } })();
const jwt = process.env.TXLINE_JWT ?? fileCreds.jwt;
const apiToken = process.env.TXLINE_API_TOKEN ?? fileCreds.apiToken;
if (!jwt || !apiToken) throw new Error("TxLINE credentials missing: set TXLINE_JWT and TXLINE_API_TOKEN or provide local/credentials.json");
const headers = { Authorization: `Bearer ${jwt}`, "X-Api-Token": apiToken };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);
const exit = async (code) => { await sleep(500); process.exit(code); };

const secret = process.env.KEYPAIR_JSON ?? readFileSync(KEYPAIR, "utf8");
const bot = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(secret)));
const connection = new Connection(RPC, "confirmed");
const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(bot), { commitment: "confirmed" });
const program = new anchor.Program(JSON.parse(readFileSync(IDL_PATH, "utf8")), provider);

// ---- 1. read the market: its terms say which fixture and stats decide the outcome ----
const market = await program.account.market.fetch(MARKET);
const fixtureId = market.terms.fixtureId.toNumber();
const keyA = market.terms.statAKey;
const keyB = market.terms.statBKey; // null for single-stat markets
log(`resolver ${bot.publicKey.toBase58()} (an ordinary keypair, no special authority)`);
log(`market ${MARKET.toBase58()}: fixture ${fixtureId}, stats ${keyA}/${keyB ?? "-"}, state ${Object.keys(market.state)[0]}`);
if (!("trading" in market.state)) { log("market is not Trading (already resolved/voided); nothing to do"); await exit(0); }

// ---- 2. watch the feed until the match reaches a terminal phase (5=FT, 10=after ET, 13=after pens) ----
async function findTerminalSeq() {
  for (;;) {
    for (const path of [`/api/scores/historical/${fixtureId}`, `/api/scores/snapshot/${fixtureId}?asOf=${Date.now()}`]) {
      const res = await fetch(`${API}${path}`, { headers }).catch(() => null);
      if (!res?.ok) continue;
      const body = await res.text();
      const records = body.trimStart().startsWith("[")
        ? JSON.parse(body)
        : body.split("\n").filter((l) => l.startsWith("data: {")).map((l) => JSON.parse(l.slice(6)));
      // Full time, specifically, and read through lib/scores.mjs so this bot cannot disagree
      // with the rest of the product about when a match ended.
      //
      // This used to be records.find(r => TERMINAL_PERIODS.includes(r.StatusId)), which had two
      // ways of being wrong. Array order is not sequence order, so it returned an arbitrary row
      // among the terminal ones. And a knockout that goes to extra time reaches two terminal
      // statuses, full time and after-extra-time, carrying different scores. This market settles
      // on the ninety-minute score, so picking the later one pays out the wrong side. The World
      // Cup final can go to extra time, so that is not a hypothetical.
      const terminal = fullTimeRow(records);
      if (terminal) return terminal.Seq;
      const last = latest(records);
      if (last) log(`match not over: seq=${last.Seq} status=${statusNow(records) ?? "?"}`);
    }
    await sleep(POLL_MS);
  }
}
const terminalSeq = await findTerminalSeq();
log(`full-time detected at seq ${terminalSeq}; fetching Merkle proof`);

// ---- 3. pull the proof; the terminal leaf only exists at/near the FT transition seq ----
async function fetchTerminalProof() {
  for (let attempt = 0; ; attempt++) {
    for (const seq of [terminalSeq, terminalSeq + 1, terminalSeq + 2]) {
      const qs = `fixtureId=${fixtureId}&seq=${seq}&statKey=${keyA}` + (keyB != null ? `&statKey2=${keyB}` : "");
      const res = await fetch(`${API}/api/scores/stat-validation?${qs}`, { headers }).catch(() => null);
      if (!res?.ok) continue;
      const pkg = await res.json();
      if (TERMINAL_PERIODS.includes(pkg.statToProve?.period)) return pkg;
      log(`seq ${seq}: proof period=${pkg.statToProve?.period} not terminal, trying next`);
    }
    log(`proof not ready (attempt ${attempt + 1}); retrying in ${POLL_MS / 1000}s`);
    await sleep(POLL_MS);
  }
}
const pkg = await fetchTerminalProof();
log(`proof in hand: ${JSON.stringify(pkg.statToProve)} vs ${JSON.stringify(pkg.statToProve2 ?? null)}`);

// ---- 4. resolve, permissionlessly. validate_stat costs ~180k CU via CPI -> 400k budget ----
for (;;) {
  try {
    const sig = await program.methods
      .resolve(summaryOf(pkg), nodes(pkg.subTreeProof), nodes(pkg.mainTreeProof),
               statA(pkg), keyB != null ? statB(pkg) : null)
      .accountsPartial({
        resolver: bot.publicKey,
        market: MARKET,
        dailyScoresRoots: rootsPda(epochDayOf(pkg)),
        txoracleProgram: TXORACLE_ID,
      })
      .preInstructions([anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })])
      .rpc();
    log(`RESOLVED: ${sig}`);
    log("market outcome fixed by Merkle proof alone: no human, no oracle admin signed this. Winners can redeem now.");
    await exit(0);
  } catch (e) {
    const s = `${e}${e.logs ? e.logs.join("\n") : ""}`;
    if (s.includes("AlreadyResolved")) { log("already resolved; another resolver beat us to it. That is the system working. Exiting."); await exit(0); }
    if (s.includes("RootNotAvailable") || s.includes("WrongDailyRootsAccount") || s.includes("6007")) {
      log(`oracle root not posted yet for this interval (devnet lag); waiting ${ROOT_LAG_MS / 60000} min`);
      await sleep(ROOT_LAG_MS);
      continue;
    }
    throw e; // anything else is a real bug; fail loudly
  }
}
