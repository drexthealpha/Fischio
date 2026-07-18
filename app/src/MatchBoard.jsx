// The board for one match: every market TxODDS prices on it.
//
// The first version stacked all three ladders at once, about thirty rows, with fourteen of them
// carrying a loud "no fair price" warning and a paragraph of explanation underneath. It read like
// an error log. This is built the way a trading screen is: one market family at a time, the lines
// you can act on given priority, and the split-stake lines folded away until you ask for them.
//
// Two facts the layout still has to be honest about. A price from the feed is not the same as a
// pool you can trade, so those are dim and not clickable. And a quarter line splits your stake
// across two lines with no single fair price, so it is hidden by default and shown only as raw
// odds when expanded, never dressed up as a percentage we do not have.
import { useEffect, useMemo, useState } from "react";
import { fetchBoard } from "./market.js";

const TYPE_NAME = {
  "1X2_PARTICIPANT_RESULT": "Result",
  OVERUNDER_PARTICIPANT_GOALS: "Total goals",
  ASIANHANDICAP_PARTICIPANT_GOALS: "Handicap",
};
const ORDER = ["1X2_PARTICIPANT_RESULT", "OVERUNDER_PARTICIPANT_GOALS", "ASIANHANDICAP_PARTICIPANT_GOALS"];
const PERIOD_ORDER = ["FT", "H1"];
const PERIOD_TITLE = { FT: "Full match", H1: "First half" };

const cents = (p) => (p == null ? "" : `${Math.round(p * 100)}¢`);
const lineLabel = (m) =>
  m.line == null ? "" : m.type === "ASIANHANDICAP_PARTICIPANT_GOALS" ? `${m.line > 0 ? "+" : ""}${m.line}` : `${m.line}`;

const nameOf = (raw, home, away) => {
  const n = String(raw).toLowerCase();
  if (n === "part1") return home ?? "Home";
  if (n === "part2") return away ?? "Away";
  if (n === "draw") return "Draw";
  return raw.charAt(0).toUpperCase() + raw.slice(1);
};

// One price. A live pool is a button; a feed-only price is quiet and static.
function Cell({ o, home, away, tradeable, onClick }) {
  const cls = tradeable ? "bd-cell bd-cell-live" : "bd-cell bd-cell-feed";
  const inner = (
    <>
      <span className="bd-cell-price display">{cents(o.prob)}</span>
      <span className="bd-cell-odds mono">{o.odds?.toFixed(2)}</span>
    </>
  );
  return tradeable ? (
    <button className={cls} onClick={onClick} title={`Buy ${nameOf(o.name, home, away)}`}>{inner}</button>
  ) : (
    <div className={cls} title="Feed price. No pool open on this line yet.">{inner}</div>
  );
}

export default function MatchBoard({ fixtureId, home, away, tradeableKeys, onTrade }) {
  const [board, setBoard] = useState(null);
  const [state, setState] = useState("loading");
  const [tab, setTab] = useState(null);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    if (!fixtureId) return;
    let alive = true;
    const load = async () => {
      const b = await fetchBoard(fixtureId);
      if (!alive) return;
      setBoard(b);
      setState(b ? "ok" : "down");
    };
    load();
    const t = setInterval(load, 20_000); // matches the ingestion poll; faster only repeats numbers
    return () => { alive = false; clearInterval(t); };
  }, [fixtureId]);

  const types = useMemo(() => (board ? ORDER.filter((t) => Object.keys(board.groups[t] ?? {}).length) : []), [board]);
  const active = tab && types.includes(tab) ? tab : types[0];

  if (state === "loading") return <p className="empty-state">Loading the board</p>;
  if (state === "down" || !board) {
    return <p className="empty-state">Prices for this match are unavailable right now.</p>;
  }

  const byPeriod = board.groups[active] ?? {};
  const periods = [...PERIOD_ORDER.filter((p) => byPeriod[p]?.length),
    ...Object.keys(byPeriod).filter((p) => !PERIOD_ORDER.includes(p))];

  // Column headers are the outcome names, from the first priced line in this family.
  const sample = periods.flatMap((p) => byPeriod[p]).find((m) => m.demargined) ?? periods.flatMap((p) => byPeriod[p])[0];
  const cols = (sample?.outcomes ?? []).map((o) => nameOf(o.name, home, away));
  const gridCols = `54px repeat(${cols.length}, 1fr)`;

  const hiddenCount = periods.flatMap((p) => byPeriod[p]).filter((m) => !m.demargined).length;

  const ageTxt = board.ageSeconds == null ? "" : board.ageSeconds < 90 ? `${board.ageSeconds}s ago` : `${Math.round(board.ageSeconds / 60)} min ago`;

  return (
    <section className="bd">
      <header className="bd-head">
        <div className="bd-tabs" role="tablist">
          {types.map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={t === active}
              className={t === active ? "bd-tab bd-tab-on" : "bd-tab"}
              onClick={() => setTab(t)}
            >
              {TYPE_NAME[t] ?? t}
            </button>
          ))}
        </div>
        {ageTxt && (
          <span className="bd-age mono" title={`Service level ${board.serviceLevel}, about 60 seconds behind live.`}>
            priced {ageTxt}
          </span>
        )}
      </header>

      {periods.map((p) => {
        const rows = [...byPeriod[p]]
          .filter((m) => showAll || m.demargined)
          .sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
        if (!rows.length) return null;
        return (
          <div key={p} className="bd-period">
            {periods.length > 1 && <div className="bd-period-title microlabel">{PERIOD_TITLE[p] ?? p}</div>}
            <div className="bd-table" style={{ "--bd-cols": gridCols }}>
              <div className="bd-row bd-row-head" style={{ gridTemplateColumns: gridCols }}>
                <span className="bd-line" />
                {cols.map((c) => <span key={c} className="bd-colname">{c}</span>)}
              </div>
              {rows.map((m) => {
                const label = lineLabel(m) || "win";
                if (!m.demargined) {
                  // a split-stake line: raw odds only, dim, honest that there is no fair price
                  return (
                    <div key={m.key} className="bd-row bd-row-split" style={{ gridTemplateColumns: gridCols }} title="Quarter line: your stake splits across two lines, so there is no single fair price.">
                      <span className="bd-line mono">{label}</span>
                      {m.outcomes.map((o) => (
                        <span key={o.name} className="bd-cell bd-cell-split mono">{o.odds?.toFixed(2)}</span>
                      ))}
                    </div>
                  );
                }
                return (
                  <div key={m.key} className="bd-row" style={{ gridTemplateColumns: gridCols }}>
                    <span className="bd-line mono">{label}</span>
                    {m.outcomes.map((o) => (
                      <Cell
                        key={o.name}
                        o={o}
                        home={home}
                        away={away}
                        tradeable={!!tradeableKeys?.has?.(m.key)}
                        onClick={() => onTrade?.(m, o)}
                      />
                    ))}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}

      {hiddenCount > 0 && (
        <button className="bd-more" onClick={() => setShowAll((v) => !v)}>
          {showAll ? "Hide split-stake lines" : `Show ${hiddenCount} more line${hiddenCount === 1 ? "" : "s"}`}
        </button>
      )}
    </section>
  );
}
