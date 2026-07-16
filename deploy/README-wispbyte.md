# Deploy the fischio live layer on Wispbyte

Wispbyte gives a free 24/7 container you drive from a web panel: pick a runtime image, set
environment variables, upload files, and set a start command. This runs the always-on services
so the platform keeps ingesting TxLINE and tracking the line even when your laptop is off.

The React app is a static build and is hosted separately (Vercel, Netlify, or Cloudflare
Pages). Only the Node services below run on Wispbyte.

## What runs here

`deploy/start-all.mjs` is one supervisor that launches and auto-restarts:

- **ingest** (port 8795) holds the TxLINE odds and scores streams open and polls the snapshots
- **api** (port 8790) serves markets, books, and prices to the app
- **keeper** trades the AMM back to the live TxLINE line whenever the odds move
- **seed** refreshes the fixture list and opens a 1X2 market for any upcoming match the moment
  TxLINE prices it, so the board fills itself with no human step
- **relayer** and **sponsor** power gasless trading and zero-SOL onboarding
- **indexer** records trade history

On a small free box, run the core four first: set `FISCHIO_SERVICES=ingest,api,keeper,seed`.

## Steps

1. **Create a server** on the Wispbyte panel and choose the **Node.js** image.
2. **Upload the code.** Point the panel at this git repo, or upload a zip of it, then in the
   console run `npm install` at the repo root and inside `services/ingest`, `services/api`,
   `services/relayer`, `services/sponsor`, and `services/indexer`.
3. **Upload the secrets by hand** (they are gitignored and must never be committed):
   - `day1/devnet-wallet.json` (the keeper and seeders sign with this)
   - `day1/credentials.json` (TxLINE guest + api token) or set the env vars in step 4
   - `day1/devnet-usdc.json`
   - `services/relayer/relayer-key.json`, `services/sponsor/sponsor-key.json`
4. **Set environment variables** in the panel:
   - `RPC` = your Helius devnet URL (the free public RPC blocks getProgramAccounts)
   - `INGEST` = `http://127.0.0.1:8795`
   - `TXLINE_JWT`, `TXLINE_API_TOKEN` (only if you did not upload `day1/credentials.json`)
   - optional `FISCHIO_SERVICES` = `ingest,api,keeper` to run a subset on a small box
5. **Set the start command** to `node deploy/start-all.mjs` and start the server.
6. **Expose the API** so the app can reach it. Note the public host and port the panel gives
   the container, then point the app at it with `VITE_API` and `VITE_INGEST` in the app's host
   (Vercel/Netlify env), for example `VITE_API=https://<your-box>:8790`.

## The front end on Vercel

The app is a static Vite build with two serverless functions (`app/api/fixtures.js` and
`app/api/scores.js`) that call TxLINE with your credentials, so the browser never sees a token.

1. **Import the repo** on Vercel and set the **Root Directory** to `app`.
2. **Build** is `npm run build`, output `dist` (Vercel detects Vite).
3. **Environment variables:**
   - `VITE_RPC` = your Helius devnet URL (on-chain reads).
   - `VITE_INGEST` = the public Wispbyte ingest URL, for the live 1X2 line, e.g.
     `https://<your-box>:8795`.
   - `TXLINE_JWT`, `TXLINE_API_TOKEN` = read by the serverless functions so live fixtures and
     scores work without a wallet or a token in the browser. These match the judge instruction
     that the demo runs with no wallet and no fees.
4. **Deploy.** The board reads fixtures and scores from its own `/api/*`, the live line from
   `VITE_INGEST`, and everything else straight from chain.

The two halves meet at one seam: the front end points `VITE_INGEST` at the Wispbyte box, and the
Wispbyte seed loop opens the markets that box's ingest priced. Nothing else connects them.

## Check it is live

The panel console should show `[supervisor] started ingest`, then `odds stream: connecting`.
Hit `http://<your-box>:8795/health` and `http://<your-box>:8795/live`; every fixture should
report an `oddsAt` and `scoresAt` within the last minute. If a value is older than a couple of
minutes, the feed stalled and the supervisor will have logged the restart.

## Note on the free tier

TxLINE's free World Cup tier samples every ~60 seconds, so the freshest the data can be is
about a minute old. A paid tier and the SSE streams push faster. The supervisor and the
timestamps make any staleness visible rather than silent.
