const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" });
const endpoints = [
  "https://solana-devnet.drpc.org",
  "https://solana-devnet-rpc.publicnode.com",
  "https://devnet.helius-rpc.com",
  "https://solana-devnet.g.alchemy.com/v2/demo",
];
for (const url of endpoints) {
  try {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body });
    console.log(url, "->", r.status, (await r.text()).slice(0, 120));
  } catch (e) {
    console.log(url, "-> ERR:", e.message, "| cause:", e.cause?.message ?? e.cause?.code ?? String(e.cause));
  }
}
