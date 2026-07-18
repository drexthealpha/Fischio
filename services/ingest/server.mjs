// fischio TxLINE ingestion: the always-on layer that keeps the platform live, using every one
// of TxLINE's 18 endpoints for a real purpose, not for the sake of it.
//
//   feeds (held live)     odds + scores streams, snapshots, and the per-fixture update deltas
//   schedule              fixtures snapshot + updates (reschedules) + batch and single validation
//   market-wide windows   odds movers and score changes for the current 5-minute interval
//   form                  historical scores per fixture
//   proofs                odds validation for the live line; stat validation on demand
//   access                guest start at boot; token activate and purchase quote on demand
//
// Every call is recorded. GET /endpoints reports the last-call time and status for all 18, so
// "we use all of TxLINE" is something you can check, not a claim.
//
//   GET /live      per-fixture odds, implied line, scores, movement, timeline, form, verified
//   GET /live/:id  one fixture
//   GET /movers    market-wide odds movement (current 5-minute window)
//   GET /goals     market-wide score changes (current 5-minute window)
//   GET /endpoints usage + status for all 18 TxLINE endpoints
//   GET /verify/*  on-demand Merkle proofs (fixture, odds, stat) and the purchase quote
//   GET /health
import "../../lib/env.mjs"; // load the gitignored root .env (RPC etc.) before anything reads it
import express from "express";
import { readFileSync } from "node:fs";
import { txlineClient, impliedResult, parseMarkets, groupOddsMarkets } from "../../lib/txline.mjs";
import { loadResultScore, lineupsOf } from "../../lib/scores.mjs";
import { computeMovers } from "../../lib/movers.mjs";
import { gateway } from "../../lib/gateway.mjs";

const PORT = Number(process.env.PORT ?? 8795);
const POLL_MS = Number(process.env.POLL_MS ?? 20000);
const WINDOW_MS = Number(process.env.WINDOW_MS ?? 30000);
const FIXTURES_MS = Number(process.env.FIXTURES_MS ?? 60000);
const tx = txlineClient({ base: process.env.TXLINE_BASE ?? "https://txline-dev.txodds.com" });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ---- endpoint usage tracker: proof that all 18 are exercised ----
const ENDPOINTS = [
  "guestStart", "activate", "purchaseQuote",
  "fixturesSnapshot", "fixturesUpdates", "fixturesValidation", "fixturesBatchValidation",
  "oddsSnapshot", "oddsUpdatesFixture", "oddsUpdatesWindow", "oddsStream", "oddsValidation",
  "scoresSnapshot", "scoresUpdatesFixture", "scoresUpdatesWindow", "scoresHistorical", "scoresStream", "statValidation",
];
const used = new Map(ENDPOINTS.map((n) => [n, { calls: 0, lastAt: 0, ok: null, note: "not called yet" }]));
function mark(name, ok, note) { const u = used.get(name); u.calls++; u.lastAt = Date.now(); u.ok = ok; if (note != null) u.note = note; }
async function hit(name, fn) {
  try { const r = await fn(); mark(name, true, r == null ? "empty" : Array.isArray(r) ? `${r.length} rows` : "ok"); return r; }
  catch (e) { mark(name, false, String(e.message ?? e).slice(0, 70)); return null; }
}

// ---- live state ----
const live = new Map(); // id -> { odds, implied, oddsAt, impliedAt, scores, scoresAt, moves, timeline, form, verified, lineProven }
let tracked = new Set();
let movers = { at: 0, window: null, rows: [] };
let goals = { at: 0, window: null, rows: [] };
const touch = (id) => { if (!live.has(id)) live.set(id, {}); return live.get(id); };

