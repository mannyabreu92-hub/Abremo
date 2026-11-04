// Phase 5 views: AI Career Coach, Artist Passport and Gallery Opportunities.
// Pure HTML builders; app.js supplies data and helpers. Rules live in
// supabase/migrations/0011_coach_passport_opportunities.sql and api/coach.js.

import { esc, Icon, PremiumButton, EmptyState, SectionHeader } from '../components.js';

export const COACH_TOOLS = {
  bio: { label: 'Biography', blurb: 'Two lengths, from your profile and works.' },
  statement: { label: 'Artist statement', blurb: 'Refines your own words, or drafts from your works.' },
  description: { label: 'Artwork description', blurb: 'A description and alt text for one work.', needs: 'artwork' },
  social: { label: 'Social captions', blurb: 'Three captions for one work, no prices.', needs: 'artwork' },
  engagement: { label: 'Engagement summary', blurb: 'Your last 30 days in plain words, from your Studio numbers.' },
  application: { label: 'Opportunity application', blurb: 'A cover letter for a listed opportunity.', needs: 'opportunity' },
};
export const OPPORTUNITY_KINDS = { open_call: 'Open call', exhibition: 'Exhibition', residency: 'Residency', prize: 'Prize' };
export const EXHIBITION_KINDS = { solo: 'Solo show', group: 'Group show', fair: 'Art fair', online: 'Online exhibition', residency: 'Residency' };
const date = (d) => new Date(`${String(d).slice(0, 10)}T00:00:00Z`).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const daysLeft = (d) => Math.ceil((Date.parse(`${String(d).slice(0, 10)}T23:59:59Z`) - Date.now()) / 864e5);

// ——— Coach ———
/** state: { tool, artworkId, opportunityId, busy, result, error }, usage, works [{id,title}], opportunities [{id,title}] */
export function coachPage({ state, usage, works = [], opportunities = [], configured = true }) {
  const tool = COACH_TOOLS[state.tool] ? state.tool : 'bio';
  const left = usage ? Math.max(0, usage.limit - usage.used) : null;
  const picker = COACH_TOOLS[tool].needs === 'artwork'
    ? `<label class="field"><span>Work</span><select id="coach-artwork">${works.map((w) => `<option value="${esc(w.id)}"${w.id === state.artworkId ? ' selected' : ''}>${esc(w.title)}</option>`).join('')}</select></label>`
    : COACH_TOOLS[tool].needs === 'opportunity'
      ? (opportunities.length ? `<label class="field"><span>Opportunity</span><select id="coach-opportunity">${opportunities.map((o) => `<option value="${esc(o.id)}"${o.id === state.opportunityId ? ' selected' : ''}>${esc(o.title)}</option>`).join('')}</select></label>` : '<p class="muted">No open listings right now. <a href="#opportunities">See Opportunities</a>.</p>')
      : '';
  const blocked = (COACH_TOOLS[tool].needs === 'artwork' && !works.length) || (COACH_TOOLS[tool].needs === 'opportunity' && !opportunities.length);
  return `<div class="shell coach">
    <header class="page-head"><p class="eyebrow">Studio</p><h1 class="display-lg">Career Coach</h1>
      <p class="muted">Drafts written from your own profile, works and numbers, never invented facts, prices or valuations. Always read and edit before you use them.</p>
      ${left != null ? `<p class="coach-usage">${Icon('spark', { size: 14 })} ${left} of ${usage.limit} requests left this month</p>` : ''}</header>
    ${configured ? '' : `<p class="notice">${Icon('info', { size: 16 })} The Coach isn’t switched on yet. The site owner needs to add an AI key.</p>`}
    <div class="coach-tools" role="radiogroup" aria-label="What should the Coach draft?">${Object.entries(COACH_TOOLS).map(([k, v]) => `<button class="coach-tool${k === tool ? ' is-on' : ''}" role="radio" aria-checked="${k === tool}" data-act="coach-tool" data-v="${k}"><b>${esc(v.label)}</b><small>${esc(v.blurb)}</small></button>`).join('')}</div>
    <div class="coach-run">${picker}
      ${PremiumButton(state.busy ? 'Drafting…' : 'Draft it', { act: 'coach-run', attrs: `${state.busy || blocked || left === 0 || !configured ? 'disabled' : ''}` })}</div>
    ${state.error ? `<p class="form-error" role="alert">${esc(state.error)}</p>` : ''}
    ${state.result ? `<section class="coach-result" aria-live="polite">
      <p class="eyebrow">Draft · ${esc(COACH_TOOLS[state.result.tool]?.label || '')}</p>
      <div class="coach-text" id="coach-text">${esc(state.result.text)}</div>
      <p class="fine">Based on ${esc(state.result.basedOn.join(', '))}. Check every fact before you use it; nothing has been saved or published.</p>
      <div class="detail-actions">${PremiumButton('Copy', { act: 'coach-copy', variant: 'secondary', icon: 'check' })}</div></section>` : ''}
  </div>`;
}

