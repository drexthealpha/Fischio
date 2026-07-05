// Parse daily_scores_roots accounts: how many 5-min interval roots are filled, and how fresh?
import { Connection, PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { readFileSync } from "node:fs";

const NETS = {
  devnet: { rpc: "https://api.devnet.solana.com", programId: "6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J" },
  mainnet: { rpc: "https://api.mainnet-beta.solana.com", programId: "9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA" },
};
const idl = JSON.parse(readFileSync("day1/txoracle-devnet-idl.json", "utf8"));
const acctType = idl.types?.find((t) => t.name.toLowerCase().includes("dailyscores")) ??
                 idl.accounts?.find((a) => a.name.toLowerCase().includes("dailyscores"));
console.log("account type in IDL:", JSON.stringify(acctType)?.slice(0, 400), "\n");

const epochDay = Math.floor(Date.now() / 86400000);
const nowInterval = Math.floor((Date.now() % 86400000) / 300000); // 0..287 current 5-min slot

for (const [net, cfg] of Object.entries(NETS)) {
  const connection = new Connection(cfg.rpc, "confirmed");
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("daily_scores_roots"), new BN(epochDay).toArrayLike(Buffer, "le", 2)],
    new PublicKey(cfg.programId)
  );
  const info = await connection.getAccountInfo(pda);
  if (!info) { console.log(`${net}: no account for today`); continue; }
  const data = info.data;
  // strip 8-byte anchor discriminator; assume remainder holds 288 x 32-byte roots (+ header)
  const body = data.subarray(8);
  const slots = Math.floor(body.length / 32);
  let filled = 0, lastFilled = -1, firstFilled = -1;
  for (let i = 0; i < slots; i++) {
    const root = body.subarray(i * 32, i * 32 + 32);
    const nonZero = root.some((b) => b !== 0);
    if (nonZero) { filled++; lastFilled = i; if (firstFilled < 0) firstFilled = i; }
  }
  console.log(`${net} today(day=${epochDay}): ${filled}/${slots} slots filled, first=${firstFilled}, last=${lastFilled}, currentSlot=${nowInterval}`);
  console.log(`  staleness: last filled slot is ${(nowInterval - lastFilled) * 5} min behind now (approx, header offset may shift index)`);
}
