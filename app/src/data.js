// Program constants and display helpers. All wager, settlement, and fixture DATA
// is read live: chain state via chain.js, fixtures via the serverless proxy.
export const PROGRAM_ID = "FVVSa2AcwxBdmtKxFHiZMmd2ceRWorh7ZDdppvPsPvxb";
export const TXORACLE_ID = "6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J";
// fischio's one shared devnet test-USDC (scripts/create-devnet-usdc.mjs). Every market
// defaults to this so collateral isn't fragmented across a fresh orphan token per market.
// Devnet only; this is not a token fischio controls the supply of on mainnet.
export const DEVNET_USDC = "rRsB6zN2rht5b2CdEFArhosMdaKVLyX7uePLfuAYHc9";

export const lamportsToSol = (n) => (n / 1e9).toLocaleString("en-US", { maximumFractionDigits: 4 });
export const shortKey = (k) => `${k.slice(0, 4)}…${k.slice(-4)}`;

// Money in bettor language: "$1,006", not "1006.37 USDC". Input is a plain USDC amount.
export const usd = (n) => `$${Number(n).toLocaleString("en-US", { maximumFractionDigits: Math.abs(n) < 100 ? 2 : 0 })}`;
// Is this pubkey the viewer's own wallet? Then show "you" instead of a raw key.
export const nameOf = (key, me) => (me && key === me ? "you" : shortKey(key));

// Solscan devnet deep links: every id the UI shows must be one click from proof
export const solscanTx = (sig) => `https://solscan.io/tx/${sig}?cluster=devnet`;
export const solscanAccount = (a) => `https://solscan.io/account/${a}?cluster=devnet`;
