// One place the app asks "what matches are on".
//
// THE BUG THIS EXISTS TO KILL
//
// The app used to read a fixtures file that ships with the build. Several views imported the
// UPCOMING list straight from it and never asked again. That file is a photograph of the
// schedule taken whenever someone last ran the refresh script, so the app kept showing matches
// that had already been played, and kept missing ones that had been added. It was right on the
// day it was generated and drifted every day after, which is the worst kind of wrong: it looks
// fine right after you fix it.
//
// A file cannot be a schedule. The schedule is the feed. So the file is now only a cold start,
// something to paint on the first frame so the page is not empty, and it is replaced by live
// data the moment that arrives. Nothing settles or prices off the file.
//
// `live` says which one you are looking at, and views should show that rather than let a stale
// list pass as current.
import { useEffect, useState } from "react";
import bundled from "./fixtures.json";

// The cold-start list. Filtered the same way as live data so the first frame is not obviously
// wrong, but this is a starting picture and never an answer.
const coldStart = (bundled.fixtures ?? []).filter((f) => new Date(f.kickoff) > new Date());

let cache = null; // one fetch per page load, shared by every view that asks

async function loadLive() {
  const r = await fetch("/api/fixtures", { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`fixtures feed answered ${r.status}`);
  const { fixtures } = await r.json();
  if (!Array.isArray(fixtures)) throw new Error("fixtures feed sent something unexpected");
  return fixtures;
}

/**
 * The matches that have not kicked off yet.
 *
 * Returns { fixtures, live, error }. `live` is false while showing the cold start, so a view
 * can say so. `error` is set when the feed could not be reached, which is worth showing: a
 * schedule that might be out of date is a different thing from one you can rely on.
 */
export function useFixtures({ includeStarted = false } = {}) {
  const [state, setState] = useState(() => ({ fixtures: cache ?? coldStart, live: cache != null, error: null }));

  useEffect(() => {
    let alive = true;
    if (cache) return;
    loadLive()
      .then((fixtures) => { cache = fixtures; if (alive) setState({ fixtures, live: true, error: null }); })
      .catch((e) => { if (alive) setState({ fixtures: coldStart, live: false, error: String(e.message ?? e) }); });
    return () => { alive = false; };
  }, []);

  // A match in progress has kicked off but is still worth listing on a live view, so the cutoff
  // is a choice the caller makes rather than one baked in here.
  const cutoff = includeStarted ? Date.now() - 3 * 3600 * 1000 : Date.now();
  const fixtures = (state.fixtures ?? [])
    .filter((f) => new Date(f.kickoff).getTime() > cutoff)
    .sort((a, b) => new Date(a.kickoff) - new Date(b.kickoff));

  return { ...state, fixtures };
}

/** Drop the shared cache, for a view that wants to force a re-read. */
export const invalidateFixtures = () => { cache = null; };
