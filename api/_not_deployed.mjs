// A truthful answer for a prefix this deployment does not serve.
//
// The Vercel deployment runs the read layer over chain state. The indexer, relayer and sponsor are
// not ported to functions: the relayer and sponsor hold signing keys and are a write path, and
// putting either behind a public URL with its key in an environment variable is a decision to make
// deliberately rather than as a side effect of fixing a dead board.
//
// The reason this exists rather than nothing: with no function on these paths, the SPA rewrite
// catches them and returns index.html with a 200. Every caller then parses a page of HTML as JSON
// and reports a syntax error, which points at the wrong component entirely. lib/gateway.mjs answers
// the same condition with the same status on a box, so both deployments agree about what a missing
// service looks like.
//
// Plain node:http rather than Vercel's res.status().json() sugar, so this runs under a bare server
// in the test suite instead of only after a deploy.
const DETAIL = {
  indexer: "Leaderboard, trade history and pnl are served by the indexer, which runs alongside the agents rather than on this deployment. The same data is derivable from chain state through /api.",
  relayer: "The relayer signs and submits transactions on a user's behalf. It holds a key, so it runs where that key is held, not on a public function.",
  sponsor: "The sponsor funds new accounts. It holds a key, so it runs where that key is held, not on a public function.",
  ingest: "The live TxLINE feed layer runs alongside the agents. Market and book state on this deployment is read from Solana and does not depend on it.",
};

/** The service name from `?service=`, without needing the runtime to have parsed a query object. */
export function serviceOf(url) {
  const q = String(url ?? "").indexOf("?");
  if (q < 0) return "unknown";
  const value = new URLSearchParams(String(url).slice(q + 1)).get("service");
  return value && value.trim() ? value.trim() : "unknown";
}

export default function handler(req, res) {
  const service = serviceOf(req.url);
  res.writeHead(501, { "content-type": "application/json" });
  res.end(JSON.stringify({
    error: "service not deployed",
    service,
    detail: DETAIL[service] ?? "This service is not part of the Vercel deployment. This is a configuration choice, not an outage, and retrying will not help.",
    served_here: ["/api/health", "/api/markets", "/api/markets/:address", "/api/books", "/api/books/:address", "/api/settlements"],
  }, null, 2));
}
