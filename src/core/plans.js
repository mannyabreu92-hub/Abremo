// Abremi plans: what each one includes. The database (supabase/migrations/0012) holds the same
// values and is the only thing that grants them; tests/db.test.js checks the two agree.
// No prices: those are set when payments are switched on, after the product, provider, tax and
// refund reviews. Plans never affect rankings.

/**
 * @typedef {{ code: 'free' | 'pro' | 'elite' | 'gallery', name: string, audience: 'artist' | 'gallery',
 *   coach_monthly: number, analytics_days: number, max_upcoming_drops: number, priority_review: boolean,
 *   direct_opportunities: boolean, badge: 'Pro' | 'Elite' | null, sort: number }} Plan
 */

/** @type {Plan[]} */
export const PLANS = [
  { code: 'free', name: 'Artist Free', audience: 'artist', coach_monthly: 20, analytics_days: 90, max_upcoming_drops: 1, priority_review: false, direct_opportunities: false, badge: null, sort: 1 },
  { code: 'pro', name: 'Artist Pro', audience: 'artist', coach_monthly: 60, analytics_days: 365, max_upcoming_drops: 3, priority_review: false, direct_opportunities: false, badge: 'Pro', sort: 2 },
  { code: 'elite', name: 'Artist Elite', audience: 'artist', coach_monthly: 150, analytics_days: 365, max_upcoming_drops: 3, priority_review: true, direct_opportunities: false, badge: 'Elite', sort: 3 },
  { code: 'gallery', name: 'Gallery', audience: 'gallery', coach_monthly: 100, analytics_days: 90, max_upcoming_drops: 1, priority_review: false, direct_opportunities: true, badge: null, sort: 4 },
];

/** What every plan includes, whatever it costs. */
export const EVERY_PLAN = [
  'Publishing, discovery, rankings and Art Battles',
  'Competitions, Collector Radar inquiries and the Artist Passport',
  'Studio analytics and weekly reports',
];

/**
 * The plan's benefits, in plain words, for the Plans page.
 * @param {Plan} p
 * @returns {string[]}
 */
export function planBenefits(p) {
  const out = [];
  if (p.audience === 'gallery') {
    out.push('A verified gallery page');
    if (p.direct_opportunities) out.push('Opportunities published without waiting for review (10 a day)');
    out.push(`${p.coach_monthly} Career Coach requests a month (for gallery artists’ texts)`);
    return out;
  }
  out.push(`${p.coach_monthly} Career Coach requests a month`);
  out.push(p.analytics_days >= 365 ? 'Analytics for up to a year' : 'Analytics for up to 90 days');
  out.push(`${p.max_upcoming_drops} upcoming drop${p.max_upcoming_drops === 1 ? '' : 's'} at a time`);
  if (p.priority_review) out.push('Exhibitions reviewed first for your Passport');
  if (p.badge) out.push(`${/^[AEIOU]/.test(p.badge) ? 'An' : 'A'} ${p.badge} badge on your artist page`);
  return out;
}

/** @param {string | null | undefined} code */
export const planByCode = (code) => PLANS.find((p) => p.code === code) || PLANS[0];