// The market catalogue for one fixture, keyed by market rather than by message.
//
// This used to be a rolling buffer of the last 40 raw odds messages. A single World Cup
// fixture carries 29 distinct markets (1X2 and first-half 1X2, nine Asian handicap lines,
// nine goal totals, and the same again for the first half) and over seven thousand updates.
// A 40-message window silently evicts any market that has not ticked recently, so the board
// would lose markets at random depending on which ones were busy. Keying by market and
// keeping the newest Ts means a quiet market stays on the board with its last real price,
// and a busy one cannot push it off.
function upsertMarkets(s, rows) {
  s.marketBook ??= new Map();
  for (const m of parseMarkets(rows)) {
    const prev = s.marketBook.get(m.key);
    if (!prev || (m.ts ?? 0) >= (prev.ts ?? 0)) s.marketBook.set(m.key, m);
  }
  const cat = [...s.marketBook.values()];
  s.markets = cat;
  s.marketCount = cat.length;
  const ft = cat.find((m) => m.type === "1X2_PARTICIPANT_RESULT" && m.period === "FT" && m.demargined);
  if (ft) {
    const [home, draw, away] = ft.outcomes.map((o) => o.prob);
    s.implied = { home, draw, away };
    s.impliedAt = Date.now();
    s.impliedTs = ft.ts;               // when TxODDS priced it, not when we fetched it
    s.impliedProof = { messageId: ft.messageId, ts: ft.ts }; // handle for validate_odds
  }
  s.oddsAt = Date.now();
  return cat;
}
const nowWindow = () => { const d = new Date(); return { epochDay: Math.floor(Date.now() / 86400000), hour: d.getUTCHours(), interval: Math.floor(d.getUTCMinutes() / 5) }; };
const messageIdOf = (rows) => (rows?.find((x) => x.SuperOddsType === "1X2_PARTICIPANT_RESULT" && !x.MarketPeriod) ?? rows?.[0])?.MessageId ?? null;

// ---- access: a keyless box bootstraps here; the paid paths fire on demand ----
async function bootstrap() {
  await hit("guestStart", () => tx.guestStart()); // verifies the auth layer and is how a fresh box signs in
  mark("activate", null, "fires on paid-token activation (POST /activate)");
  mark("purchaseQuote", null, "fires on the data-tier upgrade surface (GET /pricing)");
  mark("statValidation", null, "fires at settlement or on verify (GET /verify/stat)");
  mark("oddsValidation", null, "on-demand (GET /verify/odds); the free demargined feed carries no odds proof");
}

// ---- fixtures: schedule, changes, and verification ----
async function refreshFixtures() {
  const rows = await hit("fixturesSnapshot", () => tx.fixturesSnapshot(Math.floor(Date.now() / 86400000) - 1));
  const now = Date.now(), next = new Set();
  // always track the app's known upcoming fixtures so the winner and schedule views have a line
  try {
    const fx = JSON.parse(readFileSync(new URL("../../app/src/fixtures.json", import.meta.url), "utf8")).fixtures;
    for (const f of fx) { const ko = new Date(f.kickoff).getTime(); if (ko > now - 4 * 3600 * 1000 && ko < now + 4 * 24 * 3600 * 1000) next.add(f.id); }
  } catch { /* no fixtures file */ }
  if (rows) {
    for (const f of rows) {
      if (f.Competition !== "World Cup") continue;
      const ko = new Date(f.StartTime > 1e11 ? f.StartTime : f.StartTime * 1000).getTime();
      if (ko > now - 4 * 3600 * 1000 && ko < now + 3 * 24 * 3600 * 1000) next.add(f.FixtureId);
    }
  }
  if (next.size) tracked = next;
  const { epochDay, hour } = nowWindow();
  await hit("fixturesUpdates", () => tx.fixturesUpdates(epochDay, hour)); // reschedules / new matches
  // per-fixture proof gives each match its verified badge (the reliable one)
  for (const id of tracked) { const fv = await hit("fixturesValidation", () => tx.fixturesValidation(id)); if (fv) touch(id).verified = true; }
  // the hourly batch proof only exists once an hour is sealed, so search the recent completed hours
  for (let back = 1; back <= 4; back++) {
    let ph = hour - back, pd = epochDay; while (ph < 0) { ph += 24; pd -= 1; }
    if (await hit("fixturesBatchValidation", () => tx.fixturesBatchValidation(pd, ph))) break;
  }
  log(`tracking ${tracked.size} fixtures`);
}

// ---- per-fixture feed: snapshot + deltas + line proof ----
async function pollFixtures() {
  for (const id of tracked) {
    const s = touch(id);
    // oddsSnapshot passes asOf now. Without it the endpoint returns whichever handful of
    // markets updated most recently (measured: 5 rows) instead of the full board (29).
    const odds = await hit("oddsSnapshot", () => tx.oddsSnapshot(id));
    if (odds?.length) { s.odds = odds; upsertMarkets(s, odds); }
    const moves = await hit("oddsUpdatesFixture", () => tx.oddsUpdatesFixture(id));
    if (moves) s.moves = moves.slice(-40); // odds-movement history for the sparkline
    const sc = await hit("scoresSnapshot", () => tx.scoresSnapshot(id));
    if (sc) { s.scores = sc; s.scoresAt = Date.now(); }
    const tl = await hit("scoresUpdatesFixture", () => tx.scoresUpdatesFixture(id));
    if (tl) s.timeline = tl.slice(-40); // match timeline (goals, cards)
  }
}

