// fischio's read layer, as a serverless function.
//
// The same Express app that runs on a box behind `node services/api/server.mjs` is mounted here, so
// there is one implementation of /markets, /books and /settlements rather than a hosted copy that
// drifts from the local one. The service exports the app instead of listening when it is imported,
// which is the only change that made it portable.
//
// WHY THIS LIVES AT THE REPO ROOT AND NOT UNDER app/
//
// Vercel only uploads the project's root directory. With the root set to app/, a function under
// app/api/ cannot import ../../services or ../../lib, because neither is in the deployment. Moving
// the root up one level and pointing the build at app/ costs nothing and lets the function reuse the
// real service code.
//
// WHY NO res.status().json()
//
// Vercel's Node runtime decorates req and res with Express-style helpers. Depending on them would
// make this file runnable only on Vercel, and therefore testable only by deploying, which is how a
// broken handler reaches production. Everything below uses plain node:http, so the same handler runs
// under a bare server in the test suite.
//
// WHAT DEGRADES HERE, STATED PLAINLY
//
// /trending diffs the current snapshot against one recorded roughly an hour ago, held in a ring
// buffer in memory. A function instance has no hour of history, so movers stay empty until an
// instance has been warm that long. The /ws socket is not served at all, which removes an endpoint
// with no callers: nothing in app/src opens a WebSocket.
import { app, ensureCache } from "../services/api/server.mjs";
import { upstreamPathOf } from "../lib/gateway.mjs";

// Measured cold path on Linux: 2.0s to import, 8.1s for the first chain snapshot, so 10.1s total.
// Vercel's default function timeout is 10s, which this would cross on every cold start, so
// vercel.json raises maxDuration. Warm instances answer from memory in about a millisecond.
const MAX_CACHE_AGE_MS = Number(process.env.API_CACHE_MS ?? 30_000);

const sendJson = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body, null, 2));
};

export default async function handler(req, res) {
  // The Express app sits at the root of its own port, where its routes are /markets rather than
  // /api/markets. Strip the mount prefix with the same function the box gateway uses rather than a
  // second copy of the rule: it already handles the bare prefix, query strings, and the case where
  // /apitheft must not be treated as a request under /api.
  const mounted = upstreamPathOf("/api", req.url);
  if (mounted == null) {
    sendJson(res, 404, { error: "not found", path: req.url });
    return;
  }
  req.url = mounted;

  try {
    await ensureCache(MAX_CACHE_AGE_MS);
  } catch (e) {
    // A failed chain read is a different condition from a missing route, and saying which is the
    // difference between a caller retrying and a caller filing a bug against the wrong component.
    sendJson(res, 503, {
      error: "chain snapshot unavailable",
      detail: String(e?.message ?? e),
      rpc: process.env.RPC ? "configured" : "missing RPC environment variable",
    });
    return;
  }

  // Let the edge hold one snapshot and keep serving the previous one while the next is read.
  // Without this, every visitor triggers their own chain read.
  res.setHeader("cache-control", `public, s-maxage=${Math.floor(MAX_CACHE_AGE_MS / 1000)}, stale-while-revalidate=120`);

  return app(req, res);
}
