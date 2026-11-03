// Gamification badges.

export const BADGES = Object.freeze({
  rising: { emoji: '🏅', label: 'Rising Artist', desc: 'Debuted in the last 2 years and already top 25 in their country.' },
  topCountry: { emoji: '🏆', label: 'Top 100 Country', desc: 'Ranked in the top 100 artists of their country.' },
  topGlobal: { emoji: '🌎', label: 'Top 100 Global', desc: 'Ranked in the top 100 artists worldwide.' },
  collectorElite: { emoji: '💎', label: 'Collector Elite', desc: 'A collector who has collected 10+ works.' },
  masterCritic: { emoji: '📝', label: 'Master Critic', desc: 'A critic who has published 10+ reviews.' },
  trendSetter: { emoji: '🎨', label: 'Trend Setter', desc: 'Liked 3+ artworks that are now in the global top 20.' },
});

export const BADGE_RULES = Object.freeze({
  risingYears: 2,
  risingCountryRank: 25,
  topCountry: 100,
  topGlobal: 100,
  collectorElite: 10,
  masterCritic: 10,
  trendSetterHits: 3,
  trendSetterTopN: 20,
});

export function artistBadges({ globalRank, countryRank, debutYear, currentYear, score = 1 }) {
  const out = [];
  if (score <= 0) return out;
  if (debutYear >= currentYear - BADGE_RULES.risingYears && countryRank <= BADGE_RULES.risingCountryRank) out.push('rising');
  if (countryRank <= BADGE_RULES.topCountry) out.push('topCountry');
  if (globalRank <= BADGE_RULES.topGlobal) out.push('topGlobal');
  return out;
}

export function userBadges({ role, collectedCount = 0, reviewCount = 0, trendHits = 0 }) {
  const out = [];
  if (role === 'collector' && collectedCount >= BADGE_RULES.collectorElite) out.push('collectorElite');
  if (role === 'critic' && reviewCount >= BADGE_RULES.masterCritic) out.push('masterCritic');
  if (trendHits >= BADGE_RULES.trendSetterHits) out.push('trendSetter');
  return out;
}
