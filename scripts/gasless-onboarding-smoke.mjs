// Proof of zero-SOL onboarding: a freshly generated embedded wallet (like guestWallet.js
// mints in the browser) never receives a single lamport, yet becomes a real trading account
// on a book, because a sponsor pays the rent and the wallet only signs as the trading
// authority. This is the protocol half of "true gasless": a signature costs no balance, so
// once rent and fees are sponsored, an empty wallet can trade. The relayer covers the fee
// half (see services/relayer/smoke.mjs). Runs against the local exchange validator.
import { readFileSync } from "node:fs";
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { createMint, TOKEN_PROGRAM_ID } from "@solana/spl-token";

const connection = new Connection("http://127.0.0.1:8899", "confirmed");
const sponsor = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync("day1/devnet-wallet.json", "utf8"))));
const idl = JSON.parse(readFileSync("target/idl/fischio_exchange.json", "utf8"));
const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(sponsor), { commitment: "confirmed" });
anchor.setProvider(provider);
const program = new anchor.Program(idl, provider);
const PID = program.programId;
const seed = (s, k) => PublicKey.findProgramAddressSync([Buffer.from(s), k.toBuffer()], PID)[0];

// a book to join
const base = await createMint(connection, sponsor, sponsor.publicKey, null, 6);
const quote = await createMint(connection, sponsor, sponsor.publicKey, null, 6);
const market = Keypair.generate().publicKey;
const book = seed("book", market);
await program.methods.createBook(market).accountsPartial({
  creator: sponsor.publicKey, book, baseMint: base, quoteMint: quote,
  baseVault: seed("base_vault", book), quoteVault: seed("quote_vault", book),
  tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId, rent: anchor.web3.SYSVAR_RENT_PUBKEY,
}).rpc();

// the embedded wallet: generated, never funded
const guest = Keypair.generate();
const guestSol = await connection.getBalance(guest.publicKey);
console.log("embedded wallet:", guest.publicKey.toBase58(), `(${guestSol} lamports)`);

const openOrders = PublicKey.findProgramAddressSync(
  [Buffer.from("open_orders"), book.toBuffer(), guest.publicKey.toBuffer()], PID)[0];

// sponsor pays rent + fee; guest signs ONLY as the trading authority
await program.methods.initOpenOrders()
  .accountsPartial({ payer: sponsor.publicKey, owner: guest.publicKey, book, openOrders, systemProgram: SystemProgram.programId })
  .signers([guest]) // guest co-signs as owner; sponsor (provider wallet) is fee payer + rent payer
  .rpc();

const oo = await program.account.openOrders.fetch(openOrders);
const guestSolAfter = await connection.getBalance(guest.publicKey);
console.log("OpenOrders owner:", oo.owner.toBase58());
console.log("guest balance after:", guestSolAfter, "lamports");

const ok = oo.owner.toBase58() === guest.publicKey.toBase58() && guestSolAfter === 0;
console.log(ok
  ? "ZERO-SOL ONBOARDING OK: empty embedded wallet is now a trading account, sponsor paid everything"
  : "FAILED");
process.exit(ok ? 0 : 1);
