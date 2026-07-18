#!/usr/bin/env node
// The fischio command line tool.
//
// WHAT THIS IS FOR
//
// fischio says two things about every bet: this is the real price, and this is the real result.
// A website can say that. Saying it is free. This tool is how you check it without asking us,
// without an account, and without trusting anything we host.
//
// Every command that says "verified" here got that answer from the Solana blockchain, from a
// program fischio does not own and cannot change. If our servers lie, these commands fail. If
// our servers are switched off, these commands still work.
//
//   fischio matches                     what is on, and when
//   fischio board 18257739              every price we quote on a match
//   fischio replay 18257739 --as-of 3h  the same board as it stood earlier
//   fischio verify price 18257739       check the price is the real one
//   fischio verify result 18257739      check the score is the real one
//   fischio health                      is the data feed alive
import "../lib/env.mjs"; // load the gitignored root .env (RPC etc.) before anything reads it
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { txlineClient, parseMarkets } from "../lib/txline.mjs";
import { fixtureOf, nameOutcomes, titleOf } from "../lib/fixtures.mjs";
import { readScore, outcomeOf, loadResultScore, STAT } from "../lib/scores.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const flag = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const has = (k) => argv.includes(`--${k}`);
const JSON_OUT = has("json");

// ---- output ----
const C = process.stdout.isTTY && !JSON_OUT
  ? { dim: (s) => `\x1b[2m${s}\x1b[0m`, b: (s) => `\x1b[1m${s}\x1b[0m`, g: (s) => `\x1b[32m${s}\x1b[0m`, r: (s) => `\x1b[31m${s}\x1b[0m`, y: (s) => `\x1b[33m${s}\x1b[0m` }
  : { dim: (s) => s, b: (s) => s, g: (s) => s, r: (s) => s, y: (s) => s };
const out = (...a) => !JSON_OUT && console.log(...a);
const emit = (o) => JSON_OUT && console.log(JSON.stringify(o, null, 2));
const die = (msg) => { console.error(C.r(msg)); process.exit(1); };

const pct = (p) => (p == null ? "  n/a" : `${(p * 100).toFixed(1)}%`.padStart(5));
const ago = (ms) => {
  if (ms == null) return "unknown";
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 172800) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};
// "3h", "45m", "90s", or a plain timestamp.
function whenToMs(s) {
  if (!s) return Date.now();
  const m = String(s).match(/^(\d+(?:\.\d+)?)([smhd])$/);
  if (m) return Date.now() - Number(m[1]) * { s: 1e3, m: 6e4, h: 36e5, d: 864e5 }[m[2]];
  const n = Number(s);
  if (Number.isFinite(n) && n > 1e11) return n;
  const d = Date.parse(s);
  if (!Number.isNaN(d)) return d;
  die(`cannot read the time "${s}". Try 3h, 45m, or a full date.`);
}

const TYPE_NAME = {
  "1X2_PARTICIPANT_RESULT": "Match result",
  "OVERUNDER_PARTICIPANT_GOALS": "Total goals",
  "ASIANHANDICAP_PARTICIPANT_GOALS": "Handicap",
};
const SHORT = { "1x2": "1X2_PARTICIPANT_RESULT", totals: "OVERUNDER_PARTICIPANT_GOALS", handicap: "ASIANHANDICAP_PARTICIPANT_GOALS" };

// A handicap line is a head start, so its sign carries meaning and has to be shown. A totals
// line is just a number of goals, so a plus sign in front of it means nothing and reads as if
// the market were something it is not.
const lineLabel = (m) =>
  m.line == null ? "" : m.type === "ASIANHANDICAP_PARTICIPANT_GOALS" ? ` ${m.line > 0 ? "+" : ""}${m.line}` : ` ${m.line}`;
const marketLabel = (m) => `${m.period === "H1" ? "first half" : "full match"}${lineLabel(m)}`;

// The fixtures feed filters by a numeric competition id, not by name. Sending "World Cup"
// returns a 500, so the name has to be resolved to its id before the call.
const WORLD_CUP = 72;
const competition = () => {
  const v = flag("competition", String(WORLD_CUP));
  if (/^\d+$/.test(v)) return Number(v);
  die(`--competition takes a number, and the World Cup is ${WORLD_CUP}. The feed rejects names.`);
};

const tx = () => {
  const c = txlineClient();
  if (!c.creds?.jwt) die("no data-feed credentials. Set TXLINE_JWT and TXLINE_API_TOKEN, or add local/credentials.json.");
  return c;
};

