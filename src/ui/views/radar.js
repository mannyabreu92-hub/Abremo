// Collector Radar (inquiries between members and artists) and Drops (scheduled releases).
// Pure HTML builders; app.js supplies data and helpers. Rules live in
// supabase/migrations/0010_radar_drops.sql.

import { esc, Icon, PremiumButton, EmptyState, SectionHeader, t } from '../components.js';

/** Before release: a soft veil painted from nine colours of the teaser (the image itself isn't sent). */
function veilHTML(palette) {
  const colours = String(palette || '').split(',').filter((c) => /^#[0-9a-f]{6}$/.test(c));
  if (colours.length !== 9) return '';
  return `<svg class="drop-veil" viewBox="0 0 3 3" preserveAspectRatio="none" aria-hidden="true">${colours.map((c, i) => `<rect x="${i % 3}" y="${Math.floor(i / 3)}" width="1.02" height="1.02" fill="${c}"/>`).join('')}</svg>`;
}

export const INQUIRY_KINDS = {
  purchase: { label: 'Interested in buying', needsWork: true },
  question: { label: 'A question' },
  commission: { label: 'Commission a work' },
  sponsorship: { label: 'Sponsorship or support' },
};
const ROLE_LABEL = { fan: 'Fan', artist: 'Artist', critic: 'Verified critic', collector: 'Verified collector' };
const when = (t) => new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/** Start a conversation. ctx: { artwork?: { id, title, available }, artist: { id, name }, kind, html (thumb) } */
export function inquirySheet({ artwork = null, artist, kind = 'question', thumb = '' }) {
  const kinds = Object.entries(INQUIRY_KINDS).filter(([k, v]) => (artwork ? k !== 'purchase' || artwork.available : !v.needsWork));
  return `<form class="auth inquiry-form" id="inquiry-form" novalidate data-artwork="${esc(artwork?.id || '')}" data-artist="${esc(artist.id)}">
    <p class="eyebrow">${t('Write to the artist')}</p>
    <h2 class="display-sm" id="modal-title">${artwork ? esc(artwork.title) : esc(artist.name)}</h2>
    ${artwork ? `<div class="inquiry-subject">${thumb}<span>${t('by {name}', { name: esc(artist.name) })}</span></div>` : ''}
    <div class="chip-row chip-row-wrap" role="radiogroup" aria-label="${t('What is it about?')}">${kinds.map(([k, v]) => `<button type="button" role="radio" class="chip${k === kind ? ' is-on' : ''}" aria-checked="${k === kind}" data-act="inquiry-kind" data-v="${k}">${esc(t(v.label))}</button>`).join('')}</div>
    <input type="hidden" id="inquiry-kind" value="${esc(kinds.some(([k]) => k === kind) ? kind : kinds[0][0])}">
    <label class="field"><span>${t('Message')}</span><textarea id="inquiry-message" rows="5" maxlength="2000" placeholder="${t('Introduce yourself and what you’d like to know.')}"></textarea><small class="char-count" id="inquiry-message-count" data-max="2000">0 / 2000</small></label>
    <p class="form-error" id="inquiry-error" role="alert" hidden></p>
    <div class="detail-actions">${PremiumButton('Send', { act: 'send-inquiry' })}</div>
    <p class="fine">${t('Only you and the artist can read this conversation. Your email isn’t shared; each of you sees the other’s display name.')}</p>
  </form>`;
}

/** The inbox: conversations you received (as an artist) and started. */
export function inboxPage(list, { tab = 'received', thumb = (_id) => '', title = (id) => id } = {}) {
  const received = (list || []).filter((q) => q.side === 'artist');
  const sent = (list || []).filter((q) => q.side === 'sender');
  const rows = tab === 'sent' ? sent : received;
  const unread = (xs) => xs.filter((q) => q.unread).length;
  return `<div class="shell inbox">
    <header class="page-head"><p class="eyebrow">Collector Radar</p><h1 class="display-lg">Inbox</h1>
      <p class="muted">Conversations about works and commissions. Only the two people in a conversation can read it.</p></header>
    <div class="seg seg-gold" role="tablist">
      <button role="tab" aria-selected="${tab === 'received'}" class="${tab === 'received' ? 'is-on' : ''}" data-act="inbox-tab" data-v="received">Received${unread(received) ? ` · ${unread(received)}` : ''}</button>
      <button role="tab" aria-selected="${tab === 'sent'}" class="${tab === 'sent' ? 'is-on' : ''}" data-act="inbox-tab" data-v="sent">Sent${unread(sent) ? ` · ${unread(sent)}` : ''}</button>
    </div>
    ${list == null ? '<div class="skel skel-line"></div>' : rows.length ? `<ol class="inquiry-list">${rows.map((q) => `<li><a class="inquiry-row${q.unread ? ' is-unread' : ''}" href="#inquiry/${encodeURIComponent(q.id)}">
        <span class="inquiry-thumb">${q.artwork ? thumb(q.artwork) : Icon('mail', { size: 20 })}</span>
        <span class="inquiry-text"><b>${esc(q.other_name)}</b> <small>${esc(ROLE_LABEL[q.other_role] || '')}</small>
          <span class="inquiry-about">${esc(INQUIRY_KINDS[q.kind]?.label || q.kind)}${q.artwork ? ` · ${esc(title(q.artwork))}` : ''}${q.status !== 'open' ? ` · ${esc(q.status)}` : ''}</span>
          <span class="inquiry-last">${esc(q.last_message || '')}</span></span>
        <small class="inquiry-when">${esc(when(q.last_message_at))}</small></a></li>`).join('')}</ol>`
      : EmptyState({ icon: 'mail', title: tab === 'sent' ? 'You haven’t written to anyone yet' : 'No inquiries yet', body: tab === 'sent' ? 'Open any member’s work and choose Inquire.' : 'When collectors write about your work, it appears here.' })}
  </div>`;
}

/** One conversation. ctx: { thumb(id), title(id) } */
export function threadPage(q, { thumb = (_id) => '', title = (id) => id } = {}) {
  const open = q.status === 'open';
  return `<div class="shell thread">
    <a class="link-arrow back-link" href="#inbox">${Icon('back', { size: 14 })} Inbox</a>
    <header class="thread-head">
      ${q.artwork ? `<button class="inquiry-thumb" data-act="artwork" data-id="${esc(q.artwork)}">${thumb(q.artwork)}</button>` : ''}
      <div><p class="eyebrow">${esc(INQUIRY_KINDS[q.kind]?.label || q.kind)}${q.artwork ? ` · ${esc(title(q.artwork))}` : ''}</p>
        <h1 class="display-sm">${esc(q.other_name)} <small class="muted">${esc(ROLE_LABEL[q.other_role] || '')}</small></h1>
        ${q.offer ? `<p class="offer-line">Offer: <b>${esc(q.offer.currency)} ${esc(Number(q.offer.amount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }))}</b> · nothing is charged; agree the details here</p>` : ''}
        ${open ? '' : `<p class="tag">${q.status === 'declined' ? 'Declined by the artist' : 'Closed'}</p>`}</div>
    </header>
    <ol class="messages">${q.messages.map((m) => `<li class="message${m.mine ? ' is-mine' : ''}"><p>${esc(m.body)}</p><small>${esc(when(m.at))}</small></li>`).join('')}</ol>
    ${open && !q.blocked ? `<form class="reply" id="reply-form" novalidate data-id="${esc(q.id)}">
      <label class="field"><span class="sr-only">Reply</span><textarea id="reply-body" rows="3" maxlength="2000" placeholder="Write a reply"></textarea></label>
      <div class="detail-actions">${PremiumButton('Send', { act: 'send-reply' })}</div></form>` : ''}
    <div class="thread-actions">
      ${open ? (q.side === 'artist' ? PremiumButton('Decline', { act: 'inquiry-status', variant: 'ghost', attrs: `data-id="${esc(q.id)}" data-v="declined"` }) : '') + PremiumButton('Close conversation', { act: 'inquiry-status', variant: 'ghost', attrs: `data-id="${esc(q.id)}" data-v="closed"` }) : ''}
      ${PremiumButton(q.blocked ? 'Unblock' : 'Block', { act: 'inquiry-block', variant: 'ghost', attrs: `data-id="${esc(q.id)}" data-v="${q.blocked ? 'off' : 'on'}"` })}
      ${PremiumButton('Report', { act: 'inquiry-report', variant: 'ghost', attrs: `data-id="${esc(q.id)}"` })}
    </div>
    <p class="fine">Never send payment outside a trusted, verified checkout. Abremi doesn’t process sales yet.</p>
  </div>`;
}

