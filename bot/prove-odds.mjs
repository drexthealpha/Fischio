#!/usr/bin/env node
// Prove a price on-chain.
//
// fischio quotes every market from TxODDS's demargined line. This proves that the line it
// quoted is genuine: it pulls the Merkle proof for one odds update and calls validate_odds on
// the deployed txoracle, which folds the proof against the odds root TxODDS posted to Solana.
// If the transaction lands, that signature is public evidence that this exact price, for this
// exact market, at this exact millisecond, is the real TxLINE line and not a number fischio
// invented.
//
// It touches none of fischio's five programs. validate_odds is a public instruction on the
// oracle, so any wallet can call it and anyone can repeat this.
//
//   node bot/prove-odds.mjs --fixture 18257739                    # prove the full-match 1X2
//   node bot/prove-odds.mjs --fixture 18257739 --type totals --line 2.5
//   node bot/prove-odds.mjs --fixture 18257739 --all              # prove every market on the board
//   flags: --rpc <url>  --dry (marshal and print, send nothing)
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair } from "@solana/web3.js";
import { txlineClient, parseMarkets } from "../lib/txline.mjs";
import { TXORACLE_ID, validateOddsArgs, oddsRootsPda, oddsEpochDayOf, describeOdds } from "../lib/odds-proof.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d; };
const has = (k) => process.argv.includes(`--${k}`);

const RPC = arg("rpc", process.env.RPC ?? "https://api.devnet.solana.com");
const FIXTURE = Number(arg("fixture", 0));
const DRY = has("dry");
if (!FIXTURE) { console.error("usage: node bot/prove-odds.mjs --fixture <id> [--type 1x2|totals|handicap] [--line 2.5] [--all] [--dry]"); process.exit(1); }

const TYPES = { "1x2": "1X2_PARTICIPANT_RESULT", totals: "OVERUNDER_PARTICIPANT_GOALS", handicap: "ASIANHANDICAP_PARTICIPANT_GOALS" };
const WANT_TYPE = TYPES[String(arg("type", "1x2")).toLowerCase()];
const WANT_LINE = arg("line", null) == null ? null : Number(arg("line"));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const tx = txlineClient();
const connection = new Connection(RPC, "confirmed");

// A read-only wallet is enough to marshal; sending needs a real signer for the fee.
let payer = null;
try { payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(process.env.KEYPAIR_JSON ?? readFileSync(join(root, "local/devnet-wallet.json"), "utf8")))); }
catch { if (!DRY) { console.error("no signer: set KEYPAIR_JSON or provide local/devnet-wallet.json, or pass --dry"); process.exit(1); } }

const idl = JSON.parse(readFileSync(join(root, "local/txoracle-devnet-idl.json"), "utf8"));
const provider = new anchor.AnchorProvider(
  connection,
  payer ? new anchor.Wallet(payer) : { publicKey: TXORACLE_ID, signTransaction: async (t) => t, signAllTransactions: async (t) => t },
  { commitment: "confirmed" }
);
const oracle = new anchor.Program(idl, provider);

// ---- pick the markets to prove ----
const board = parseMarkets((await tx.oddsSnapshot(FIXTURE)) ?? []);
if (!board.length) { log(`no odds board for fixture ${FIXTURE}`); process.exit(0); }
let targets = has("all") ? board : board.filter((m) => m.type === WANT_TYPE && (WANT_LINE == null || m.line === WANT_LINE));
if (!targets.length) { log(`no market matched type=${WANT_TYPE} line=${WANT_LINE ?? "-"}; board has ${board.length} markets`); process.exit(0); }
log(`fixture ${FIXTURE}: board has ${board.length} markets, proving ${targets.length}`);

let proven = 0, failed = 0;
for (const m of targets) {
  const label = `${m.type.split("_")[0]} ${m.period}${m.line != null ? ` ${m.line}` : ""}`;
  try {
    // messageId + ts identify the exact update. Both come straight off the odds row, which is
    // why every market in the catalogue is provable without any extra bookkeeping.
    const pkg = await tx.oddsValidation({ fixtureId: FIXTURE, messageId: m.messageId, ts: m.ts });
    if (!pkg?.odds) { log(`  ${label}: no validation package returned`); failed++; continue; }

    const day = oddsEpochDayOf(pkg);
    const roots = oddsRootsPda(day);
    const args = validateOddsArgs(pkg);
    log(`  ${label}`);
    log(`     ${describeOdds(pkg)}`);
    log(`     messageId ${pkg.odds.MessageId}`);
    log(`     epochDay ${day} -> roots ${roots.toBase58()}`);
    log(`     subTree ${pkg.subTreeProof?.length ?? 0} nodes, mainTree ${pkg.mainTreeProof?.length ?? 0} nodes`);

    if (DRY) { log(`     [dry] marshalled ok, sending nothing`); proven++; continue; }

    const info = await connection.getAccountInfo(roots);
    if (!info) { log(`     roots account for day ${day} is not on chain yet; the batch root has not been posted`); failed++; continue; }

    const sig = await oracle.methods
      .validateOdds(...args)
      .accountsPartial({ dailyOddsMerkleRoots: roots })
      .preInstructions([anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })])
      .rpc();
    log(`     PROVEN on-chain: ${sig}`);
    proven++;
  } catch (e) {
    const s = String(e.message ?? e);
    log(`     failed: ${s.slice(0, 200)}`);
    if (e.logs) for (const l of e.logs.slice(-6)) log(`       ${l}`);
    failed++;
  }
}
log(`done: ${proven} proven, ${failed} failed`);
process.exit(failed && !proven ? 1 : 0);