// ——— Passport ———
/** The public Passport (artist page tab). p: artist_passport() result. ctx: { artworkTitle(id) } */
export function passportHTML(p, { artworkTitle = (id) => id } = {}) {
  if (!p) return EmptyState({ icon: 'spark', title: 'No Passport yet', body: 'Passports belong to member artists.' });
  const m = p.milestones || {};
  const milestones = [['Joined Abremi', m.joined], ['First work published', m.first_work], ['First drop released', m.first_drop], ['First collector inquiry', m.first_inquiry]].filter(([, t]) => t);
  const ordinal = (n) => `${n}${n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th'}`;
  return `<div class="passport">
    <section>${SectionHeader({ eyebrow: 'Verified by Abremi moderators', title: 'Exhibitions' })}
      ${p.exhibitions.length ? `<ol class="passport-list">${p.exhibitions.map((e) => `<li><span class="passport-mark">${Icon('check', { size: 14 })}</span><div>
        <b>${esc(e.title)}</b><small>${esc(EXHIBITION_KINDS[e.kind] || e.kind)} · ${esc(e.venue)}${e.city ? `, ${esc(e.city)}` : ''} · ${esc(date(e.start_date))}${e.end_date ? ` to ${esc(date(e.end_date))}` : ''}</small>
        <a href="${esc(e.link)}" target="_blank" rel="noopener noreferrer nofollow">Source</a></div></li>`).join('')}</ol>` : '<p class="muted">No verified exhibitions yet.</p>'}</section>
    <section>${SectionHeader({ eyebrow: 'Artist Arena', title: 'Competitions' })}
      ${p.competitions.length ? `<ol class="passport-list">${p.competitions.map((c) => `<li><span class="passport-mark">${Icon('trophy', { size: 14 })}</span><div>
        <b><a href="#competition/${encodeURIComponent(c.id)}">${esc(c.title)}</a></b><small>${c.place ? `${ordinal(c.place)} place` : 'Entered'} · ${c.votes} vote${c.votes === 1 ? '' : 's'} · “${esc(artworkTitle(c.artwork))}” · ${esc(date(c.closed_at))}</small></div></li>`).join('')}</ol>` : '<p class="muted">No finished competitions yet.</p>'}</section>
    <section>${SectionHeader({ eyebrow: 'Earned on Abremi', title: 'Achievements' })}
      ${p.achievements.length ? `<div class="signal-row">${p.achievements.map((a) => `<span class="badge" title="${esc(a.criteria)}">${esc(a.label)} · ${esc(date(a.at))}</span>`).join('')}</div>` : '<p class="muted">None yet.</p>'}</section>
    <section>${SectionHeader({ eyebrow: 'From Abremi records', title: 'Milestones' })}
      <ol class="passport-list">${milestones.map(([k, t]) => `<li><span class="passport-mark">${Icon('clock', { size: 14 })}</span><div><b>${esc(k)}</b><small>${esc(date(t))}</small></div></li>`).join('')}</ol></section>
    <p class="fine">Every entry comes from an Abremi record. Exhibitions appear only after a moderator has checked their source. Sales will appear once verified checkout exists.</p>
  </div>`;
}

