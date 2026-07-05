// Assemble keeper-upload/ : the minimal self-contained folder to host the settlement
// bot on Wispbyte (or any Node host). No secrets are copied; keys and TxLINE tokens
// travel as env vars set in the host panel.
import { mkdirSync, copyFileSync, writeFileSync, cpSync } from "node:fs";

mkdirSync("keeper-upload/bot", { recursive: true });
mkdirSync("keeper-upload/lib", { recursive: true });
mkdirSync("keeper-upload/target/idl", { recursive: true });

copyFileSync("bot/settle-bot.mjs", "keeper-upload/bot/settle-bot.mjs");
copyFileSync("lib/proof-marshal.mjs", "keeper-upload/lib/proof-marshal.mjs");
copyFileSync("target/idl/wc_settle.json", "keeper-upload/target/idl/wc_settle.json");

writeFileSync("keeper-upload/package.json", JSON.stringify({
  name: "wc-settle-keeper",
  private: true,
  type: "module",
  engines: { node: ">=20" },
  scripts: { start: "node bot/settle-bot.mjs" },
  dependencies: {
    "@coral-xyz/anchor": "^0.32.1",
    "@solana/web3.js": "^1.98.0",
  },
}, null, 2));

writeFileSync("keeper-upload/README.txt", [
  "wc-settle permissionless keeper. Runs the settlement bot headless.",
  "",
  "Required env vars (set in the host panel, never in files):",
  "  WAGER            wager account address to watch and settle",
  "  RPC              https://api.devnet.solana.com",
  "  KEYPAIR_JSON     throwaway devnet keypair, JSON byte array (contents of the key file)",
  "  TXLINE_JWT       guest JWT from the TxLINE activation flow",
  "  TXLINE_API_TOKEN activated TxLINE API token",
  "",
  "Start command: npm start   (runs: node bot/settle-bot.mjs, config from env)",
  "The process exits 0 after settling, or if the wager is already settled.",
].join("\n"));

console.log("keeper-upload/ ready: bot, lib, idl, package.json, README.txt (no secrets)");
