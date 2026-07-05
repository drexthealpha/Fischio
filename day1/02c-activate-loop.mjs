// Retry devnet activation until their backend recovers (max ~30 min).
import { Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";
import { readFileSync, writeFileSync } from "node:fs";

const API_ORIGIN = "https://txline-dev.txodds.com";
const txSig = "4crKzQ7YX2cHvAzgAzdP1G7GrnNh2cLZgxmMHsZKiQBESgvmjYLAa59rFs9wb7biSWXytVdeJqXjULxgik7PMnAr";
const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync("day1/devnet-wallet.json", "utf8"))));

for (let attempt = 1; attempt <= 15; attempt++) {
  try {
    const jwtRes = await fetch(`${API_ORIGIN}/auth/guest/start`, { method: "POST" });
    if (!jwtRes.ok) throw new Error(`guest/start ${jwtRes.status}`);
    const jwt = (await jwtRes.json()).token;
    const message = new TextEncoder().encode(`${txSig}::${jwt}`);
    const walletSignature = Buffer.from(nacl.sign.detached(message, kp.secretKey)).toString("base64");
    const res = await fetch(`${API_ORIGIN}/api/token/activate`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${jwt}` },
      body: JSON.stringify({ txSig, walletSignature, leagues: [] }),
    });
    const body = await res.text();
    console.log(`[${new Date().toISOString()}] attempt ${attempt}: ${res.status} ${body.replace(/\s+/g, " ").slice(0, 100)}`);
    if (res.ok) {
      let apiToken;
      try { apiToken = JSON.parse(body).token ?? body; } catch { apiToken = body; }
      writeFileSync("day1/credentials.json", JSON.stringify({ jwt, apiToken, txSig, serviceLevelId: 1, createdAt: new Date().toISOString() }, null, 2));
      console.log("SUCCESS - api token saved");
      process.exit(0);
    }
  } catch (e) {
    console.log(`[${new Date().toISOString()}] attempt ${attempt}: ERR ${e.message}`);
  }
  await new Promise((r) => setTimeout(r, 120000));
}
console.log("gave up after 15 attempts");
process.exit(1);