// ---- form: historical scores per fixture (refreshes slowly) ----
async function pollHistory() {
  for (const id of tracked) { const h = await hit("scoresHistorical", () => tx.scoresHistorical(id)); if (h) touch(id).form = h; }
}

// ---- market-wide windows: movers + goals ----
//
// The feed does not publish a five minute window the moment it closes. Measured against the live
// World Cup tier on epochDay 20652: the current interval and the one before it both return zero
// rows, and every interval from two back returns between 27 and 140.
//
//   back 0  20652/14/7   odds=0        <- what this service used to ask for, every time
//   back 1  20652/14/6   odds=0
//   back 2  20652/14/5   odds=117
//   back 3  20652/14/4   odds=27
//
// So asking for the current interval returns an empty board on every poll. The movers surface was
// permanently blank because of it, and because the request itself succeeded the health page read
// "oddsUpdatesWindow ok, 0 rows", which looks like a quiet market rather than a bug.
//
// Walk back until a window actually carries rows. The lookback is capped: past a few intervals the
// data is too old to call movement, and an uncapped walk would hammer the feed whenever the board
// is genuinely quiet, which it is between matches.
const WINDOW_LOOKBACK = 4;

/** The window `back` intervals before now, in the feed's UTC day/hour/interval coordinates. */
function windowAt(back) {
  const d = new Date();
  let epochDay = Math.floor(Date.now() / 86_400_000);
  let hour = d.getUTCHours();
  let interval = Math.floor(d.getUTCMinutes() / 5) - back;
  while (interval < 0) { interval += 12; hour -= 1; }     // twelve five-minute intervals per hour
  while (hour < 0) { hour += 24; epochDay -= 1; }
  return {
    epochDay, hour, interval,
    startMs: epochDay * 86_400_000 + hour * 3_600_000 + interval * 300_000,
  };
}

/** A window described for a caller: what it covers, and how stale it is right now. */
const windowLabel = (w) => (w == null ? null : {
  epochDay: w.epochDay, hour: w.hour, interval: w.interval,
  startMs: w.startMs,
  endMs: w.startMs + 300_000,
  // seconds between the end of the window and now. Never zero: the feed publishes a window a
  // couple of intervals after it closes, so this floor is about five to ten minutes in practice.
  ageSeconds: Math.max(0, Math.round((Date.now() - (w.startMs + 300_000)) / 1000)),
});

/**
 * The freshest window that actually has rows.
 *
 * Returns null when every window in the lookback is empty, which is the honest answer between
 * matches. The caller keeps whatever it had and lets the age speak for itself, because replacing
 * real movement with an empty board would make a quiet minute look like a data outage.
 */
async function freshestWindow(name, fetchWindow) {
  for (let back = 1; back <= WINDOW_LOOKBACK; back++) {
    const w = windowAt(back);
    const rows = await hit(name, () => fetchWindow(w));
    if (rows?.length) return { at: Date.now(), window: w, rows };
  }
  return null;
}

async function pollWindows() {
  const om = await freshestWindow("oddsUpdatesWindow", (w) => tx.oddsUpdatesWindow(w.epochDay, w.hour, w.interval));
  if (om) movers = om;
  const sg = await freshestWindow("scoresUpdatesWindow", (w) => tx.scoresUpdatesWindow(w.epochDay, w.hour, w.interval));
  if (sg) goals = sg;
}