// ——— Drops ———
export function countdown(t, now = Date.now()) {
  const ms = Math.max(0, Date.parse(t) - now);
  const d = Math.floor(ms / 864e5), h = Math.floor((ms % 864e5) / 36e5), m = Math.floor((ms % 36e5) / 6e4);
  return d ? `${d}d ${h}h ${m}m` : h ? `${h}h ${m}m` : `${Math.max(1, m)}m`;
}

/** Upcoming and recent drops (Home). ctx.image(path) → URL. */
export function dropsSection(list, { image = (p) => p } = {}) {
  if (!list?.length) return '';
  return `<section class="section drops-section">${SectionHeader({ eyebrow: 'Drops', title: 'Scheduled releases' })}
    <div class="drop-row">${list.slice(0, 6).map((d) => dropCard(d, image)).join('')}</div></section>`;
}

function dropCard(d, image) {
  return `<a class="drop-card phase-${esc(d.phase)}" href="#drop/${encodeURIComponent(d.id)}">
    <span class="drop-teaser${d.phase === 'upcoming' ? ' is-veiled' : ''}">${d.teaser_thumb ? `<img src="${esc(image(d.teaser_thumb))}" alt="" loading="lazy">` : veilHTML(d.teaser_palette)}</span>
    <span class="drop-text"><span class="eyebrow">${d.phase === 'upcoming' ? `In ${esc(countdown(d.release_at))}` : 'Released'}</span>
      <b>${esc(d.title)}</b><small>${esc(d.artist_name)} · ${d.works} work${d.works === 1 ? '' : 's'}</small></span></a>`;
}

