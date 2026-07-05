// Does the DEPLOYED devnet txoracle binary have validate_stat_v2, despite its
// stale on-chain IDL (1.4.2)? Probe by discriminator: a nonexistent instruction
// fails with InstructionFallbackNotFound (101); an existing one with a garbage
// payload fails differently (deserialization or program logic error).
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import BN from "bn.js";
import { readFileSync } from "node:fs";

const TXORACLE = new PublicKey("6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J");
const connection = new Connection("https://api.devnet.solana.com", "confirmed");
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync("day1/devnet-wallet.json", "utf8"))));

const [rootsPda] = PublicKey.findProgramAddressSync(
  [Buffer.from("daily_scores_roots"), new BN(20638).toArrayLike(Buffer, "le", 2)],
  TXORACLE
);

async function probe(label, disc) {
  const data = Buffer.concat([Buffer.from(disc), Buffer.alloc(8)]); // disc + junk
  const ix = new TransactionInstruction({
    programId: TXORACLE,
    keys: [{ pubkey: rootsPda, isSigner: false, isWritable: false }],
    data,
  });
  const tx = new Transaction().add(ix);
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  const sim = await connection.simulateTransaction(tx);
  const logs = (sim.value.logs ?? []).filter((l) => l.includes("Error") || l.includes("error") || l.includes("panicked"));
  console.log(`${label}: err=${JSON.stringify(sim.value.err)}`);
  for (const l of logs.slice(0, 3)) console.log(`   ${l}`);
}

await probe("validate_stat    (v1 disc + junk)", [107, 197, 232, 90, 191, 136, 105, 185]);
await probe("validate_stat_v2 (v2 disc + junk)", [208, 215, 194, 214, 241, 71, 246, 178]);
await probe("nonexistent      (random disc)   ", [1, 2, 3, 4, 5, 6, 7, 8]);
