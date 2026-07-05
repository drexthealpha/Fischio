// Day-1 step 2: on-chain subscribe (free World Cup tier) + API token activation on devnet
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";
import nacl from "tweetnacl";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const API_ORIGIN = "https://txline-dev.txodds.com";
const TXL_MINT = new PublicKey("4Zao8ocPhmMgq7PdsYWyxvqySMGx7xb9cMftPMkEokRG");
const SERVICE_LEVEL_ID = Number(process.argv[2] ?? 1); // 1 = World Cup free (60s delay)
const DURATION_WEEKS = 4;
const SELECTED_LEAGUES = [];

const connection = new Connection("https://api.devnet.solana.com", "confirmed");
const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync("day1/devnet-wallet.json", "utf8"))));
const wallet = new anchor.Wallet(kp);
const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
const idl = JSON.parse(readFileSync("day1/txoracle-devnet-idl.json", "utf8"));
const program = new anchor.Program(idl, provider);

// Reuse a prior subscription tx if we already ran this step
let txSig;
if (existsSync("day1/credentials.json")) {
  const prev = JSON.parse(readFileSync("day1/credentials.json", "utf8"));
  if (prev.txSig && prev.serviceLevelId === SERVICE_LEVEL_ID) txSig = prev.txSig;
}

if (!txSig) {
  const [tokenTreasuryPda] = PublicKey.findProgramAddressSync([Buffer.from("token_treasury_v2")], program.programId);
  const tokenTreasuryVault = getAssociatedTokenAddressSync(TXL_MINT, tokenTreasuryPda, true, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const [pricingMatrixPda] = PublicKey.findProgramAddressSync([Buffer.from("pricing_matrix")], program.programId);
  const userTokenAccount = getAssociatedTokenAddressSync(TXL_MINT, kp.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);

  // subscribe requires the user's TxL ATA to exist, even at 0 cost (AccountNotInitialized otherwise)
  const createAtaIx = createAssociatedTokenAccountIdempotentInstruction(
    kp.publicKey, userTokenAccount, kp.publicKey, TXL_MINT,
    TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
  );

  // ATA-create as ix[0] may break the activation backend's tx parsing; only include if missing
  const ataInfo = await connection.getAccountInfo(userTokenAccount);
  const pre = ataInfo ? [] : [createAtaIx];

  txSig = await program.methods
    .subscribe(SERVICE_LEVEL_ID, DURATION_WEEKS)
    .preInstructions(pre)
    .accounts({
      user: kp.publicKey,
      pricingMatrix: pricingMatrixPda,
      tokenMint: TXL_MINT,
      userTokenAccount,
      tokenTreasuryVault,
      tokenTreasuryPda,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  console.log("subscribe tx:", txSig);
} else {
  console.log("reusing subscribe tx:", txSig);
}

const jwt = (await (await fetch(`${API_ORIGIN}/auth/guest/start`, { method: "POST" })).json()).token;
console.log("guest jwt acquired, len", jwt.length);

// Activation message binding: `${txSig}:${leagues.join(",")}:${jwt}` (empty leagues -> `sig::jwt`)
const message = new TextEncoder().encode(`${txSig}:${SELECTED_LEAGUES.join(",")}:${jwt}`);
const walletSignature = Buffer.from(nacl.sign.detached(message, kp.secretKey)).toString("base64");

const res = await fetch(`${API_ORIGIN}/api/token/activate`, {
  method: "POST",
  headers: { "content-type": "application/json", Authorization: `Bearer ${jwt}` },
  body: JSON.stringify({ txSig, walletSignature, leagues: SELECTED_LEAGUES }),
});
const bodyText = await res.text();
console.log("activate status:", res.status);
if (!res.ok) {
  console.log("activate error body:", bodyText.slice(0, 500));
  process.exit(1);
}
let apiToken;
try { apiToken = JSON.parse(bodyText).token ?? bodyText; } catch { apiToken = bodyText; }
writeFileSync("day1/credentials.json", JSON.stringify({ jwt, apiToken, txSig, serviceLevelId: SERVICE_LEVEL_ID, createdAt: new Date().toISOString() }, null, 2));
console.log("api token saved:", String(apiToken).slice(0, 20) + "...");
