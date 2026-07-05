// Dump txoracle program ELF + daily roots PDAs from devnet for local test-validator,
// and save the mid-match period-0 proof package used by the exploit test.
import { Connection, PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const TXORACLE = new PublicKey("6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J");
const connection = new Connection("https://api.devnet.solana.com", "confirmed");
mkdirSync("test-fixtures", { recursive: true });

// --- program ELF (upgradeable loader: proxy -> programdata, 45-byte header) ---
const proxy = await connection.getAccountInfo(TXORACLE);
const programdataAddr = new PublicKey(proxy.data.subarray(4, 36));
const programdata = await connection.getAccountInfo(programdataAddr);
const elf = programdata.data.subarray(45);
writeFileSync("test-fixtures/txoracle.so", elf);
console.log(`txoracle.so: ${elf.length} bytes (programdata ${programdataAddr.toBase58()})`);

// --- daily roots accounts for the proof epoch days ---
for (const day of [20635, 20636]) {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("daily_scores_roots"), new BN(day).toArrayLike(Buffer, "le", 2)],
    TXORACLE
  );
  const info = await connection.getAccountInfo(pda);
  const dump = {
    pubkey: pda.toBase58(),
    account: {
      lamports: info.lamports,
      data: [info.data.toString("base64"), "base64"],
      owner: info.owner.toBase58(),
      executable: false,
      rentEpoch: 18446744073709551615,
      space: info.data.length,
    },
  };
  writeFileSync(`test-fixtures/roots-${day}.json`, JSON.stringify(dump));
  console.log(`roots-${day}.json: ${info.data.length} bytes @ ${pda.toBase58()}`);
}

// --- mid-match period-0 proof (USA-Bosnia seq 446) for the exploit test ---
const { jwt, apiToken } = JSON.parse(readFileSync("day1/credentials.json", "utf8"));
const r = await fetch(
  "https://txline-dev.txodds.com/api/scores/stat-validation?fixtureId=18172379&seq=446&statKey=1&statKey2=2",
  { headers: { Authorization: `Bearer ${jwt}`, "X-Api-Token": apiToken } }
);
if (!r.ok) throw new Error(`stat-validation ${r.status}`);
const proof = await r.json();
writeFileSync("test-fixtures/proof-mid-446.json", JSON.stringify(proof, null, 2));
console.log(`proof-mid-446.json: period=${proof.statToProve.period} value=${proof.statToProve.value}`);

// copy the terminal proofs next to it for the suite
writeFileSync("test-fixtures/final-proofs.json", readFileSync("day1/final-proofs.json"));
console.log("final-proofs.json copied");
