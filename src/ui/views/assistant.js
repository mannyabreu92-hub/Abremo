// The Abremi Guide's interface: the panel, its three modes, suggested questions, messages with
// suggestion cards, and personalization settings. Pure HTML builders; app.js supplies state and
// renders the cards (it knows the catalog). All interface text is in GUIDE_COPY.

import { esc, Icon, PremiumButton } from '../components.js';

export const GUIDE_COPY = {
  launcher: 'Ask Abremi',
  name: 'Abremi Guide',
  close: 'Close the Guide',
  settings: 'Guide settings',
  modes: 'Who are you asking as?',
  placeholder: 'Ask about art, artists or Abremi…',
  send: 'Send',
  sending: 'Thinking…',
  retry: 'Try again',
  refresh: 'Refresh',
  newChat: 'New conversation',
  left: (n, limit) => `${n} of ${limit} messages left today`,
  disclaimer: 'The Guide uses what’s on Abremi and can be wrong. It never values art or judges authenticity.',
  signedOut: 'Sign in to ask the Guide. It suggests works and artists you’ll love, from what’s on Abremi.',
  signIn: 'Sign in',
  artistOnly: 'The artist mode is for artists. Publish a work from Profile → Studio first.',
  studio: 'Go to Studio',
  you: 'You',
  guide: 'Guide',
  view: 'View',
  save: 'Save to a collection',
  follow: 'Follow',
  following: 'Following',
  search: 'Search',
  prefsTitle: 'Personalize your suggestions',
  prefsUse: 'Use my follows, admirations and treasures to tailor suggestions',
  prefsInterests: 'What do you enjoy? (optional)',
  prefsInterestsHint: 'For example: quiet landscapes, street art from Lisbon, black-and-white photography.',
  prefsPrivacy: 'Only you see your suggestions. Conversations aren’t saved: they’re gone when you close or reload Abremi.',
  prefsSave: 'Save',
  prefsReset: 'Reset personalization',
  prefsBack: 'Back to the conversation',
};

export const GUIDE_MODES = {
  visitor: { label: 'Discover', title: 'Find art you’ll love', intro: 'Tell me what you enjoy, or ask about anything on this page. I’ll suggest works and artists, and say why.' },
  collector: { label: 'Collect', title: 'Collect with confidence', intro: 'I can help you explore, organize your collections, and read Abremi’s signals: what verified collectors and critics appreciate.' },
  artist: { label: 'For artists', title: 'Your work on Abremi', intro: 'Ask how your work appears on Abremi, what your numbers show, or how to present a piece better.' },
};

/** Suggested questions for the mode and the page being viewed. */
export function suggestedPrompts(mode, page) {
  const onPage = {
    artwork: { visitor: ['What should I notice in this work?', 'Show me more like this'], collector: ['What do Abremi’s signals say about this work?', 'Which collection would this fit?'], artist: ['How could a work like this be presented better?'] },
    artist: { visitor: ['Tell me about this artist', 'Who else paints like this?'], collector: ['How is this artist appreciated on Abremi?'], artist: ['What makes a strong artist profile?'] },
    collection: { visitor: ['What ties this collection together?', 'Suggest works that would fit'], collector: ['What’s missing from this collection?'], artist: [] },
    ranking: { visitor: ['How do these rankings work?', 'What’s trending this week?'], collector: ['What do collectors appreciate most right now?'], artist: ['How does a work rise in the rankings?'] },
    battle: { visitor: ['How do Art Battles work?', 'Tell me about these two works'], collector: ['What do battle ratings mean?'], artist: ['How do battle ratings work?'] },
    competition: { visitor: ['How does voting work here?'], collector: ['How are competition results decided?'], artist: ['How do competitions work?'] },
  }[page?.type]?.[mode] || [];
  const general = {
    visitor: ['Show me something calm and minimal', 'Who are emerging artists to follow?', 'Surprise me with something bold'],
    collector: ['Help me start a collection', 'Which works do verified collectors save most?', 'How do I contact an artist about a work?'],
    artist: ['How are my works doing this month?', 'How can I improve my artist profile?', 'How do rankings and followers work?'],
  }[mode];
  return [...onPage, ...general].slice(0, 4);
}

