// Check txoracle program activity on devnet + mainnet: are scores roots being posted?
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { readFileSync } from "node:fs";

const NETS = {
  devnet: { rpc: "https://api.devnet.solana.com", programId: "6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J" },
  mainnet: { rpc: "https://api.mainnet-beta.solana.com", programId: "9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA" },
};

const idl = JSON.parse(readFileSync("day1/txoracle-devnet-idl.json", "utf8"));
const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync("day1/devnet-wallet.json", "utf8"))));

for (const [net, cfg] of Object.entries(NETS)) {
  const connection = new Connection(cfg.rpc, "confirmed");
  const programId = new PublicKey(cfg.programId);
  try {
    const sigs = await connection.getSignaturesForAddress(programId, { limit: 20 });
    console.log(`\n=== ${net}: last ${sigs.length} program txs ===`);
    for (const s of sigs.slice(0, 20)) {
      const age = ((Date.now() / 1000 - s.blockTime) / 60).toFixed(1);
      console.log(` ${s.signature.slice(0, 20)}... ${age} min ago ${s.err ? "FAILED" : "ok"} memo=${s.memo ?? ""}`);
    }
    // decode instruction names for the 5 most recent
    const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(kp), {});
    const coder = new anchor.BorshInstructionCoder({ ...idl, address: cfg.programId });
    for (const s of sigs.slice(0, 5)) {
      const tx = await connection.getTransaction(s.signature, { maxSupportedTransactionVersion: 0 });
      if (!tx) continue;
      const msg = tx.transaction.message;
      const keys = msg.staticAccountKeys ?? msg.accountKeys;
      const ixs = msg.compiledInstructions ?? msg.instructions;
      for (const ix of ixs) {
        const pid = keys[ix.programIdIndex];
        if (!pid.equals(programId)) continue;
        const data = Buffer.from(ix.data ?? ix.dataBase58 ? ix.data : [], "base64");
        const raw = ix.data instanceof Uint8Array ? Buffer.from(ix.data) : Buffer.from(anchor.utils.bytes.bs58.decode(ix.data));
        const decoded = coder.decode(raw);
        console.log(`   ${s.signature.slice(0, 12)}... ix: ${decoded?.name ?? "unknown(" + raw.slice(0, 8).toString("hex") + ")"}`);
      }
    }
  } catch (e) {
    console.log(`${net} ERROR:`, e.message);
  }
}
