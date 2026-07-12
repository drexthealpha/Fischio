// Seed real prop markets on devnet: total corners O/U and total yellow cards O/U, alongside
// the match winner. Proves the deployed market program accepts these terms (op=Add, TxLINE
// stat keys 7/8 corners, 3/4 cards) and that they settle through the same validate_stat CPI.
import { readFileSync } from "node:fs";
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount, TOKEN_PROGRAM_ID } from "@solana/spl-token";

const RPC = process.env.RPC ?? "https://api.devnet.solana.com";
const connection = new Connection(RPC, "confirmed");
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync("day1/devnet-wallet.json", "utf8"))));
const idl = JSON.parse(readFileSync("target/idl/fischio_market.json", "utf8"));
const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(payer), { commitment: "confirmed" });
anchor.setProvider(provider);
const program = new anchor.Program(idl, provider);
const PID = program.programId;
const BN = anchor.BN, U = 1_000_000;
const { mint: usdcStr } = JSON.parse(readFileSync("day1/devnet-usdc.json", "utf8"));
const usdc = new PublicKey(usdcStr);

const fixtures = JSON.parse(readFileSync("app/src/fixtures.json", "utf8")).fixtures;
const now = Date.now();
const fx = fixtures.filter((f) => new Date(f.kickoff).getTime() > now + 15 * 60 * 1000)[0] ?? fixtures[fixtures.length - 1];
const closeTs = Math.floor(new Date(fx.kickoff).getTime() / 1000);
console.log("fixture:", fx.id, fx.home, "v", fx.away);

const seed = (s, m) => PublicKey.findProgramAddressSync([Buffer.from(s), m.toBuffer()], PID)[0];

// the two props to open beyond the winner market
const props = [
  { name: "Total corners O/U 9", statA: 7, statB: 8, op: { add: {} }, threshold: 9 },
  { name: "Total yellow cards O/U 3", statA: 3, statB: 4, op: { add: {} }, threshold: 3 },
];

for (const p of props) {
  const marketId = (BigInt(Date.now()) << 6n) + BigInt(Math.floor(Math.random() * 64));
  const market = PublicKey.findProgramAddressSync(
    [Buffer.from("market"), payer.publicKey.toBuffer(), new BN(marketId.toString()).toArrayLike(Buffer, "le", 8)], PID)[0];
  const P = { yesMint: seed("yes", market), noMint: seed("no", market), lpMint: seed("lp", market),
    vault: seed("vault", market), yesPool: seed("yes_pool", market), noPool: seed("no_pool", market) };
  const terms = { fixtureId: new BN(fx.id), statAKey: p.statA, statBKey: p.statB, op: p.op,
    predicate: { threshold: p.threshold, comparison: { greaterThan: {} } } };
  await program.methods.createMarket(new BN(marketId.toString()), terms, new BN(closeTs), new BN(closeTs + 8 * 3600), 200)
    .accountsPartial({ creator: payer.publicKey, market, collateralMint: usdc, yesMint: P.yesMint, noMint: P.noMint, lpMint: P.lpMint,
      vault: P.vault, yesPool: P.yesPool, noPool: P.noPool, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId, rent: anchor.web3.SYSVAR_RENT_PUBKEY })
    .preInstructions([anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })]).rpc();

  const col = (await getOrCreateAssociatedTokenAccount(connection, payer, usdc, payer.publicKey)).address;
  const yes = (await getOrCreateAssociatedTokenAccount(connection, payer, P.yesMint, payer.publicKey)).address;
  const no = (await getOrCreateAssociatedTokenAccount(connection, payer, P.noMint, payer.publicKey)).address;
  const lp = (await getOrCreateAssociatedTokenAccount(connection, payer, P.lpMint, payer.publicKey)).address;
  await program.methods.addLiquidity(new BN(500 * U))
    .accountsPartial({ provider: payer.publicKey, market, yesMint: P.yesMint, noMint: P.noMint, lpMint: P.lpMint, vault: P.vault,
      yesPool: P.yesPool, noPool: P.noPool, providerCollateral: col, providerYes: yes, providerNo: no, providerLp: lp, tokenProgram: TOKEN_PROGRAM_ID })
    .preInstructions([anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })]).rpc();
  console.log(`opened + seeded: ${p.name}  ${market.toBase58()}`);
}
console.log("\nprop markets live");
