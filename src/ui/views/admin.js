// The moderator page (#admin): role applications, competitions, review queues, plan grants, gallery
// verification, beta tools (invites, feedback, app errors), integrity flags and the audit trail.
// Pure HTML builders, moved out of app.js; every action is checked again by the database.

import { esc, fmt, flag, Avatar, PremiumButton, EmptyState, SectionHeader } from '../components.js';
import { PALETTES } from '../../core/seed.js';
import { hashString } from '../../core/random.js';
import { PLANS } from '../../core/plans.js';
import { reviewQueuesHTML } from './careers.js';
import { reportsHTML } from './radar.js';
import { FEEDBACK_KINDS } from './membership.js';

const day = (t) => new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
const when = (t) => new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const planName = (code) => PLANS.find((p) => p.code === code)?.name || code;

/**
 * @param {any} data everything loadAdmin() fetched
 * @param {{ roleLabel: (role: string) => string, competitionSection: string, planSearch?: { query: string, results: any[] | null } }} o
 */
export function adminPage(data, { roleLabel, competitionSection, planSearch = { query: '', results: null } }) {
  const { queue, verified } = data;
  const stat = (n, label) => `<div><dt>${label}</dt><dd>${fmt(n)}</dd></div>`;
  return `<div class="shell admin">
    <header class="page-head page-head-row"><div><p class="eyebrow">Moderation</p><h1 class="display-lg">Applications</h1>
      <p class="muted">${queue.length} pending · ${verified.length} verified members</p></div>
      ${PremiumButton('Refresh', { act: 'admin-reload', variant: 'secondary' })}</header>
    <nav class="chip-row chip-row-wrap admin-jump" aria-label="Jump to">${[['admin-plans', 'Plans'], ['admin-galleries', 'Galleries'], ['admin-beta', 'Beta'], ['integrity', 'Integrity']]
      .map(([id, label]) => `<a class="chip" href="#admin" data-act="admin-jump" data-v="${id}">${label}</a>`).join('')}</nav>
    ${queue.length ? queue.map((a) => `<article class="app-card">
      <header><div><p class="eyebrow">${esc(roleLabel(a.role))} · ${new Date(a.created_at).toLocaleDateString([], { month: 'short', day: 'numeric' })}</p>
        <h2 class="display-sm">${esc(a.applicant_name)} <span class="flag">${flag(a.applicant_country)}</span></h2>
        <p class="muted">${esc(a.email || '')} · currently ${esc(a.applicant_role)} · member since ${new Date(a.member_since).toLocaleDateString([], { month: 'short', year: 'numeric' })}${a.previous_declines ? ` · ${a.previous_declines} earlier decline${a.previous_declines === 1 ? '' : 's'}` : ''}</p></div></header>
      <blockquote class="quote app-statement">${esc(a.statement)}</blockquote>
      ${a.links?.length ? `<ul class="app-links">${a.links.map((l) => /^https:\/\//.test(l) ? `<li><a href="${esc(l)}" target="_blank" rel="noopener noreferrer nofollow">${esc(l)}</a></li>` : '').join('')}</ul>` : '<p class="muted">No links provided.</p>'}
      <dl class="stat-row app-stats">${stat(a.influence_added, 'Influence added')}${stat(a.likes, 'Likes')}${stat(a.saves, 'Super Likes')}${stat(a.reviews, 'Reviews')}</dl>
      <label class="field"><span>Note to the applicant (optional)</span><textarea id="note-${a.id}" rows="2" maxlength="500"></textarea></label>
      <div class="detail-actions">
        ${PremiumButton(`Approve as ${roleLabel(a.role)}`, { act: 'admin-decide', attrs: `data-id="${a.id}" data-v="approve"` })}
        ${PremiumButton('Decline', { act: 'admin-decide', variant: 'secondary', attrs: `data-id="${a.id}" data-v="decline"` })}
      </div></article>`).join('') : EmptyState({ icon: 'check', title: 'All caught up', body: 'No applications are waiting.' })}
    <section class="section section-tight">${SectionHeader({ eyebrow: 'Verified', title: 'Critics & collectors' })}
      ${verified.length ? `<ol class="rank-list">${verified.map((v) => `<li><div class="rank-row">${Avatar({ name: v.name, palette: hashString(v.name) % PALETTES.length }, 'md')}
        <span class="rank-text"><b>${esc(v.name)} <span class="flag">${flag(v.country)}</span></b><small>${esc(roleLabel(v.role))} · ${esc(v.email || '')}${v.approved_at ? ` · since ${new Date(v.approved_at).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}` : ''}</small></span>
        ${PremiumButton('Remove role', { act: 'admin-revoke', variant: 'ghost', attrs: `data-id="${v.user_id}" data-name="${esc(v.name)}" data-danger` })}</div></li>`).join('')}</ol>` : '<p class="muted">Nobody yet.</p>'}
    </section>
    ${competitionSection}
    ${reviewQueuesHTML({ exhibitions: data.exQueue || [], opportunities: data.oppQueue || [] })}
    ${galleriesHTML(data.galleries || [])}
    ${plansAdminHTML(data.holders || [], planSearch)}
    ${betaHTML(data.invites, data.feedback || [], data.errors || [])}
    ${reportsHTML(data.reports || [])}
    ${integrityHTML(data.flags || [])}
    ${auditHTML(data.audit || [])}
  </div>`;
}

