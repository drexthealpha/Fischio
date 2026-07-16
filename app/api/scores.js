// Live score proxy: compact in-play state for the fixtures shown on market tickets.
// Same credential model as fixtures.js; 30s edge cache keeps polling cheap.
export default async function handler(req, res) {
  const { TXLINE_JWT, TXLINE_API_TOKEN } = process.env;
  if (!TXLINE_JWT || !TXLINE_API_TOKEN) {
    res.status(503).json({ error: "scores proxy not configured" });
    return;
  }
  const ids = String(req.query.ids ?? "").split(",").map(Number).filter(Boolean).slice(0, 12);
  if (ids.length === 0) {
    res.status(400).json({ error: "ids required" });
    return;
  }
  const headers = { Authorization: `Bearer ${TXLINE_JWT}`, "X-Api-Token": TXLINE_API_TOKEN };
  const out = {};
  await Promise.all(ids.map(async (id) => {
    const r = await fetch(
      `https://txline-dev.txodds.com/api/scores/snapshot/${id}?asOf=${Date.now()}`,
      { headers }
    ).catch(() => null);
    if (!r?.ok) return;
    const recs = await r.json();
    if (!Array.isArray(recs) || recs.length === 0) return;
    // Snapshot records arrive out of Seq order, so pick by highest Seq rather than array
    // position. The terminal cumulative Stats gives the full box score; TxLINE stat keys are
    // 1/2 goals, 3/4 yellow cards, 5/6 red cards, 7/8 corners (home/away).
    const maxBy = (pred) => {
      const xs = recs.filter(pred);
      return xs.length ? xs.reduce((a, b) => (b.Seq > a.Seq ? b : a)) : null;
    };
    // Require the goal totals to be present, not just any Stats, so a partial record can
    // never be read as 0-0. Score snapshots are cumulative, so the highest-Seq record with
    // goals carries the full box score (corners/cards) too.
    const latestStats = maxBy((x) => x.Stats && x.Stats["1"] != null);
    const lastStatus = maxBy((x) => x.StatusId != null);
    const lastClock = maxBy((x) => x.Clock?.Seconds != null);
    const st = latestStats?.Stats ?? {};
    const pair = (h, a) => [Number(st[h] ?? 0), Number(st[a] ?? 0)];
    out[id] = {
      statusId: lastStatus?.StatusId ?? null,
      goals: latestStats ? pair("1", "2") : null,
      corners: latestStats ? pair("7", "8") : null,
      yellow: latestStats ? pair("3", "4") : null,
      red: latestStats ? pair("5", "6") : null,
      clockSeconds: lastClock?.Clock?.Seconds ?? null,
      seq: latestStats?.Seq ?? recs[recs.length - 1].Seq,
    };
  }));
  res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=60");
  res.status(200).json({ at: new Date().toISOString(), scores: out });
}
