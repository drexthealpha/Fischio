// fischio always-on supervisor: the single entry point on the VPS (Wispbyte). It runs every
// 24/7 service in one process and restarts any that crash, with exponential backoff. This is
// what keeps the platform live: the ingestion layer holding the TxLINE streams open, the price
// keeper tracking the line, and the read/relay services the app talks to.
//
//   node deploy/start-all.mjs
//
// Config comes from env (set these in the Wispbyte panel):
//   RPC              Solana RPC (Helius; the free tier blocks getProgramAccounts)
//   INGEST           where the keeper reads the live line (default http://127.0.0.1:8795)
//   TXLINE_JWT       TxLINE guest token   (or place day1/credentials.json on the box)
//   TXLINE_API_TOKEN TxLINE api token
//
// Secrets are NOT in git. Upload these to the box separately before starting:
//   day1/devnet-wallet.json, day1/credentials.json, day1/devnet-usdc.json,
//   services/relayer/relayer-key.json, services/sponsor/sponsor-key.json
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const RPC = process.env.RPC ?? "https://api.devnet.solana.com";

// A hosted panel hands the container one allocated port (Pterodactyl and Wispbyte expose it as
// SERVER_PORT). The ingest is the service the front end must reach, so it takes that port by
// default; otherwise it falls back to the local dev port.
const INGEST_PORT = process.env.INGEST_PORT ?? process.env.SERVER_PORT ?? "8795";
const API_PORT = process.env.API_PORT ?? "8790";
const INGEST = process.env.INGEST ?? `http://127.0.0.1:${INGEST_PORT}`;

// name, entry file, extra env. Order puts the ingest first so the keeper finds a live line.
const SERVICES = [
  ["ingest", "services/ingest/server.mjs", { PORT: INGEST_PORT }],
  ["api", "services/api/server.mjs", { PORT: API_PORT, RPC }],
  ["keeper", "bot/odds-keeper.mjs", { RPC, INGEST }],
  ["seed", "deploy/seed-loop.mjs", { RPC, INGEST }],
  ["relayer", "services/relayer/server.mjs", { RPC }],
  ["sponsor", "services/sponsor/server.mjs", { RPC }],
  ["indexer", "services/indexer/server.mjs", { RPC }],
];

function run(name, file, extra, backoff = 1000) {
  const path = join(root, file);
  if (!existsSync(path)) { console.log(`[supervisor] skip ${name}: ${file} not found`); return; }
  const child = spawn(process.execPath, [path], {
    cwd: root,
    env: { ...process.env, ...extra },
    stdio: ["ignore", "inherit", "inherit"],
  });
  console.log(`[supervisor] started ${name} (${file}) pid ${child.pid}`);
  child.on("error", (e) => console.log(`[supervisor] ${name} error: ${e.message}`));
  child.on("exit", (code) => {
    const wait = Math.min(backoff, 30000);
    console.log(`[supervisor] ${name} exited (code ${code}); restarting in ${wait}ms`);
    setTimeout(() => run(name, file, extra, Math.min(backoff * 2, 30000)), wait);
  });
}

// On a small box, pick a subset: FISCHIO_SERVICES=ingest,api,keeper runs only those. Default all.
const only = (process.env.FISCHIO_SERVICES ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const chosen = only.length ? SERVICES.filter(([n]) => only.includes(n)) : SERVICES;

console.log(`[supervisor] fischio services starting; RPC ${RPC.includes("helius") ? "helius" : RPC}; running ${chosen.map(([n]) => n).join(", ")}`);
for (const [name, file, extra] of chosen) run(name, file, extra);

// keep the parent alive and log a heartbeat so the panel shows the process is healthy
setInterval(() => console.log(`[supervisor] alive ${new Date().toISOString()}`), 300000);
