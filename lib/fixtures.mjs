// Turning a fixture id into the two team names.
//
// THE PROBLEM THIS SOLVES
//
// The odds feed and the scores feed both talk about a match entirely in numbers. An odds row
// names its outcomes "part1", "draw" and "part2". A score row carries Participant1Id and
// Participant2Id. Neither one ever says "Spain" or "Argentina".
//
// Only the fixtures feed knows the names, and it is indexed by day, so you cannot ask it about
// a fixture id directly. You have to know which day the match is on before you can look it up.
//
// The way through: a score row carries StartTime, which gives the day in one call. Then one
// fixtures call for that day returns the names. Two calls, cached, instead of scanning a
// fortnight of the schedule hunting for an id.
//
// This matters beyond tidiness. "part1 42.2%" is not a price a person can check. They cannot
// tell whether we attached it to the right team, which is the one thing the proof is supposed
// to let them confirm.

const cache = new Map();

/** Which day's fixture list a timestamp belongs to. */
const epochDay = (ms) => Math.floor(Number(ms) / 86_400_000);

/**
 * Find the fixture record, which is the only place the team names live.
 * Returns null rather than throwing, because a missing name should degrade the display and
 * never take down a price or a proof.
 */
export async function fixtureOf(client, fixtureId, { competitionId, day } = {}) {
  const id = Number(fixtureId);
  if (cache.has(id)) return cache.get(id);

  const days = [];
  if (day != null) days.push(Number(day));
  else {
    // Ask the scores feed when this match kicks off. It answers for scheduled matches too, so
    // this works before a ball is kicked.
    const s = await client.scoresSnapshot(id).catch(() => null);
    const row = Array.isArray(s) ? s[0] : s;
    const start = Number(row?.StartTime);
    if (Number.isFinite(start) && start > 0) {
      // A late kickoff can be filed under the next day depending on the timezone the feed
      // rolls on, so check the neighbours too.
      days.push(epochDay(start), epochDay(start) - 1, epochDay(start) + 1);
      if (competitionId == null && row?.CompetitionId != null) competitionId = Number(row.CompetitionId);
    }
  }
  // Nothing told us the day, so sweep a short window rather than give up.
  if (!days.length) { const t = epochDay(Date.now()); for (let d = t - 2; d <= t + 14; d++) days.push(d); }

  for (const d of days) {
    const list = await client.fixturesSnapshot(d, competitionId).catch(() => null);
    const hit = (list ?? []).find((f) => Number(f.FixtureId) === id);
    if (hit) {
      const rec = {
        fixtureId: id,
        home: hit.Participant1 ?? null,
        away: hit.Participant2 ?? null,
        // Participant1IsHome is not decoration. When it is false the first participant is the
        // away side, and a scoreboard that ignores it shows the match backwards.
        participant1IsHome: hit.Participant1IsHome !== false,
        competition: hit.Competition ?? null,
        competitionId: hit.CompetitionId ?? null,
        startTime: Number(hit.StartTime ?? hit.Ts) || null,
      };
      cache.set(id, rec);
      return rec;
    }
  }
  cache.set(id, null);
  return null;
}

/**
 * Name the outcomes of one market.
 *
 * The feed's own labels are positional: part1 and part2 mean the first and second participant
 * of the fixture, in every market type. So the same mapping works for a match result and for a
 * handicap. Over and under are already words and are left alone.
 */
export function nameOutcomes(market, fixture) {
  if (!fixture) return market.outcomes;
  const label = (name) => {
    const n = String(name).toLowerCase();
    if (n === "part1") return fixture.home ?? name;
    if (n === "part2") return fixture.away ?? name;
    if (n === "draw") return "Draw";
    return name;
  };
  return market.outcomes.map((o) => ({ ...o, name: label(o.name), raw: o.name }));
}

/** A readable title for a match, falling back to the id when the feed has no names. */
export const titleOf = (fixture, fixtureId) =>
  fixture?.home && fixture?.away ? `${fixture.home} v ${fixture.away}` : `Match ${fixtureId}`;

export const clearFixtureCache = () => cache.clear();
