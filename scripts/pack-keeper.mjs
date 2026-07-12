// Assemble keeper-upload/ : the minimal self-contained folder to host the settlement
// bot on Wispbyte (or any Node host). No secrets are copied; keys and TxLINE tokens
// travel as env vars set in the host panel.
import { mkdirSync, copyFileSync, writeFileSync, cpSync } from "node:fs";

mkdirSync("keeper-upload/bot", { recursive: true });
mkdirSync("keeper-upload/lib", { recursive: true });
mkdirSync("keeper-upload/target/idl", { recursive: true });

copyFileSync("bot/keeper.mjs", "keeper-upload/bot/keeper.mjs");         // the daemon
copyFileSync("bot/settle-bot.mjs", "keeper-upload/bot/settle-bot.mjs"); // single-shot demo tool
copyFileSync("lib/proof-marshal.mjs", "keeper-upload/lib/proof-marshal.mjs");
copyFileSync("target/idl/wc_settle.json", "keeper-upload/target/idl/wc_settle.json");

writeFileSync("keeper-upload/package.json", JSON.stringify({
  name: "fischio-keeper",
  private: true,
  type: "module",
  engines: { node: ">=20" },
  scripts: { start: "node bot/keeper.mjs" }, // watches every wager, runs forever
  dependencies: {
    "@coral-xyz/anchor": "^0.32.1",
    "@solana/web3.js": "^1.98.0",
  },
}, null, 2));

writeFileSync("keeper-upload/README.txt", [
  "fischio keeper. Watches EVERY wager on the program and settles each one when its",
  "match ends. Runs forever. Any wager a user creates in the app is settled here",
  "automatically; there is no per-wager setup.",
  "",
  "Required env vars (set in the host panel, never in files):",
  "  RPC              https://api.devnet.solana.com",
  "  KEYPAIR_JSON     throwaway devnet keypair, JSON byte array (contents of the key file)",
  "  TXLINE_JWT       guest JWT from the TxLINE activation flow",
  "  TXLINE_API_TOKEN activated TxLINE API token",
  "  SCAN_MS          optional, sweep interval in ms (default 60000)",
  "",
  "Start command: npm start   (runs: node bot/keeper.mjs, config from env)",
  "It never exits. Each settlement pays the keeper a tip larger than the fee, so a",
  "small starting balance sustains it.",
].join("\n"));

console.log("keeper-upload/ ready: bot, lib, idl, package.json, README.txt (no secrets)");