// Anchor and the Solana libraries are heavy, so only the verify commands pay for them.
async function chain() {
  const anchor = await import("@coral-xyz/anchor");
  const { Connection, Keypair } = await import("@solana/web3.js");
  const rpc = flag("rpc", process.env.RPC ?? "https://api.devnet.solana.com");
  const connection = new Connection(rpc, "confirmed");
  let payer = null;
  try { payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(process.env.KEYPAIR_JSON ?? readFileSync(join(root, "local/devnet-wallet.json"), "utf8")))); } catch { /* checked below */ }
  if (!payer) die("verifying sends a transaction, so it needs a funded devnet wallet.\nSet KEYPAIR_JSON, or run: solana-keygen new -o local/devnet-wallet.json && solana airdrop 1 --url devnet");
  const idl = JSON.parse(readFileSync(join(root, "local/txoracle-devnet-idl.json"), "utf8"));
  const oracle = new anchor.Program(idl, new anchor.AnchorProvider(connection, new anchor.Wallet(payer), { commitment: "confirmed" }));
  return { anchor, connection, oracle, rpc };
}

// ---- commands ----

async function cmdMatches() {
  const c = tx();
  const comp = competition();
  const day = Math.floor(Date.now() / 86_400_000);
  const days = Number(flag("days", 14));
  const rows = [];
  for (let d = day; d < day + days && rows.length < 60; d++) {
    for (const f of (await c.fixturesSnapshot(d, comp)) ?? []) rows.push(f);
  }
  // The same match can appear on more than one day's snapshot, so key by id and keep one.
  const byId = new Map(rows.map((f) => [f.FixtureId, f]));
  const list = [...byId.values()].sort((a, b) => Number(a.StartTime ?? a.Ts) - Number(b.StartTime ?? b.Ts));
  if (!list.length) return out(`No matches scheduled in the next ${days} days.`);
  emit(list);

  out(C.b(`${list.length} ${list[0].Competition ?? "competition " + comp} ${list.length === 1 ? "match" : "matches"}`));
  for (const f of list) {
    const ko = Number(f.StartTime ?? f.Ts);
    const when = Number.isFinite(ko) ? new Date(ko).toISOString().replace("T", " ").slice(0, 16) + "Z" : "kickoff unknown";
    const soon = Number.isFinite(ko) && ko > Date.now() ? C.dim(` in ${countdown(ko - Date.now())}`) : "";
    out(`  ${C.dim(String(f.FixtureId).padEnd(9))} ${when}  ${C.b(`${f.Participant1 ?? "?"} v ${f.Participant2 ?? "?"}`)}${soon}`);
  }
  out(C.dim(`\nSee the prices on one: fischio board ${list[0].FixtureId}`));
}

// Days down to seconds, because "in 2 days" is not the same information as "in 2 days 4 hours".
function countdown(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (d || h) parts.push(`${h}h`);
  parts.push(`${m}m`);
  if (!d) parts.push(`${s % 60}s`);
  return parts.join(" ");
}

async function cmdBoard(fixtureId, asOf = Date.now()) {
  if (!fixtureId) die("which match? Try: fischio board 18257739");
  const c = tx();
  // asOf is what makes this the whole board. Without it the feed returns whatever ticked most
  // recently, which is a shifting handful of the markets rather than all of them.
  const board = parseMarkets((await c.oddsSnapshot(fixtureId, asOf)) ?? []);
  if (!board.length) return out(`No prices for match ${fixtureId}.`);
  emit(board);

  const order = ["1X2_PARTICIPANT_RESULT", "OVERUNDER_PARTICIPANT_GOALS", "ASIANHANDICAP_PARTICIPANT_GOALS"];
  board.sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type) || a.period.localeCompare(b.period) || (a.line ?? 0) - (b.line ?? 0));
  const fx = await fixtureOf(c, fixtureId);
  const priced = board.map((m) => m.ts).filter(Boolean);
  out(C.b(titleOf(fx, fixtureId)) + C.dim(`   ${board.length} markets   priced ${ago(Math.max(...priced))}`));

  const width = Math.max(...board.map((m) => marketLabel(m).length)) + 2;
  let group = null;
  for (const m of board) {
    if (m.type !== group) { group = m.type; out(`\n${C.b(TYPE_NAME[m.type] ?? m.type)}`); }
    const label = marketLabel(m);
    const named = nameOutcomes(m, fx);
    if (!m.demargined) {
      // Quarter lines split your stake over two lines, so TxODDS publishes no single fair
      // percentage for them. We show the odds and say so rather than inventing a number.
      out(`  ${label.padEnd(width)} ${C.y("no fair price published")} ${C.dim(named.map((o) => `${o.name} ${o.odds?.toFixed(2)}`).join("  "))}`);
      continue;
    }
    const cells = named.map((o) => `${o.name} ${pct(o.prob)} ${C.dim(`(${o.odds?.toFixed(2)})`)}`).join("   ");
    out(`  ${label.padEnd(width)} ${cells}`);
  }
  out(C.dim(`\nThese percentages are the bookmaker consensus with the margin removed, published by TxODDS.`));
  out(C.dim(`Check any of them for yourself: fischio verify price ${fixtureId}`));
}

