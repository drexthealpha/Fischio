// Retry activation with a given txSig and league list (no new subscribe)
import { Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";
import { readFileSync, writeFileSync } from "node:fs";

const API_ORIGIN = "https://txline-dev.txodds.com";
const txSig = process.argv[2];
const leagues = process.argv[3] ? process.argv[3].split(",").map(Number) : [];
if (!txSig) throw new Error("usage: node 02b-activate-only.mjs <txSig> [leagues,csv]");

const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync("day1/devnet-wallet.json", "utf8"))));
const jwt = (await (await fetch(`${API_ORIGIN}/auth/guest/start`, { method: "POST" })).json()).token;

const message = new TextEncoder().encode(`${txSig}:${leagues.join(",")}:${jwt}`);
const walletSignature = Buffer.from(nacl.sign.detached(message, kp.secretKey)).toString("base64");

const res = await fetch(`${API_ORIGIN}/api/token/activate`, {
  method: "POST",
  headers: { "content-type": "application/json", Authorization: `Bearer ${jwt}` },
  body: JSON.stringify({ txSig, walletSignature, leagues }),
});
const bodyText = await res.text();
console.log(`leagues=[${leagues}] status=${res.status} body=${bodyText.slice(0, 300)}`);
if (res.ok) {
  let apiToken;
  try { apiToken = JSON.parse(bodyText).token ?? bodyText; } catch { apiToken = bodyText; }
  writeFileSync("day1/credentials.json", JSON.stringify({ jwt, apiToken, txSig, leagues, createdAt: new Date().toISOString() }, null, 2));
  console.log("api token saved");
}
