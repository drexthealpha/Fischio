// "Verify it yourself": the whole trust claim, made checkable in your browser.
//
// A settlement proves a score with a Merkle leaf: SHA-256 of the raw stat bytes, folded
// up a sibling path to a root TxLINE committed on Solana. This panel does that fold here,
// live, with the Web Crypto API and nothing else, and shows it reproduces the committed
// root byte-for-byte. Then it hands you the numbers: change the score and watch the root
// diverge. That is why a forged result cannot settle. The money is bound to the hash. No
// claim about the score can move it.
import { useState, useEffect, useMemo } from "react";
import { verifyBundle } from "./verifyProof.js";
import { SAMPLE_PROOF } from "./sampleProof.js";

const PHASE = {
  5: "Full time", 10: "After extra time", 13: "After penalties",
  0: "Running total", 12: "During shootout",
};
const clip = (h) => (h ? h.slice(0, 12) + "…" + h.slice(-10) : "");

function Row({ label, hash, state, note }) {
  const rowClass = state === "bad" ? "pf-row-bad" : state === "ok" ? "pf-row-ok" : state === "absence" ? "pf-row-absence" : "";
  const noteClass = state === "bad" ? "pf-bad" : state === "ok" ? "pf-ok" : "pf-note";
  return (
    <div className={`pf-row ${rowClass}`}>
      <span className="microlabel pf-row-label">{label}</span>
      <code className="mono pf-hash" title={hash}>{clip(hash)}</code>
      {note && <span className={`mono pf-verdict ${noteClass}`}>{note}</span>}
    </div>
  );
}

const matchNote = (ok) => (ok ? "matches committed root" : "diverges from committed root");

// One leaf's rows. A scoring leaf (value ≥ 1) shows its hash and the fold that reproduces
// the committed root. A clean sheet is an absence leaf: shown honestly as proven on-chain,
// never as a divergence, because the browser does not reproduce the empty-stat encoding.
function LeafRows({ rep, team, siblings }) {
  if (!rep) return null;
  if (rep.absence) {
    return <Row label={`${team} · clean sheet (0)`} hash={rep.committedRootHex} state="absence" note="no scoring event, proven on-chain" />;
  }
  return (
    <>
      <Row label={`SHA-256 leaf (${team})`} hash={rep.leafHex} />
      <Row label={`fold ${siblings} siblings → event root`} hash={rep.computedRootHex} state={rep.ok ? "ok" : "bad"} note={matchNote(rep.ok)} />
    </>
  );
}

export default function ProofPanel({ bundle = SAMPLE_PROOF }) {
  const original = bundle.statA.statToProve.value;
  const originalB = bundle.statB?.statToProve.value ?? null;
  const [homeGoals, setHomeGoals] = useState(original);
  const [awayGoals, setAwayGoals] = useState(originalB);
  const [report, setReport] = useState(null);

  // Rebuild the bundle with the (possibly edited) leaf values, keeping the REAL captured
  // proof path and committed root untouched. Tampering only changes the claimed number,
  // so the recomputed root stops landing on the fixed committed root.
  const working = useMemo(() => {
    const b = structuredClone(bundle);
    b.statA.statToProve.value = Number(homeGoals) || 0;
    if (b.statB) b.statB.statToProve.value = Number(awayGoals) || 0;
    return b;
  }, [bundle, homeGoals, awayGoals]);

  useEffect(() => {
    let live = true;
    verifyBundle(working).then((r) => live && setReport(r));
    return () => { live = false; };
  }, [working]);

  const tampered =
    Number(homeGoals) !== original || (originalB != null && Number(awayGoals) !== originalB);
  const reset = () => { setHomeGoals(original); setAwayGoals(originalB); };

  const m = bundle.meta ?? {};
  const phase = PHASE[bundle.statA.statToProve.period] ?? `phase ${bundle.statA.statToProve.period}`;

  return (
    <section className="proofpanel">
      <header className="pf-head">
        <div>
          <h3 className="display pf-title">Verify this settlement yourself</h3>
          <p className="pf-sub">
            SHA-256, run in your browser, no server. The score below hashes into the exact
            root TxLINE committed on Solana. Change a goal and the proof breaks.
          </p>
        </div>
        <span className="mono pf-badge">Web Crypto · SHA-256</span>
      </header>

      <div className="pf-scoreline">
        <label className="pf-team">
          <span className="pf-team-name">{m.home ?? "Home"}</span>
          <input
            className="mono pf-goal" type="number" min="0" max="20" value={homeGoals}
            onChange={(e) => setHomeGoals(e.target.value)} aria-label={`${m.home ?? "home"} goals`}
          />
        </label>
        <span className="pf-dash">–</span>
        <label className="pf-team pf-team-away">
          {bundle.statB ? (
            <input
              className="mono pf-goal" type="number" min="0" max="20" value={awayGoals}
              onChange={(e) => setAwayGoals(e.target.value)} aria-label={`${m.away ?? "away"} goals`}
            />
          ) : null}
          <span className="pf-team-name">{m.away ?? "Away"}</span>
        </label>
        <span className="mono pf-phase">{phase}</span>
      </div>

      <div className="pf-fold">
        <LeafRows rep={report?.a} team={m.home ?? "home"} siblings={bundle.statA.statProof.length} />
        {report?.b && <LeafRows rep={report.b} team={m.away ?? "away"} siblings={bundle.statB?.statProof.length} />}
        <Row label="TxLINE committed event-stat root" hash={report?.a.committedRootHex} />
        {report?.subTree && (
          <Row label="event root → signed batch sub-tree root" hash={report.subTree.computedRootHex} state={report.subTree.ok ? "ok" : "bad"} note={matchNote(report.subTree.ok)} />
        )}
      </div>

      {report && (
        <div className={`pf-result ${report.allOk ? "pf-result-ok" : "pf-result-bad"}`}>
          {report.allOk ? (
            <>
              <strong>Reproduced.</strong> The scoring {report.b && (report.a.absence || report.b.absence) ? "goal hashes" : "goals hash"} to the exact
              event-stat root TxLINE committed, which folds into the sub-tree root in its
              signed batch summary{report.a.absence || report.b?.absence ? "; the clean sheet is proven on-chain by an empty-stat leaf" : ""}.
              The on-chain settlement verified that same root against TxLINE's daily root
              posted on Solana before paying. Open the transaction below to see it. You just
              checked the result without trusting us.
            </>
          ) : (
            <>
              <strong>Broken.</strong> The recomputed root no longer matches the committed
              root. A settlement carrying this leaf is rejected on-chain. This is why a forged
              score cannot move the money{tampered ? ". Reset to see the genuine proof." : "."}
            </>
          )}
          {tampered && (
            <button type="button" className="pf-reset" onClick={reset}>reset to the real score</button>
          )}
        </div>
      )}

      {m.settleSig && (
        <a
          className="mono pf-onchain"
          href={`https://solscan.io/tx/${m.settleSig}?cluster=devnet`}
          target="_blank" rel="noreferrer"
        >
          open the on-chain settlement that used this proof →
        </a>
      )}
    </section>
  );
}
