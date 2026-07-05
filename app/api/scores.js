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
    const lastStatus = [...recs].reverse().find((x) => x.StatusId != null);
    const lastStats = [...recs].reverse().find((x) => x.Stats && x.Stats["1"] != null);
    const lastClock = [...recs].reverse().find((x) => x.Clock?.Seconds != null);
    out[id] = {
      statusId: lastStatus?.StatusId ?? null,
      goals: lastStats ? [lastStats.Stats["1"] ?? 0, lastStats.Stats["2"] ?? 0] : null,
      clockSeconds: lastClock?.Clock?.Seconds ?? null,
      seq: recs[recs.length - 1].Seq,
    };
  }));
  res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=60");
  res.status(200).json({ at: new Date().toISOString(), scores: out });
}
