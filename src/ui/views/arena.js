// Artist Arena and Creative Challenges: pure HTML builders. app.js supplies the data and helpers
// (cards, artwork lookups) and wires up the actions. The rules themselves live in
// supabase/migrations/0008_competitions.sql.

import { esc, Icon, PremiumButton, EmptyState, SectionHeader } from '../components.js';
import { CATEGORIES, COUNTRIES, categoryById, countryByCode } from '../../core/seed.js';

export const KINDS = {
  daily: { label: 'Daily Arena', blurb: 'A new competition every day, open to every artist.' },
  weekly: { label: 'Weekly Arena', blurb: 'A week-long competition, open to every artist.' },
  category: { label: 'Medium', blurb: 'For one medium only.' },
  country: { label: 'Country', blurb: 'For artists from one country.' },
  emerging: { label: 'Emerging Artists', blurb: 'For artists who joined Abremi in the last 12 months.' },
  challenge: { label: 'Creative Challenge', blurb: 'A theme to respond to.' },
};

export const DEFAULT_RULES = 'One entry per artist, of your own published work. One vote per member (all roles count the same; accounts must be 3+ days old with 5+ likes). You can change your vote until voting closes; you can’t vote for your own entry. Most votes wins; ties share the place. Vote totals are published when voting closes.';

const HOUR = 3600e3, DAY = 24 * HOUR;
/** Ready-made schedules for moderators: [entries open, voting opens, voting closes], from the next hour. */
export function templateSchedule(kind, from = Date.now()) {
  const start = Math.ceil(from / HOUR) * HOUR;
  if (kind === 'daily') return [start, start + 12 * HOUR, start + DAY];
  if (kind === 'challenge') return [start, start + 7 * DAY, start + 10 * DAY];
  return [start, start + 4 * DAY, start + 7 * DAY];
}

export function competitionScope(c) {
  if (c.kind === 'category') return categoryById[c.category]?.label || c.category;
  if (c.kind === 'country') return `${countryByCode[c.country]?.flag || ''} ${countryByCode[c.country]?.name || c.country}`;
  return KINDS[c.kind]?.label || c.kind;
}