/** The artist's own exhibitions, with the add form. */
export function exhibitionsSheet(list = []) {
  const status = { pending: 'Waiting for review', verified: 'Verified', rejected: 'Couldn’t be verified' };
  return `<form class="auth" id="exhibition-form" novalidate>
    <p class="eyebrow">Artist Passport</p><h2 class="display-md" id="modal-title">Exhibitions</h2>
    ${list.length ? `<ul class="pick-list">${list.map((e) => `<li class="exhibition-row"><span><b>${esc(e.title)}</b><small>${esc(e.venue)} · ${esc(date(e.start_date))} · ${esc(status[e.status])}${e.review_note ? ` (${esc(e.review_note)})` : ''}</small></span>
      <button type="button" class="link" data-act="exhibition-delete" data-id="${esc(e.id)}">Remove</button></li>`).join('')}</ul>` : ''}
    <h3 class="sub-head">Add an exhibition</h3>
    <div class="field-row"><label class="field"><span>Type</span><select id="ex-kind">${Object.entries(EXHIBITION_KINDS).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</select></label>
      <label class="field"><span>Title</span><input id="ex-title" maxlength="120"></label></div>
    <div class="field-row"><label class="field"><span>Venue</span><input id="ex-venue" maxlength="120"></label>
      <label class="field"><span>City</span><input id="ex-city" maxlength="60"></label></div>
    <div class="field-row"><label class="field"><span>Opened</span><input id="ex-start" type="date"></label>
      <label class="field"><span>Closed (optional)</span><input id="ex-end" type="date"></label></div>
    <label class="field"><span>Link that shows it (venue page, press, catalogue)</span><input id="ex-link" type="url" placeholder="https://"></label>
    <p class="form-error" id="ex-error" role="alert" hidden></p>
    <div class="detail-actions">${PremiumButton('Send for verification', { act: 'exhibition-submit' })}</div>
    <p class="fine">A moderator checks the link before the exhibition appears on your public Passport. You’ll get a notification either way.</p>
  </form>`;
}

// ——— Opportunities ———
export function opportunityCard(o, { signedIn = false, artist = false } = {}) {
  const left = daysLeft(o.deadline);
  return `<article class="opportunity">
    <p class="eyebrow">${esc(OPPORTUNITY_KINDS[o.kind] || o.kind)} · ${left <= 0 ? 'Closes today' : `Closes in ${left} day${left === 1 ? '' : 's'}`}</p>
    <h3>${esc(o.title)}</h3>
    <p class="muted">${o.gallery_id ? `<a href="#gallery/${esc(o.gallery_id)}">${esc(o.organizer)}</a> <span class="verified-mark" title="Verified gallery">${Icon('check', { size: 12 })} Verified gallery</span>` : esc(o.organizer)} · ${esc(o.location)} · deadline ${esc(date(o.deadline))}</p>
    <p class="opportunity-fee ${Number(o.fee) > 0 ? 'has-fee' : ''}">${Number(o.fee) > 0 ? `${Icon('info', { size: 14 })} Application fee: ${esc(o.fee_currency)} ${esc(Number(o.fee).toFixed(2).replace(/\.00$/, ''))}` : 'Free to apply'}</p>
    ${o.eligibility ? `<p><b>Who can apply:</b> ${esc(o.eligibility)}</p>` : ''}
    ${o.description ? `<p class="muted">${esc(o.description)}</p>` : ''}
    <div class="detail-actions">
      <a class="btn btn-primary" href="${esc(o.link)}" target="_blank" rel="noopener noreferrer nofollow"><span>Apply on their site</span>${Icon('arrow', { size: 16 })}</a>
      ${signedIn ? PremiumButton(o.saved ? 'Saved' : 'Save', { act: 'opportunity-save', variant: 'secondary', icon: 'bookmark', attrs: `data-id="${esc(o.id)}" data-v="${o.saved ? 'off' : 'on'}" aria-pressed="${Boolean(o.saved)}"` }) : ''}
      ${artist ? PremiumButton('Draft with the Coach', { act: 'coach-for-opportunity', variant: 'ghost', icon: 'pen', attrs: `data-id="${esc(o.id)}"` }) : ''}
    </div></article>`;
}

export function opportunitiesPage(list, { kind = '', signedIn = false, artist = false } = {}) {
  const shown = (list || []).filter((o) => !kind || o.kind === kind);
  return `<div class="shell opportunities">
    <header class="page-head page-head-row"><div><p class="eyebrow">For artists</p><h1 class="display-lg">Opportunities</h1>
      <p class="muted">Open calls, exhibitions, residencies and prizes, checked by Abremi moderators. Any application fee is shown up front.</p></div>
      ${signedIn ? PremiumButton('Suggest one', { act: 'opportunity-suggest', variant: 'secondary', icon: 'plus' }) : ''}</header>
    <div class="chip-row chip-row-wrap">${[['', 'All'], ...Object.entries(OPPORTUNITY_KINDS)].map(([k, v]) => `<button class="chip${k === kind ? ' is-on' : ''}" data-act="opportunity-kind" data-v="${k}">${esc(v)}</button>`).join('')}</div>
    ${list == null ? '<div class="skel skel-line"></div>' : shown.length ? `<div class="opportunity-list">${shown.map((o) => opportunityCard(o, { signedIn, artist })).join('')}</div>`
      : EmptyState({ icon: 'search', title: 'No open listings right now', body: signedIn ? 'Know of one? Suggest it and a moderator will check it.' : 'New listings appear here after a moderator checks them.' })}
    <p class="fine">Saved listings send you a reminder 3 days before the deadline. Abremi doesn’t take part in selection; apply on the organizer’s site.</p>
  </div>`;
}

