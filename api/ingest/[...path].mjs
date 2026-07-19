// The TxLINE feed layer, as a serverless function.
//
// Mounts the same Express app that runs on a box behind `node services/ingest/server.mjs`, so the
// live board, the movers, the goals ticker and the on-demand Merkle proofs are one implementation
// rather than a hosted copy that drifts.
//
// WHY EACH ROUTE DECLARES WHAT IT NEEDS
//
// On a box, four pollers keep every piece of state warm all the time. Doing that per request would
// mean /movers paying for a full fixture poll it never reads, on every cold start. So each route
// names the data it actually depends on and `ensureFresh` fills only that.
//
// WHAT IS DIFFERENT FROM THE BOX, STATED PLAINLY
//
// The odds and scores SSE streams are not emulated here. They exist to catch every event between
// polls, resuming from the last processed event id, and a function that lives for one request cannot
// hold one. Data served here is therefore poll-fresh, not push-fresh. The agents keep reading from
// the box for that reason.
import { app, ensureFresh } from "../../services/ingest/server.mjs";
import { upstreamPathOf } from "../../lib/gateway.mjs";

const MAX_AGE_MS = Number(process.env.INGEST_CACHE_MS ?? 30_000);

/**
 * Which cached data a path reads.
 *
 * Returns null for routes that call TxLINE on demand or report local counters, so those answer
 * without paying for a poll they will not read.
 */
export function freshnessKindOf(path) {
  const p = String(path ?? "").split("?")[0];
  if (p === "/live" || p.startsWith("/live/")) return "fixtures";
  if (p.startsWith("/markets/")) return "fixtures";
  if (p.startsWith("/score/") || p.startsWith("/lineups/")) return "fixtures";
  if (p === "/movers" || p === "/goals") return "windows";
  return null; // /health, /endpoints, /verify/*, /pricing, /activate
}

const sendJson = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body, null, 2));
};

export default async function handler(req, res) {
  const mounted = upstreamPathOf("/api/ingest", req.url);
  if (mounted == null) {
    sendJson(res, 404, { error: "not found", path: req.url });
    return;
  }
  req.url = mounted;

  const kind = freshnessKindOf(mounted);
  if (kind) {
    try {
      await ensureFresh(kind, MAX_AGE_MS);
    } catch (e) {
      // Distinguish a feed that refused from a route that does not exist. The most likely cause is
      // credentials, and saying so beats a generic failure that sends someone reading chain code.
      sendJson(res, 503, {
        error: "TxLINE feed unavailable",
        detail: String(e?.message ?? e),
        credentials: process.env.TXLINE_JWT && process.env.TXLINE_API_TOKEN
          ? "configured"
          : "missing TXLINE_JWT or TXLINE_API_TOKEN",
      });
      return;
    }
    res.setHeader("cache-control", `public, s-maxage=${Math.floor(MAX_AGE_MS / 1000)}, stale-while-revalidate=120`);
  }

  return app(req, res);
}