// Who is actually good, worked out from public trades rather than taken on anyone's word.
//
// Copy trading exists elsewhere because trades are public. What is missing elsewhere is the other
// half: the outcome those trades were scored against comes from a resolver you have to trust.
// Here the trade is an on-chain transaction and the result it settled against carries a proof, so
// this table is arithmetic anyone can redo and get the same answer.
async function cmdTraders() {
  const indexer = flag("indexer", process.env.INDEXER ?? "http://127.0.0.1:8792");
  const min = flag("min-trades", 3);
  const r = await fetch(`${indexer}/leaderboard?minTrades=${min}`).catch(() => null);
  if (!r?.ok) die(`the indexer is not answering at ${indexer}.\nStart it with: node services/indexer/server.mjs`);
  const { traders } = await r.json();
  emit(traders);
  if (!traders.length) return out(`No trader has closed enough positions to rank yet.`);

  out(C.b(`${traders.length} trader${traders.length === 1 ? "" : "s"} by realised profit`));
  out(C.dim(`  ${"wallet".padEnd(46)} ${"realised".padStart(11)} ${"win rate".padStart(9)} ${"trades".padStart(7)} ${"markets".padStart(8)}`));
  for (const t of traders.slice(0, 25)) {
    const pnl = `$${(t.realizedPnl / 1e6).toFixed(2)}`;
    const wr = t.winRate == null ? "n/a" : `${Math.round(t.winRate * 100)}%`;
    const colour = t.realizedPnl > 0 ? C.g : t.realizedPnl < 0 ? C.r : ((s) => s);
    out(`  ${t.wallet.padEnd(46)} ${colour(pnl.padStart(11))} ${wr.padStart(9)} ${String(t.trades).padStart(7)} ${String(t.marketsTraded).padStart(8)}`);
  }
  out(C.dim(`\nRealised profit only. Open positions are left out because pricing them needs a live`));
  out(C.dim(`price, which would move the table for reasons the trader had nothing to do with.`));
  out(C.dim(`Follow one:  node bot/copy-agent.mjs --leader <wallet> --allocation 500`));
}

// Prove several stats at once with one compressed multiproof.
//
// validate_stat carries a separate sibling path per stat, so proving a whole prop board costs a
// transaction per market. validate_stat_v3 sends the shared hashes once and says where each leaf
// sits, so the match result and every goals-derived prop on a fixture settle against a single
// root check. On a settled match the per-leaf proofs come back empty and a handful of shared
// hashes cover all of them, which is the compression doing the work.
async function cmdVerifyStats(fixtureId) {
  if (!fixtureId) die("which match? Try: fischio verify stats 18241006");
  const c = tx();
  const { loadResultScore } = await import("../lib/scores.mjs");
  const { payloadArg, strategyArg, single, epochDayOf, tsOf, scoresRootsPda, describe } =
    await import("../lib/stat-proof-v3.mjs");

  const { score, source } = await loadResultScore(c, fixtureId);
  if (!score?.final) return out(`Match ${fixtureId} has not reached full time, so there is nothing settled to prove.`);

  const keys = flag("stats", "1,2");
  const url = `${c.base}/api/scores/stat-validation-v3?fixtureId=${fixtureId}&seq=${score.seq}&statKeys=${keys}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${c.creds.jwt}`, "X-Api-Token": c.creds.apiToken } });
  if (!r.ok) die(`the feed returned ${r.status} for the multi-stat proof.`);
  const pkg = await r.json();

  const fx = await fixtureOf(c, fixtureId);
  const leaves = pkg.statsToProve?.length ?? 0;
  const shared = pkg.multiproof?.hashes?.length ?? 0;
  const perLeaf = (pkg.statsToProve ?? []).reduce((n, l) => n + (l.statProof?.length ?? 0), 0);
  out(C.b(`${titleOf(fx, fixtureId)}  ${score.p1}-${score.p2}`) + C.dim(`  (full time, from ${source})`));
  out(`Proving ${leaves} stats in one transaction: ${describe(pkg)}`);
  out(C.dim(`Compression: ${perLeaf} per-leaf proof nodes, ${shared} shared hashes covering all ${leaves}.`));
  emit({ fixtureId, leaves, sharedHashes: shared, perLeafNodes: perLeaf });

  const { anchor, oracle: _o, connection } = await chain();
  const idlPath = join(root, "local/txoracle-devnet-idl-v3.json");
  const prog = new anchor.Program(JSON.parse(readFileSync(idlPath, "utf8")), _o.provider);
  const roots = scoresRootsPda(prog.programId, epochDayOf(pkg));
  out(C.dim(`Roots account for ${new Date(tsOf(pkg)).toISOString().slice(0, 10)}: ${roots.toBase58()}`));

  try {
    const strategy = strategyArg({ discrete: [single(0, 0, "greaterThan"), single(1, 0, "greaterThan")] });
    const sig = await prog.methods.validateStatV3(payloadArg(pkg), strategy)
      .accountsPartial({ dailyScoresMerkleRoots: roots })
      .preInstructions([anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 })])
      .rpc();
    out(C.g(`\nVerified on-chain. ${leaves} stats, one proof, one transaction.`));
    out(`  ${sig}`);
    out(C.dim(`\nThe oracle re-derived every leaf from the shared hashes and matched the day's root.`));
    out(C.dim(`It is a program TxODDS deployed, so this is their answer and not ours.`));
  } catch (e) {
    die(`the oracle rejected it: ${String(e.message ?? e).slice(0, 160)}`);
  }
}

