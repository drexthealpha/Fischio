# Notes on building against TxLINE

Findings from building fischio on the World Cup feed, service level 1. Everything here was measured
against the live API rather than inferred from the docs, and each item says what we saw and what we
did about it. Most of these cost us time, so they are written for the next person building on the
same tier.

## What worked well

The single normalised schema across competitions is the thing that made a full tournament tractable.
One parser reads every fixture, and the same market identity (`SuperOddsType` + `MarketPeriod` +
`MarketParameters`) works for the group stage and the final.

`Pct` being the demargined percentage rather than raw price removed a whole class of work. We never
had to strip vig, and because it sums to 1.000 across a market we could use it directly as fair
value. Our market maker does no probability modelling at all, which means it has no model to be
wrong.

The proof primitives are the reason this project exists. `stat-validation` returning a Merkle proof
that an on-chain program can verify is what let us settle prediction markets without an oracle
anyone has to trust.

## Things that cost us time

### The historical endpoint is empty at full time

The largest one. We built settlement around `/api/scores/historical` on the reasoning that a
finished match is a historical record.

Measured on fixture 18257865, France v England, watching the transition live:

```
23:05:37  status=4  over=false  4-5  seq=1177
23:05:58  status=5  over=true   4-6  seq=1194
```

At that moment `/api/scores/historical/18257865` returned zero rows, and it was still returning zero
fifteen minutes later. The snapshot already carried two terminal rows (seq 1194 and 1192, both
status 5), and `stat-validation` produced a complete proof against seq 1194 straight away:

```
statsToProve: [{"key":1,"value":4,"period":5},{"key":2,"value":6,"period":5}]
statProofs: 2   subTreeProof: 6 hashes   mainTreeProof: 1 hash
```

So the data needed to settle is available immediately, just not from the endpoint we expected.

So the settlement path has to read the snapshot first and treat historical as the fallback for
matches that have aged out, which is the reverse of what we assumed. A bot that reads historical
first fails on every match at exactly the moment it is supposed to settle it.

Being told the population lag, or having the endpoint return the terminal rows immediately, would
have saved us a rewrite.

### Windowed endpoints do not publish the current interval

`/api/odds/updates/{day}/{hour}/{interval}` returns an empty array for the interval currently in
progress, and stays empty for roughly one interval after it closes.

Our "what is moving" board asked for the current window, got `200` with zero rows, and reported
itself healthy for weeks while showing nothing. Querying about 12 minutes back returns real data
immediately: 929 odds rows and 55 score rows on a single live window.

A documented note that a window is available roughly two intervals after it opens would make this
obvious. An empty `200` is hard to tell apart from a quiet period.

### `GameState` never changes

`GameState` stayed `"scheduled"` on every fixture we tracked, including matches that were being
played and matches that had finished. We use `StatusId` from the scores feed and the running clock
instead, which works, but the field reads as authoritative and is not.

### `StatusId` 100 is not terminal

We treated `{5, 10, 13}` as terminal and settled from them. Status 100 appears after those and looks
like a completion marker, but the row carries a finalisation record rather than the full-time score.
Settling from it produces the wrong outcome. We now exclude it explicitly.

It would help for the docs to state which status values carry a settleable score.

### `Pct` is `"NA"` on quarter lines

About a third of the board on a typical fixture. It is the correct answer, since a quarter line
splits the stake across two outcomes and has no single two-way percentage, but it arrives as the
string `"NA"` in a numeric field, so a naive parse yields `NaN` and silently poisons anything
downstream.

We exclude those lines from on-chain markets entirely, because a market that splits a stake is not
binary and cannot settle two ways. Having them typed as `null` rather than `"NA"` would make the
intent clearer.

### `asOf` is needed for a complete snapshot

Without it the odds snapshot returns a partial board. This is not obvious from the endpoint
description and produced intermittent missing markets until we found it.

### In-play repricing is every five minutes on this tier

Not a fault, but worth stating in the docs because it changes how a trading tool must be built.

Measured on the same fixture at the 71st minute, polling every 12 seconds for 3 minutes, nine
repricings observed: min 195s, median 300s, max 300s.

We had set our in-play staleness limit to 180 seconds, reasoning that service level 1 is already
about 60 seconds delayed. Against a 300 second cadence no line ever qualifies, so our market maker
quoted nothing in play at all. Knowing the publication cadence per service level would let a builder
set that threshold correctly the first time.

### The board thins out near the end of a match

A fixture carrying 29 markets pre-match and 23 at the 71st minute was down to 2 by the 96th. Sensible
from a trading standpoint, and worth knowing if you are building anything that expects a stable
market count through a match.

### One fixture appeared twice

USA v Paraguay is listed under ids 17588394 and 17588396, three hours apart. One pairing out of 105
across the tournament, so an anomaly rather than a pattern, but a market factory keyed on fixture id
alone opens two complete boards for one match and splits its liquidity. We deduplicate by
participants plus a kickoff window.

## Smaller notes

`StartTime` arrives as seconds in some responses and milliseconds in others, so everything that
reads it has to normalise.

Lineups were empty on the fixtures we checked, including a live knockout match, so anything built
around them needs a fallback.

Extra-time markets appear with periods like `et` and `et,half=1` once a match reaches them. We did
not anticipate these and they are worth documenting alongside the standard periods.
