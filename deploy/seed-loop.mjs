// Self-seeding loop for the always-on deploy. Every interval it refreshes the fixture list
// from TxLINE, then opens a 1X2 market for any upcoming fixture that does not have one yet,
// pricing each leg at the demargined line the ingest is holding. A fixture whose odds are not
// published yet is skipped and retried next pass, so markets appear the moment TxLINE prices
// them, with no human step. This is the piece that lets the ingest capture the line and open
// the markets on its own.
//
//   node deploy/seed-loop.mjs        (usually run by deploy/start-all.mjs)
//   env: SEED_EVERY_MS (default 600000), RPC, INGEST, and the day1/ credentials + wallet.
import { spawn } from "node:child_process";

const EVERY_MS = Number(process.env.SEED_EVERY_MS ?? 10 * 60_000);
const log = (msg) => console.log(`[${new Date().toISOString()}] seed-loop: ${msg}`);

const run = (script) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [script], { stdio: "inherit", env: process.env });
    child.on("exit", (code) => resolve(code ?? 0));
    child.on("error", (e) => { console.error("seed-loop spawn error:", e); resolve(1); });
  });

log(`starting; a pass every ${Math.round(EVERY_MS / 60000)} min`);
for (;;) {
  try {
    await run("scripts/refresh-fixtures.mjs");   // keep the fixture list current
    await run("scripts/seed-worldcup-markets.mjs"); // open any missing 1X2 market at the live line
  } catch (e) {
    console.error("seed-loop pass failed:", e);
  }
  await new Promise((r) => setTimeout(r, EVERY_MS));
}
