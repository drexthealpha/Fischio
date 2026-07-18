// fischio always-on supervisor: the single entry point on the VPS (Wispbyte).
//
// Runs every 24/7 process in one place, restarts what crashes, gives up on what cannot stay up, and
// exposes a health endpoint that is allowed to say no. The restart policy lives in
// lib/supervision.mjs so it can be tested without spawning anything (test/supervision.test.mjs).
//
//   node deploy/start-all.mjs
//
// Config comes from env (the Wispbyte panel, or the gitignored root .env locally):
//   RPC               Solana RPC. Helius devnet is verified to allow getProgramAccounts, which the
//                     api and indexer need. Public devnet works but rate limits under load.
//   INGEST            where agents read the live line (default http://127.0.0.1:8795)
//   TXLINE_JWT        TxLINE guest token   (or place local/credentials.json on the box)
//   TXLINE_API_TOKEN  TxLINE api token
//   KEYPAIR_JSON      the trading wallet as JSON, if you would rather not upload a file
//   FISCHIO_SERVICES  comma separated subset to run. Default is the read-only set.
//   FISCHIO_FIXTURE   fixture id for the agents that need one
//   HEALTH_PORT       where the health endpoint listens (default 8799)
//
// Secrets are NOT in git. Upload these separately, or supply them as env:
//   local/devnet-wallet.json, local/credentials.json, local/devnet-usdc.json,
//   services/relayer/relayer-key.json, services/sponsor/sponsor-key.json
//
// WHAT RUNS BY DEFAULT, AND WHY THE AGENTS DO NOT
//
// The default set reads data and serves it. Agents that commit collateral are opt-in, because a
// process that spends money should be started deliberately by someone who has checked the wallet is
// funded and the parameters are right. Booting them automatically on every container restart is how
// an unattended box quietly drains a wallet.
import "../lib/env.mjs"; // load the gitignored root .env so every spawned child inherits RPC etc.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { restartDecision, newState, healthOf } from "../lib/supervision.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const RPC = process.env.RPC ?? "https://api.devnet.solana.com";

// A hosted panel hands the container one allocated port (Pterodactyl and Wispbyte expose it as
// SERVER_PORT). The ingest is the service the front end must reach, so it takes that port.
const INGEST_PORT = process.env.INGEST_PORT ?? process.env.SERVER_PORT ?? "8795";

const HEALTH_PORT = process.env.HEALTH_PORT ?? "8799";
const INGEST = process.env.INGEST ?? `http://127.0.0.1:${INGEST_PORT}`;
const FIXTURE = process.env.FISCHIO_FIXTURE ?? "";

// One JSON object per line, so the log can be read back by a tool rather than only by a person
// squinting at it. This is the record that has to explain, after the fact and without the author
// present, why a process did what it did.
const emit = (event, fields = {}) =>
  console.log(JSON.stringify({ at: new Date().toISOString(), component: "supervisor", event, ...fields }));

// Ports have one source of truth, shared with the gateway.
//
// The ingest forwards to these services on the container's single public port, so it has to know
// where each one is listening. Letting each service fall back to its own default while the gateway
// reads an env var is how /indexer returned 502 on a box where the indexer was running perfectly:
// the service bound 8792 and the gateway looked at whatever INDEXER_PORT said. Every port is passed
// explicitly here, from the same values lib/gateway.mjs reads.
const PORTS = {
  api: process.env.API_PORT ?? "8790",
  relayer: process.env.RELAYER_PORT ?? "8791",
  indexer: process.env.INDEXER_PORT ?? "8792",
  sponsor: process.env.SPONSOR_PORT ?? "8793",
};