async function cmdReplay(fixtureId) {
  const when = whenToMs(flag("as-of", "1h"));
  out(C.dim(`The board as it stood at ${new Date(when).toISOString().replace("T", " ").slice(0, 19)}Z\n`));
  await cmdBoard(fixtureId, when);
}

// Size a bet from the terminal, priced off the real line.
//
// This is the trader's question, and it is read only: no wallet, no transaction, nothing spent.
// The price it quotes is TxODDS's demargined percentage, the same number the board shows and the
// same one `verify price` proves on-chain. A share of an outcome pays one dollar if that outcome
// happens, so a fair price of p per share means a stake buys stake/p shares and the decimal odds
// are 1/p. That is the honest ceiling. A real pool charges a fee and moves against you as you
// buy, so the quote says so rather than pretending the fill is free.
async function cmdQuote(fixtureId) {
  if (!fixtureId) die("which match? Try: fischio quote 18257739 --type totals --line 2.5 --side over");
  const c = tx();
  const board = parseMarkets((await c.oddsSnapshot(fixtureId)) ?? []);
  if (!board.length) return out(`No prices for match ${fixtureId}.`);

  const wantType = SHORT[String(flag("type", "1x2")).toLowerCase()];
  const wantLine = flag("line", null) == null ? null : Number(flag("line"));
  const stake = Number(flag("stake", 10));
  if (!(stake > 0)) die("--stake takes a positive number of dollars, for example --stake 50.");
  const side = flag("side", null);

  let market;
  if (wantType === "1X2_PARTICIPANT_RESULT") {
    // The match result has no line. Default to the full match, which is what almost everyone
    // means, and let --period H1 ask for the first half instead.
    const period = flag("period", "FT");
    market = board.find((m) => m.type === wantType && m.period === period) ?? board.find((m) => m.type === wantType);
  } else if (wantLine == null) {
    // A totals or handicap quote needs a line, because "over" means nothing without one. Show
    // the ladder rather than silently quoting whichever line happened to come first.
    const lines = [...new Set(board.filter((m) => m.type === wantType && m.demargined).map((m) => m.line))].sort((a, b) => a - b);
    die(`which line? ${TYPE_NAME[wantType]} has: ${lines.join(", ")}\nFor example: fischio quote ${fixtureId} --type ${flag("type", "totals")} --line ${lines[Math.floor(lines.length / 2)] ?? 2.5} --side over`);
  } else {
    market = board.find((m) => m.type === wantType && m.line === wantLine && m.period === flag("period", "FT"))
          ?? board.find((m) => m.type === wantType && m.line === wantLine);
  }
  if (!market) die(`no market matched. See what is on offer: fischio board ${fixtureId}`);
  if (!market.demargined) {
    return out(C.y(`That line splits your stake across two lines, so there is no single fair price to quote.\n`) +
      C.dim(`It is on the board for reference only. Pick a half-goal line instead, for example --line ${Math.round(market.line ?? 2) + 0.5}.`));
  }

  const fx = await fixtureOf(c, fixtureId);
  const named = nameOutcomes(market, fx);
  emit({ market: marketLabel(market), type: market.type, pricedMs: market.ts, messageId: market.messageId,
    stake, outcomes: named.map((o) => ({ name: o.name, prob: o.prob, odds: o.odds, shares: o.prob ? stake / o.prob : null, payout: o.prob ? stake / o.prob : null })) });

  // Which outcomes to quote: the one the trader named, or every outcome if they named none.
  const norm = (s) => String(s).toLowerCase();
  const chosen = side
    ? named.filter((o) => norm(o.name) === norm(side) || norm(o.raw) === norm(side)
        || (norm(side) === "home" && o.raw === "part1") || (norm(side) === "away" && o.raw === "part2"))
    : named;
  if (side && !chosen.length) die(`no outcome called "${side}" here. This market has: ${named.map((o) => o.name).join(", ")}`);

  out(C.b(titleOf(fx, fixtureId)));
  out(`${TYPE_NAME[market.type] ?? market.type}, ${marketLabel(market)}   ${C.dim(`priced ${ago(market.ts)}`)}\n`);
  for (const o of chosen) {
    const shares = stake / o.prob;
    const payout = shares; // one dollar per winning share
    out(`  ${C.b(o.name)}   ${C.dim(`fair ${pct(o.prob)}  (${o.odds?.toFixed(2)})`)}`);
    out(`    stake $${stake.toFixed(2)}  ->  ${shares.toFixed(1)} shares  ->  ${C.g(`$${payout.toFixed(2)} if it happens`)}  ${C.dim(`(+$${(payout - stake).toFixed(2)}, ${o.odds?.toFixed(2)}x)`)}`);
  }
  out(C.dim(`\nThe price is the bookmaker consensus with the margin removed, published by TxODDS.`));
  out(C.dim(`Prove it is the real one:  fischio verify price ${fixtureId} --type ${flag("type", "1x2")}${wantLine != null ? ` --line ${wantLine}` : ""}`));
  out(C.dim(`A live pool adds a ${(200 / 100).toFixed(0)}% fee and moves as you buy, so your real fill is a little worse than this ceiling.`));
}

