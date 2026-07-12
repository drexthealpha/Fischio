// A small header pill that shows the TxLINE feed is live and how fresh it is, read from the
// ingestion service. It disappears if the ingest is not running, so it never lies about being
// live. This makes the data freshness visible on every page rather than a claim.
import { useEffect, useState } from "react";

const INGEST = new URLSearchParams(window.location.search).get("ingest") ?? import.meta.env.VITE_INGEST ?? "http://127.0.0.1:8795";

export default function LiveFeed() {
  const [age, setAge] = useState(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch(`${INGEST}/live`);
        if (!r.ok) throw new Error();
        const j = await r.json();
        const times = Object.values(j.fixtures || {}).flatMap((f) => [f.oddsAt, f.scoresAt]).filter(Boolean);
        if (alive) setAge(times.length ? Math.max(0, Math.round((Date.now() - Math.max(...times)) / 1000)) : null);
      } catch { if (alive) setAge(null); }
    };
    load();
    const t = setInterval(load, 5000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  if (age == null) return null;
  return (
    <span className="livefeed" title="Live TxLINE data">
      <span className="livefeed-dot" />
      TxLINE live · {age < 60 ? `${age}s` : `${Math.round(age / 60)}m`} ago
    </span>
  );
}