/** Splits the Guide's text into paragraphs and suggestion lines. */
export function parseReply(text) {
  const blocks = [];
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^(?:[-*•]\s*)?\[\[(art|artist|search):([^\]]+)\]\]\s*(?:[—–-]\s*)?(.*)$/.exec(line);
    if (m) blocks.push({ ref: { type: m[1] === 'art' ? 'artwork' : m[1], id: m[2].trim() }, reason: m[3] });
    else blocks.push({ text: line });
  }
  return blocks;
}

/**
 * The panel.
 * @param {{ open: boolean, mode: string, view: string, thread: any[], busy: boolean, error: any, input: string, usage: any, prefs: any, prefsBusy?: boolean }} g
 * @param {{ signedIn: boolean, isArtist: boolean, page: any, renderRef: (ref: any, reason: string) => string, inlineRef: (ref: any) => string }} o
 */
export function guidePanelHTML(g, { signedIn, isArtist, page, renderRef, inlineRef }) {
  const mode = GUIDE_MODES[g.mode] ? g.mode : 'visitor';
  const tabs = Object.entries(GUIDE_MODES).map(([k, v]) => `<button role="tab" aria-selected="${k === mode}" class="${k === mode ? 'is-on' : ''}" data-act="guide-mode" data-v="${k}"${g.busy && k !== mode ? ' disabled' : ''}>${esc(v.label)}</button>`).join('');
  const head = `<header class="guide-head">
      <div><p class="eyebrow">${Icon('spark', { size: 14 })} ${esc(GUIDE_COPY.name)}</p><h2 class="guide-title" id="guide-title">${esc(GUIDE_MODES[mode].title)}</h2></div>
      <div class="guide-head-actions">
        ${signedIn ? `<button class="icon-btn" data-act="guide-settings" aria-label="${esc(GUIDE_COPY.settings)}" aria-pressed="${g.view === 'settings'}">${Icon('more')}</button>` : ''}
        <button class="icon-btn" data-act="guide-close" aria-label="${esc(GUIDE_COPY.close)}">${Icon('x')}</button>
      </div>
    </header>
    <div class="seg guide-modes" role="tablist" aria-label="${esc(GUIDE_COPY.modes)}">${tabs}</div>`;

  if (!signedIn) {
    return `${head}<div class="guide-body"><div class="guide-empty"><p>${esc(GUIDE_COPY.signedOut)}</p>${PremiumButton(GUIDE_COPY.signIn, { act: 'sign-in' })}</div></div>`;
  }
  if (g.view === 'settings') return `${head}<div class="guide-body">${settingsHTML(g)}</div>`;
  if (mode === 'artist' && !isArtist) {
    return `${head}<div class="guide-body"><div class="guide-empty"><p>${esc(GUIDE_COPY.artistOnly)}</p><a class="btn btn-secondary" href="#profile"><span>${esc(GUIDE_COPY.studio)}</span></a></div></div>`;
  }

  const thread = g.thread || [];
  const messages = thread.map((m, i) => messageHTML(m, { last: i === thread.length - 1, busy: g.busy, renderRef, inlineRef })).join('');
  const prompts = suggestedPrompts(mode, page);
  const left = g.usage ? Math.max(0, g.usage.limit - g.usage.used) : null;
  return `${head}
    <div class="guide-body" id="guide-body">
      <div class="guide-log" role="log" aria-live="polite" aria-relevant="additions text" aria-label="Conversation">
        ${thread.length ? '' : `<div class="guide-intro"><p>${esc(GUIDE_MODES[mode].intro)}</p></div>`}
        ${messages}
        ${g.error ? `<div class="guide-error" role="alert"><p>${esc(g.error.message)}</p>${g.error.refresh ? PremiumButton(GUIDE_COPY.refresh, { act: 'pwa-update', variant: 'secondary', size: 'sm' }) : g.error.retry ? PremiumButton(GUIDE_COPY.retry, { act: 'guide-retry', variant: 'secondary', size: 'sm' }) : ''}</div>` : ''}
      </div>
      ${!g.busy && prompts.length && thread.length < 2 ? `<div class="guide-prompts" aria-label="Suggested questions">${prompts.map((p) => `<button class="chip" data-act="guide-prompt" data-v="${esc(p)}">${esc(p)}</button>`).join('')}</div>` : ''}
    </div>
    <form class="guide-compose" id="guide-form" onsubmit="return false">
      <label class="sr-only" for="guide-input">${esc(GUIDE_COPY.placeholder)}</label>
      <textarea id="guide-input" rows="1" maxlength="2000" placeholder="${esc(GUIDE_COPY.placeholder)}" ${left === 0 ? 'disabled' : ''}>${esc(g.input || '')}</textarea>
      <button class="guide-send" data-act="guide-send" aria-label="${esc(g.busy ? GUIDE_COPY.sending : GUIDE_COPY.send)}" ${g.busy || left === 0 ? 'disabled' : ''}>${Icon('arrow')}</button>
    </form>
    <footer class="guide-foot">
      <span>${left != null ? esc(GUIDE_COPY.left(left, g.usage.limit)) : ''}</span>
      ${thread.length ? `<button class="link" data-act="guide-new">${esc(GUIDE_COPY.newChat)}</button>` : ''}
    </footer>
    <p class="guide-disclaimer">${esc(GUIDE_COPY.disclaimer)}</p>`;
}