/** Gallery applications waiting for verification. */
export function galleriesHTML(queue) {
  return `<section class="section section-tight" id="admin-galleries">${SectionHeader({ eyebrow: 'Gallery accounts', title: 'Galleries to verify' })}
    ${queue.length ? queue.map((g) => `<article class="app-card">
      <p class="eyebrow">${esc(g.city)} · ${flag(g.country)} · applied ${esc(day(g.created_at))} by ${esc(g.member || 'a member')}</p>
      <h3 class="display-sm">${esc(g.name)}</h3>
      <p><a href="${esc(g.website)}" target="_blank" rel="noopener noreferrer nofollow">${esc(g.website)}</a></p>
      ${g.bio ? `<p class="muted">${esc(g.bio)}</p>` : ''}
      <label class="field"><span>Note (sent to the applicant, recorded)</span><input id="gal-note-${esc(g.id)}" maxlength="500"></label>
      <div class="detail-actions">
        ${PremiumButton('Verify gallery', { act: 'gallery-review', attrs: `data-id="${esc(g.id)}" data-v="verify"` })}
        ${PremiumButton('Decline', { act: 'gallery-review', variant: 'secondary', attrs: `data-id="${esc(g.id)}" data-v="decline"` })}
      </div></article>`).join('') : '<p class="muted">No gallery applications waiting.</p>'}
    <p class="fine">Check that the website belongs to a real gallery and that the applicant can speak for it.</p>
  </section>`;
}