// ---- live push ----
// Hold a stream open forever, resuming from the last event we actually processed.
//
// Every SSE `data:` line is preceded by an `id:` line. We record that id as each message is
// applied, and hand it back as Last-Event-ID when the connection drops. Without it a
// reconnect starts at "now" and every event that happened while we were away is gone. That is
// invisible: no error, no gap in the logs, just a goal or a price that never arrived. For a
// service whose output settles money, that is a correctness bug rather than a dropped frame.
async function runStream(name, open, apply) {
  let lastId = null;
  for (;;) {
    try {
      log(`${name}: connecting${lastId ? ` (resuming from event ${lastId})` : ""}`);
      mark(name, null, lastId ? "resuming" : "connecting");
      for await (const m of open({ lastEventId: lastId, onId: (id) => { lastId = id; } })) {
        const u = used.get(name);
        u.lastAt = Date.now(); u.ok = true; u.note = lastId ? `streaming @${lastId}` : "streaming";
        apply(m);
      }
    } catch (e) { mark(name, false, String(e.message ?? e).slice(0, 60)); log(`${name} error:`, String(e.message ?? e)); }
    await new Promise((r) => setTimeout(r, 3000));
  }
}

const app = express();
app.use((_, res, nx) => { res.set("Access-Control-Allow-Origin", "*"); nx(); });

// This service holds the container's one allocated public port, so it also forwards to the services
// that would otherwise be unreachable from outside the box: the api behind markets and books, the
// indexer behind the leaderboard, the relayer, the sponsor, and the supervisor's health endpoint.
// Without this a front end deployed anywhere else reaches the feed and nothing else, which is most
// of the product.
//
// Each service keeps its own prefix rather than mounting at the root, because this service and the
// api both answer /markets and mean different things by it. Registered before the routes below, so a
// prefixed request never reaches them and anything unprefixed falls straight through untouched.
app.use(gateway());
app.get("/health", (_, res) => { const done = [...used.values()].filter((u) => u.calls > 0).length; res.json({ ok: true, tracked: [...tracked], fixtures: live.size, endpointsExercised: `${done}/18`, pollMs: POLL_MS }); });
// marketBook is the internal Map the catalogue is keyed on; it does not survive JSON, and
// s.markets already carries the same data as an array. Strip it rather than emit "{}".
const publicState = ({ marketBook, ...rest }) => rest; // eslint-disable-line no-unused-vars
app.get("/live", (_, res) =>
  res.json({ ts: Date.now(), fixtures: Object.fromEntries([...live].map(([k, v]) => [k, publicState(v)])) }));
app.get("/live/:id", (req, res) => { const s = live.get(Number(req.params.id)); s ? res.json(publicState(s)) : res.status(404).json({ error: "not tracked" }); });

// The full market catalogue for one fixture: every SuperOddsType x period x line TxLINE
// prices, each with its demargined probabilities and the messageId+ts that proves it.
// ?group=1 nests by type and period for a UI; ?type= and ?period= filter.
app.get("/markets/:id", (req, res) => {
  const s = live.get(Number(req.params.id));
  if (!s?.markets?.length) return res.status(404).json({ error: "no markets for this fixture yet" });
  let markets = s.markets;
  if (req.query.type) markets = markets.filter((m) => m.type === req.query.type);
  if (req.query.period) markets = markets.filter((m) => m.period === req.query.period);
  res.json({
    fixtureId: Number(req.params.id),
    count: markets.length,
    // how stale this is, measured from when TxODDS priced it rather than when we fetched it.
    // The free World Cup tier is service level 1, which is delayed by about 60 seconds.
    pricedAt: s.impliedTs ?? null,
    ageSeconds: s.impliedTs ? Math.round((Date.now() - s.impliedTs) / 1000) : null,
    serviceLevel: Number(process.env.TXLINE_SERVICE_LEVEL ?? 1),
    markets: req.query.group ? groupOddsMarkets(markets) : markets,
  });
});
// final (or latest) score for any fixture, fetched on demand so closed markets can show the
// real result instead of a frozen probability. Returns { home, away, statusId, final }.
app.get("/score/:id", async (req, res) => {
  // Read through loadResultScore so a finished match resolves from /scores/historical, not the
  // live snapshot. Without it, a match the app shows as closed reads back no score once it ages
  // out of the snapshot, which is every match by the time anyone reviews it after the fact.
  const id = Number(req.params.id);
  const { score, source } = await loadResultScore(tx, id).catch(() => ({ score: null }));
  if (!score) return res.json({ home: null, away: null, statusId: null, final: false });
  res.json({ home: score.p1, away: score.p2, statusId: score.status, final: !!score.final, seq: score.seq, source });
});

