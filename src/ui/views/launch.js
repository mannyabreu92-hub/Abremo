// The beta launch kit: a welcome card and short tour for first-time visitors, and the artist
// invitation page (#join). Pure HTML builders; app.js supplies state.

import { esc, Icon, PremiumButton, SectionHeader } from '../components.js';

export const WELCOME_KEY = 'abremi:welcomed';

/** A small card on Home for first-time visitors (dismissed for good once closed or completed). */
export function welcomeCardHTML() {
  return `<section class="welcome-card" aria-label="Welcome">
    <div><p class="eyebrow">New here?</p><p><b>Take the 30-second tour</b> of how Abremi works.</p></div>
    <div class="welcome-actions">${PremiumButton('Show me', { act: 'tour-open', variant: 'secondary' })}
      <button class="icon-btn" data-act="welcome-dismiss" aria-label="Dismiss">${Icon('x', { size: 18 })}</button></div>
  </section>`;
}

const STEPS = [
  { eyebrow: '1 of 3 · Discover', title: 'One work at a time', icons: ['brush', 'treasure', 'admire'],
    body: 'Works arrive one by one, given the whole screen. <b>Pass</b> to move on, <b>Admire</b> what moves you, and <b>Treasure</b> what you’d keep: it saves the work and counts twice.' },
  { eyebrow: '2 of 3 · Your voice', title: 'Taste with weight', icons: ['chart'],
    body: 'Every admiration shapes the rankings, weighed by experience: fans, artists, and moderator-verified critics and collectors. Your own work never counts for you, and nothing can be bought into the rankings.' },
  { eyebrow: '3 of 3 · Artists', title: 'Follow who you discover', icons: ['user', 'bell'],
    body: 'Follow artists to see their new work, hear about their drops, and get told when a work you treasured becomes available. When something is for sale, you can make an offer or ask the artist directly.' },
];

/** The tour, one step at a time. */
export function tourSheet(step = 0) {
  const s = STEPS[Math.max(0, Math.min(step, STEPS.length - 1))];
  const last = step >= STEPS.length - 1;
  return `<div class="tour">
    <p class="eyebrow">${esc(s.eyebrow)}</p>
    <div class="tour-icons" aria-hidden="true">${s.icons.map((i) => `<span>${Icon(i, { size: 26 })}</span>`).join('')}</div>
    <h2 class="display-md" id="modal-title">${esc(s.title)}</h2>
    <p class="lede">${s.body}</p>
    <div class="tour-dots" aria-hidden="true">${STEPS.map((_, i) => `<i class="${i === step ? 'is-on' : ''}"></i>`).join('')}</div>
    <div class="detail-actions">
      ${last ? PremiumButton('Start discovering', { act: 'tour-done' }) : PremiumButton('Next', { act: 'tour-next', attrs: `data-v="${step + 1}"` })}
      ${last ? '' : PremiumButton('Skip', { act: 'tour-done', variant: 'ghost' })}
    </div>
  </div>`;
}

/** #join: why artists should show and sell their work on Abremi. */
export function joinPage({ community, signedIn, isArtist, salesOn }) {
  const benefit = (icon, title, body) => `<li><span class="join-icon">${Icon(icon, { size: 22 })}</span><div><b>${esc(title)}</b><p>${body}</p></div></li>`;
  const cta = !community ? '<a class="btn btn-primary" href="#discover"><span>Explore the preview</span></a>'
    : isArtist ? '<a class="btn btn-primary" href="#profile"><span>Go to your Studio</span></a>'
      : signedIn ? PremiumButton('Become an artist on Abremi', { act: 'join-artist', size: 'lg' })
        : PremiumButton('Join Abremi', { act: 'sign-in', size: 'lg' });
  return `<div class="shell join-page">
    <header class="page-head join-hero"><p class="eyebrow">For artists</p>
      <h1 class="display-lg">Be discovered for the work itself.</h1>
      <p class="lede">On Abremi, an unknown artist’s first piece stands beside an established name on equal terms. Collectors, critics and art lovers decide, and their judgement is weighed by experience, not bought.</p>
      ${cta}</header>
    <section class="section section-tight">${SectionHeader({ eyebrow: 'What you get', title: 'A career, not just a profile' })}
      <ul class="join-list">
        ${benefit('chart', 'The Abremi Index', 'A weekly public chart of the most appreciated work. Ranked artists get a badge for their own website that updates every week.')}
        ${benefit('mail', 'Collectors who reach out', 'Offers, questions and commission requests arrive in your Inbox, with no middleman. Collectors can join a waitlist for works that aren’t available.')}
        ${benefit('spark', 'Drops', 'Schedule a release of new work. Followers are told, the works stay veiled until the moment, and anyone can ask to be notified.')}
        ${benefit('check', 'A verified Passport', 'Exhibitions checked by moderators, competition placings and achievements, in one place collectors trust.')}
        ${benefit('grid', 'Studio analytics', 'Who saw your work, where they are, and what they admired, without guesswork.')}
        ${benefit('pen', 'The Career Coach and the Guide', 'Help with your bio, statement and descriptions (Coach on Pro and Elite), and an assistant that explains how your work is doing.')}
      </ul></section>
    <section class="section section-tight">${SectionHeader({ eyebrow: 'Selling', title: 'Keep more of every sale' })}
      <p>${salesOn ? 'Collectors can buy your listed works on Abremi.' : 'Selling directly on Abremi is opening soon.'} Abremi’s commission is <b>20%</b>; galleries commonly take around half. Payment goes through Stripe, which pays you directly, so Abremi never holds your money. You can also sell editions: prints you make and ship.</p>
    </section>
    <section class="section section-tight">${SectionHeader({ eyebrow: 'Getting started', title: 'Three steps' })}
      <ol class="join-steps"><li>Sign in with your email and choose the Artist role on your Profile.</li>
        <li>Publish a few strong works with clear photos, the medium, size, year and price.</li>
        <li>Share them: every work has a share card for Instagram and a link back to you.</li></ol>
      ${cta}</section>
  </div>`;
}