/** A drop's page. ctx: { image(path), card(artworkId) → HTML, signedIn } */
export function dropPage(d, { image = (p) => p, card = (_id) => '', signedIn = false } = {}) {
  const upcoming = d.phase === 'upcoming';
  return `<div class="shell drop-page">
    <header class="drop-hero">
      <span class="drop-teaser drop-teaser-lg${upcoming && !d.mine ? ' is-veiled' : ''}">${d.teaser_thumb ? `<img src="${esc(image(d.teaser_thumb))}" alt="">` : veilHTML(d.teaser_palette)}</span>
      <div class="drop-copy"><p class="eyebrow">${upcoming ? 'Drop · coming soon' : d.phase === 'cancelled' ? 'Drop · cancelled' : 'Drop · released'}</p>
        <h1 class="display-lg">${esc(d.title)}</h1>
        <p class="muted">by <a href="#artist/${encodeURIComponent(d.artist_id)}">${esc(d.artist_name)}</a> · ${d.work_count} work${d.work_count === 1 ? '' : 's'}</p>
        ${d.description ? `<p class="lede">${esc(d.description)}</p>` : ''}
        ${upcoming ? `<p class="drop-countdown" data-release="${esc(d.release_at)}">${Icon('clock', { size: 18 })} <b>${esc(countdown(d.release_at))}</b> · ${esc(new Date(d.release_at).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))}</p>` : ''}
        <div class="detail-actions">
          ${upcoming && !d.mine ? (signedIn ? PremiumButton(d.subscribed ? 'You’ll be notified' : 'Notify me', { act: 'drop-subscribe', variant: d.subscribed ? 'secondary' : 'primary', icon: 'bell', attrs: `data-id="${esc(d.id)}" data-v="${d.subscribed ? 'off' : 'on'}"` }) : PremiumButton('Sign in to be notified', { act: 'sign-in' })) : ''}
          ${upcoming && d.mine ? PremiumButton('Cancel drop', { act: 'drop-cancel', variant: 'ghost', attrs: `data-id="${esc(d.id)}" data-danger` }) : ''}
        </div>
        ${upcoming ? `<p class="fine">${d.mine ? 'Only you can see these works until the release. Your followers were notified.' : 'The works are revealed at the release time. Followers of the artist are notified automatically.'}</p>` : ''}
      </div>
    </header>
    ${d.works.length ? `<div class="art-grid">${d.works.map((id) => card(id)).join('')}</div>` : ''}
  </div>`;
}

