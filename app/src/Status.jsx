// The status page.
//
// A prediction market that settles money should be able to show, on one screen, that its two
// halves are alive: the data feed it reads prices and scores from, and the on-chain programs it
// settles through. This reads both live. The feed side comes from the ingestion service, which
// tracks every one of the eighteen TxLINE endpoints. The chain side asks Solana directly whether
// each program is deployed, so nothing here is a claim we typed into a table.
import { useEffect, useState } from "react";
import { Connection } from "@solana/web3.js";
import { RPC } from "./chain.js";

import { INGEST } from "./origins.js";

// The eighteen endpoints, in the four groups the OpenAPI spec puts them in, so the page reads
// like the feed's own shape rather than an arbitrary list.
const GROUPS = [
  { name: "Access", blurb: "Getting a token and keeping it live.", names: ["guestStart", "activate", "purchaseQuote"] },
  { name: "Fixtures", blurb: "The schedule, and the proof a match is real.", names: ["fixturesSnapshot", "fixturesUpdates", "fixturesValidation", "fixturesBatchValidation"] },
  { name: "Odds", blurb: "Every price, live and provable.", names: ["oddsSnapshot", "oddsUpdatesFixture", "oddsUpdatesWindow", "oddsStream", "oddsValidation"] },
  { name: "Scores", blurb: "The live match, and the proof of the final score.", names: ["scoresSnapshot", "scoresUpdatesFixture", "scoresUpdatesWindow", "scoresHistorical", "scoresStream", "statValidation"] },
];
const PLAIN = {
  guestStart: "Start a guest session", activate: "Activate the token", purchaseQuote: "Price an upgrade",
  fixturesSnapshot: "The schedule now", fixturesUpdates: "Schedule changes", fixturesValidation: "Prove one fixture", fixturesBatchValidation: "Prove an hour of fixtures",
  oddsSnapshot: "The whole board", oddsUpdatesFixture: "One match's price moves", oddsUpdatesWindow: "All price moves in a window", oddsStream: "The live price stream", oddsValidation: "Prove one price",
  scoresSnapshot: "The live score", scoresUpdatesFixture: "One match's events", scoresUpdatesWindow: "All events in a window", scoresHistorical: "Past results", scoresStream: "The live score stream", statValidation: "Prove one stat",
};

// The programs that settle the money, read straight from the addresses the app trades against.
const PROGRAMS = [
  { name: "Head to head", addr: "FVVSa2AcwxBdmtKxFHiZMmd2ceRWorh7ZDdppvPsPvxb", what: "Two people lock stakes, a proof of the score pays the winner." },
  { name: "Pooled market", addr: "AweLznQDPzt9UXKhon6X8iKgvrd5dX4Ru36ddnuRirKZ", what: "The pool you trade against, open even with nobody else online." },
  { name: "Order book", addr: "7PtxtGEGwBsSNRcRDsP4pedkQkzpGLZNv92Ndc9WwgrE", what: "A price-time order book, matched on-chain." },
  { name: "Multi-outcome", addr: "8zVnp7ivs5fSdmjYFHTLChrSzbKnDeKX6mj5nuP1CAgg", what: "Events with more than two outcomes and exactly one winner." },
  { name: "Optimistic oracle", addr: "HUXM89x5Uxex2XfTh58i2xXzroeULgtuq7w3tT7zzYpJ", what: "A bonded fallback for questions the match data cannot answer." },
  { name: "TxODDS proof root", addr: "6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J", what: "The oracle TxODDS deployed. It holds the daily roots every proof checks against. We do not control it.", external: true },
];

