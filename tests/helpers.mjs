// Shared rig for the adversarial suite: local validator, funded actors, proof marshalling.
import * as anchor from "@coral-xyz/anchor";
import {
  Connection, Keypair, PublicKey, SystemProgram, LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import BN from "bn.js";
import { readFileSync } from "node:fs";

export {
  TXORACLE_ID, TERMINAL_PERIODS, b32, nodes, summaryOf, statA, statB, epochDayOf, rootsPda,
} from "../lib/proof-marshal.mjs";
import { TXORACLE_ID, summaryOf, statA, statB, epochDayOf, rootsPda, nodes } from "../lib/proof-marshal.mjs";

export const STAKE = 10_000_000; // 0.01 SOL per side
export const TIP = 100_000; // must match SETTLER_TIP_LAMPORTS

export const connection = new Connection("http://127.0.0.1:8899", "confirmed");

const idl = JSON.parse(readFileSync("target/idl/wc_settle.json", "utf8"));

export function makeActor() {
  return Keypair.generate();
}

// Fund from the genesis-rich local wallet (validator started with --mint); the
// test-validator faucet is unreliable on Windows and isn't needed.
const genesisPayer = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(readFileSync("local/devnet-wallet.json", "utf8")))
);

export async function fund(...keypairs) {
  const { Transaction, SystemProgram, sendAndConfirmTransaction } = anchor.web3;
  const tx = new Transaction();
  for (const kp of keypairs) {
    tx.add(SystemProgram.transfer({
      fromPubkey: genesisPayer.publicKey,
      toPubkey: kp.publicKey,
      lamports: 10 * LAMPORTS_PER_SOL,
    }));
  }
  await sendAndConfirmTransaction(connection, tx, [genesisPayer], { commitment: "confirmed" });
}

export function programFor(kp) {
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(kp), { commitment: "confirmed" });
  return new anchor.Program(idl, provider);
}

export function wagerPda(programId, maker, wagerId) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("wager"), maker.toBuffer(), new BN(wagerId.toString()).toArrayLike(Buffer, "le", 8)],
    programId
  )[0];
}

export function vaultPda(programId, wager) {
  return PublicKey.findProgramAddressSync([Buffer.from("vault"), wager.toBuffer()], programId)[0];
}

// canonical v1 market: "maker's team (P1) wins in 90'+ET"
export function p1WinsTerms(fixtureId) {
  return {
    fixtureId: new BN(fixtureId),
    statAKey: 1,
    statBKey: 2,
    op: { subtract: {} },
    predicate: { threshold: 0, comparison: { greaterThan: {} } },
  };
}

let idCounter = 0n;
export function freshWagerId() {
  return (BigInt(Date.now()) << 8n) + idCounter++;
}

export async function createWager(program, maker, terms, { stake = STAKE, expiryTs } = {}) {
  const wagerId = freshWagerId();
  const wager = wagerPda(program.programId, maker.publicKey, wagerId);
  const vault = vaultPda(program.programId, wager);
  expiryTs ??= Math.floor(Date.now() / 1000) + 3600;
  await program.methods
    .createWager(new BN(wagerId.toString()), terms, new BN(stake), new BN(expiryTs))
    .accountsPartial({
      maker: maker.publicKey,
      wager,
      vault,
      systemProgram: SystemProgram.programId,
    })
    .signers([maker])
    .rpc();
  return { wagerId, wager, vault };
}

export async function acceptWager(program, taker, maker, wagerId) {
  const wager = wagerPda(program.programId, maker.publicKey, wagerId);
  await program.methods
    .acceptWager()
    .accountsPartial({
      taker: taker.publicKey,
      wager,
      vault: vaultPda(program.programId, wager),
      systemProgram: SystemProgram.programId,
    })
    .signers([taker])
    .rpc();
}

export async function settle(program, settler, { maker, taker, wagerId }, pkg, overrides = {}) {
  const wager = wagerPda(program.programId, maker, wagerId); // maker/taker are PublicKeys here
  return program.methods
    .settle(
      overrides.summary ?? summaryOf(pkg),
      nodes(pkg.subTreeProof),
      nodes(pkg.mainTreeProof),
      overrides.statA ?? statA(pkg),
      overrides.statB !== undefined ? overrides.statB : statB(pkg)
    )
    .accountsPartial({
      settler: settler.publicKey,
      wager,
      vault: vaultPda(program.programId, wager),
      maker,
      taker,
      dailyScoresRoots: overrides.roots ?? rootsPda(epochDayOf(pkg)),
      txoracleProgram: TXORACLE_ID,
      systemProgram: SystemProgram.programId,
    })
    // validate_stat costs ~179k CU via CPI; the default 200k tx budget is not enough
    .preInstructions([anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })])
    .signers([settler])
    .rpc();
}

export async function refund(program, { maker, taker, wagerId }) {
  const wager = wagerPda(program.programId, maker, wagerId); // maker/taker are PublicKeys here
  return program.methods
    .refund()
    .accountsPartial({
      wager,
      vault: vaultPda(program.programId, wager),
      maker,
      taker,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
}

/// Assert a promise rejects with our specific anchor error code (by name).
export async function expectError(promise, codeName) {
  try {
    await promise;
  } catch (e) {
    const s = `${e}${e.logs ? "\n" + e.logs.join("\n") : ""}`;
    if (s.includes(codeName)) return;
    throw new Error(`expected error ${codeName}, got: ${s.slice(0, 400)}`);
  }
  throw new Error(`expected error ${codeName}, but the call SUCCEEDED`);
}

export const balance = (pk) => connection.getBalance(pk, "confirmed");
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/// Wall-clock sleeps race the validator's PoH-driven clock; wait on the actual
/// on-chain clock sysvar instead when a test needs chain time to pass expiry.
export async function waitForChainTime(unixTs) {
  const { SYSVAR_CLOCK_PUBKEY } = anchor.web3;
  for (;;) {
    const info = await connection.getParsedAccountInfo(SYSVAR_CLOCK_PUBKEY, "confirmed");
    const now = info.value?.data?.parsed?.info?.unixTimestamp ?? 0;
    if (now > unixTs) return;
    await sleep(500);
  }
}
