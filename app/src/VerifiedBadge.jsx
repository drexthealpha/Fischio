// A "verified fixture" badge. It asks the ingestion service for TxLINE's fixtures/validation
// payload, which carries the signed fixture record and its Merkle summary. If that comes back
// genuine, the badge shows; otherwise it stays hidden, so it never claims a proof it does not
// have. This is the trust primitive made visible: the match itself is a signed TxLINE record.
import { useEffect, useState } from "react";

const INGEST = new URLSearchParams(window.location.search).get("ingest") ?? import.meta.env.VITE_INGEST ?? "http://127.0.0.1:8795";

export default function VerifiedBadge({ fixtureId }) {
  const [ok, setOk] = useState(false);
  useEffect(() => {
    let alive = true;
    fetch(`${INGEST}/verify/fixture/${fixtureId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (alive && j?.snapshot?.Competition) setOk(true); })
      .catch(() => {});
    return () => { alive = false; };
  }, [fixtureId]);
  if (!ok) return null;
  return <span className="verified-badge" title="This fixture is a signed TxLINE record, verifiable on-chain">✓ verified</span>;
}
