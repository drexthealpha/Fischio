import { useState } from "react";
import { lamportsToSol, shortKey } from "./data.js";
import Flag from "./Flag.jsx";
import Barcode from "./Barcode.jsx";
import SolLink from "./SolLink.jsx";
import ProofPanel from "./ProofPanel.jsx";
import BoxScore from "./BoxScore.jsx";

const PHASE_NAMES = { 5: "FULL TIME", 10: "AFTER EXTRA TIME", 13: "AFTER PENALTIES" };

// feed phase codes -> short board chips (confirmed from real feed data, RECON.md)
const LIVE_PHASE = {
  1: "PRE", 2: "H1", 3: "HT", 4: "H2", 5: "FT", 6: "ET", 7: "ET1", 8: "ET·HT",
  9: "ET2", 10: "AET", 11: "PENS", 12: "PENS", 13: "AET·P", 100: "FINAL",
};
const IN_PLAY = new Set([2, 3, 4, 6, 7, 8, 9, 11, 12]);

function Field({ label, children, mono = true }) {
  return (
    <div className="field">
      <div className="microlabel">{label}</div>
      <div className={mono ? "mono field-value" : "field-value"}>{children}</div>
    </div>
  );
}

export default function Ticket({ wager, live, stats }) {
  const [showProof, setShowProof] = useState(false);
  const settled = wager.state === "settled";
  const pot = 2 * wager.stakeLamports;
  const showLive = !settled && !wager.finalScore && live?.goals;
  const minute = live?.clockSeconds != null ? `${Math.floor(live.clockSeconds / 60)}'` : "";

  return (
    <article className={`ticket ${settled ? "ticket-settled" : ""}`}>
      {/* scoreboard register */}
      <header className="ticket-board">
        <div className="board-row">
          <span className="display board-team"><Flag team={wager.home} size={22} /> {wager.home}</span>
          {wager.finalScore ? (
            <span className="display board-score">
              {wager.finalScore[0]}-{wager.finalScore[1]}
            </span>
          ) : showLive ? (
            <span className="display board-score">
              {live.goals[0]}-{live.goals[1]}
            </span>
          ) : (
            <span className="display board-score board-score-tbd">v</span>
          )}
          <span className="display board-team board-team-away">{wager.away} <Flag team={wager.away} size={22} /></span>
        </div>
        <div className="board-meta mono">
          {settled && <span className="board-ft">FT</span>}
          {showLive && IN_PLAY.has(live.statusId) && (
            <span className="live-tag">
              <span className="live-tag-dot" />
              LIVE · {LIVE_PHASE[live.statusId] ?? ""} {minute}
            </span>
          )}
          {showLive && !IN_PLAY.has(live.statusId) && LIVE_PHASE[live.statusId] && (
            <span className="board-ft">{LIVE_PHASE[live.statusId]}</span>
          )}
          <span>{wager.kickoff}</span>
          <span>FIXTURE {wager.fixtureId}</span>
        </div>
      </header>

      <p className="ticket-terms"><strong>{wager.home} to beat {wager.away}</strong></p>

      <div className="ticket-fields">
        <Field label={`Backing ${wager.home}`}>
          <SolLink account={wager.maker}>{shortKey(wager.maker)}</SolLink>
        </Field>
        <Field label="Against">
          {wager.state === "open" ? (
            "open: yours to take"
          ) : (
            <SolLink account={wager.taker}>{shortKey(wager.taker)}</SolLink>
          )}
        </Field>
        <Field label="Bet size">{lamportsToSol(wager.stakeLamports)} SOL</Field>
        <Field label="Winner takes">{lamportsToSol(pot)} SOL</Field>
      </div>

      {/* perforation between ticket body and receipt stub */}
      <div className="perforation" aria-hidden="true" />

      {/* receipt register */}
      <footer className="ticket-stub">
        {settled ? (
          <>
            <div className="stub-head">
              <span className="stamp display">SETTLED BY PROOF</span>
              <span className="stub-note">no oracle · no admin · no human signature</span>
            </div>
            {wager.provenLeaves?.length >= 2 && (
              <div className="stub-leaves mono">
                goals[{wager.home}]={wager.provenLeaves[0].value} ·
                goals[{wager.away.split(" ")[0]}]={wager.provenLeaves[1].value} ·
                phase={wager.provenLeaves[0].period} ({PHASE_NAMES[wager.provenLeaves[0].period]})
              </div>
            )}
            <div className="stub-sig">
              <div className="microlabel">Settlement transaction · click to verify</div>
              <SolLink tx={wager.settleSig} className="stub-sig-value">
                {wager.settleSig}
              </SolLink>
            </div>
            <BoxScore home={wager.home} away={wager.away} stats={stats} />
            <div className="stub-settler mono">
              settled permissionlessly by{" "}
              {wager.settler ? (
                <SolLink account={wager.settler}>{shortKey(wager.settler)}</SolLink>
              ) : (
                "an ordinary keypair"
              )}{" "}
              · tip {lamportsToSol(wager.tipLamports)} SOL
            </div>
            {wager.proof?.statA?.statProof?.length > 0 && (
              <div className="ticket-verify">
                <button type="button" className="ticket-verify-btn" onClick={() => setShowProof((v) => !v)}>
                  {showProof ? "hide proof" : "verify this settlement in your browser"}
                </button>
                {showProof && <ProofPanel bundle={wager.proof} />}
              </div>
            )}
            <Barcode data={wager.settleSig} />
          </>
        ) : (
          <div className="stub-head">
            <span className="stamp stamp-pending display">AWAITING FULL TIME</span>
            <span className="stub-note">anyone may settle this ticket with a TxLINE proof</span>
          </div>
        )}
      </footer>
    </article>
  );
}
