// One client for the whole TxLINE surface: all 18 endpoints in its OpenAPI spec, each wrapped
// as a named function so the rest of fischio has a single, typed place to reach the data layer.
// Credentials (guest JWT + API token) come from local/credentials.json or the TXLINE_JWT /
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
  try { const c = JSON.parse(readFileSync("local/credentials.json", "utf8")); return { jwt: c.jwt, apiToken: c.apiToken }; }
  catch { return { jwt: null, apiToken: null }; }
}

export function txlineClient({ base = DEV, creds = loadCreds() } = {}) {
  const authHeaders = () => ({ Authorization: `Bearer ${creds.jwt}`, "X-Api-Token": creds.apiToken });

  // Read a JSON endpoint, tolerating the two shapes TxLINE also replies with: an empty body
  // (for example historical scores that do not exist yet), and an SSE body (some update feeds
  // switch to `data:` lines when a match has live data). Empty returns null; SSE returns the array.
  // A connection that times out, or a moment of rate limiting, is not the same thing as a bad
  // request. Treating them the same makes anything that walks the whole board fragile: a bot
  // proving twenty-nine markets in a row fails entirely because one call out of thirty could not
  // open a socket. Transient failures get a couple of short backoffs. A 4xx is the feed saying we
  // asked wrongly, so that is raised at once instead of hammered.
  const TRANSIENT = /ConnectTimeout|UND_ERR|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|fetch failed/i;
  async function getJson(path, { auth = true, attempts = 3 } = {}) {
    let lastErr;
    for (let i = 0; i < attempts; i++) {
      try {
        const r = await fetch(`${base}${path}`, { headers: auth ? authHeaders() : {} });
        if (r.status === 429 || r.status >= 500) {
          lastErr = new Error(`${path} -> ${r.status}`);
          if (i < attempts - 1) { await new Promise((s) => setTimeout(s, 400 * 2 ** i)); continue; }
          throw lastErr;
        }
        if (!r.ok) { const b = await r.text().catch(() => ""); throw new Error(`${path} -> ${r.status} ${b.slice(0, 50)}`); }
        const text = await r.text();
        if (!text.trim()) return null;
        if (text.startsWith("data:")) return parseSse(text);
        return JSON.parse(text);
      } catch (e) {
        lastErr = e;
        const msg = `${e?.message ?? e}${e?.cause?.code ?? ""}`;
        if (!TRANSIENT.test(msg) || i === attempts - 1) throw e;
        await new Promise((s) => setTimeout(s, 400 * 2 ** i));
      }
    }
    throw lastErr;
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
  //
  // Two capabilities of these streams that fischio ignored until now:
  //
  //   fixtureId    filters the stream server-side to one match, instead of taking the whole
  //                market-wide firehose and discarding what we do not want.
  //   lastEventId  resumes from the last event we actually processed. SSE carries an `id:`
  //                line next to every `data:` line, and sending it back as the Last-Event-ID
  //                header asks the server to replay from there. Without it, a reconnect drops
  //                every event that happened while we were disconnected. For a feed that
  //                settles money, a silently missed goal or price is a correctness bug, not a
  //                dropped frame, so we track the id and hand it back on reconnect.
  //
  // onId fires for each `id:` seen so the caller can persist it and resume after a crash.
  async function* stream(path, { fixtureId, lastEventId, onId } = {}) {
    const url = new URL(`${base}${path}`);
    if (fixtureId != null) url.searchParams.set("fixtureId", String(fixtureId));
    const headers = { ...authHeaders(), Accept: "text/event-stream" };
    if (lastEventId) headers["Last-Event-ID"] = String(lastEventId);
    const r = await fetch(url, { headers });
    if (!r.ok || !r.body) throw new Error(`${url.pathname} -> ${r.status}`);
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
        if (line.startsWith("id:")) { const id = line.slice(3).trim(); if (id) onId?.(id); continue; }
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
    // competitionId filters server-side. Without it we pull every sport TxLINE carries and
    // throw away everything that is not football in JS.
    fixturesSnapshot: (startEpochDay, competitionId) => {
      const q = new URLSearchParams();
      if (startEpochDay != null) q.set("startEpochDay", startEpochDay);
      if (competitionId != null) q.set("competitionId", competitionId);
      return getJson(`/api/fixtures/snapshot${q.size ? `?${q}` : ""}`);
    },
    fixturesUpdates: (epochDay, hourOfDay) => getJson(`/api/fixtures/updates/${epochDay}/${hourOfDay}`),
    // Proves one fixture existed with these teams and this kickoff. `timestamp` picks which
    // update to prove; the spec takes it and we were never sending it.
    fixturesValidation: (fixtureId, timestamp) =>
      getJson(`/api/fixtures/validation?fixtureId=${fixtureId}${timestamp != null ? `&timestamp=${timestamp}` : ""}`),
    // Proves an entire hour of the schedule in one proof.
    fixturesBatchValidation: (epochDay, hourOfDay) => getJson(`/api/fixtures/batch-validation?epochDay=${epochDay}&hourOfDay=${hourOfDay}`),

    // ---- odds ----
    // asOf is required for a COMPLETE snapshot, not an optional extra. Measured against the
    // live feed on fixture 18257739: no asOf returns 5 rows, asOf returns 29. Without it the
    // caller silently sees a shifting sixth of the board. It doubles as point-in-time replay:
    // asOf = three hours ago returns the full catalogue exactly as it stood then.
    oddsSnapshot: (fixtureId, asOf = Date.now()) => getJson(`/api/odds/snapshot/${fixtureId}?asOf=${asOf}`),
    oddsUpdatesFixture: (fixtureId) => getJson(`/api/odds/updates/${fixtureId}`),
    oddsUpdatesWindow: (epochDay, hourOfDay, interval, fixtureId) =>
      getJson(`/api/odds/updates/${epochDay}/${hourOfDay}/${interval}${fixtureId != null ? `?fixtureId=${fixtureId}` : ""}`),
    oddsStream: (opts) => stream(`/api/odds/stream`, opts),
    // Proves one price. messageId + ts identify the exact update; both come off the odds row.
    oddsValidation: (params) => getJson(`/api/odds/validation?${new URLSearchParams(params)}`),

    // ---- scores ----
    scoresSnapshot: (fixtureId, asOf = Date.now()) => getJson(`/api/scores/snapshot/${fixtureId}?asOf=${asOf}`),
    scoresUpdatesFixture: (fixtureId) => getJson(`/api/scores/updates/${fixtureId}`),
    scoresUpdatesWindow: (epochDay, hourOfDay, interval, fixtureId) =>
      getJson(`/api/scores/updates/${epochDay}/${hourOfDay}/${interval}${fixtureId != null ? `?fixtureId=${fixtureId}` : ""}`),
    scoresHistorical: (fixtureId) => getJson(`/api/scores/historical/${fixtureId}`),
    scoresStream: (opts) => stream(`/api/scores/stream`, opts),
    // statKeys (plural) returns ScoresStatValidationV2, which shares one eventStatRoot and one
    // subTreeProof across many stats. That settles a whole board in one transaction instead of
    // two stats at a time. statKey/statKey2 stay for the V1 shape the settle bots already use.
    statValidation: ({ fixtureId, seq, statKey, statKey2, statKeys }) => {
      const q = new URLSearchParams({ fixtureId, seq });
      if (statKeys?.length) q.set("statKeys", Array.isArray(statKeys) ? statKeys.join(",") : statKeys);
      else { q.set("statKey", statKey); if (statKey2 != null) q.set("statKey2", statKey2); }
      return getJson(`/api/scores/stat-validation?${q}`);
    },
  };
}

// Reading this feed lives in lib/markets.mjs, which is the one place that knows how a TxLINE
// odds row maps to a market. It is re-exported here so every existing caller picks it up with
// no import change.
//
// The impliedResult that used to live here took `oddsRows.find(...)`, the first matching row
// in array order. Odds rows do not arrive in time order, so that returned whichever update
// happened to sit first rather than the newest one. Measured against the live feed on fixture
// 18257865: 85 full-match 1X2 rows spanning 157 minutes, and the first in the array was two
// and a half minutes stale. It agreed with the newest row on the other fixture in the same
// scan, which is why a spot check never caught it. Every on-chain price the keeper holds is
// derived from this number, so parseMarkets keys markets by type, period and line, and keeps
// the highest Ts.
export {
  impliedResult,
  impliedFirstHalf,
  parseMarkets,
  parseRow,
  groupMarkets as groupOddsMarkets,
  totalsLadder,
  handicapLadder,
  marketKey,
  periodOf,
  lineOf,
  decimalOdds,
} from "./markets.mjs";
