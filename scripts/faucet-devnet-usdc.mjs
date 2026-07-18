// Hand out fischio's shared devnet test-USDC (local/devnet-usdc.json) to a wallet, from the
// fixed supply create-devnet-usdc.mjs minted once. Usage:
//   node scripts/faucet-devnet-usdc.mjs <recipient-pubkey> [amount]   (amount defaults to 1000)
import { readFileSync } from "node:fs";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";

const RPC = process.env.RPC ?? "https://api.devnet.solana.com";
const connection = new Connection(RPC, "confirmed");
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync("local/devnet-wallet.json", "utf8"))));
const { mint: mintStr } = JSON.parse(readFileSync("local/devnet-usdc.json", "utf8"));
const mint = new PublicKey(mintStr);
const U = 1_000_000;

const recipient = new PublicKey(process.argv[2]);
const amount = Number(process.argv[3] ?? 1000);

const ata = (await getOrCreateAssociatedTokenAccount(connection, payer, mint, recipient)).address;
await mintTo(connection, payer, mint, ata, payer, amount * U);
console.log(`sent ${amount} fUSDC to ${recipient.toBase58()} (${ata.toBase58()})`);