/** Grant a plan for a fixed period (beta testers, partners), and see who has one. */
export function plansAdminHTML(holders, { query, results }) {
  const tomorrow = new Date(Date.now() + 864e5).toISOString().slice(0, 10);
  const inMonth = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
  const yearOut = new Date(Date.now() + 366 * 864e5).toISOString().slice(0, 10);
  return `<section class="section section-tight" id="admin-plans">${SectionHeader({ eyebrow: 'Plans', title: 'Grant a plan' })}
    <p class="muted">While payments are off, plans are granted here for a fixed period. Every grant is recorded and the member is told.</p>
    <div class="search-row"><label class="field"><span>Find a member by display or artist name</span><input id="plan-search" value="${esc(query)}" minlength="2" maxlength="60"></label>
      ${PremiumButton('Search', { act: 'plan-search', variant: 'secondary' })}</div>
    ${results ? (results.length ? `<ul class="grant-list">${results.map((m) => `<li class="grant-row">
        <span class="rank-text"><b>${esc(m.name)} <span class="flag">${flag(m.country)}</span></b><small>${esc(m.role)}${m.artist_id ? ' · artist' : ''}${m.verified_gallery ? ' · verified gallery' : ''} · now ${esc(planName(m.plan))}</small></span>
        <select id="grant-plan-${esc(m.id)}" aria-label="Plan">${PLANS.filter((p) => p.code !== 'free' && (p.code !== 'gallery' || m.verified_gallery)).map((p) => `<option value="${p.code}">${esc(p.name)}</option>`).join('')}</select>
        <input id="grant-until-${esc(m.id)}" type="date" min="${tomorrow}" max="${yearOut}" value="${inMonth}" aria-label="Until">
        <input id="grant-note-${esc(m.id)}" maxlength="300" placeholder="Note (e.g. beta tester)" aria-label="Note">
        ${PremiumButton('Grant', { act: 'plan-grant', attrs: `data-id="${esc(m.id)}"` })}</li>`).join('')}</ul>` : '<p class="muted">No members match.</p>') : ''}
    <h3 class="sub-head">Current plans</h3>
    ${holders.length ? `<ul class="grant-list">${holders.map((h) => `<li class="grant-row"><span class="rank-text"><b>${esc(h.name)}</b>
        <small>${esc(planName(h.plan))} · ${h.source === 'grant' ? 'granted' : 'paid'}${h.ends_at ? ` · until ${esc(day(h.ends_at))}` : ''}${h.note ? ` · “${esc(h.note)}”` : ''}</small></span>
        ${h.source === 'grant' ? PremiumButton('Remove', { act: 'plan-revoke', variant: 'ghost', attrs: `data-id="${esc(h.user_id)}" data-name="${esc(h.name)}" data-danger` }) : ''}</li>`).join('')}</ul>`
      : '<p class="muted">Everyone is on Artist Free.</p>'}
  </section>`;
}

/** Beta tools: invite codes (and whether new sign-ups need one), feedback, and app errors. */
export function betaHTML(invites, feedback, errors) {
  const required = Boolean(invites?.invite_required);
  return `<section class="section section-tight" id="admin-beta">${SectionHeader({ eyebrow: 'Beta', title: 'Invites, feedback and errors' })}
    <div class="beta-toggle"><p><b>New sign-ups ${required ? 'need an invite code' : 'are open to everyone'}.</b> Existing members always sign in as usual.</p>
      ${PremiumButton(required ? 'Open sign-ups' : 'Require invite codes', { act: 'invite-required', variant: 'secondary', attrs: `data-v="${required ? 'off' : 'on'}"` })}</div>
    <div class="invite-form">
      <label class="field"><span>Uses</span><input id="invite-uses" type="number" min="1" max="500" value="10"></label>
      <label class="field"><span>Valid for (days)</span><input id="invite-days" type="number" min="1" max="365" value="30"></label>
      <label class="field"><span>Note</span><input id="invite-note" maxlength="200" placeholder="e.g. Lisbon artists"></label>
      ${PremiumButton('Create invite code', { act: 'invite-create' })}</div>
    ${invites?.codes?.length ? `<ul class="grant-list">${invites.codes.slice(0, 30).map((c) => `<li class="grant-row">
      <span class="rank-text"><b class="invite-code">${esc(c.code)}</b><small>${c.uses} of ${c.max_uses} used${c.expires_at ? ` · until ${esc(day(c.expires_at))}` : ''}${c.note ? ` · ${esc(c.note)}` : ''}${c.revoked ? ' · revoked' : ''}</small></span>
      ${c.revoked ? '' : `${PremiumButton('Copy', { act: 'invite-copy', variant: 'ghost', attrs: `data-v="${esc(c.code)}"` })}${PremiumButton('Revoke', { act: 'invite-revoke', variant: 'ghost', attrs: `data-v="${esc(c.code)}" data-danger` })}`}</li>`).join('')}</ul>` : ''}
    <h3 class="sub-head">Feedback (${feedback.length} open)</h3>
    ${feedback.length ? feedback.map((f) => `<article class="flag-card">
      <p class="eyebrow">${esc(FEEDBACK_KINDS[f.kind] || f.kind)} · ${esc(f.member || 'Member')} · ${esc(when(f.created_at))}${f.page ? ` · ${esc(f.page)}` : ''}</p>
      <p>${esc(f.message)}</p>${f.user_agent ? `<p class="fine">${esc(f.user_agent)}</p>` : ''}
      <div class="detail-actions">${PremiumButton('Mark resolved', { act: 'feedback-resolve', variant: 'secondary', attrs: `data-id="${esc(f.id)}"` })}</div></article>`).join('')
      : '<p class="muted">No open feedback.</p>'}
    <h3 class="sub-head">App errors, last 7 days</h3>
    ${errors.length ? `<ul class="error-list">${errors.map((e) => `<li><b>${esc(e.message)}</b><small>${e.count}× · last ${esc(when(e.last_seen))}${e.source ? ` · ${esc(e.source)}` : ''}${e.pages?.length ? ` · ${esc(e.pages.slice(0, 3).join(', '))}` : ''}${e.releases?.length ? ` · release ${esc(e.releases.join(', '))}` : ''}</small></li>`).join('')}</ul>`
      : '<p class="muted">No errors reported.</p>'}
    <p class="fine">Errors are recorded without accounts, emails or IP addresses, and deleted after 30 days.</p>
  </section>`;
}

