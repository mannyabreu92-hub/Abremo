// "How rankings work": the published formulas and integrity rules (community mode).
// Keep in step with supabase/migrations/0007_ranking_integrity.sql and src/core/scoring.js.

import { esc } from '../components.js';
import { ROLES, SAVE_MULTIPLIER } from '../../core/scoring.js';

export function howRankedSheet() {
  const weights = ROLES.map((r) => `${esc(r.label)} ×${r.weight}`).join(' · ');
  const score = (title, body) => `<div class="how-item"><h3>${title}</h3><p>${body}</p></div>`;
  return `<div class="how-ranked">
    <p class="eyebrow">Transparency</p>
    <h2 class="display-md" id="modal-title">How rankings work</h2>
    <p class="muted">Abremi keeps five separate scores. They are calculated on the server from members’ real activity, are never combined into one number, and no payment or plan changes any of them.</p>
    <div class="how-list">
      ${score('Artwork popularity', `Every like counts by who gave it (${weights}); a save counts ×${SAVE_MULTIPLIER}; each critic review adds 2 points per star. <b>All Time</b> uses every like; <b>Trending This Week</b> halves a like’s value for every 7 days since it was given.`)}
      ${score('Artist reputation', 'The popularity of all the artist’s works, plus their followers, each counted by role.')}
      ${score('Critic credibility', 'The share of a work’s or artist’s popularity that comes from verified critics and collectors, and the critic reviews behind it.')}
      ${score('Collector interest', 'Likes and saves from verified collectors only. Shown as Collectors’ Picks.')}
      ${score('Battle performance', 'Art Battle ratings (Elo). Only works that have actually battled are listed.')}
    </div>
    <h3 class="how-sub">What never counts</h3>
    <ul class="how-rules">
      <li>Likes, saves, reviews or battle votes on your own work, and following yourself.</li>
      <li>More than one like or save per member per work (you can change it, not repeat it).</li>
      <li>Activity beyond 600 likes and saves, or 200 follows, an hour.</li>
      <li>Bursts a moderator confirmed as coordinated: when a work gets 10 or more likes in an hour and most come from accounts under 3 days old, a moderator reviews it. If confirmed, those likes stop counting (they’re never deleted), and the decision is recorded.</li>
      <li>The sample catalog’s demo numbers: sample works start at zero like everyone else.</li>
    </ul>
    <p class="fine">Verified sales will be a separate score when they arrive; an artist marking a work “sold” changes no ranking.</p>
  </div>`;
}
