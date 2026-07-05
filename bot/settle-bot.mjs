#!/usr/bin/env node
// wc-settle settlement bot: PERMISSIONLESS by construction.
//
// This bot holds no admin key, no oracle role, no allowlist entry. It is an
// arbitrary keypair whose only powers are (a) reading the public TxLINE feed and
// (b) submitting a settle transaction anyone else could submit first. If two bots
// race, the loser's tx fails with WagerNotActive and nothing is lost. The winner
// of the race earns the settler tip; that is the entire incentive model.
//
// Usage:
//   node bot/settle-bot.mjs --wager <pubkey> [--rpc <url>] [--keypair <path>] [--api <origin>]
// Devnet note: api.devnet.solana.com served an expired TLS cert 2026-07-02/03; rotated
// 2026-07-04 (verified). No TLS workarounds are needed anymore.

import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import {
  TXORACLE_ID, TERMINAL_PERIODS, summaryOf, statA, statB, epochDayOf, rootsPda, nodes,
} from "../lib/proof-marshal.mjs";

// config: CLI flag first, then env var (WAGER, RPC, KEYPAIR, API...), then default.
// Env support exists so the same file runs unchanged on a headless host (Wispbyte).
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  if (i > -1) return process.argv[i + 1];
  return process.env[name.toUpperCase().replaceAll("-", "_")] ?? dflt;
};
const WAGER = new PublicKey(arg("wager"));
const RPC = arg("rpc", "http://127.0.0.1:8899");
const KEYPAIR = arg("keypair", "day1/devnet-wallet.json");
const API = arg("api", "https://txline-dev.txodds.com");
const IDL_PATH = arg("idl", "target/idl/wc_settle.json");
const POLL_MS = 20_000;         // feed re-check while match is live
const ROOT_LAG_MS = 5 * 60_000; // devnet oracle posts roots lazily (~45 min worst observed)

// TxLINE credentials: env first (hosted keeper), day1/credentials.json fallback (local)
const fileCreds = (() => {
  try { return JSON.parse(readFileSync("day1/credentials.json", "utf8")); } catch { return {}; }
})();
const jwt = process.env.TXLINE_JWT ?? fileCreds.jwt;
const apiToken = process.env.TXLINE_API_TOKEN ?? fileCreds.apiToken;
if (!jwt || !apiToken) throw new Error("TxLINE credentials missing: set TXLINE_JWT and TXLINE_API_TOKEN or provide day1/credentials.json");
const headers = { Authorization: `Bearer ${jwt}`, "X-Api-Token": apiToken };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);
// exiting while an RPC keep-alive socket is mid-close trips a libuv assert on
// Windows (Node 24); a short drain avoids the crash-on-teardown
const exit = async (code) => { await sleep(500); process.exit(code); };

// keeper key: KEYPAIR_JSON env (secret as a JSON byte array, for hosts without file upload)
// or a keypair file path. Use a throwaway devnet key on third-party hosting, always.
const secret = process.env.KEYPAIR_JSON ?? readFileSync(KEYPAIR, "utf8");
const bot = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(secret)));
const connection = new Connection(RPC, "confirmed");
const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(bot), { commitment: "confirmed" });
const program = new anchor.Program(JSON.parse(readFileSync(IDL_PATH, "utf8")), provider);

// ---- 1. read the wager: everything needed to settle is public on-chain state ----
const wager = await program.account.wager.fetch(WAGER);
const fixtureId = wager.terms.fixtureId.toNumber();
const keyA = wager.terms.statAKey;
const keyB = wager.terms.statBKey; // null for single-stat markets
log(`bot ${bot.publicKey.toBase58()} (an ordinary keypair, no special authority)`);
log(`wager ${WAGER.toBase58()}: fixture ${fixtureId}, stats ${keyA}/${keyB ?? "-"}, state ${Object.keys(wager.state)[0]}`);
if (!("active" in wager.state)) {
  log("wager is not Active (already settled/refunded or not yet accepted); nothing to do");
  await exit(0);
}

// ---- 2. watch the feed until the match reaches a terminal phase (5=FT, 10=after ET, 13=after pens) ----
async function findTerminalSeq() {
  for (;;) {
    // historical returns the full record sequence once the match started >6h ago;
    // for fresher matches the same records come from the updates endpoint via snapshot
    for (const path of [`/api/scores/historical/${fixtureId}`, `/api/scores/snapshot/${fixtureId}?asOf=${Date.now()}`]) {
      const res = await fetch(`${API}${path}`, { headers }).catch(() => null);
      if (!res?.ok) continue;
      const body = await res.text();
      const records = body.trimStart().startsWith("[")
        ? JSON.parse(body)
        : body.split("\n").filter((l) => l.startsWith("data: {")).map((l) => JSON.parse(l.slice(6)));
      const terminal = records.find((r) => TERMINAL_PERIODS.includes(r.StatusId));
      if (terminal) return terminal.Seq;
      const last = records.at(-1);
      if (last) log(`match not over: seq=${last.Seq} status=${last.StatusId ?? "?"} clock=${last.Clock?.Seconds ?? "?"}s`);
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

// ---- 4. settle, permissionlessly. validate_stat costs ~179k CU via CPI -> 400k budget ----
for (;;) {
  try {
    const sig = await program.methods
      .settle(summaryOf(pkg), nodes(pkg.subTreeProof), nodes(pkg.mainTreeProof),
              statA(pkg), keyB != null ? statB(pkg) : null)
      .accountsPartial({
        settler: bot.publicKey,
        wager: WAGER,
        vault: PublicKey.findProgramAddressSync([Buffer.from("vault"), WAGER.toBuffer()], program.programId)[0],
        maker: wager.maker,
        taker: wager.taker,
        dailyScoresRoots: rootsPda(epochDayOf(pkg)),
        txoracleProgram: TXORACLE_ID,
        systemProgram: SystemProgram.programId,
      })
      .preInstructions([anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })])
      .rpc();
    log(`SETTLED: ${sig}`);
    log("funds released by Merkle proof alone: no human, no multisig, no oracle admin signed this");
    await exit(0);
  } catch (e) {
    const s = `${e}${e.logs ? e.logs.join("\n") : ""}`;
    if (s.includes("WagerNotActive")) {
      log("already settled; another bot beat us to it. That is the system working. Exiting.");
      await exit(0);
    }
    if (s.includes("RootNotAvailable") || s.includes("6007")) {
      log(`oracle root not posted yet for this interval (devnet lag); waiting ${ROOT_LAG_MS / 60000} min`);
      await sleep(ROOT_LAG_MS);
      continue;
    }
    throw e; // anything else is a real bug; fail loudly, never silently
  }
}
