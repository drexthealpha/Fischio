// A country flag as a real SVG image, so it looks the same on every platform. Falls back to
// a clean country-code chip if the image cannot load (offline, blocked host), so the UI never
// shows a broken-image icon.
import { useState } from "react";
import { flagUrl, codeLabel } from "./teams.js";

export default function Flag({ team, size = 20 }) {
  const [broken, setBroken] = useState(false);
  const url = flagUrl(team);
  if (!url || broken) {
    return <span className="flag-fallback" style={{ height: size }}>{codeLabel(team)}</span>;
  }
  return (
    <img className="flag" src={url} alt={team} title={team}
      style={{ height: size, width: size * 1.4 }} onError={() => setBroken(true)} loading="lazy" />
  );
}
