// Probe data endpoints on dev + mainnet APIs with guest JWT only (and bogus token) to map auth enforcement
const origins = { devnet: "https://txline-dev.txodds.com", mainnet: "https://txline.txodds.com" };
const epochDay = Math.floor(Date.now() / 86400000);

for (const [net, origin] of Object.entries(origins)) {
  const jwt = (await (await fetch(`${origin}/auth/guest/start`, { method: "POST" })).json()).token;
  for (const headers of [
    { name: "jwt-only", h: { Authorization: `Bearer ${jwt}` } },
    { name: "jwt+bogus-token", h: { Authorization: `Bearer ${jwt}`, "X-Api-Token": "txoracle_api_bogus" } },
  ]) {
    const r = await fetch(`${origin}/api/fixtures/snapshot?startEpochDay=${epochDay}`, { headers: headers.h });
    const body = (await r.text()).slice(0, 150);
    console.log(`${net} ${headers.name}: ${r.status} ${body}`);
  }
}
