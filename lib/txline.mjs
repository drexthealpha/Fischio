// One client for the whole TxLINE surface: all 18 endpoints in its OpenAPI spec, each wrapped
// as a named function so the rest of fischio has a single, typed place to reach the data layer.
// Credentials (guest JWT + API token) come from day1/credentials.json or the TXLINE_JWT /
// TXLINE_API_TOKEN env vars. Devnet by default; pass base for mainnet.
//
// Groups: access (guest JWT, activation, purchase quote), fixtures (snapshot, updates, and
// the two validation proofs), odds (snapshot, per-fixture and windowed updates, live stream,
// validation), scores (snapshot, per-fixture and windowed updates, historical, live stream,
// stat-validation). Everything is read-only except the two access POSTs.
import { readFileSync } from "node:fs";

const DEV = "https://txline-dev.txodds.com";
const MAIN = "https://txline.txodds.com";

function loadCreds() {
  const jwt = process.env.TXLINE_JWT, apiToken = process.env.TXLINE_API_TOKEN;
  if (jwt && apiToken) return { jwt, apiToken };
  try { const c = JSON.parse(readFileSync("day1/credentials.json", "utf8")); return { jwt: c.jwt, apiToken: c.apiToken }; }
  catch { return { jwt: null, apiToken: null }; }
}

export function txlineClient({ base = DEV, creds = loadCreds() } = {}) {
  const authHeaders = () => ({ Authorization: `Bearer ${creds.jwt}`, "X-Api-Token": creds.apiToken });

  // Read a JSON endpoint, tolerating the two shapes TxLINE also replies with: an empty body
  // (for example historical scores that do not exist yet), and an SSE body (some update feeds
  // switch to `data:` lines when a match has live data). Empty returns null; SSE returns the array.
  async function getJson(path, { auth = true } = {}) {
    const r = await fetch(`${base}${path}`, { headers: auth ? authHeaders() : {} });
    if (!r.ok) { const b = await r.text().catch(() => ""); throw new Error(`${path} -> ${r.status} ${b.slice(0, 50)}`); }
    const text = await r.text();
    if (!text.trim()) return null;
    if (text.startsWith("data:")) return parseSse(text);
    return JSON.parse(text);
  }
  function parseSse(text) {
    const out = [];
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (t.startsWith("data:")) { const p = t.slice(5).trim(); if (p) { try { out.push(JSON.parse(p)); } catch { /* skip */ } } }
    }
    return out;
  }
  // Server-Sent Events reader: yields each parsed data line until the caller stops iterating.
  async function* stream(path) {
    const r = await fetch(`${base}${path}`, { headers: { ...authHeaders(), Accept: "text/event-stream" } });
    if (!r.ok || !r.body) throw new Error(`${path} -> ${r.status}`);
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (line.startsWith("data:")) {
          const payload = line.slice(5).trim();
          if (payload) { try { yield JSON.parse(payload); } catch { yield payload; } }
        }
      }
    }
  }

  return {
    base, creds,
    // ---- access ----
    guestStart: () => fetch(`${base}/auth/guest/start`, { method: "POST" }).then((r) => r.json()),
    activate: (body) => fetch(`${base}/api/token/activate`, { method: "POST", headers: { ...authHeaders(), "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json()),
    purchaseQuote: (body) => fetch(`${base}/api/guest/purchase/quote`, { method: "POST", headers: { ...authHeaders(), "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json()),
    // ---- fixtures ----
    fixturesSnapshot: (startEpochDay) => getJson(`/api/fixtures/snapshot${startEpochDay != null ? `?startEpochDay=${startEpochDay}` : ""}`),
    fixturesUpdates: (epochDay, hourOfDay) => getJson(`/api/fixtures/updates/${epochDay}/${hourOfDay}`),
    fixturesValidation: (fixtureId) => getJson(`/api/fixtures/validation?fixtureId=${fixtureId}`),
    fixturesBatchValidation: (epochDay, hourOfDay) => getJson(`/api/fixtures/batch-validation?epochDay=${epochDay}&hourOfDay=${hourOfDay}`),
    // ---- odds ----
    oddsSnapshot: (fixtureId) => getJson(`/api/odds/snapshot/${fixtureId}`),
    oddsUpdatesFixture: (fixtureId) => getJson(`/api/odds/updates/${fixtureId}`),
    oddsUpdatesWindow: (epochDay, hourOfDay, interval) => getJson(`/api/odds/updates/${epochDay}/${hourOfDay}/${interval}`),
    oddsStream: () => stream(`/api/odds/stream`),
    oddsValidation: (params) => getJson(`/api/odds/validation?${new URLSearchParams(params)}`),
    // ---- scores ----
    scoresSnapshot: (fixtureId) => getJson(`/api/scores/snapshot/${fixtureId}?asOf=${Date.now()}`),
    scoresUpdatesFixture: (fixtureId) => getJson(`/api/scores/updates/${fixtureId}`),
    scoresUpdatesWindow: (epochDay, hourOfDay, interval) => getJson(`/api/scores/updates/${epochDay}/${hourOfDay}/${interval}`),
    scoresHistorical: (fixtureId) => getJson(`/api/scores/historical/${fixtureId}`),
    scoresStream: () => stream(`/api/scores/stream`),
    statValidation: ({ fixtureId, seq, statKey, statKey2 }) => getJson(`/api/scores/stat-validation?fixtureId=${fixtureId}&seq=${seq}&statKey=${statKey}${statKey2 ? `&statKey2=${statKey2}` : ""}`),
  };
}

// Convenience: the full-match demargined home-win probability from the 1X2 consensus, the
// fair opening line for a "home wins" market. Returns { home, draw, away } as fractions.
export function impliedResult(oddsRows) {
  const m = oddsRows.find((x) => x.SuperOddsType === "1X2_PARTICIPANT_RESULT" && !x.MarketPeriod && x.Pct?.[0] !== "NA");
  if (!m) return null;
  const [home, draw, away] = m.Pct.map((x) => Number(x) / 100);
  return Number.isFinite(home) ? { home, draw, away } : null;
}
