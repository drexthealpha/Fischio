// A finished match's full stat line, read from the TxLINE scores feed. Goals settle the
// wager; corners and cards are the same stat keys the prop markets resolve on (1/2 goals,
// 3/4 yellow cards, 5/6 red cards, 7/8 corners), so this is the box score behind every
// market on the fixture. Renders nothing until the scores feed provides stats, so it stays
// quiet in local dev where the serverless scores proxy has no credentials.
const ROWS = [
  { key: "goals", label: "Goals" },
  { key: "corners", label: "Corners" },
  { key: "yellow", label: "Yellow cards" },
  { key: "red", label: "Red cards" },
];

export default function BoxScore({ home, away, stats }) {
  const rows = ROWS.filter((r) => Array.isArray(stats?.[r.key]));
  if (rows.length === 0) return null;
  return (
    <div className="boxscore">
      <div className="boxscore-head mono">
        <span className="boxscore-team">{home}</span>
        <span className="boxscore-label">match stats</span>
        <span className="boxscore-team boxscore-team-away">{away}</span>
      </div>
      {rows.map((r) => {
        const [h, a] = stats[r.key];
        return (
          <div className="boxscore-row mono" key={r.key}>
            <span className={`boxscore-h${h > a ? " boxscore-lead" : ""}`}>{h}</span>
            <span className="boxscore-stat">{r.label}</span>
            <span className={`boxscore-a${a > h ? " boxscore-lead" : ""}`}>{a}</span>
          </div>
        );
      })}
    </div>
  );
}
