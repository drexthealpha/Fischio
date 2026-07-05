import { lamportsToSol, shortKey } from "./data.js";
import Barcode from "./Barcode.jsx";

const PHASE_NAMES = { 5: "FULL TIME", 10: "AFTER EXTRA TIME" };

function Field({ label, children, mono = true }) {
  return (
    <div className="field">
      <div className="microlabel">{label}</div>
      <div className={mono ? "mono field-value" : "field-value"}>{children}</div>
    </div>
  );
}

export default function Ticket({ wager }) {
  const settled = wager.state === "settled";
  const pot = 2 * wager.stakeLamports;

  return (
    <article className={`ticket ${settled ? "ticket-settled" : ""}`}>
      {/* scoreboard register */}
      <header className="ticket-board">
        <div className="board-row">
          <span className="display board-team">{wager.home}</span>
          {wager.finalScore ? (
            <span className="display board-score">
              {wager.finalScore[0]}–{wager.finalScore[1]}
            </span>
          ) : (
            <span className="display board-score board-score-tbd">v</span>
          )}
          <span className="display board-team board-team-away">{wager.away}</span>
        </div>
        <div className="board-meta mono">
          {settled && <span className="board-ft">FT</span>}
          <span>{wager.kickoff}</span>
          <span>FIXTURE {wager.fixtureId}</span>
        </div>
      </header>

      {/* the bet, in plain football English */}
      <p className="ticket-terms">
        <strong>{wager.home} to beat {wager.away}</strong>: 90 minutes + extra time,
        penalties excluded. Maker wins if the predicate holds at the final whistle;
        otherwise the taker collects (a shootout counts as the taker&#8217;s win).
      </p>

      <div className="ticket-fields">
        <Field label="Maker · backs the bet">{shortKey(wager.maker)}</Field>
        <Field label="Taker · against">{shortKey(wager.taker)}</Field>
        <Field label="Stake each">{lamportsToSol(wager.stakeLamports)} SOL</Field>
        <Field label="Pot">{lamportsToSol(pot)} SOL</Field>
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
              <div className="microlabel">Settlement transaction</div>
              <div className="mono stub-sig-value">{wager.settleSig}</div>
            </div>
            <div className="stub-settler mono">
              settled permissionlessly by {shortKey(wager.settler)} · tip{" "}
              {lamportsToSol(wager.tipLamports)} SOL
            </div>
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
