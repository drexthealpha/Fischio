// Program constants and display helpers. All wager, settlement, and fixture DATA
// is read live: chain state via chain.js, fixtures via the serverless proxy.
export const PROGRAM_ID = "FVVSa2AcwxBdmtKxFHiZMmd2ceRWorh7ZDdppvPsPvxb";
export const TXORACLE_ID = "6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J";

export const lamportsToSol = (n) => (n / 1e9).toLocaleString("en-US", { maximumFractionDigits: 4 });
export const shortKey = (k) => `${k.slice(0, 4)}…${k.slice(-4)}`;

// Solscan devnet deep links: every id the UI shows must be one click from proof
export const solscanTx = (sig) => `https://solscan.io/tx/${sig}?cluster=devnet`;
export const solscanAccount = (a) => `https://solscan.io/account/${a}?cluster=devnet`;