async function cmdVerifyPrice(fixtureId) {
  if (!fixtureId) die("which match? Try: fischio verify price 18257739");
  const c = tx();
  const { anchor, connection, oracle } = await chain();
  const { validateOddsArgs, oddsRootsPda, oddsEpochDayOf } = await import("../lib/odds-proof.mjs");

  const board = parseMarkets((await c.oddsSnapshot(fixtureId)) ?? []);
  const wantType = SHORT[String(flag("type", "1x2")).toLowerCase()];
  const wantLine = flag("line", null) == null ? null : Number(flag("line"));
  const targets = has("all") ? board : board.filter((m) => m.type === wantType && (wantLine == null || m.line === wantLine));
  if (!targets.length) die(`no market matched. The board has ${board.length} markets: fischio board ${fixtureId}`);

  const fx = await fixtureOf(c, fixtureId);
  out(C.b(titleOf(fx, fixtureId)));
  out(`Checking ${targets.length === 1 ? "this price" : `these ${targets.length} prices`} against the record TxODDS published on Solana.\n`);
  const results = [];
  for (const m of targets) {
    const label = `${TYPE_NAME[m.type] ?? m.type}${lineLabel(m)}, ${m.period === "H1" ? "first half" : "full match"}`;
    const named = nameOutcomes(m, fx);
    const pk = await c.oddsValidation({ fixtureId, messageId: m.messageId, ts: m.ts });
    if (!pk?.odds) { out(`  ${C.r("no record")}  ${label}`); results.push({ label, verified: false, reason: "no record" }); continue; }
    const day = oddsEpochDayOf(pk);
    const roots = oddsRootsPda(day);
    try {
      // The cost of a proof depends on how deep the record sits in that interval's tree, and it
      // runs past Solana's default allowance for most markets, so ask for enough up front.
      const sig = await oracle.methods.validateOdds(...validateOddsArgs(pk))
        .accountsPartial({ dailyOddsMerkleRoots: roots })
        .preInstructions([anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })])
        .rpc();
      const shown = named.map((o) => `${o.name} ${pct(o.prob)}`).join("  ");
      out(`  ${C.g("verified")}  ${label}`);
      out(`            ${shown}`);
      out(C.dim(`            published ${new Date(m.ts).toISOString().replace("T", " ").slice(0, 19)}Z, ${ago(m.ts)}`));
      out(C.dim(`            https://explorer.solana.com/tx/${sig}?cluster=devnet`));
      results.push({ label, verified: true, signature: sig, prices: m.outcomes, publishedAt: m.ts });
    } catch (e) {
      out(`  ${C.r("FAILED")}    ${label}: ${String(e.message ?? e).slice(0, 90)}`);
      results.push({ label, verified: false, reason: String(e.message ?? e).slice(0, 200) });
    }
  }
  emit({ fixtureId, results });
  const ok = results.filter((r) => r.verified).length;
  out(`\n${ok} of ${results.length} checked out.`);
  out(C.dim(`Each link above is a transaction on Solana. It ran TxODDS's own checking program against`));
  out(C.dim(`the fingerprint they published before you asked. Nothing in that chain is ours.`));
  if (ok !== results.length) process.exitCode = 1;
}

