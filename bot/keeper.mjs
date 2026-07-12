#!/usr/bin/env node
// fischio keeper: the always-on settlement service.
//
// It watches EVERY wager on the program, not one. On each scan it reads all active
// wagers from chain, groups them by fixture, and for any fixture that has reached a
// terminal phase it pulls the proof and settles each wager on that fixture. It never
// exits. A user creates a wager through the app and does nothing else; this settles it
// when the match ends.
//
// It holds no special authority. Anyone can run a copy. Settling pays the runner a
// tip from the pot that exceeds the transaction fee, so the keeper is self-sustaining.
//
// Config via env (no CLI needed): RPC, KEYPAIR_JSON (or KEYPAIR path), TXLINE_JWT,
// TXLINE_API_TOKEN, optional API and IDL_PATH. No WAGER: it watches all of them.

import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import {
  TXORACLE_ID, TERMINAL_PERIODS, summaryOf, statA, statB, epochDayOf, rootsPda, nodes,
} from "../lib/proof-marshal.mjs";

const env = (name, dflt) => process.env[name] ?? dflt;
const RPC = env("RPC", "https://api.devnet.solana.com");
const API = env("API", "https://txline-dev.txodds.com");
const IDL_PATH = env("IDL_PATH", "target/idl/wc_settle.json");
const SCAN_MS = Number(env("SCAN_MS", "60000")); // full sweep interval

const fileCreds = (() => {
  try { return JSON.parse(readFileSync("day1/credentials.json", "utf8")); } catch { return {}; }
})();
const jwt = env("TXLINE_JWT", fileCreds.jwt);
const apiToken = env("TXLINE_API_TOKEN", fileCreds.apiToken);
if (!jwt || !apiToken) throw new Error("set TXLINE_JWT and TXLINE_API_TOKEN (or provide day1/credentials.json)");
const headers = { Authorization: `Bearer ${jwt}`, "X-Api-Token": apiToken };

const secret = env("KEYPAIR_JSON") ?? readFileSync(env("KEYPAIR", "keeper/keeper-key.json"), "utf8");
const keeper = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(secret)));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);

const connection = new Connection(RPC, "confirmed");
const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(keeper), { commitment: "confirmed" });
const program = new anchor.Program(JSON.parse(readFileSync(IDL_PATH, "utf8")), provider);

// One non-blocking check: has this fixture reached a terminal phase? Returns the
// terminal seq or null. Unlike the single-shot bot, it never waits; a fixture that
// is not over yet is simply retried on the next sweep.
async function terminalSeqFor(fixtureId) {
  for (const path of [`/api/scores/historical/${fixtureId}`, `/api/scores/snapshot/${fixtureId}?asOf=${Date.now()}`]) {
    const res = await fetch(`${API}${path}`, { headers }).catch(() => null);
    if (!res?.ok) continue;
    const body = await res.text();
    const records = body.trimStart().startsWith("[")
      ? JSON.parse(body)
      : body.split("\n").filter((l) => l.startsWith("data: {")).map((l) => JSON.parse(l.slice(6)));
    const terminal = records.find((r) => TERMINAL_PERIODS.includes(r.StatusId));
    if (terminal) return terminal.Seq;
  }
  return null;
}

// The terminal proof leaf lives at or just after the FT-transition seq.
async function proofFor(fixtureId, seq, keyA, keyB) {
  for (const s of [seq, seq + 1, seq + 2]) {
    const qs = `fixtureId=${fixtureId}&seq=${s}&statKey=${keyA}` + (keyB != null ? `&statKey2=${keyB}` : "");
    const res = await fetch(`${API}/api/scores/stat-validation?${qs}`, { headers }).catch(() => null);
    if (!res?.ok) continue;
    const pkg = await res.json();
    if (TERMINAL_PERIODS.includes(pkg.statToProve?.period)) return pkg;
  }
  return null;
}

async function settleOne(pubkey, wager, pkg) {
  const keyB = wager.terms.statBKey;
  const [vault] = PublicKey.findProgramAddressSync([Buffer.from("vault"), pubkey.toBuffer()], program.programId);
  const sig = await program.methods
    .settle(summaryOf(pkg), nodes(pkg.subTreeProof), nodes(pkg.mainTreeProof),
            statA(pkg), keyB != null ? statB(pkg) : null)
    .accountsPartial({
      settler: keeper.publicKey,
      wager: pubkey,
      vault,
      maker: wager.maker,
      taker: wager.taker,
      dailyScoresRoots: rootsPda(epochDayOf(pkg)),
      txoracleProgram: TXORACLE_ID,
      systemProgram: SystemProgram.programId,
    })
    .preInstructions([anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })])
    .rpc();
  return sig;
}

async function sweep() {
  const all = await program.account.wager.all();
  const active = all.filter(({ account }) => "active" in account.state);
  if (active.length === 0) { log("no active wagers"); return; }

  // group by fixture so each fixture's feed is checked once per sweep
  const byFixture = new Map();
  for (const w of active) {
    const fid = w.account.terms.fixtureId.toNumber();
    (byFixture.get(fid) ?? byFixture.set(fid, []).get(fid)).push(w);
  }
  log(`${active.length} active wager(s) across ${byFixture.size} fixture(s)`);

  for (const [fixtureId, wagers] of byFixture) {
    const seq = await terminalSeqFor(fixtureId).catch(() => null);
    if (seq == null) continue; // match not over yet; try again next sweep
    for (const { publicKey, account } of wagers) {
      try {
        const pkg = await proofFor(fixtureId, seq, account.terms.statAKey, account.terms.statBKey);
        if (!pkg) { log(`fixture ${fixtureId}: proof not ready yet`); continue; }
        const sig = await settleOne(publicKey, account, pkg);
        log(`SETTLED ${publicKey.toBase58()} (fixture ${fixtureId}): ${sig}`);
      } catch (e) {
        const s = `${e}${e.logs ? e.logs.join("\n") : ""}`;
        if (s.includes("WagerNotActive")) { log(`${publicKey.toBase58()}: already settled by someone else`); continue; }
        if (s.includes("RootNotAvailable") || s.includes("6007")) { log(`fixture ${fixtureId}: oracle root not posted yet`); continue; }
        log(`${publicKey.toBase58()}: settle error, will retry next sweep: ${s.slice(0, 160)}`);
      }
    }
  }
}

log(`keeper ${keeper.publicKey.toBase58()} watching all wagers on ${program.programId.toBase58()}`);
log(`rpc ${RPC} · sweep every ${SCAN_MS / 1000}s · earns the settler tip on each settlement`);
for (;;) {
  try { await sweep(); }
  catch (e) { log(`sweep error: ${String(e.message ?? e).slice(0, 160)}`); }
  await sleep(SCAN_MS);
}