// name, entry, args, env, spends money
const ALL = [
  ["ingest", "services/ingest/server.mjs", [], { PORT: INGEST_PORT, ...Object.fromEntries(Object.entries(PORTS).map(([k, v]) => [`${k.toUpperCase()}_PORT`, v])), HEALTH_PORT }, false],
  ["api", "services/api/server.mjs", [], { PORT: PORTS.api, RPC }, false],
  ["indexer", "services/indexer/server.mjs", [], { PORT: PORTS.indexer, RPC }, false],
  ["relayer", "services/relayer/server.mjs", [], { PORT: PORTS.relayer, RPC }, false],
  ["sponsor", "services/sponsor/server.mjs", [], { PORT: PORTS.sponsor, RPC }, false],
  ["keeper", "bot/odds-keeper.mjs", [], { RPC, INGEST }, false],
  ["seed", "deploy/seed-loop.mjs", [], { RPC, INGEST }, false],
  // Everything below commits collateral. Opt in with FISCHIO_SERVICES.
  ["maker", "bot/inplay-mm.mjs", FIXTURE ? ["--fixture", FIXTURE] : [], { RPC, INGEST }, true],
  ["arena", "bot/arena.mjs", FIXTURE ? ["--fixture", FIXTURE] : [], { RPC, INGEST }, true],
  ["settle", "bot/settle-market.mjs", [], { RPC }, true],
];

const only = (process.env.FISCHIO_SERVICES ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const chosen = ALL.filter(([n, , , , spends]) => (only.length ? only.includes(n) : !spends));
const states = new Map();

function run(name, file, args, extra) {
  const path = join(root, file);
  if (!existsSync(path)) { emit("skipped", { service: name, reason: `${file} not found` }); return; }

  const state = states.get(name) ?? states.set(name, newState()).get(name);
  const startedAt = Date.now();
  state.startedAt = startedAt;

  const child = spawn(process.execPath, [path, ...args], {
    cwd: root,
    env: { ...process.env, ...extra },
    stdio: ["ignore", "inherit", "inherit"],
  });
  emit("started", { service: name, file, pid: child.pid, args: args.join(" ") || undefined });

  child.on("error", (e) => emit("spawn_error", { service: name, error: e.message }));
  child.on("exit", (code, signal) => {
    const ranForMs = Date.now() - startedAt;
    state.startedAt = null;
    state.lastExit = { code, signal, ranForMs, at: new Date().toISOString() };

    const d = restartDecision(state, { code, ranForMs });
    if (!d.restart) {
      state.givenUp = true;
      // Loud, and it stays loud: health reports not ok from here until someone intervenes.
      emit("gave_up", { service: name, code, signal, ranForMs, reason: d.reason, restarts: state.restarts });
      return;
    }
    state.restarts = (state.restarts ?? 0) + 1;
    emit("restarting", { service: name, code, signal, ranForMs, delayMs: d.delayMs, reason: d.reason, restarts: state.restarts });
    setTimeout(() => run(name, file, args, extra), d.delayMs);
  });
}

// ---- health ------------------------------------------------------------------------------------
// A monitor needs somewhere to look that is not the log. This returns 503 when anything has given up
// or is between restarts, so an uptime check fails on a box where half the agents are dead. An
// endpoint that can only ever say "ok" is not a health check, it is decoration.
createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (!req.url.startsWith("/health")) { res.writeHead(404).end(); return; }
  const h = healthOf(states);
  res.writeHead(h.ok ? 200 : 503, { "content-type": "application/json" });
  res.end(JSON.stringify({ ...h, rpc: RPC.includes("helius") ? "helius" : "public", at: new Date().toISOString() }, null, 2));
}).listen(HEALTH_PORT, () => emit("health_listening", { port: Number(HEALTH_PORT) }));

emit("boot", {
  rpc: RPC.includes("helius") ? "helius" : RPC,
  running: chosen.map(([n]) => n),
  spending: chosen.filter(([, , , , s]) => s).map(([n]) => n),
  mode: only.length ? "explicit FISCHIO_SERVICES" : "default read-only set",
});
if (chosen.some(([, , , , s]) => s) && !FIXTURE) {
  emit("warning", { message: "an agent that spends was selected without FISCHIO_FIXTURE, so it will exit on start until one is set" });
}
for (const [name, file, args, extra] of chosen) run(name, file, args, extra);

// The heartbeat carries the health summary, so the panel's own log shows degradation without anyone
// having to poll the endpoint.
setInterval(() => {
  const h = healthOf(states);
  emit("heartbeat", { ok: h.ok, summary: h.summary });
}, 300_000);
