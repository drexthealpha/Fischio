// One public port has to serve five services. Path rewriting decides which one gets the request,
// so a mistake here routes a caller to the wrong service and looks like corrupt data rather than a
// routing bug. The prefix-boundary cases are the ones worth pinning.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { upstreamPathOf, matchRoute, gateway, DEFAULT_ROUTES } from "../lib/gateway.mjs";

test("the prefix is stripped and the rest is preserved", () => {
  assert.equal(upstreamPathOf("/api", "/api/markets"), "/markets");
  assert.equal(upstreamPathOf("/api", "/api/markets/abc?full=1"), "/markets/abc?full=1");
  assert.equal(upstreamPathOf("/indexer", "/indexer/leaderboard"), "/leaderboard");
});

test("the prefix alone and the prefix with a slash reach the same place", () => {
  assert.equal(upstreamPathOf("/api", "/api"), "/");
  assert.equal(upstreamPathOf("/api", "/api/"), "/");
});

test("a query directly on the prefix keeps its slash", () => {
  assert.equal(upstreamPathOf("/api", "/api?x=1"), "/?x=1");
});

test("a longer word starting with the prefix does not match", () => {
  // /apitheft must not be routed to the api. Without the separator check it would be, and it would
  // arrive upstream as the path "theft".
  assert.equal(upstreamPathOf("/api", "/apitheft"), null);
  assert.equal(upstreamPathOf("/api", "/apis/markets"), null);
});

test("unrelated paths do not match, so the ingest keeps its own routes", () => {
  for (const url of ["/markets", "/live/123", "/movers", "/health", "/"]) {
    assert.equal(upstreamPathOf("/api", url), null, `${url} must fall through`);
  }
});

test("the ingest and the api can both own /markets without shadowing", () => {
  // This is why the mount uses prefixes. Both services answer /markets and mean different things.
  assert.equal(matchRoute(DEFAULT_ROUTES, "/markets"), null, "the ingest keeps its own");
  assert.equal(matchRoute(DEFAULT_ROUTES, "/api/markets").path, "/markets", "the api gets its own");
});

test("the longest matching prefix wins", () => {
  const routes = { "/api": 1, "/api/v2": 2 };
  assert.equal(matchRoute(routes, "/api/v2/markets").port, 2);
  assert.equal(matchRoute(routes, "/api/markets").port, 1);
});

test("a request is forwarded, and the response comes back intact", async () => {
  const upstream = express();
  upstream.get("/markets", (req, res) => res.json({ from: "api", query: req.query.full ?? null }));
  const up = await new Promise((r) => { const s = upstream.listen(0, () => r(s)); });

  const app = express();
  app.use(gateway({ "/api": up.address().port }));
  app.get("/markets", (_, res) => res.json({ from: "ingest" }));
  const front = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${front.address().port}`;

  const viaGateway = await (await fetch(`${base}/api/markets?full=1`)).json();
  assert.deepEqual(viaGateway, { from: "api", query: "1" });

  const ownRoute = await (await fetch(`${base}/markets`)).json();
  assert.deepEqual(ownRoute, { from: "ingest" }, "the ingest's own route is untouched");

  front.close(); up.close();
});

test("a POST body reaches the upstream service", async () => {
  const upstream = express();
  upstream.use(express.json());
  upstream.post("/auth/verify", (req, res) => res.json({ got: req.body }));
  const up = await new Promise((r) => { const s = upstream.listen(0, () => r(s)); });

  const app = express();
  app.use(gateway({ "/api": up.address().port }));
  const front = await new Promise((r) => { const s = app.listen(0, () => r(s)); });

  const out = await (await fetch(`http://127.0.0.1:${front.address().port}/api/auth/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ signature: "abc" }),
  })).json();
  assert.deepEqual(out, { got: { signature: "abc" } });

  front.close(); up.close();
});

test("a service that is down returns 502 naming which one, not a hang", async () => {
  const app = express();
  // Port 1 is not listening, which is what a service still booting looks like.
  app.use(gateway({ "/api": 1 }));
  const front = await new Promise((r) => { const s = app.listen(0, () => r(s)); });

  const res = await fetch(`http://127.0.0.1:${front.address().port}/api/markets`);
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.service, "/api", "the caller must be told which service is missing");
  assert.match(body.detail, /starting|refused|ECONNREFUSED/i);

  front.close();
});

test("an upstream status code is passed through rather than flattened", async () => {
  const upstream = express();
  upstream.get("/health", (_, res) => res.status(503).json({ ok: false }));
  const up = await new Promise((r) => { const s = upstream.listen(0, () => r(s)); });

  const app = express();
  app.use(gateway({ "/supervisor": up.address().port }));
  const front = await new Promise((r) => { const s = app.listen(0, () => r(s)); });

  const res = await fetch(`http://127.0.0.1:${front.address().port}/supervisor/health`);
  assert.equal(res.status, 503, "a 503 that arrives as 200 defeats the health check");
  assert.deepEqual(await res.json(), { ok: false });

  front.close(); up.close();
});