function messageHTML(m, { last, busy, renderRef, inlineRef }) {
  if (m.role === 'user') return `<div class="guide-msg is-user"><span class="sr-only">${esc(GUIDE_COPY.you)}:</span><p>${esc(m.content)}</p></div>`;
  const streaming = last && busy;
  const body = replyHTML(m.content, { renderRef, inlineRef });
  return `<div class="guide-msg is-guide${streaming ? ' is-streaming' : ''}"><span class="sr-only">${esc(GUIDE_COPY.guide)}:</span>
    <div class="guide-text">${body || (streaming ? '<span class="guide-typing" aria-label="Thinking"><i></i><i></i><i></i></span>' : '')}</div></div>`;
}

/** The Guide's reply: paragraphs, inline references as links, suggestion lines as cards. */
export function replyHTML(text, { renderRef, inlineRef }) {
  const blocks = parseReply(text);
  let html = '';
  let cards = [];
  const flush = () => { if (cards.length) { html += `<div class="guide-refs">${cards.join('')}</div>`; cards = []; } };
  for (const b of blocks) {
    if (b.ref) { cards.push(renderRef(b.ref, b.reason)); continue; }
    flush();
    html += `<p>${esc(b.text).replace(/\[\[(art|artist|search):([^\]]+)\]\]/g, (all, kind, id) => inlineRef({ type: kind === 'art' ? 'artwork' : kind, id: id.trim() }))}</p>`;
  }
  flush();
  return html;
}

function settingsHTML(g) {
  const p = g.prefs || { personalize: true, interests: '' };
  return `<div class="guide-settings">
    <h3 class="sub-head">${esc(GUIDE_COPY.prefsTitle)}</h3>
    <label class="check"><input type="checkbox" id="guide-personalize" ${p.personalize ? 'checked' : ''}> ${esc(GUIDE_COPY.prefsUse)}</label>
    <label class="field"><span>${esc(GUIDE_COPY.prefsInterests)}</span><textarea id="guide-interests" rows="3" maxlength="300">${esc(p.interests || '')}</textarea></label>
    <p class="fine">${esc(GUIDE_COPY.prefsInterestsHint)}</p>
    <p class="fine">${esc(GUIDE_COPY.prefsPrivacy)}</p>
    <div class="detail-actions">
      ${PremiumButton(GUIDE_COPY.prefsSave, { act: 'guide-prefs-save', attrs: g.prefsBusy ? 'disabled' : '' })}
      ${PremiumButton(GUIDE_COPY.prefsReset, { act: 'guide-reset', variant: 'ghost', attrs: 'data-danger' })}
    </div>
    <button class="link" data-act="guide-settings">${esc(GUIDE_COPY.prefsBack)}</button>
  </div>`;
}
