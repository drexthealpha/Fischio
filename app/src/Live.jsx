// ?live settlement view: renders ONLY what the real bot logged, streamed through
// the local relay (bot/live-relay.mjs). No fabricated states: the stamp lands when
// and only when a real "SETTLED: <sig>" line arrives with a real signature.
import { useEffect, useState } from "react";
import Ticket from "./Ticket.jsx";
import { lamportsToSol } from "./data.js";

const RELAY = "http://127.0.0.1:8787";

// classify a real bot log line for feed styling; unknown lines pass through as-is
function classify(text) {
  const body = text.replace(/^\[[^\]]+\]\s*/, ""); // strip the bot's ISO timestamp
  if (body.startsWith("SETTLED:")) return { kind: "settle", body, sig: body.slice(8).trim() };
  if (body.startsWith("full-time detected")) return { kind: "ft", body };
  if (body.startsWith("match not over")) return { kind: "score", body };
  if (body.startsWith("oracle root not posted")) return { kind: "waitroot", body };
  if (body.startsWith("proof not ready")) return { kind: "waitproof", body };
  if (body.startsWith("already settled")) return { kind: "other", body };
  return { kind: "bot", body };
}

const KIND_TAG = { bot: "BOT", score: "FEED", ft: "FT", settle: "TX", waitroot: "WAIT", waitproof: "WAIT", other: "BOT" };

export default function Live({ wagerAddress }) {
  const [conn, setConn] = useState("connecting"); // connecting | open | offline
  const [ctx, setCtx] = useState(null);
  const [ctxError, setCtxError] = useState(null);
  const [events, setEvents] = useState([]);
  const [settleSig, setSettleSig] = useState(null);
  const [waiting, setWaiting] = useState(null); // { kind, body } while bot retries
  const [leaves, setLeaves] = useState(null); // real proven leaves from the bot's proof line
  const [botPk, setBotPk] = useState("");

  useEffect(() => {
    if (!wagerAddress) return;
    let alive = true;
    const loadCtx = () =>
      fetch(`${RELAY}/context?wager=${wagerAddress}`)
        .then((r) => r.json())
        .then((j) => { if (alive) (j.error ? setCtxError(j.error) : setCtx(j)); })
        .catch((e) => { if (alive) setCtxError(String(e)); });
    loadCtx();

    const es = new EventSource(`${RELAY}/events`);
    es.onopen = () => setConn("open");
    es.onerror = () => setConn("offline"); // EventSource auto-reconnects; state flips back on success
    es.onmessage = (m) => {
      const ev = classify(JSON.parse(m.data));
      setEvents((prev) => [...prev.slice(-199), ev]);
      if (ev.kind === "waitroot" || ev.kind === "waitproof") setWaiting(ev);
      if (ev.kind === "ft") setWaiting(null);
      if (ev.body.startsWith("bot ")) {
        const pk = ev.body.split(" ")[1];
        if (pk?.length > 30) setBotPk(pk);
      }
      if (ev.body.startsWith("proof in hand")) {
        setWaiting(null);
        try {
          const objs = [...ev.body.matchAll(/\{[^{}]+\}/g)].map((m2) => JSON.parse(m2[0]));
          if (objs.length >= 2) setLeaves(objs.slice(0, 2));
        } catch { /* leave leaves null; the feed line itself still shows the data */ }
      }
      if (ev.kind === "settle") {
        setWaiting(null);
        setSettleSig(ev.sig);
        loadCtx(); // re-read on-chain state so the ticket shows the real Settled account
      }
    };
    return () => { alive = false; es.close(); };
  }, [wagerAddress]);

  if (!wagerAddress) {
    return <div className="live-error mono">?live needs a wager: add &wager=&lt;address&gt; to the URL</div>;
  }

  const settled = settleSig != null;
  const score = leaves && [leaves[0].value, leaves[1].value];
  const ticket = ctx && {
    address: ctx.address,
    fixtureId: ctx.fixtureId,
    home: ctx.fixture?.home ?? `P1 (fixture ${ctx.fixtureId})`,
    away: ctx.fixture?.away ?? "P2",
    kickoff: ctx.fixture?.kickoff ?? "",
    finalScore: settled ? score : null,
    maker: ctx.maker,
    taker: ctx.taker,
    stakeLamports: ctx.stakeLamports,
    tipLamports: 100_000,
    state: settled ? "settled" : ctx.state,
    settleSig: settleSig ?? "",
    settler: botPk,
    provenLeaves: leaves ?? [],
    terminalSeq: null,
  };

  return (
    <div className="settlement">
      <div className="settlement-head">
        <h2 className="display settlement-title">Settlement, live</h2>
        <span className="mono live-chip">
          <span className={conn === "open" ? "live-dot live-dot-on" : "live-dot"} />
          LIVE · {conn === "open" ? "relay connected" : conn === "connecting" ? "connecting…" : "RELAY OFFLINE"}
        </span>
      </div>

      {conn === "offline" && (
        <div className="live-error mono">
          Relay unreachable at {RELAY}. Start it from the repo root:
          node bot/live-relay.mjs --log live.log
          (and run the bot with: node bot/settle-bot.mjs --wager {wagerAddress} &gt; live.log)
        </div>
      )}
      {ctxError && (
        <div className="live-error mono">Could not load wager from chain: {ctxError}</div>
      )}

      <div className="settlement-columns">
        <div className={settled ? "ticket-wrap ticket-wrap-settled" : "ticket-wrap"}>
          {ticket ? (
            <>
              {settled && score && (
                <div className="live-settled-line mono">
                  final {ticket.home} {score[0]}-{score[1]} {ticket.away} · pot{" "}
                  {lamportsToSol(2 * ticket.stakeLamports)} SOL released
                </div>
              )}
              <Ticket wager={ticket} />
            </>
          ) : (
            !ctxError && <div className="feed-idle mono">loading wager from chain…</div>
          )}
        </div>

        <section className="feed" aria-live="polite">
          <div className="microlabel feed-label">Bot log, live tail: anyone can run this</div>
          {waiting && !settled && (
            <div className="live-waiting mono">
              {waiting.kind === "waitroot"
                ? "WAITING FOR ON-CHAIN ROOT: devnet posts terminal roots up to ~45 min late. The bot retries; nothing is fabricated."
                : "WAITING FOR PROOF: the terminal leaf is not served yet. The bot retries; nothing is fabricated."}
            </div>
          )}
          <div className="feed-rows">
            {events.length === 0 && (
              <div className="feed-idle mono">
                no bot output yet; the log tail starts the moment the bot writes a line
              </div>
            )}
            {events.map((ev, i) => (
              <div key={i} className={`feed-row feed-row-${ev.kind === "waitroot" || ev.kind === "waitproof" ? "bot" : ev.kind}`}>
                <span className="mono feed-tag">{KIND_TAG[ev.kind]}</span>
                <span className="mono feed-text">{ev.body}</span>
              </div>
            ))}
            {settled && (
              <div className="climax display">
                SETTLED BY PROOF: no oracle, no admin, no human signed this.
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
