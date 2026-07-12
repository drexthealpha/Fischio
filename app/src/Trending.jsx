// Moving now: the result markets whose price shifted the most in the last window, read from our
// own chain scan via services/api. It quietly disappears if the API is not running. This is the
// live pulse of the platform, the same idea as Polymarket's "Breaking" strip.
import { useEffect, useState } from "react";
import { FIXTURES_BY_ID } from "./chain.js";

const params = new URLSearchParams(window.location.search);
const API = params.get("api") ?? "http://127.0.0.1:8790";
const pct = (p) => `${Math.round(p * 100)}%`;

export default function Trending() {
  const [data, setData] = useState(null);
  const [reachable, setReachable] = useState(true);

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch(`${API}/trending`)
        .then((r) => (r.ok ? r.json() : Promise.reject()))
        .then((j) => { if (alive) { setData(j); setReachable(true); } })
        .catch(() => { if (alive) setReachable(false); });
    load();
    const t = setInterval(load, 15000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  if (!reachable || !data) return null;
  const movers = (data.movers ?? []).filter((m) => Math.abs(m.delta) > 0.001).slice(0, 5);
  if (movers.length === 0) return null;

  return (
    <section className="trending">
      <div className="microlabel trending-head">Moving now</div>
      {movers.map((m) => {
        const fx = FIXTURES_BY_ID.get(m.fixtureId);
        const label = fx ? `${fx.home} v ${fx.away}` : `fixture ${m.fixtureId}`;
        const up = m.delta > 0;
        return (
          <div className="trending-row" key={m.address}>
            <span className="trending-name">{label}</span>
            <span className="trending-move">
              <span className={up ? "trending-delta trending-up" : "trending-delta trending-down"}>
                {up ? "▲" : "▼"} {Math.abs(m.delta * 100).toFixed(1)}pt
              </span>
              <span className="trending-price">{pct(m.yesPrice)}</span>
            </span>
          </div>
        );
      })}
    </section>
  );
}