async function cmdVerifyResult(fixtureId) {
  if (!fixtureId) die("which match? Try: fischio verify result 18241006");
  const c = tx();
  // Read the result from the right feed for the match's age. A finished match, which is what a
  // judge checks after the fact, is served by /scores/historical, not the live snapshot.
  const { score, source } = await loadResultScore(c, fixtureId);
  if (!score) return out(`No score published for match ${fixtureId} yet.`);

  const fx = await fixtureOf(c, fixtureId);
  const n1 = fx?.home ?? "the first team", n2 = fx?.away ?? "the second team";
  out(C.b(`${titleOf(fx, fixtureId)}  ${score.p1}-${score.p2}`) + C.dim(score.final ? `  (full time, from ${source})` : "  (still playing, this can change)"));
  if (!score.final) {
    out(`\nA result can only be proven once the match reaches full time. This one has not yet.`);
    return emit({ fixtureId, p1: score.p1, p2: score.p2, final: false });
  }
  if (score.wentToExtraTime) {
    out(C.dim(`This match went past ninety minutes. The result below is the score at full time,`));
    out(C.dim(`which is what a match-result bet is settled on.`));
  }

  // Ask for both goal totals in one package, then have the oracle subtract them and check the
  // sign of the answer. That one check settles who won without us ever asserting it.
  const { anchor, oracle } = await chain();
  const { summaryOf, statA, statB, epochDayOf, rootsPda, nodes } = await import("../lib/proof-marshal.mjs");
  // The proof is bound to a sequence, and the sequence that matters is the final whistle, not
  // whatever arrived most recently. readScore already picked that row.
  const pk = await c.statValidation({ fixtureId, seq: score.seq, statKey: STAT.P1_GOALS, statKey2: STAT.P2_GOALS });
  if (!pk?.summary) die("the data feed returned no proof for this result.");

  const winner = outcomeOf(score);
  const claim = winner === "P1" ? `${n1} won` : winner === "P2" ? `${n2} won` : "it was a draw";
  const comparison = winner === "P1" ? { greaterThan: {} } : winner === "P2" ? { lessThan: {} } : { equalTo: {} };

  out(`\nChecking the claim "${claim}" against the record TxODDS published on Solana.`);
  try {
    // The timestamp identifies the batch, not the update. The oracle derives the roots account
    // and the five-minute interval from it, so it has to be the batch's own minTimestamp, which
    // is the same figure the account seed is built from. Passing the update's Ts fails with
    // TimestampMismatch on any batch holding more than one update, and silently works on a batch
    // of one, where the two happen to be equal.
    const sig = await oracle.methods
      .validateStat(new anchor.BN(pk.summary.updateStats.minTimestamp), summaryOf(pk), nodes(pk.subTreeProof), nodes(pk.mainTreeProof),
        { threshold: 0, comparison }, statA(pk), statB(pk), { subtract: {} })
      .accountsPartial({ dailyScoresMerkleRoots: rootsPda(epochDayOf(pk)) })
      .preInstructions([anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })])
      .rpc();
    out(`\n  ${C.g("verified")}  ${claim}, ${score.p1}-${score.p2}`);
    out(C.dim(`            https://explorer.solana.com/tx/${sig}?cluster=devnet`));
    out(`\nThat transaction took the two goal totals, subtracted one from the other, and checked the`);
    out(`answer against the fingerprint TxODDS published while the match was still being played.`);
    out(`No person graded this match, and we could not have changed the answer.`);
    emit({ fixtureId, p1: score.p1, p2: score.p2, final: true, claim, verified: true, signature: sig, seq: score.seq });
  } catch (e) {
    out(`\n  ${C.r("FAILED")}  ${String(e.message ?? e).slice(0, 160)}`);
    emit({ fixtureId, p1: score.p1, p2: score.p2, final: true, claim, verified: false });
    process.exitCode = 1;
  }
}