/** Integrity flags: bursts of likes from brand-new accounts, for a moderator to confirm or dismiss. */
export function integrityHTML(flags) {
  return `<section class="section section-tight" id="integrity">${SectionHeader({ eyebrow: 'Ranking integrity', title: 'Flags to review' })}
    ${flags.length ? flags.map((f) => `<article class="flag-card">
      <p class="eyebrow">Burst from new accounts · ${esc(when(f.created_at))}</p>
      <h3><button class="link" data-act="artwork" data-id="${esc(f.target_id)}">${esc(f.title || f.target_id)}</button></h3>
      <p class="muted">${Number(f.details?.total) || 0} likes or saves in an hour, ${Number(f.details?.new_accounts) || 0} of them from accounts under 3 days old.</p>
      <label class="field"><span>Note (recorded in the audit log)</span><input id="flag-note-${esc(f.id)}" maxlength="500"></label>
      <div class="detail-actions">
        ${PremiumButton('Exclude those likes', { act: 'flag-resolve', attrs: `data-id="${esc(f.id)}" data-v="exclude" data-danger` })}
        ${PremiumButton('Looks genuine', { act: 'flag-resolve', variant: 'secondary', attrs: `data-id="${esc(f.id)}" data-v="dismiss"` })}
      </div></article>`).join('') : '<p class="muted">Nothing to review. Abremi checks for bursts from new accounts every 10 minutes.</p>'}
    <p class="fine">Excluding never deletes anything: the likes stop counting toward rankings, and the decision is recorded.</p>
  </section>`;
}

const AUDIT_LABELS = {
  'role_application.approved': 'approved a role application', 'role_application.declined': 'declined a role application',
  'role.revoked': 'removed a verified role', 'artwork.deleted': 'deleted an artwork',
  'integrity_flag.confirmed': 'excluded a burst of likes', 'integrity_flag.dismissed': 'dismissed an integrity flag',
  'plan.granted': 'granted a plan', 'plan.revoked': 'removed a granted plan',
  'gallery.verified': 'verified a gallery', 'gallery.rejected': 'declined a gallery',
  'invite.created': 'created an invite code', 'invite.revoked': 'revoked an invite code',
  'beta.invites_required': 'required invite codes for sign-up', 'beta.invites_optional': 'opened sign-ups',
  'opportunity.published_by_gallery': 'published a listing (verified gallery)',
};
export function auditHTML(rows) {
  if (!rows.length) return '';
  return `<section class="section section-tight">${SectionHeader({ eyebrow: 'Audit trail', title: 'Recent sensitive actions' })}
    <ul class="audit-list">${rows.slice(0, 30).map((r) => `<li><b>${esc(r.actor_email || 'Someone')}</b> ${esc(AUDIT_LABELS[r.action] || r.action)}
      <small>· ${esc(new Date(r.created_at).toLocaleString())}${r.details?.note ? ` · “${esc(r.details.note)}”` : ''}${r.details?.title ? ` · ${esc(r.details.title)}` : ''}${r.details?.plan ? ` · ${esc(planName(r.details.plan))}` : ''}</small></li>`).join('')}</ul>
  </section>`;
}
