// Differential probe: activation error shape on dev vs mainnet for a bogus txSig.
// If devnet 500s on everything while mainnet gives a specific 4xx, devnet's tx lookup is broken server-side.
import { Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";
import { readFileSync } from "node:fs";

const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync("day1/devnet-wallet.json", "utf8"))));
const bogusSig = "5".repeat(87); // syntactically valid-looking base58 length
const realDevSig = "4crKzQ7YX2cHvAzgAzdP1G7GrnNh2cLZgxmMHsZKiQBESgvmjYLAa59rFs9wb7biSWXytVdeJqXjULxgik7PMnAr";

const cases = [
  ["devnet", "https://txline-dev.txodds.com", bogusSig],
  ["devnet", "https://txline-dev.txodds.com", realDevSig],
  ["mainnet", "https://txline.txodds.com", bogusSig],
];

for (const [net, origin, txSig] of cases) {
  const jwt = (await (await fetch(`${origin}/auth/guest/start`, { method: "POST" })).json()).token;
  const message = new TextEncoder().encode(`${txSig}::${jwt}`);
  const walletSignature = Buffer.from(nacl.sign.detached(message, kp.secretKey)).toString("base64");
  const res = await fetch(`${origin}/api/token/activate`, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ txSig, walletSignature, leagues: [] }),
  });
  console.log(`${net} ${txSig === bogusSig ? "BOGUS" : "REAL "} -> ${res.status}: ${(await res.text()).slice(0, 120)}`);
}
