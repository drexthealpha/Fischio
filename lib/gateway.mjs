// Serve every fischio service through one public port.
//
// A hosted panel allocates the container exactly one reachable port. Wispbyte and Pterodactyl both
// expose it as SERVER_PORT. fischio runs five HTTP services, so four of them would be invisible
// from outside the box: the api that serves markets and books, the indexer behind the leaderboard,
// the relayer, the sponsor, and the supervisor's health endpoint. A front end deployed anywhere
// else would reach the feed and nothing else, which is most of the product.
//
// So the ingest, which holds the allocated port, also forwards to its neighbours.
//
// WHY PREFIXES AND NOT ROOT
//
// The ingest and the api both serve `/markets`, and they mean different things: the ingest returns
// the TxLINE catalogue for a fixture, the api returns on-chain markets. Mounting the api at the
// root would shadow one with the other depending on registration order, which is the kind of bug
// that looks like stale data rather than a routing mistake. Each service keeps its own namespace.
//
// WHY NO PROXY LIBRARY
//
// Adding a dependency to move bytes between two sockets on the same host is not worth the supply
// chain. This is node:http, streamed rather than buffered, so the SSE endpoints keep working.

import http from "node:http";

/** Where each prefix forwards to. Ports match the defaults each service binds to. */
export const DEFAULT_ROUTES = {
  "/api": Number(process.env.API_PORT ?? 8790),
  "/relayer": Number(process.env.RELAYER_PORT ?? 8791),
  "/indexer": Number(process.env.INDEXER_PORT ?? 8792),
  "/sponsor": Number(process.env.SPONSOR_PORT ?? 8793),
  "/supervisor": Number(process.env.HEALTH_PORT ?? 8799),
};

/**
 * The path to request upstream, with the mount prefix removed.
 *
 * `/api/markets/abc?x=1` under prefix `/api` becomes `/markets/abc?x=1`. A request for the prefix
 * itself becomes `/`, because `/api` and `/api/` should not reach different handlers.
 *
 * Returns null when the url does not belong to this prefix. `/apitheft` must not match `/api`, so
 * the character after the prefix has to be a separator or nothing at all.
 */
export function upstreamPathOf(prefix, url) {
  if (typeof url !== "string" || !url.startsWith(prefix)) return null;
  const rest = url.slice(prefix.length);
  if (rest === "") return "/";
  if (rest[0] !== "/" && rest[0] !== "?") return null;
  return rest[0] === "?" ? `/${rest}` : rest;
}

/** The prefix that claims this url, longest first so nesting is unambiguous. */
export function matchRoute(routes, url) {
  const prefixes = Object.keys(routes).sort((a, b) => b.length - a.length);
  for (const p of prefixes) {
    const path = upstreamPathOf(p, url);
    if (path != null) return { prefix: p, port: routes[p], path };
  }
  return null;
}

/**
 * Express middleware forwarding prefixed requests to the local service that owns them.
 *
 * Anything with no matching prefix falls through untouched, so the ingest's own routes are
 * unaffected and this can be mounted before them.
 */
export function gateway(routes = DEFAULT_ROUTES, { timeoutMs = 15_000, host = "127.0.0.1" } = {}) {
  return function gatewayMiddleware(req, res, next) {
    const hit = matchRoute(routes, req.originalUrl ?? req.url);
    if (!hit) return next();

    const upstream = http.request({
      host,
      port: hit.port,
      path: hit.path,
      method: req.method,
      // Host is rewritten because the upstream sees a different port, and the original value
      // confuses any service that builds absolute urls from it.
      headers: { ...req.headers, host: `${host}:${hit.port}` },
    }, (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res); // streamed, so server-sent events keep flowing
    });

    upstream.setTimeout(timeoutMs, () => {
      upstream.destroy();
      if (!res.headersSent) {
        res.status(504).json({ error: "upstream timed out", service: hit.prefix, afterMs: timeoutMs });
      }
    });

    // A service being down is ordinary here, because the supervisor restarts them independently and
    // the box may be part way through a boot. Say which one, so the caller is not left guessing.
    upstream.on("error", (e) => {
      if (res.headersSent) { res.destroy(); return; }
      res.status(502).json({
        error: "service unavailable",
        service: hit.prefix,
        detail: e.code === "ECONNREFUSED" ? "not listening yet, it may still be starting" : e.message,
      });
    });

    req.pipe(upstream);
  };
}