// Prove a whole hour of the schedule in one transaction. validate_fixture verifies one match;
// this verifies every fixture published in an hour against the same ten-day roots account, which
// is what makes it a batch. It defaults to the most recent populated hour so it just works.
async function cmdVerifySchedule(dayArg, hourArg) {
  const c = tx();
  const { anchor, connection, oracle } = await chain();
  const { validateFixtureBatchArgs, fixturesRootsPda, batchEpochDayHour, batchIndex } = await import("../lib/fixture-proof.mjs");

  const today = Math.floor(Date.now() / 86_400_000);
  const day = dayArg && /^\d+$/.test(dayArg) ? Number(dayArg) : today;
  let pkg, hour;
  if (hourArg != null && /^\d+$/.test(hourArg)) {
    pkg = await c.fixturesBatchValidation(day, Number(hourArg)); hour = Number(hourArg);
  } else {
    // walk back from now to the first hour that actually has fixtures
    for (let h = new Date().getUTCHours(); h >= 0 && h > new Date().getUTCHours() - 12; h--) {
      const p = await c.fixturesBatchValidation(day, h).catch(() => null);
      if (p?.proof?.length) { pkg = p; hour = h; break; }
    }
  }
  if (!pkg?.proof?.length) die(`no published fixtures batch found for day ${day}. Try: fischio verify schedule ${day} <hour>`);

  const { epochDay, hourOfDay } = batchEpochDayHour(pkg);
  const m = pkg.metadata;
  out(C.b(`The schedule for day ${epochDay}, hour ${String(hourOfDay).padStart(2, "0")}:00 UTC`));
  out(`  fixtures in this hour   ${m.numUniqueFixtures}`);
  out(`  updates in this hour    ${m.totalUpdateCount}`);
  out(`\nChecking every one of them against the schedule root TxODDS published on Solana, in one proof.`);

  const roots = fixturesRootsPda(epochDay);
  const info = await connection.getAccountInfo(roots);
  if (!info) die(`the roots account for this ten-day block is not on chain yet.`);
  try {
    const sig = await oracle.methods.validateFixtureBatch(...validateFixtureBatchArgs(pkg))
      .accountsPartial({ tenDailyFixturesRoots: roots })
      .preInstructions([anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })])
      .rpc();
    out(`\n  ${C.g("verified")}  all ${m.numUniqueFixtures} fixtures in this hour are in the published schedule`);
    out(C.dim(`            slot ${batchIndex(pkg)} in ${roots.toBase58()}`));
    out(C.dim(`            https://explorer.solana.com/tx/${sig}?cluster=devnet`));
    emit({ epochDay, hourOfDay, fixtures: m.numUniqueFixtures, verified: true, signature: sig });
  } catch (e) {
    out(`\n  ${C.r("FAILED")}  ${String(e.message ?? e).slice(0, 160)}`);
    emit({ epochDay, hourOfDay, verified: false });
    process.exitCode = 1;
  }
}

async function cmdVerifyFixture(fixtureId) {
  if (!fixtureId) die("which match? Try: fischio verify fixture 18257739");
  const c = tx();
  const { anchor, oracle } = await chain();
  const { validateFixtureArgs, fixturesRootsPda, fixtureEpochDayOf } = await import("../lib/fixture-proof.mjs");

  const pkg = await c.fixturesValidation(fixtureId);
  if (!pkg?.snapshot) die(`no record of match ${fixtureId} in the schedule.`);
  const f = pkg.snapshot;
  const ko = new Date(Number(f.StartTime));

  out(C.b(`${f.Participant1} v ${f.Participant2}`));
  out(`  competition  ${f.Competition}`);
  out(`  kickoff      ${ko.toISOString().replace("T", " ").slice(0, 16)}Z`);
  out(`  at home      ${f.Participant1IsHome ? f.Participant1 : f.Participant2}`);
  out(`\nChecking this match is really in the schedule TxODDS published on Solana.`);

  const day = fixtureEpochDayOf(pkg);
  try {
    const sig = await oracle.methods.validateFixture(...validateFixtureArgs(pkg))
      .accountsPartial({ tenDailyFixturesRoots: fixturesRootsPda(day) })
      .preInstructions([anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })])
      .rpc();
    out(`\n  ${C.g("verified")}  this match exists, with these teams, at this kickoff`);
    out(C.dim(`            https://explorer.solana.com/tx/${sig}?cluster=devnet`));
    out(`\nThat matters because proving a score is not enough on its own. Anyone can invent a match,`);
    out(`take your money on it, and then settle it from a real proof of some other game. This is the`);
    out(`check that the match you are betting on is one TxODDS actually scheduled.`);
    emit({ fixtureId, teams: [f.Participant1, f.Participant2], competition: f.Competition, kickoff: Number(f.StartTime), verified: true, signature: sig });
  } catch (e) {
    out(`\n  ${C.r("FAILED")}  ${String(e.message ?? e).slice(0, 160)}`);
    emit({ fixtureId, verified: false });
    process.exitCode = 1;
  }
}

