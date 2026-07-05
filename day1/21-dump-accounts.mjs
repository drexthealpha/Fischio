// Dump txoracle program ELF + all daily_scores_roots PDAs our saved proofs reference,
// in the JSON format solana-test-validator --account expects.
import { Connection, PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const TXORACLE = new PublicKey("6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J");
const UPGRADEABLE_LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const connection = new Connection("https://api.devnet.solana.com", "confirmed");
mkdirSync("test-fixtures", { recursive: true });

// 1. program ELF: program account -> programdata account -> strip 45-byte header
const progAcc = await connection.getAccountInfo(TXORACLE);
const programdataAddr = new PublicKey(progAcc.data.subarray(4, 36)); // UpgradeableLoaderState::Program { programdata_address }
const pd = await connection.getAccountInfo(programdataAddr);
const elf = pd.data.subarray(45); // 4 enum + 8 slot + 33 Option<Pubkey> upgrade authority
writeFileSync("test-fixtures/txoracle.so", elf);
console.log(`txoracle ELF: ${elf.length} bytes -> test-fixtures/txoracle.so`);

// 2. roots PDAs for every epoch day referenced by saved proofs
const proofFiles = [
  "day1/proof-package.json",     // Spain-Austria mid-match (live sample)
  "day1/proof-usa-corners.json", // USA corners terminal
];
const finals = JSON.parse(readFileSync("day1/final-proofs.json", "utf8"));
const summaries = [
  ...proofFiles.map((f) => JSON.parse(readFileSync(f, "utf8")).summary),
  ...Object.values(finals).map((v) => v.summary),
];
const epochDays = [...new Set(summaries.map((s) => Math.floor(s.updateStats.minTimestamp / 86400000)))];
console.log("epoch days needed:", epochDays.join(", "));

const accountsArgs = [];
for (const day of epochDays) {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("daily_scores_roots"), new BN(day).toArrayLike(Buffer, "le", 2)],
    TXORACLE
  );
  const acc = await connection.getAccountInfo(pda);
  if (!acc) { console.log(`day ${day}: PDA ${pda.toBase58()} NOT FOUND on devnet`); continue; }
  const file = `test-fixtures/roots-${day}.json`;
  writeFileSync(file, JSON.stringify({
    pubkey: pda.toBase58(),
    account: {
      lamports: acc.lamports,
      data: [acc.data.toString("base64"), "base64"],
      owner: acc.owner.toBase58(),
      executable: false,
      rentEpoch: 18446744073709551615,
      space: acc.data.length,
    },
  }, null, 2));
  accountsArgs.push(`--account ${pda.toBase58()} ${file}`);
  console.log(`day ${day}: ${pda.toBase58()} ${acc.data.length} bytes -> ${file}`);
}

writeFileSync(
  "test-fixtures/validator-args.txt",
  [`--bpf-program ${TXORACLE.toBase58()} test-fixtures/txoracle.so`, ...accountsArgs].join(" ")
);
console.log("validator args -> test-fixtures/validator-args.txt");
