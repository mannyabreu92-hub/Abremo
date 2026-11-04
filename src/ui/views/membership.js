// Phase 6 member views: Plans, gallery accounts, and the feedback form.
// Pure HTML builders; app.js supplies the data. What each account gets is decided by the database
// (supabase/migrations/0012); these pages only show it.

import { esc, Icon, PremiumButton, EmptyState, SectionHeader, flag, countryName } from '../components.js';
import { PLANS, EVERY_PLAN, planBenefits } from '../../core/plans.js';
import { opportunityCard } from './careers.js';

const day = (t) => new Date(t).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });

/**
 * The Plans page.
 * @param {{ community: boolean, signedIn: boolean, mine: any, payments: boolean, gallery: any, busy?: string }} o
 */
export function plansPage({ community, signedIn, mine, payments, gallery, busy = '' }) {
  const current = mine?.plan?.code || 'free';
  const verifiedGallery = gallery?.status === 'verified';
  const status = mine && current !== 'free'
    ? `<p class="plan-status">${Icon('check', { size: 16 })} You’re on <b>${esc(mine.plan.name)}</b>${mine.ends_at ? ` until ${esc(day(mine.ends_at))}` : ''}${mine.source === 'grant' ? ', granted by Abremi' : ''}.
       ${mine.manage ? PremiumButton(busy === 'manage' ? 'Opening…' : 'Manage or cancel', { act: 'plan-manage', variant: 'ghost', attrs: busy ? 'disabled' : '' }) : ''}</p>`
    : '';
  const action = (p) => {
    if (p.code === current) return '<span class="tag tag-gold">Your plan</span>';
    if (p.code === 'free') return '';
    if (p.code === 'gallery' && !verifiedGallery) {
      return community && signedIn ? PremiumButton(gallery ? 'Your gallery application' : 'Apply as a gallery', { act: 'gallery-open', variant: 'secondary' }) : '<span class="tag">For verified galleries</span>';
    }
    if (!community || !payments) return '<span class="tag">Coming soon</span>';
    if (!signedIn) return PremiumButton('Sign in to choose', { act: 'sign-in', variant: 'secondary' });
    return PremiumButton(busy === p.code ? 'Opening checkout…' : `Choose ${p.name}`, { act: 'plan-checkout', variant: p.code === 'pro' ? 'primary' : 'secondary', attrs: `data-v="${p.code}"${busy ? ' disabled' : ''}` });
  };
  return `<div class="shell plans-page">
    <header class="page-head"><p class="eyebrow">Membership</p><h1 class="display-lg">Plans</h1>
      <p class="muted">Every plan sees and is seen the same way. Plans add tools for your practice; they never change how work is ranked.</p></header>
    ${community && !payments ? `<p class="notice">${Icon('info', { size: 16 })} Paid plans aren’t on sale yet. Abremi is in beta: prices will be announced before anything can be bought, and nothing is charged unless you choose it.</p>` : ''}
    ${!community ? `<p class="notice">${Icon('info', { size: 16 })} This is the on-device preview. Plans come with accounts.</p>` : ''}
    ${status}
    <div class="plan-grid plan-grid-4">${PLANS.map((p) => `<div class="plan${p.code === current ? ' is-on' : ''}">
      <p class="plan-name">${esc(p.name)}</p>
      <p class="plan-price">${p.code === 'free' ? 'Free' : '<small class="plan-tba">Price to be announced</small>'}</p>
      <ul>${planBenefits(p).map((x) => `<li>${Icon('check', { size: 16 })}${esc(x)}</li>`).join('')}</ul>
      ${action(p)}</div>`).join('')}</div>
    <section class="section section-tight">${SectionHeader({ eyebrow: 'Included in every plan', title: 'The essentials stay free' })}
      <ul class="plain-list">${EVERY_PLAN.map((x) => `<li>${Icon('check', { size: 16 })} ${esc(x)}</li>`).join('')}</ul>
      <p class="fine"><b>Our ranking promise:</b> likes, votes, followers and scores count exactly the same whatever plan anyone is on. If Abremi ever offers paid promotion, it will be a separate, clearly labelled placement, never a change to the rankings.</p>
    </section>
    ${community && signedIn ? gallerySummaryHTML(gallery) : ''}
  </div>`;
}

/** Gallery account status, with the way to apply or edit. */
export function gallerySummaryHTML(gallery) {
  const state = !gallery ? null : gallery.status;
  return `<section class="section section-tight" id="gallery-account">${SectionHeader({ eyebrow: 'For galleries', title: 'Gallery account' })}
    ${state === 'verified' ? `<p>${Icon('check', { size: 16 })} <a href="#gallery/${esc(gallery.id)}"><b>${esc(gallery.name)}</b></a> is a verified gallery.</p>`
      : state === 'pending' ? `<p class="muted">${esc(gallery.name)}: waiting for a moderator to verify it.</p>`
      : state === 'rejected' ? `<p class="muted">${esc(gallery.name)} couldn’t be verified${gallery.review_note ? `: ${esc(gallery.review_note)}` : ''}. You can update the details and apply again.</p>`
      : '<p class="muted">Galleries get a verified page on Abremi and can post open calls, exhibitions and residencies. A moderator checks every application.</p>'}
    ${PremiumButton(state ? 'Edit gallery details' : 'Apply as a gallery', { act: 'gallery-open', variant: 'secondary' })}
  </section>`;
}

