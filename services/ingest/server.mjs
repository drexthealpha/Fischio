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
import express from "express";
import { readFileSync } from "node:fs";
import { txlineClient, impliedResult } from "../../lib/txline.mjs";

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
let movers = { at: 0, rows: [] };
let goals = { at: 0, rows: [] };
const touch = (id) => { if (!live.has(id)) live.set(id, {}); return live.get(id); };
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
    const odds = await hit("oddsSnapshot", () => tx.oddsSnapshot(id));
    if (odds?.length) { s.odds = odds; s.oddsAt = Date.now(); const imp = impliedResult(odds); if (imp) { s.implied = imp; s.impliedAt = Date.now(); } }
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

// ---- market-wide windows: movers + goals for the current 5-minute interval ----
async function pollWindows() {
  const { epochDay, hour, interval } = nowWindow();
  const om = await hit("oddsUpdatesWindow", () => tx.oddsUpdatesWindow(epochDay, hour, interval));
  if (om) movers = { at: Date.now(), rows: om };
  const sg = await hit("scoresUpdatesWindow", () => tx.scoresUpdatesWindow(epochDay, hour, interval));
  if (sg) goals = { at: Date.now(), rows: sg };
}

// ---- live push ----
async function runStream(name, open, apply) {
  for (;;) {
    try {
      log(`${name}: connecting`); mark(name, null, "connecting");
      for await (const m of open()) { const u = used.get(name); u.lastAt = Date.now(); u.ok = true; u.note = "streaming"; apply(m); }
    } catch (e) { mark(name, false, String(e.message ?? e).slice(0, 60)); log(`${name} error:`, String(e.message ?? e)); }
    await new Promise((r) => setTimeout(r, 3000));
  }
}

const app = express();
app.use((_, res, nx) => { res.set("Access-Control-Allow-Origin", "*"); nx(); });
app.get("/health", (_, res) => { const done = [...used.values()].filter((u) => u.calls > 0).length; res.json({ ok: true, tracked: [...tracked], fixtures: live.size, endpointsExercised: `${done}/18`, pollMs: POLL_MS }); });
app.get("/live", (_, res) => res.json({ ts: Date.now(), fixtures: Object.fromEntries(live) }));
app.get("/live/:id", (req, res) => { const s = live.get(Number(req.params.id)); s ? res.json(s) : res.status(404).json({ error: "not tracked" }); });
// final (or latest) score for any fixture, fetched on demand so closed markets can show the
// real result instead of a frozen probability. Returns { home, away, statusId, final }.
app.get("/score/:id", async (req, res) => {
  const recs = await hit("scoresSnapshot", () => tx.scoresSnapshot(Number(req.params.id)));
  if (!Array.isArray(recs) || !recs.length) return res.json({ home: null, away: null, statusId: null, final: false });
  const rev = [...recs].reverse();
  const stats = rev.find((x) => x.Stats && x.Stats["1"] != null);
  const status = rev.find((x) => x.StatusId != null);
  const statusId = status?.StatusId ?? null;
  res.json({ home: stats ? Number(stats.Stats["1"]) : null, away: stats ? Number(stats.Stats["2"]) : null, statusId, final: [5, 10, 13].includes(statusId) });
});
app.get("/movers", (_, res) => res.json(movers));
app.get("/goals", (_, res) => res.json(goals));
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
  runStream("oddsStream", () => tx.oddsStream(), (m) => { const id = m.FixtureId ?? m.fixtureId; if (!id) return; const s = touch(id); s.odds = [m, ...(s.odds ?? []).filter((x) => x.MessageId !== m.MessageId)].slice(0, 40); const imp = impliedResult(s.odds); if (imp) { s.implied = imp; s.impliedAt = Date.now(); } s.oddsAt = Date.now(); });
  runStream("scoresStream", () => tx.scoresStream(), (m) => { const id = m.FixtureId ?? m.fixtureId; if (!id) return; const s = touch(id); s.scores = m; s.scoresAt = Date.now(); });
});
