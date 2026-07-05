#!/usr/bin/env node
// Local relay for the ?live settlement view. Two jobs, both read-only:
//   GET /events            SSE tail of the real bot's log file (replays existing
//                          lines, then streams new ones). The UI renders ONLY what
//                          the bot actually logged; nothing is synthesized here.
//   GET /context?wager=PK  decoded wager account + fixture names, fetched in Node
//                          where the devnet TLS workaround is possible (browsers
//                          cannot bypass the expired api.devnet.solana.com cert).
// Usage: node bot/live-relay.mjs --log live.log [--port 8787] [--rpc <url>]
import http from "node:http";
import { readFileSync, existsSync, watchFile } from "node:fs";
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : dflt;
};
const LOG = arg("log", "live.log");
const PORT = Number(arg("port", 8787));
const RPC = arg("rpc", "http://127.0.0.1:8899");
const API = arg("api", "https://txline-dev.txodds.com");

const { jwt, apiToken } = JSON.parse(readFileSync("day1/credentials.json", "utf8"));
const headers = { Authorization: `Bearer ${jwt}`, "X-Api-Token": apiToken };
const connection = new Connection(RPC, "confirmed");
const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(Keypair.generate()), {});
const program = new anchor.Program(JSON.parse(readFileSync("target/idl/wc_settle.json", "utf8")), provider);

const fixtureCache = new Map();
async function fixtureInfo(fixtureId) {
  if (fixtureCache.has(fixtureId)) return fixtureCache.get(fixtureId);
  const today = Math.floor(Date.now() / 86400000);
  for (const day of [today, today - 1, today - 2, today - 3]) {
    const r = await fetch(`${API}/api/fixtures/snapshot?startEpochDay=${day}`, { headers }).catch(() => null);
    if (!r?.ok) continue;
    const hit = (await r.json()).find((f) => f.FixtureId === fixtureId);
    if (hit) {
      const info = {
        home: hit.Participant1,
        away: hit.Participant2,
        kickoff: new Date(hit.StartTime > 1e11 ? hit.StartTime : hit.StartTime * 1000)
          .toISOString().slice(0, 16).replace("T", " ") + " UTC",
      };
      fixtureCache.set(fixtureId, info);
      return info;
    }
  }
  return null;
}

const sseClients = new Set();
let sentLines = 0;

// PowerShell `>` writes UTF-16 LE with BOM; bash/cmd write UTF-8. Decode by BOM so
// the operator's shell choice cannot garble the stream. The log is tiny, so re-read
// whole and emit only lines we have not sent yet.
function readLogLines() {
  if (!existsSync(LOG)) return [];
  const raw = readFileSync(LOG);
  const text =
    raw[0] === 0xff && raw[1] === 0xfe ? raw.toString("utf16le").slice(1) : raw.toString("utf8");
  return text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

function tail() {
  const lines = readLogLines();
  for (; sentLines < lines.length; sentLines++) {
    for (const res of sseClients) res.write(`data: ${JSON.stringify(lines[sentLines])}\n\n`);
  }
}
watchFile(LOG, { interval: 500 }, tail);

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const cors = { "Access-Control-Allow-Origin": "*" };

  if (url.pathname === "/events") {
    res.writeHead(200, { ...cors, "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    // replay the whole existing log so late-joining viewers see the full run
    const lines = readLogLines();
    for (const t of lines) res.write(`data: ${JSON.stringify(t)}\n\n`);
    sentLines = Math.max(sentLines, lines.length);
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
    return;
  }

  if (url.pathname === "/context") {
    try {
      const wagerPk = new PublicKey(url.searchParams.get("wager"));
      const w = await program.account.wager.fetch(wagerPk);
      const fixtureId = w.terms.fixtureId.toNumber();
      const fixture = await fixtureInfo(fixtureId);
      res.writeHead(200, { ...cors, "Content-Type": "application/json" });
      res.end(JSON.stringify({
        address: wagerPk.toBase58(),
        fixtureId,
        fixture,
        maker: w.maker.toBase58(),
        taker: w.taker.toBase58(),
        stakeLamports: w.stakeLamports.toNumber(),
        state: Object.keys(w.state)[0],
        expiryTs: w.expiryTs.toNumber(),
      }));
    } catch (e) {
      res.writeHead(500, { ...cors, "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(e.message ?? e) }));
    }
    return;
  }

  res.writeHead(404, cors);
  res.end();
}).listen(PORT, () => console.log(`live relay on http://127.0.0.1:${PORT} tailing ${LOG} (rpc ${RPC})`));
