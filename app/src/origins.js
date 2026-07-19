// Where the front end finds each backend service.
//
// One module, because this was previously spread across a dozen files. Eight of them read a VITE_
// variable and six hardcoded a localhost port with no way to override it outside a query string.
// The six would have built cleanly on Vercel and fetched nothing, which is the worst kind of
// deployment failure: the page renders, the panels are empty, and nothing in the build log says why.
//
// TWO SHAPES, ONE SET OF NAMES
//
// In local development each service listens on its own port. On a hosted panel the container gets
// exactly one public port, so lib/gateway.mjs puts every service behind path prefixes on the
// ingest. These are the same services either way, so the difference is confined to this file.
//
//   local          deployed
//   :8795          BASE            ingest, the TxLINE feed layer
//   :8790          BASE/api        markets, books, settlements
//   :8792          BASE/indexer    leaderboard, history, pnl
//   :8791          BASE/relayer    gasless submission
//   :8793          BASE/sponsor    onboarding
//
// MIXED CONTENT
//
// A page served over https cannot fetch http, and the browser blocks it before the request is made.
// A hosted panel gives you an ip and a port, not a certificate, so pointing a Vercel deployment
// straight at the backend origin fails for every call even when every variable is set correctly.
// The deployment answer is to leave VITE_BASE empty and let vercel.json rewrite same-origin paths
// through to the backend, which is why an empty base resolves to relative paths rather than to
// localhost.

const params = new URLSearchParams(typeof window === "undefined" ? "" : window.location.search);

/** Query string wins, then the build-time variable, then the default. Blank counts as unset. */
const pick = (name, envValue, fallback) => {
  for (const candidate of [params.get(name), envValue]) {
    if (candidate != null && String(candidate).trim() !== "") return String(candidate).replace(/\/+$/, "");
  }
  return fallback;
};

// The single origin every service sits behind, when one is given.
const BASE = pick("base", import.meta.env.VITE_BASE, null);

// What an unconfigured build should point at, which is not the same answer in both directions.
//
// A development run wants the local ports, because that is where the services are. A production
// build wants same-origin relative paths, because vercel.json rewrites each prefix through to the
// backend server side: the browser only ever talks to the page's own https origin, so an http
// backend never triggers the mixed-content block that would otherwise fail every request.
//
// Defaulting to localhost in both cases is what the first version of this file did, and it would
// have shipped a bundle that fetches 127.0.0.1 from a public site. It builds, it deploys, every
// panel is empty, and nothing in the build log mentions it. VITE_API is set in a gitignored
// .env.local here, so it is present locally and absent on Vercel, which is precisely the case that
// would have gone unnoticed until someone opened the deployed page.
const under = (prefix, localPort) => {
  if (BASE != null) return `${BASE}${prefix}`;
  return import.meta.env.PROD ? prefix : `http://127.0.0.1:${localPort}`;
};

export const INGEST = pick("ingest", import.meta.env.VITE_INGEST, under("", 8795));
export const API = pick("api", import.meta.env.VITE_API, under("/api", 8790));
export const INDEXER = pick("indexer", import.meta.env.VITE_INDEXER, under("/indexer", 8792));
export const RELAYER = pick("relayer", import.meta.env.VITE_RELAYER, under("/relayer", 8791));
export const SPONSOR = pick("sponsor", import.meta.env.VITE_SPONSOR, under("/sponsor", 8793));

/** Solana RPC. A paid endpoint belongs in the environment, never committed. */
export const RPC = pick("rpc", import.meta.env.VITE_RPC, "https://api.devnet.solana.com");

/** What the status page shows an operator, so a misconfigured deployment is visible in the UI. */
export const origins = () => ({ base: BASE ?? "(same origin)", ingest: INGEST, api: API, indexer: INDEXER, relayer: RELAYER, sponsor: SPONSOR });