/** "2d 4h", "3h 10m", "8m" until the given time. */
export function timeLeft(t, now = Date.now()) {
  const ms = Math.max(0, Date.parse(t) - now);
  const d = Math.floor(ms / DAY), h = Math.floor((ms % DAY) / HOUR), m = Math.floor((ms % HOUR) / 60e3);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${Math.max(1, m)}m`;
}

export function phaseLine(c, now = Date.now()) {
  switch (c.phase) {
    case 'upcoming': return `Entries open in ${timeLeft(c.entries_open_at, now)}`;
    case 'entries': return `Entries close in ${timeLeft(c.voting_opens_at, now)}`;
    case 'voting': return `Voting closes in ${timeLeft(c.voting_closes_at, now)}`;
    case 'closed': return `Closed ${new Date(c.voting_closes_at).toLocaleDateString([], { month: 'short', day: 'numeric' })}`;
    default: return 'Cancelled';
  }
}

const PHASE_LABEL = { upcoming: 'Coming soon', entries: 'Entries open', voting: 'Voting', closed: 'Results', cancelled: 'Cancelled' };

export function arenaTabs(active) {
  return `<div class="seg seg-gold arena-tabs" role="tablist">${[['battles', 'Battles'], ['competitions', 'Competitions'], ['history', 'History']]
    .map(([k, v]) => `<button role="tab" aria-selected="${active === k}" class="${active === k ? 'is-on' : ''}" data-act="arena-tab" data-v="${k}">${v}</button>`).join('')}</div>`;
}

/**
 * A competition in a list.
 * @param {any} c
 * @param {{ cover?: (artworkId: string) => string }} [ctx] cover → thumbnail HTML for the winner
 */
export function competitionCard(c, { cover = (_id) => '' } = {}) {
  return `<a class="competition-card phase-${esc(c.phase)}" href="#competition/${encodeURIComponent(c.id)}">
    <span class="competition-cover">${c.winner ? cover(c.winner) : Icon('trophy', { size: 28 })}</span>
    <span class="competition-text">
      <span class="eyebrow">${esc(competitionScope(c))} · ${esc(PHASE_LABEL[c.phase] || c.phase)}</span>
      <b>${esc(c.title)}</b>
      <small>${esc(phaseLine(c))} · ${c.entries} entr${c.entries === 1 ? 'y' : 'ies'}${c.my_entry ? ' · you entered' : ''}</small>
    </span>${Icon('arrow', { size: 16 })}</a>`;
}

export function competitionsHTML(list, { cover, signedIn, demo }) {
  if (demo) return EmptyState({ icon: 'trophy', title: 'Competitions run with accounts', body: 'Artist Arena competitions and Creative Challenges need the shared database.' });
  if (!list) return '<div class="skel skel-line"></div><div class="skel skel-line"></div>';
  const order = { voting: 0, entries: 1, upcoming: 2 };
  const active = list.filter((c) => c.phase in order)
    .sort((a, b) => order[a.phase] - order[b.phase] || Date.parse(a.voting_closes_at) - Date.parse(b.voting_closes_at));
  return active.length
    ? `<div class="competition-list">${active.map((c) => competitionCard(c, { cover })).join('')}</div>`
    : EmptyState({ icon: 'trophy', title: 'No competitions right now', body: signedIn ? 'New daily, weekly and themed competitions are announced here.' : 'Sign in to enter or vote when the next one opens.' });
}

export function historyHTML(list, { cover }) {
  const done = (list || []).filter((c) => c.phase === 'closed');
  return done.length
    ? `<div class="competition-list">${done.map((c) => competitionCard(c, { cover })).join('')}</div>`
    : EmptyState({ icon: 'trophy', title: 'No results yet', body: 'Finished competitions and their winners appear here.' });
}

/**
 * One competition. ctx: { card(artwork, extra) → HTML, artwork(id) → artwork | undefined,
 * signedIn, canEnter (has eligible works), now }.
 */
export function competitionPage(d, ctx) {
  const results = d.results?.entries || [];
  const mine = d.entries.find((e) => e.mine);
  const entries = d.phase === 'closed'
    ? results.map((r) => ({ id: r.entry, artwork: r.artwork, place: r.place, votes: r.votes, mine: r.entry === mine?.id }))
    : d.entries;
  const ordinal = (n) => `${n}${n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th'}`;
  const tile = (e) => {
    const w = ctx.artwork(e.artwork);
    if (!w) return '';
    const voted = d.my_vote === e.id;
    const footer = d.phase === 'voting'
      ? (e.mine ? '<span class="tag">Your entry</span>'
        : `<button class="btn ${voted ? 'btn-primary' : 'btn-secondary'} btn-block" data-act="vote-entry" data-v="${esc(e.id)}" aria-pressed="${voted}"><span>${voted ? 'Your vote' : 'Vote'}</span></button>`)
      : d.phase === 'closed'
        ? `<span class="result-line">${e.place ? `<b class="place place-${e.place}">${ordinal(e.place)}</b>` : ''} ${e.votes} vote${e.votes === 1 ? '' : 's'}${e.mine ? ' · your entry' : ''}</span>`
        : e.mine ? '<span class="tag">Your entry</span>' : '';
    return `<div class="entry-tile${voted ? ' is-voted' : ''}${e.place === 1 ? ' is-winner' : ''}">${ctx.card(w)}${footer}</div>`;
  };
  const action = (() => {
    if (d.phase === 'entries') {
      if (!ctx.signedIn) return PremiumButton('Sign in to enter', { act: 'sign-in' });
      if (mine) return PremiumButton('Withdraw my entry', { act: 'withdraw-entry', variant: 'ghost', attrs: `data-v="${esc(d.id)}"` });
      return ctx.canEnter ? PremiumButton('Enter a work', { act: 'enter-competition', attrs: `data-v="${esc(d.id)}"` })
        : '<p class="muted">Publish a work from Profile → Studio to enter.</p>';
    }
    if (d.phase === 'voting') {
      if (!ctx.signedIn) return PremiumButton('Sign in to vote', { act: 'sign-in' });
      if (!d.can_vote) return `<p class="muted">${esc(d.vote_blocker || 'You can’t vote in this competition.')}</p>`;
      return `<p class="muted">${d.my_vote ? 'You’ve voted. You can change your vote until voting closes.' : 'Pick one favourite. You can change it until voting closes.'}</p>`;
    }
    return '';
  })();
  const dates = [['Entries open', d.entries_open_at], ['Voting opens', d.voting_opens_at], ['Voting closes', d.voting_closes_at]]
    .map(([k, t]) => `<div><dt>${k}</dt><dd>${new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</dd></div>`).join('');
  return `<div class="shell competition-page">
    <button class="link-arrow back-link" data-act="arena-tab" data-v="${d.phase === 'closed' ? 'history' : 'competitions'}">${Icon('back', { size: 14 })} Arena</button>
    <header class="page-head">
      <p class="eyebrow">${esc(competitionScope(d))} · ${esc(PHASE_LABEL[d.phase] || d.phase)}</p>
      <h1 class="display-lg">${esc(d.title)}</h1>
      ${d.brief ? `<p class="lede">${esc(d.brief)}</p>` : ''}
      <p class="countdown">${Icon('clock', { size: 16 })} ${esc(phaseLine(d, ctx.now))}</p>
      <div class="detail-actions">${action}</div>
    </header>
    ${d.phase === 'closed' ? `<p class="muted">${d.results?.voters || 0} member${d.results?.voters === 1 ? '' : 's'} voted.</p>` : d.phase === 'voting' ? '<p class="fine">Vote totals are hidden until voting closes.</p>' : ''}
    ${entries.length ? `<div class="entry-grid">${entries.map(tile).join('')}</div>`
      : EmptyState({ icon: 'trophy', title: d.phase === 'closed' ? 'No entries' : 'No entries yet', body: d.phase === 'entries' ? 'Be the first to enter.' : '' })}
    <section class="section section-tight competition-rules">
      ${SectionHeader({ eyebrow: 'How it’s judged', title: 'Rules' })}
      <p>${esc(d.rules || DEFAULT_RULES)}</p>
      ${d.kind === 'emerging' ? `<p class="muted">${esc(KINDS.emerging.blurb)}</p>` : ''}
      <dl class="spec">${dates}</dl>
    </section>
  </div>`;
}

/** Pick one of your works to enter. works: [{ id, title, html }] already filtered for eligibility. */
export function enterSheet(d, works) {
  return `<div class="auth"><p class="eyebrow">Enter</p><h2 class="display-sm" id="modal-title">${esc(d.title)}</h2>
    <p class="muted">One entry per artist. You can withdraw it until voting opens.</p>
    ${works.length ? `<ul class="pick-list">${works.map((w) => `<li><button class="pick" data-act="enter-with" data-v="${esc(d.id)}" data-id="${esc(w.id)}"><span>${w.html}${esc(w.title)}</span>${Icon('plus', { size: 18 })}</button></li>`).join('')}</ul>`
      : '<p class="muted">None of your published works fit this competition.</p>'}</div>`;
}

/** Moderators: create a competition from a template. */
export function createCompetitionForm(kind = 'weekly') {
  const [open, voting, close] = templateSchedule(kind);
  const local = (t) => { const d = new Date(t); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
  const titles = { daily: `Daily Arena · ${new Date(open).toLocaleDateString([], { month: 'short', day: 'numeric' })}`, weekly: 'Weekly Arena', category: 'Best Photography of the Week', country: 'Best of France', emerging: 'Emerging Artists', challenge: 'Creative Challenge: The Hour After Rain' };
  return `<form class="panel create-competition" id="create-competition" novalidate>
    <div class="field-row">
      <label class="field"><span>Template</span><select id="comp-kind">${Object.entries(KINDS).map(([k, v]) => `<option value="${k}"${k === kind ? ' selected' : ''}>${esc(v.label)}</option>`).join('')}</select></label>
      ${kind === 'category' ? `<label class="field"><span>Medium</span><select id="comp-category">${CATEGORIES.map((c) => `<option value="${c.id}"${c.id === 'photography' ? ' selected' : ''}>${esc(c.label)}</option>`).join('')}</select></label>` : ''}
      ${kind === 'country' ? `<label class="field"><span>Country</span><select id="comp-country">${COUNTRIES.map((c) => `<option value="${c.code}"${c.code === 'FR' ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>` : ''}
    </div>
    <label class="field"><span>Title</span><input id="comp-title" maxlength="80" value="${esc(titles[kind])}"></label>
    <label class="field"><span>Brief${kind === 'challenge' ? ' (the theme)' : ' (optional)'}</span><textarea id="comp-brief" rows="3" maxlength="1000">${kind === 'challenge' ? 'Paint, photograph or make the moment just after the rain stops.' : ''}</textarea></label>
    <label class="field"><span>Rules and judging criteria</span><textarea id="comp-rules" rows="4" maxlength="2000">${esc(DEFAULT_RULES)}</textarea></label>
    <div class="field-row field-row-3">
      <label class="field"><span>Entries open</span><input id="comp-open" type="datetime-local" value="${local(open)}"></label>
      <label class="field"><span>Voting opens</span><input id="comp-voting" type="datetime-local" value="${local(voting)}"></label>
      <label class="field"><span>Voting closes</span><input id="comp-close" type="datetime-local" value="${local(close)}"></label>
    </div>
    <p class="fine">${esc(KINDS[kind].blurb)} Times are in your time zone. The server closes the competition and announces results on schedule.</p>
    <p class="form-error" id="comp-error" role="alert" hidden></p>
    ${PremiumButton('Create competition', { act: 'create-competition' })}
  </form>`;
}