export function opportunityForm({ admin = false } = {}) {
  const soon = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
  return `<form class="auth" id="opportunity-form" novalidate>
    <p class="eyebrow">${admin ? 'Publish' : 'Suggest'} an opportunity</p><h2 class="display-md" id="modal-title">${admin ? 'New listing' : 'Know of an open call?'}</h2>
    <div class="field-row"><label class="field"><span>Type</span><select id="op-kind">${Object.entries(OPPORTUNITY_KINDS).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</select></label>
      <label class="field"><span>Deadline</span><input id="op-deadline" type="date" value="${soon}"></label></div>
    <label class="field"><span>Title</span><input id="op-title" maxlength="120"></label>
    <div class="field-row"><label class="field"><span>Organizer</span><input id="op-organizer" maxlength="120"></label>
      <label class="field"><span>Location</span><input id="op-location" maxlength="120" placeholder="City, country, or Online"></label></div>
    <label class="field"><span>Who can apply</span><input id="op-eligibility" maxlength="1000"></label>
    <label class="field"><span>Description</span><textarea id="op-description" rows="3" maxlength="2000"></textarea></label>
    <div class="field-row"><label class="field"><span>Application fee (0 if free)</span><input id="op-fee" type="number" min="0" step="0.01" value="0"></label>
      <label class="field"><span>Currency</span><input id="op-currency" maxlength="3" value="USD"></label></div>
    <label class="field"><span>Official link</span><input id="op-link" type="url" placeholder="https://"></label>
    <p class="form-error" id="op-error" role="alert" hidden></p>
    <div class="detail-actions">${PremiumButton(admin ? 'Publish' : 'Send for review', { act: 'opportunity-submit' })}</div>
    ${admin ? '' : '<p class="fine">A moderator checks every suggestion before it’s listed.</p>'}
  </form>`;
}

/** Moderators: exhibitions and opportunity suggestions waiting for review. */
export function reviewQueuesHTML({ exhibitions = [], opportunities = [] }) {
  return `<section class="section section-tight">${SectionHeader({ eyebrow: 'Artist Passport', title: 'Exhibitions to verify' })}
    ${exhibitions.length ? exhibitions.map((e) => `<article class="flag-card"><p class="eyebrow">${esc(e.artist)} · ${esc(EXHIBITION_KINDS[e.kind] || e.kind)}</p>
      <h3>${esc(e.title)}</h3><p class="muted">${esc(e.venue)}${e.city ? `, ${esc(e.city)}` : ''} · ${esc(date(e.start_date))}</p>
      <p><a href="${esc(e.link)}" target="_blank" rel="noopener noreferrer nofollow">${esc(e.link)}</a></p>
      <div class="detail-actions">${PremiumButton('Verify', { act: 'exhibition-review', attrs: `data-id="${esc(e.id)}" data-v="verify"` })}
        ${PremiumButton('Can’t verify', { act: 'exhibition-review', variant: 'secondary', attrs: `data-id="${esc(e.id)}" data-v="reject"` })}</div></article>`).join('') : '<p class="muted">Nothing to verify.</p>'}
  </section>
  <section class="section section-tight">${SectionHeader({ eyebrow: 'Opportunities', title: 'Suggestions to review', action: PremiumButton('Post a listing', { act: 'opportunity-suggest', variant: 'secondary', icon: 'plus' }) })}
    ${opportunities.length ? opportunities.map((o) => `<article class="flag-card"><p class="eyebrow">${esc(OPPORTUNITY_KINDS[o.kind] || o.kind)} · deadline ${esc(date(o.deadline))}${Number(o.fee) > 0 ? ` · fee ${esc(o.fee_currency)} ${esc(o.fee)}` : ''}</p>
      <h3>${esc(o.title)}</h3><p class="muted">${esc(o.organizer)} · ${esc(o.location)}</p>
      <p><a href="${esc(o.link)}" target="_blank" rel="noopener noreferrer nofollow">${esc(o.link)}</a></p>
      <div class="detail-actions">${PremiumButton('Approve', { act: 'opportunity-review', attrs: `data-id="${esc(o.id)}" data-v="approve"` })}
        ${PremiumButton('Reject', { act: 'opportunity-review', variant: 'secondary', attrs: `data-id="${esc(o.id)}" data-v="reject"` })}</div></article>`).join('') : '<p class="muted">No suggestions waiting.</p>'}
  </section>`;
}
