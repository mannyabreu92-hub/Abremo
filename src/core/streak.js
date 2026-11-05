// Art Battle streaks: at least one vote a day (UTC) keeps the streak going, and a single missed day
// is forgiven once every 7 days. Two missed days in a row, or a second miss within the week, end it.
// Today still counts as open. The database applies the same rules in battle_streak()
// (supabase/migrations/0018_seasons.sql); tests/db.test.js checks the two agree.

export const STREAK_MILESTONES = [7, 30, 100];
const DAY = 86_400_000;
const dayNumber = (d) => Math.floor((typeof d === 'number' ? d : Date.parse(d)) / DAY);

/**
 * days: the dates (ISO strings or ms timestamps) of a member's votes; now: the current time.
 * Returns { current, best, today, grace_used }.
 */
export function battleStreak(days, now = Date.now()) {
  const voted = new Set(days.map(dayNumber));
  const today = dayNumber(now);
  if (!voted.size) return { current: 0, best: 0, today: false, grace_used: false };
  let run = 0, best = 0, forgiven = null;
  for (let d = Math.min(...voted); d <= today; d += 1) {
    if (voted.has(d)) { run += 1; best = Math.max(best, run); }
    else if (d === today) { /* the day isn't over */ }
    else if (run > 0 && (forgiven === null || d - forgiven >= 7)) forgiven = d;
    else { run = 0; forgiven = null; }
  }
  return { current: run, best, today: voted.has(today), grace_used: forgiven !== null && today - forgiven < 7 };
}

/** The first day (ms) and the day after the end of the month (UTC) that contains `date`. */
export function seasonWindow(date) {
  const d = new Date(date);
  return { from: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1), to: Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) };
}

/** "November 2026" for a season (any date in the month). */
export const seasonName = (date) => new Date(date).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
