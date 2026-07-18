// Mint fischio's one shared devnet test-USDC token. Every market and book should default to
// this mint so liquidity isn't fragmented across a fresh orphan token every time someone
// creates a market, the way earlier demo scripts each minted their own. Devnet only: before
// mainnet, this gets replaced with real USDC, not a token we control the supply of.
//
// A fixed supply is minted once to the deployer wallet, then faucet.mjs hands out small
// amounts from that balance on request. Nobody is granted open mint authority; that would be
// a backdoor into the very unit of account every market prices against.
import { readFileSync, writeFileSync } from "node:fs";
import { Connection, Keypair } from "@solana/web3.js";
import { createMint, getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";

const RPC = process.env.RPC ?? "https://api.devnet.solana.com";
const connection = new Connection(RPC, "confirmed");
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync("local/devnet-wallet.json", "utf8"))));
const U = 1_000_000; // 6 decimals, matches real USDC

const mint = await createMint(connection, payer, payer.publicKey, null, 6);
const ata = (await getOrCreateAssociatedTokenAccount(connection, payer, mint, payer.publicKey)).address;
await mintTo(connection, payer, mint, ata, payer, 100_000_000 * U); // 100M fUSDC, faucet supply

writeFileSync("local/devnet-usdc.json", JSON.stringify({ mint: mint.toBase58(), faucetOwner: payer.publicKey.toBase58(), decimals: 6 }, null, 2));
console.log("fischio devnet test-USDC mint:", mint.toBase58());
console.log("faucet balance:", 100_000_000, "fUSDC in", ata.toBase58());
console.log("saved to local/devnet-usdc.json");
