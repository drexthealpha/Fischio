// Vercel serverless proxy for live World Cup fixtures. The TxLINE credentials live
// in Vercel env vars (TXLINE_JWT, TXLINE_API_TOKEN); the browser never sees them.
// The client falls back to its bundled snapshot when this returns non-200.
export default async function handler(req, res) {
  const { TXLINE_JWT, TXLINE_API_TOKEN } = process.env;
  if (!TXLINE_JWT || !TXLINE_API_TOKEN) {
    res.status(503).json({ error: "fixtures proxy not configured" });
    return;
  }
  const headers = { Authorization: `Bearer ${TXLINE_JWT}`, "X-Api-Token": TXLINE_API_TOKEN };
  const today = Math.floor(Date.now() / 86400000);
  const map = new Map();
  for (const day of [today - 2, today]) {
    const r = await fetch(
      `https://txline-dev.txodds.com/api/fixtures/snapshot?startEpochDay=${day}`,
      { headers }
    ).catch(() => null);
    if (!r?.ok) continue;
    for (const f of await r.json()) {
      if (f.Competition !== "World Cup") continue;
      map.set(f.FixtureId, {
        id: f.FixtureId,
        home: f.Participant1,
        away: f.Participant2,
        kickoff: new Date(f.StartTime > 1e11 ? f.StartTime : f.StartTime * 1000).toISOString(),
      });
    }
  }
  if (map.size === 0) {
    res.status(502).json({ error: "upstream returned no fixtures" });
    return;
  }
  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");
  res.status(200).json({
    generatedAt: new Date().toISOString(),
    fixtures: [...map.values()].sort((a, b) => a.kickoff.localeCompare(b.kickoff)),
  });
}