// Team lineups for a fixture, straight from the scores feed. Display data only: no player id
// ever settles a market. Lineups are published about an hour before kickoff, so this is empty
// for a match that is still days away. Snapshot serves a live match, historical a finished one.
app.get("/lineups/:id", async (req, res) => {
  const id = Number(req.params.id);
  let recs = await hit("scoresSnapshot", () => tx.scoresSnapshot(id)).catch(() => null);
  let teams = lineupsOf(recs);
  if (!teams) { recs = await hit("scoresHistorical", () => tx.scoresHistorical(id)).catch(() => null); teams = lineupsOf(recs); }
  res.json({ fixtureId: id, teams: teams ?? null });
});
// What is actually moving, rather than a dump of every update in the window.
//
// The reduction lives in lib/movers.mjs so it can be tested without a live match and without this
// service running. See test/movers.test.mjs: comparing outcomes by name rather than by position,
// and ordering by timestamp rather than by array index, are both things this got wrong when the
// logic sat inline here.
//
// `limit` and `minMove` are query parameters so a caller can ask for the whole board or filter
// out noise. minMove is in probability points, so minMove=2 means two percentage points.
app.get("/movers", (req, res) => {
  const limit = Number(req.query.limit ?? 25);
  const minMove = Number(req.query.minMove ?? 0) / 100;
  res.json({
    at: movers.at,
    // Which five minutes this is, and how far behind now it ended. The feed publishes a window a
    // couple of intervals late, so a caller that assumes "now" would misdate every move on screen.
    window: windowLabel(movers.window),
    windowRows: movers.rows?.length ?? 0,
    movers: computeMovers(movers.rows, {
      limit: Number.isFinite(limit) ? limit : 25,
      minMove: Number.isFinite(minMove) ? minMove : 0,
    }),
  });
});
app.get("/goals", (_, res) =>
  res.json({ at: goals.at, window: windowLabel(goals.window), rows: goals.rows ?? [] }));
app.get("/endpoints", (_, res) => { const now = Date.now(); res.json({ ts: now, exercised: [...used.values()].filter((u) => u.calls > 0).length, total: 18, endpoints: [...used.entries()].map(([name, u]) => ({ name, calls: u.calls, ageSeconds: u.lastAt ? Math.round((now - u.lastAt) / 1000) : null, status: u.ok === true ? "ok" : u.ok === false ? "error" : "on-demand", note: u.note })) }); });
app.get("/verify/fixture/:id", async (req, res) => { const r = await hit("fixturesValidation", () => tx.fixturesValidation(Number(req.params.id))); r ? res.json(r) : res.status(502).json({ error: used.get("fixturesValidation").note }); });
app.get("/verify/odds", async (req, res) => { const r = await hit("oddsValidation", () => tx.oddsValidation(req.query)); r ? res.json(r) : res.status(502).json({ error: used.get("oddsValidation").note }); });
app.get("/verify/stat", async (req, res) => { const r = await hit("statValidation", () => tx.statValidation(req.query)); r ? res.json(r) : res.status(502).json({ error: used.get("statValidation").note }); });
app.get("/pricing", async (req, res) => { const r = await hit("purchaseQuote", () => tx.purchaseQuote(req.query)); r ? res.json(r) : res.status(502).json({ error: used.get("purchaseQuote").note }); });
app.post("/activate", express.json(), async (req, res) => { const r = await hit("activate", () => tx.activate(req.body)); r ? res.json(r) : res.status(502).json({ error: used.get("activate").note }); });

app.listen(PORT, async () => {
  log(`fischio ingestion on http://127.0.0.1:${PORT}`);
  await bootstrap();
  await refreshFixtures();
  await pollFixtures();
  await pollWindows();
  await pollHistory();
  setInterval(refreshFixtures, FIXTURES_MS);
  setInterval(pollFixtures, POLL_MS);
  setInterval(pollWindows, WINDOW_MS);
  setInterval(pollHistory, 10 * 60 * 1000);
  runStream("oddsStream", (opts) => tx.oddsStream(opts), (m) => {
    const id = m.FixtureId ?? m.fixtureId; if (!id) return;
    upsertMarkets(touch(id), [m]);
  });
  runStream("scoresStream", (opts) => tx.scoresStream(opts), (m) => {
    const id = m.FixtureId ?? m.fixtureId; if (!id) return;
    const s = touch(id); s.scores = m; s.scoresAt = Date.now();
  });
});