/** Sheet: apply as a gallery, or edit the details (a new name goes back for review). */
export function galleryForm(g, { busy = false, error = '' } = {}) {
  const v = (k) => esc(g?.[k] || '');
  return `<form class="sheet-form" id="gallery-form" onsubmit="return false">
    <p class="eyebrow">Gallery account</p><h2 class="display-md" id="modal-title">${g ? 'Gallery details' : 'Apply as a gallery'}</h2>
    <p class="muted">A moderator checks the website before the gallery is verified.${g?.status === 'verified' ? ' Changing the name sends it back for review.' : ''}</p>
    <label class="field"><span>Gallery name</span><input id="gal-name" maxlength="120" required value="${v('name')}"></label>
    <div class="field-row">
      <label class="field"><span>City</span><input id="gal-city" maxlength="80" required value="${v('city')}"></label>
      <label class="field"><span>Country code</span><input id="gal-country" maxlength="2" required placeholder="PT" autocapitalize="characters" value="${v('country')}"></label>
    </div>
    <label class="field"><span>Website (https)</span><input id="gal-website" type="url" maxlength="300" required placeholder="https://" value="${v('website')}"></label>
    <label class="field"><span>About the gallery</span><textarea id="gal-bio" rows="4" maxlength="1000">${v('bio')}</textarea></label>
    ${error ? `<p class="form-error" id="gal-error" role="alert">${esc(error)}</p>` : '<p class="form-error" id="gal-error" role="alert" hidden></p>'}
    <div class="detail-actions">${PremiumButton(busy ? 'Sending…' : g ? 'Save' : 'Send for verification', { act: 'gallery-submit', attrs: busy ? 'disabled' : '' })}</div>
  </form>`;
}

/** #gallery/<id>: a verified gallery's public page and its open listings. */
export function galleryPageHTML(g, { signedIn = false, artist = false } = {}) {
  if (!g) return `<div class="shell">${EmptyState({ icon: 'search', title: 'Gallery not found', body: 'It may not be verified yet.', action: '<a class="btn btn-secondary" href="#opportunities"><span>Opportunities</span></a>' })}</div>`;
  return `<div class="shell gallery-page">
    <header class="page-head"><p class="eyebrow">${Icon('check', { size: 14 })} Verified gallery${g.verified_at ? ` since ${esc(day(g.verified_at))}` : ''}</p>
      <h1 class="display-lg">${esc(g.name)}</h1>
      <p class="muted">${esc(g.city)} · <span class="flag">${flag(g.country)}</span> ${esc(countryName(g.country))}</p>
      ${g.bio ? `<p class="lede">${esc(g.bio)}</p>` : ''}
      <a class="btn btn-secondary" href="${esc(g.website)}" target="_blank" rel="noopener noreferrer nofollow"><span>Visit their website</span>${Icon('arrow', { size: 16 })}</a></header>
    <section class="section section-tight">${SectionHeader({ eyebrow: 'Open now', title: 'Opportunities' })}
      ${g.opportunities?.length ? `<div class="opportunity-list">${g.opportunities.map((o) => opportunityCard({ ...o, organizer: g.name, gallery_id: null }, { signedIn, artist })).join('')}</div>`
        : '<p class="muted">No open listings right now.</p>'}</section>
  </div>`;
}

export const FEEDBACK_KINDS = { bug: 'Something’s broken', idea: 'An idea', other: 'Something else' };

/** Sheet: send feedback to the Abremi team. */
export function feedbackSheet({ kind = 'bug', busy = false, error = '' } = {}) {
  return `<form class="sheet-form" id="feedback-form" onsubmit="return false">
    <p class="eyebrow">Beta</p><h2 class="display-md" id="modal-title">Send feedback</h2>
    <p class="muted">It goes straight to the people building Abremi.</p>
    <div class="chip-row chip-row-wrap" role="radiogroup" aria-label="Kind of feedback">${Object.entries(FEEDBACK_KINDS).map(([k, v]) => `<button type="button" class="chip${k === kind ? ' is-on' : ''}" role="radio" aria-checked="${k === kind}" data-act="feedback-kind" data-v="${k}">${esc(v)}</button>`).join('')}</div>
    <label class="field"><span>What happened, or what would help?</span><textarea id="feedback-message" rows="5" maxlength="2000" required></textarea></label>
    ${error ? `<p class="form-error" role="alert">${esc(error)}</p>` : ''}
    <p class="fine">Sent with the page you’re on and your browser type, nothing else.</p>
    <div class="detail-actions">${PremiumButton(busy ? 'Sending…' : 'Send', { act: 'feedback-submit', attrs: busy ? 'disabled' : '' })}</div>
  </form>`;
}

/** The plan line on Profile. */
export function membershipCardHTML(mine, { community }) {
  const name = mine?.plan?.name || 'Artist Free';
  return `<section class="section section-tight">${SectionHeader({ eyebrow: 'Membership', title: 'Your plan', action: `<a class="link-arrow" href="#plans">See plans ${Icon('arrow', { size: 16 })}</a>` })}
    <p>${community ? `<b>${esc(name)}</b>${mine?.ends_at ? ` · until ${esc(day(mine.ends_at))}` : ''}` : 'Plans come with accounts.'}</p>
    <p class="fine">Plans never change rankings.</p>
  </section>`;
}