async function cmdHealth() {
  const c = tx();
  const checks = [];
  const timed = async (name, fn) => {
    const t0 = Date.now();
    try { const v = await fn(); checks.push({ name, ok: true, ms: Date.now() - t0, note: v }); }
    catch (e) { checks.push({ name, ok: false, ms: Date.now() - t0, note: String(e.message ?? e).slice(0, 60) }); }
  };
  const day = Math.floor(Date.now() / 86_400_000);
  await timed("fixtures", async () => `${((await c.fixturesSnapshot(day, competition())) ?? []).length} matches today`);
  await timed("prices", async () => {
    const f = flag("fixture", "18257739");
    return `${parseMarkets((await c.oddsSnapshot(f)) ?? []).length} markets on ${f}`;
  });
  await timed("scores", async () => { const s = await c.scoresSnapshot(flag("fixture", "18257739")); return s ? "reachable" : "no score yet"; });
  emit(checks);
  out(C.b("Data feed"));
  for (const k of checks) out(`  ${k.ok ? C.g("ok  ") : C.r("down")}  ${k.name.padEnd(9)} ${String(k.ms + "ms").padStart(7)}  ${C.dim(k.note)}`);
  const bad = checks.filter((k) => !k.ok).length;
  out(bad ? C.r(`\n${bad} of ${checks.length} not answering.`) : C.dim(`\nPrices are delayed by about 60 seconds on the free tier.`));
  if (bad) process.exitCode = 1;
}

function usage() {
  out(`${C.b("fischio")} ${C.dim("check the prices and results for yourself")}

  ${C.b("fischio matches")}                     what is on, and when
  ${C.b("fischio board")} <id>                  every price we quote on a match
  ${C.b("fischio quote")} <id> --type totals --line 2.5 --side over --stake 50
                                     ${C.dim("what a bet costs and pays, priced off the real line")}
  ${C.b("fischio replay")} <id> --as-of 3h      the same board as it stood earlier
  ${C.b("fischio traders")}                     who is profitable, from public trades
  ${C.b("fischio health")}                      is the data feed answering

  ${C.dim("three things you should not have to take on trust")}
  ${C.b("fischio verify fixture")} <id>         is this a real match, with these teams and this kickoff
  ${C.b("fischio verify schedule")}             is a whole hour of the schedule real, in one proof
  ${C.b("fischio verify price")} <id>           is this the price TxODDS published, or one we made up
  ${C.b("fischio verify result")} <id>          is this the score, once the match is over
  ${C.b("fischio verify stats")} <id>           prove several stats in one transaction
  ${C.b("fischio verify all")} <id>             all three at once

  ${C.dim("options")}
  --json                 machine readable output
  --all                  verify every market on the board, not just the match result
  --type 1x2|totals|handicap   --line 2.5     pick one market
  --as-of 3h|45m|<date>  a moment in the past
  --rpc <url>            a different Solana endpoint

  ${C.dim("The verify commands send a real transaction to a program TxODDS deployed and we do not")}
  ${C.dim("control. They need a funded devnet wallet. Everything else is read only.")}`);
}

const [a, b, ...rest] = argv.filter((x) => !x.startsWith("--"));
const id = (b && /^\d+$/.test(b)) ? b : rest[0];
try {
  if (a === "matches") await cmdMatches();
  else if (a === "board") await cmdBoard(b);
  else if (a === "quote") await cmdQuote(b);
  else if (a === "traders") await cmdTraders();
  else if (a === "replay") await cmdReplay(b);
  else if (a === "health") await cmdHealth();
  else if (a === "verify" && b === "price") await cmdVerifyPrice(id);
  else if (a === "verify" && b === "result") await cmdVerifyResult(id);
  else if (a === "verify" && b === "stats") await cmdVerifyStats(id);
  else if (a === "verify" && b === "fixture") await cmdVerifyFixture(id);
  else if (a === "verify" && b === "schedule") await cmdVerifySchedule(rest[0], rest[1]);
  else if (a === "verify" && b === "all") { await cmdVerifyFixture(id); out(""); await cmdVerifyPrice(id); out(""); await cmdVerifyResult(id); }
  else if (a === "verify") die(`verify what? Try one of:\n  fischio verify fixture <id>   is the match real\n  fischio verify schedule       is a whole hour of the schedule real\n  fischio verify price <id>     is the price real\n  fischio verify result <id>    is the score real\n  fischio verify all <id>       all three`);
  else usage();
} catch (e) {
  die(`${e.message ?? e}`);
}