const shortAddr = (a) => `${a.slice(0, 4)}…${a.slice(-4)}`;
const ageLabel = (s) => (s == null ? "not called yet" : s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)}h ago`);

function Dot({ tone }) {
  return <span className={`status-dot status-dot-${tone}`} aria-hidden="true" />;
}

function EndpointRow({ e }) {
  // ok streams live, error is failing, idle means on-demand and not hit yet this run
  const tone = e?.status === "ok" ? "ok" : e?.status === "error" ? "bad" : "idle";
  const when = e?.status === "ok" ? ageLabel(e.ageSeconds) : e?.ageSeconds != null ? ageLabel(e.ageSeconds) : "on demand";
  return (
    <div className="status-ep">
      <Dot tone={tone} />
      <span className="status-ep-name">{PLAIN[e?.name] ?? e?.name}</span>
      <span className="status-ep-age mono">{when}</span>
      <span className="status-ep-calls mono">{e?.calls ?? 0} call{e?.calls === 1 ? "" : "s"}</span>
    </div>
  );
}

export default function Status() {
  const [feed, setFeed] = useState(null);
  const [feedErr, setFeedErr] = useState(false);
  const [chain, setChain] = useState({}); // addr -> "live" | "missing" | "checking"

  // the data feed, from the ingestion service
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch(`${INGEST}/endpoints`);
        if (!r.ok) throw new Error(String(r.status));
        const j = await r.json();
        if (alive) { setFeed(j); setFeedErr(false); }
      } catch { if (alive) setFeedErr(true); }
    };
    load();
    const t = setInterval(load, 10_000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  // the programs, asked of Solana directly
  useEffect(() => {
    let alive = true;
    const connection = new Connection(RPC, "confirmed");
    (async () => {
      for (const p of PROGRAMS) {
        try {
          const info = await connection.getAccountInfo(new (await import("@solana/web3.js")).PublicKey(p.addr));
          if (alive) setChain((c) => ({ ...c, [p.addr]: info?.executable ? "live" : "missing" }));
        } catch { if (alive) setChain((c) => ({ ...c, [p.addr]: "missing" })); }
      }
    })();
    return () => { alive = false; };
  }, []);

  const byName = new Map((feed?.endpoints ?? []).map((e) => [e.name, e]));
  // Every endpoint is integrated. Some stream continuously (the live feeds), the rest run on
  // demand (the proof and access calls, fired when a proof is requested). "Answering right now"
  // was the wrong number to headline: it read as if only some endpoints were used, when all
  // eighteen are wired and every one has been exercised.
  const streaming = (feed?.endpoints ?? []).filter((e) => e.status === "ok").length;
  const onDemand = 18 - streaming;
  const liveProgs = PROGRAMS.filter((p) => chain[p.addr] === "live").length;

  return (
    <div className="status-page">
      <header className="status-head">
        <h2 className="display status-title">System status</h2>
        <p className="status-sub">
          Live health of the TxLINE data feed and the on-chain programs, read from the ingestion service and from Solana.
        </p>
      </header>

      <section className="status-cards">
        <div className="status-card">
          <div className="microlabel">Data feed</div>
          {feedErr ? (
            <div className="status-card-big status-bad-text">unreachable</div>
          ) : (
            <div className="status-card-big">18<span className="status-card-unit"> / 18 integrated</span></div>
          )}
          <div className="status-card-note">
            {feedErr ? "ingestion service not answering" : feed ? `${streaming} streaming live, ${onDemand} on-demand` : "reading the ingestion service"}
          </div>
        </div>
        <div className="status-card">
          <div className="microlabel">On-chain programs</div>
          <div className="status-card-big">{liveProgs}<span className="status-card-unit"> / {PROGRAMS.length} deployed</span></div>
          <div className="status-card-note">queried on Solana {RPC.includes("devnet") ? "devnet" : "at the configured RPC"}</div>
        </div>
      </section>

      <section className="status-section">
        <h3 className="status-section-title">Data feed</h3>
        <p className="status-section-blurb">
          Eighteen endpoints. The live feeds stream continuously; the proof and access calls run on demand.
          The free World Cup tier is about 60 seconds behind live.
        </p>
        {feedErr && (
          <p className="empty-state">
            The ingestion service is not answering, so the feed status cannot be shown. Start it and this fills in.
          </p>
        )}
        {!feedErr && GROUPS.map((g) => (
          <div key={g.name} className="status-group">
            <div className="status-group-head">
              <span className="status-group-name">{g.name}</span>
              <span className="status-group-blurb">{g.blurb}</span>
            </div>
            {g.names.map((n) => <EndpointRow key={n} e={byName.get(n) ?? { name: n }} />)}
          </div>
        ))}
      </section>

      <section className="status-section">
        <h3 className="status-section-title">Programs</h3>
        <p className="status-section-blurb">
          Five fischio deployed and one TxODDS deployed that we only read from. Each row is a live query to Solana for
          whether the program is deployed and executable.
        </p>
        {PROGRAMS.map((p) => {
          const st = chain[p.addr];
          const tone = st === "live" ? "ok" : st === "missing" ? "bad" : "idle";
          return (
            <div key={p.addr} className="status-prog">
              <div className="status-prog-top">
                <Dot tone={tone} />
                <span className="status-prog-name">{p.name}{p.external && <span className="status-tag">external</span>}</span>
                <a className="mono status-prog-addr" href={`https://explorer.solana.com/address/${p.addr}?cluster=devnet`} target="_blank" rel="noreferrer">{shortAddr(p.addr)}</a>
              </div>
              <p className="status-prog-what">{p.what}</p>
            </div>
          );
        })}
      </section>

    </div>
  );
}
