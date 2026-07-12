// Seed one live AMM market on devnet, priced against fischio's shared devnet test-USDC, so
// the Predictions view has a real market to show and trade against instead of an empty list.
import { readFileSync } from "node:fs";
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount, mintTo, TOKEN_PROGRAM_ID } from "@solana/spl-token";

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
// Seed a market on a genuinely upcoming fixture, so the market is real: it trades until the
// match kicks off, the same as any prediction market. Run scripts/refresh-fixtures.mjs first
// so the snapshot has current fixtures. If none are upcoming (between tournaments), fall back
// to the latest fixture with a forward-looking window so the demo still has a live market.
const fixtures = JSON.parse(readFileSync("app/src/fixtures.json", "utf8")).fixtures;
const now = Date.now();
const upcoming = fixtures.filter((f) => new Date(f.kickoff).getTime() > now + 15 * 60 * 1000);
const fixture = upcoming[0] ?? fixtures[fixtures.length - 1];
const realKickoff = new Date(fixture.kickoff).getTime() > now;
console.log(`fixture: ${fixture.id} ${fixture.home} v ${fixture.away} ${fixture.kickoff}${realKickoff ? "" : " (kickoff passed; using a demo window)"}`);

const seed = (s, m) => PublicKey.findProgramAddressSync([Buffer.from(s), m.toBuffer()], PID)[0];
const marketId = (BigInt(Date.now()) << 6n) + BigInt(Math.floor(Math.random() * 64));
const market = PublicKey.findProgramAddressSync(
  [Buffer.from("market"), payer.publicKey.toBuffer(), new BN(marketId.toString()).toArrayLike(Buffer, "le", 8)], PID
)[0];
const P = { yesMint: seed("yes", market), noMint: seed("no", market), lpMint: seed("lp", market),
  vault: seed("vault", market), yesPool: seed("yes_pool", market), noPool: seed("no_pool", market) };

const terms = { fixtureId: new BN(fixture.id), statAKey: 1, statBKey: 2, op: { subtract: {} }, predicate: { threshold: 0, comparison: { greaterThan: {} } } };
// close at kickoff for a real upcoming fixture; otherwise a forward window so the demo trades
const closeTs = realKickoff ? Math.floor(new Date(fixture.kickoff).getTime() / 1000) : Math.floor(now / 1000) + 30 * 24 * 3600;
const expiryTs = closeTs + 8 * 3600;

await program.methods.createMarket(new BN(marketId.toString()), terms, new BN(closeTs), new BN(expiryTs), 200)
  .accountsPartial({
    creator: payer.publicKey, market, collateralMint: usdc, yesMint: P.yesMint, noMint: P.noMint, lpMint: P.lpMint,
    vault: P.vault, yesPool: P.yesPool, noPool: P.noPool,
    tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId, rent: anchor.web3.SYSVAR_RENT_PUBKEY,
  })
  .preInstructions([anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })])
  .rpc();
console.log("market:", market.toBase58());

// seed liquidity so the market is immediately tradeable at 50/50
const col = (await getOrCreateAssociatedTokenAccount(connection, payer, usdc, payer.publicKey)).address;
const yes = (await getOrCreateAssociatedTokenAccount(connection, payer, P.yesMint, payer.publicKey)).address;
const no = (await getOrCreateAssociatedTokenAccount(connection, payer, P.noMint, payer.publicKey)).address;
const lp = (await getOrCreateAssociatedTokenAccount(connection, payer, P.lpMint, payer.publicKey)).address;
await program.methods.addLiquidity(new BN(500 * U))
  .accountsPartial({
    provider: payer.publicKey, market, yesMint: P.yesMint, noMint: P.noMint, lpMint: P.lpMint, vault: P.vault,
    yesPool: P.yesPool, noPool: P.noPool, providerCollateral: col, providerYes: yes, providerNo: no, providerLp: lp,
    tokenProgram: TOKEN_PROGRAM_ID,
  })
  .preInstructions([anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })])
  .rpc();
console.log("seeded 500 USDC of liquidity, market live at 50/50");
console.log("\nMARKET", market.toBase58());