/** Schedule a drop from your own works. works: [{ id, title }] */
export function createDropForm(works) {
  const soon = new Date(Date.now() + 3 * 864e5); soon.setMinutes(0, 0, 0);
  const local = (d) => { const x = new Date(d); x.setMinutes(x.getMinutes() - x.getTimezoneOffset()); return x.toISOString().slice(0, 16); };
  return `<form class="auth" id="drop-form" novalidate>
    <p class="eyebrow">Drops</p><h2 class="display-md" id="modal-title">Schedule a release</h2>
    <label class="field"><span>Title</span><input id="drop-title" maxlength="80" placeholder="Summer Night"></label>
    <label class="field"><span>Description</span><textarea id="drop-description" rows="3" maxlength="1000" placeholder="What’s coming"></textarea></label>
    <label class="field"><span>Release</span><input id="drop-release" type="datetime-local" value="${local(soon)}"></label>
    <fieldset class="field drop-works"><legend>Works (1 to 12). They stay hidden from everyone else until the release.</legend>
      ${works.length ? works.map((w) => `<label class="check"><input type="checkbox" name="drop-work" value="${esc(w.id)}"> ${esc(w.title)}</label>`).join('') : '<p class="muted">Publish a work first.</p>'}</fieldset>
    <p class="form-error" id="drop-error" role="alert" hidden></p>
    <div class="detail-actions">${PremiumButton('Schedule drop', { act: 'create-drop' })}</div>
    <p class="fine">Your followers are notified now and at the release; anyone can ask to be notified too. Up to 3 upcoming drops, within 60 days.</p>
  </form>`;
}

/** Moderators: reported conversations (the only ones they can read). */
export function reportsHTML(reports) {
  return `<section class="section section-tight">${SectionHeader({ eyebrow: 'Collector Radar', title: 'Reported conversations' })}
    ${reports.length ? reports.map((r) => `<article class="flag-card"><p class="eyebrow">Reported by ${esc(r.reporter)} · ${esc(when(r.created_at))}</p>
      <h3>${esc(r.sender)} → ${esc(r.artist)}</h3><p class="muted">“${esc(r.reason)}”</p>
      <ol class="messages messages-compact">${(r.messages || []).map((m) => `<li class="message"><p><b>${esc(m.from)}:</b> ${esc(m.body)}</p></li>`).join('')}</ol>
      <div class="detail-actions">${PremiumButton('Close conversation', { act: 'report-resolve', attrs: `data-id="${esc(r.id)}" data-v="close" data-danger` })}
        ${PremiumButton('Dismiss', { act: 'report-resolve', variant: 'secondary', attrs: `data-id="${esc(r.id)}" data-v="dismiss"` })}</div></article>`).join('')
      : '<p class="muted">No reports. Moderators can read a conversation only after one of its members reports it.</p>'}
  </section>`;
}
