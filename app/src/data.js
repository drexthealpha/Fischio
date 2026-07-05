// Real captured data from our stack: the settled demo wager on the local validator
// (bot dry-run 2026-07-03) and real World Cup 2026 fixtures from the TxLINE devnet
// free tier. Live RPC reads replace the static wager in the settlement screen wiring.

export const PROGRAM_ID = "FVVSa2AcwxBdmtKxFHiZMmd2ceRWorh7ZDdppvPsPvxb";
export const TXORACLE_ID = "6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J";

export const SETTLED_WAGER = {
  address: "HEaV9oSmogZoEEa7p2NVQRfcD6HDzLjfYi7YvRmrKpzH",
  fixtureId: 18172379,
  home: "USA",
  away: "Bosnia & Herzegovina",
  kickoff: "2026-07-02 00:00 UTC",
  finalScore: [2, 0],
  maker: "HGFLCUjPk2Pfonwmb7BiGtsoQr767xgyJbf6b9i9W5bn",
  taker: "2hf9iVoTVybzmTkPBmRFjAqEpvpqS4SKUprDCNCGVjho",
  stakeLamports: 10_000_000,
  tipLamports: 100_000,
  state: "settled",
  settleSig:
    "5Hm4fJmqAN6Pk6tSqK293yois6PePzR7TpY9Xtg2Sf9n94P3dDP9gCNoinnp1tyREKxnkVLF4Rc1eqAFYmXWeaM9",
  settler: "CTpEUqmyWvziXzMWHT4CPH52eWti7U8LvDpAZiqJHSm8",
  provenLeaves: [
    { key: 1, value: 2, period: 5 },
    { key: 2, value: 0, period: 5 },
  ],
  terminalSeq: 1054,
};

// Upcoming/played fixtures from the devnet free tier (fetched 2026-07-02/03)
export const FIXTURES = [
  { id: 18175918, home: "Argentina", away: "Cape Verde", kickoff: "2026-07-03 22:00 UTC" },
  { id: 18176123, home: "Australia", away: "Egypt", kickoff: "2026-07-03 18:00 UTC" },
  { id: 18179549, home: "Colombia", away: "Ghana", kickoff: "2026-07-04 01:30 UTC" },
  { id: 18185036, home: "Canada", away: "Morocco", kickoff: "2026-07-04 17:00 UTC" },
  { id: 18188721, home: "Paraguay", away: "France", kickoff: "2026-07-04 21:00 UTC" },
  { id: 18187298, home: "Brazil", away: "Norway", kickoff: "2026-07-05 20:00 UTC" },
  { id: 18192996, home: "Mexico", away: "England", kickoff: "2026-07-06 00:00 UTC" },
  { id: 18193785, home: "USA", away: "Belgium", kickoff: "2026-07-07 00:00 UTC" },
];

export const lamportsToSol = (n) => (n / 1e9).toLocaleString("en-US", { maximumFractionDigits: 4 });
export const shortKey = (k) => `${k.slice(0, 4)}…${k.slice(-4)}`;

// The genuine recorded sequence from the settlement-bot dry run (2026-07-03, local
// validator + real TxLINE devnet data). Score lines come from the real USA-Bosnia
// feed history; bot lines are the bot's actual log output. `at` = ms into the replay.
export const REPLAY_EVENTS = [
  { at: 0,     kind: "bot",   text: "bot CTpEUqmy…JHSm8 watching fixture 18172379 (an ordinary keypair, no special authority)" },
  { at: 900,   kind: "score", text: "seq 447 · 49:12 · GOAL: USA 1-0 (H2)" },
  { at: 1800,  kind: "score", text: "seq 850 · 79:59 · USA 1–0 · red card USA · corners 4–3" },
  { at: 2700,  kind: "score", text: "seq 1050 · 99:43 · GOAL: USA 2-0" },
  { at: 3600,  kind: "ft",    text: "seq 1054 · FULL TIME: USA 2-0 Bosnia & Herzegovina (phase 5)" },
  { at: 4400,  kind: "bot",   text: "proof pulled: goals[USA]=2 · goals[BIH]=0 · phase=5 · 3 Merkle paths vs on-chain root" },
  { at: 5200,  kind: "bot",   text: "settle sent with 400k CU budget; verifying inside txoracle via CPI…" },
  { at: 6100,  kind: "settle", text: "SETTLED: 5Hm4fJmqAN6Pk6tSqK293yois6PePzR7TpY9Xtg2Sf9n94P3dDP9gCNoinnp1tyREKxnkVLF4Rc1eqAFYmXWeaM9" },
];
