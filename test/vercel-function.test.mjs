// The Vercel functions, exercised under a plain node:http server.
//
// A serverless handler is normally only testable by deploying, which means a broken one is found by
// a judge rather than by CI. These handlers use node:http rather than Vercel's res.status().json()
// decorations precisely so a bare server can drive them, and this is the test that pays for that
// choice.
//
// The live case reads devnet, so it runs only when RPC is set, matching how the rest of the
// integration suite behaves. Everything else here is pure and always runs.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { serviceOf } from "../api/_not_deployed.mjs";
import notDeployed from "../api/_not_deployed.mjs";
import { upstreamPathOf } from "../lib/gateway.mjs";

/** Run one request against a handler on an ephemeral port, and return status, headers and body. */
async function callHandler(handler, path) {
  const server = createServer((req, res) => { handler(req, res); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}${path}`);
    return { status: res.status, headers: res.headers, body: await res.text() };
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test("the not-deployed handler names the service instead of returning a page", async () => {
  const { status, body, headers } = await callHandler(notDeployed, "/api/_not_deployed?service=relayer");
  assert.equal(status, 501);
  assert.match(headers.get("content-type"), /application\/json/);
  const json = JSON.parse(body);
  assert.equal(json.service, "relayer");
  assert.match(json.detail, /holds a key/);
  // The point of the endpoint: tell the caller where to go instead.
  assert.ok(json.served_here.includes("/api/markets"));
});

test("an unknown service still answers as json, never as html", async () => {
  const { status, body } = await callHandler(notDeployed, "/api/_not_deployed");
  assert.equal(status, 501);
  const json = JSON.parse(body); // would throw on an html error page, which is the bug this guards
  assert.equal(json.service, "unknown");
});

test("serviceOf reads the query without a parsed query object", () => {
  assert.equal(serviceOf("/api/_not_deployed?service=indexer"), "indexer");
  assert.equal(serviceOf("/api/_not_deployed?service=indexer&x=1"), "indexer");
  assert.equal(serviceOf("/api/_not_deployed"), "unknown");
  assert.equal(serviceOf("/api/_not_deployed?service="), "unknown");
  assert.equal(serviceOf(undefined), "unknown");
});

// The function mounts the api app by stripping /api with the same helper the box gateway uses.
// These assertions pin the behaviour the handler depends on, so a change to the shared helper that
// would silently break the deployed routes fails here instead.
test("the mount prefix strips exactly like the box gateway", () => {
  assert.equal(upstreamPathOf("/api", "/api/markets"), "/markets");
  assert.equal(upstreamPathOf("/api", "/api/markets/abc?x=1"), "/markets/abc?x=1");
  assert.equal(upstreamPathOf("/api", "/api"), "/");
  assert.equal(upstreamPathOf("/api", "/api?x=1"), "/?x=1");
  // Must not treat a longer word starting with the prefix as a request under it.
  assert.equal(upstreamPathOf("/api", "/apitheft"), null);
});

test("a path outside the mount is refused as json, not passed to express", { skip: !process.env.RPC && "set RPC to import the api service" }, async () => {
  const { default: handler } = await import("../api/[...path].mjs");
  const { status, body } = await callHandler(handler, "/apitheft");
  assert.equal(status, 404);
  assert.equal(JSON.parse(body).error, "not found");
});

test("the api function serves the real board off devnet", { skip: !process.env.RPC && "set RPC to reach devnet" }, async () => {
  const { default: handler } = await import("../api/[...path].mjs");

  const health = await callHandler(handler, "/api/health");
  assert.equal(health.status, 200);
  assert.equal(JSON.parse(health.body).ok, true);

  const markets = await callHandler(handler, "/api/markets");
  assert.equal(markets.status, 200);
  const json = JSON.parse(markets.body);
  assert.ok(Array.isArray(json.markets), "markets must be an array");
  assert.ok(json.markets.length > 0, "a deployment with no markets is not a working board");

  // The edge has to be allowed to hold a snapshot, or every visitor triggers their own chain read.
  assert.match(markets.headers.get("cache-control") ?? "", /s-maxage=\d+/);
});
