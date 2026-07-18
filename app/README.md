# The fischio web app

React and Vite. This is the screen most people will use, and none of it is the source of truth.
Every price comes from the TxLINE feed and every position is read from Solana. If this app is
switched off, the markets, the proofs and the settlements all still work, and the `fischio`
command line tool reaches them without it.

## Running it

    npm install
    npm run dev

It expects three services. Start them from the repo root first:

    node services/ingest/server.mjs     # the TxLINE feed, port 8795
    node services/api/server.mjs        # markets and books, port 8790
    node services/indexer/server.mjs    # trade history and the trader table, port 8792

Point a local build at a different backend with query parameters, which is the quickest way to
check a deployed one:

    http://localhost:5173/?ingest=http://127.0.0.1:8795&indexer=http://127.0.0.1:8792

For anything permanent, set `VITE_INGEST`, `VITE_API`, `VITE_INDEXER` and `VITE_RPC` in
`app/.env.local`, which is gitignored. Placeholders are in `.env.example` at the repo root.

## How it is laid out

- `Market.jsx` is the board and a single market's page. `MatchBoard.jsx` under it lists every line
  TxODDS prices on that fixture and marks which ones have a pool you can actually trade.
- `OrderBook.jsx` shows one market's own on-chain book. It never falls back to another market's
  depth, so an empty book renders as empty instead of borrowing numbers from elsewhere.
- `LiveMatch.jsx` is the in-play view, with `Lineups.jsx` under it.
- `Portfolio.jsx` is positions, realised profit and head to head wagers.
- `Traders.jsx` ranks wallets by realised profit worked out from public trades.
- `Status.jsx` is feed and program health. It is reached from the freshness chip in the header
  rather than the main navigation, because it is an operator screen and not a bettor's screen.

## Things worth knowing before you change it

The free World Cup tier runs about sixty seconds behind live, so wherever a price appears it also
carries its real age. Do not label that data live.

Roughly a third of the board is quarter lines, where a stake splits across two lines and TxODDS
publishes no single fair percentage for them. Those render as odds with the fair price marked
unpublished. Filling that column with a number we invented would be the wrong fix.

A price we can show is not the same as a market you can trade. Cells that exist only in the feed
are visibly disabled and say why.
