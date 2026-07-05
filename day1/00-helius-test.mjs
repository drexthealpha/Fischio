const call = (method, params) =>
  fetch("https://devnet.helius-rpc.com", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  }).then((r) => r.text());

console.log(await call("getBalance", ["CTpEUqmyWvziXzMWHT4CPH52eWti7U8LvDpAZiqJHSm8"]));
console.log((await call("getAccountInfo", ["6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J", { encoding: "base64" }])).slice(0, 200));
