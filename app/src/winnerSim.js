// Client-side Monte Carlo World Cup winner simulator, a mirror of lib/wc-simulator.mjs. Pure
// functions, no dependencies, so it runs in the browser. Deterministic given a seed.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// One knockout match to its winner (0 = a, 1 = b). A draw goes to a coin-flip shootout.
export function playKnockout(odds, rng) {
  const r = rng();
  if (r < odds.home) return 0;
  if (r < odds.home + odds.draw) return rng() < 0.5 ? 0 : 1;
  return 1;
}

// bracket: [round0, round1, ...]; round0 = [{ a, b, odds }]. Returns { team: probability }.
export function simulateWinner(bracket, { iterations = 20000, seed = 20260714 } = {}) {
  const rng = mulberry32(seed);
  const wins = new Map();
  const round0 = bracket[0];
  for (let it = 0; it < iterations; it++) {
    let winners = round0.map((m) => (playKnockout(m.odds, rng) === 0 ? m.a : m.b));
    for (let r = 1; r < bracket.length; r++) {
      const next = [];
      for (let i = 0; i < winners.length; i += 2) {
        const odds = bracket[r][i / 2]?.odds ?? { home: 0.5, draw: 0, away: 0.5 };
        next.push(playKnockout(odds, rng) === 0 ? winners[i] : winners[i + 1]);
      }
      winners = next;
    }
    const champ = winners[0];
    wins.set(champ, (wins.get(champ) ?? 0) + 1);
  }
  const out = {};
  for (const [team, w] of wins) out[team] = w / iterations;
  return out;
}
