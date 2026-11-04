// Account views: sign-in, the account card, About, and installing the app.
// Pure HTML builders (moved out of app.js); app.js passes in the state they show.

import { esc, fmt, Icon, PremiumButton } from '../components.js';

/** About Abremi. roles: [{ label, weight }]. */
export function aboutHTML({ roles, community }) {
  return `<div class="about">
    <p class="eyebrow">About</p><h2 class="display-md" id="modal-title">Abremi</h2>
    <p class="lede about-lede">A gallery without walls, where every work is seen on its own merit.</p>
    <p>Abremi was made for the moment a work of art stops you. Paintings, photography, sculpture, street art and digital work arrive one at a time and are given the whole screen, the way a curator would hang them in a quiet room. What moves you, you keep. What you keep shapes what others discover next.</p>
    <h3 class="sub-head">Taste with weight</h3>
    <p>Every appreciation counts, and every voice is weighed by experience: ${roles.map((r) => `${esc(r.label)} ×${r.weight}`).join(', ')}. Critics and collectors are verified before their judgement carries more weight, so the rankings reflect considered taste rather than noise.</p>
    <h3 class="sub-head">The work comes first</h3>
    <p>We fall in love with a painting before we know who painted it. So the rankings begin with works, not names, and an unknown artist’s first piece stands beside an established name on equal terms.</p>
    <h3 class="sub-head">Honest by design</h3>
    <p>${community
      ? 'Nothing on Abremi can be bought into the rankings. Every number you see comes from real members, how each score is calculated is published, and no one’s own work ever counts in their favour.'
      : 'This is a preview: the activity you see is simulated on this device. With accounts, every number comes from real members, and nothing can be bought into the rankings.'}</p>
    <p class="about-sign">Look closely. Keep what moves you. Help the right work find its audience.</p>
  </div>`;
}

/** The "install the app" card. st: pwa.status() */
export function installCardHTML(st) {
  if (!st?.available) return '';
  return `<section class="install-card">
    <img src="icons/icon-192.png" alt="" width="56" height="56" class="install-icon">
    <div><p class="eyebrow">Abremi app</p><p><b>Put Abremi on your home screen</b></p>
    <p class="muted">Full screen, one tap away, and it works offline.</p></div>
    ${PremiumButton(st.canPrompt ? 'Install' : 'How to install', { act: 'pwa-install', variant: 'secondary', icon: 'download' })}
  </section>`;
}

/** Step-by-step for iPhone and iPad, which have no install prompt. */
export function iosInstallHTML(host) {
  return `<div class="install-guide">
    <p class="eyebrow">Install Abremi</p>
    <h2 class="display-md" id="modal-title">Add it to your Home Screen</h2>
    <ol class="steps">
      <li><span class="step-icon">${Icon('share', { size: 22 })}</span><div><b>Tap Share</b><small>The square with an arrow, in Safari’s toolbar. On iPad it’s at the top.</small></div></li>
      <li><span class="step-icon">${Icon('plusSquare', { size: 22 })}</span><div><b>Choose “Add to Home Screen”</b><small>Scroll down the list if you don’t see it.</small></div></li>
      <li><span class="step-icon"><img src="icons/icon-192.png" alt="" width="26" height="26"></span><div><b>Tap Add</b><small>Abremi opens full screen, like any other app.</small></div></li>
    </ol>
    <p class="fine">Don’t see Share? Open <b>${esc(host)}</b> in Safari. Apps like Instagram use their own browser, which can’t install apps.</p>
  </div>`;
}

/**
 * The sign-in sheet: email (and an invite code while sign-ups need one), then the code from the email.
 * @param {{ auth: { stage: string, email: string, invite?: string, busy: boolean, error: string }, standalone: boolean, local: number, inviteRequired: boolean }} o
 */
export function signInHTML({ auth, standalone, local, inviteRequired }) {
  if (auth.stage === 'sent') {
    return `<div class="auth">
      <p class="eyebrow">Check your inbox</p>
      <h2 class="display-md" id="modal-title">One tap to sign in</h2>
      ${standalone
        ? `<p class="muted">We emailed <b>${esc(auth.email)}</b>. Type the code from the email below. In the home-screen app, the link would open your browser instead.</p>`
        : `<p class="muted">We sent a sign-in link to <b>${esc(auth.email)}</b>. Open it on this device and you’re in.</p>`}
      <label class="field"><span>Or enter the code from the email</span>
        <input id="auth-code" inputmode="numeric" autocomplete="one-time-code" maxlength="10" placeholder="123456"></label>
      ${auth.error ? `<p class="form-error" role="alert">${esc(auth.error)}</p>` : ''}
      <div class="detail-actions">
        ${PremiumButton(auth.busy ? 'Checking…' : 'Verify code', { act: 'verify-code', attrs: auth.busy ? 'disabled' : '' })}
        ${PremiumButton('Use a different email', { act: 'auth-back', variant: 'ghost' })}
      </div>
      <p class="fine">No email after a minute? Check spam, or go back and send it again.</p>
    </div>`;
  }
  return `<div class="auth">
    <p class="eyebrow">Join Abremi</p>
    <h2 class="display-md" id="modal-title">Make your taste count</h2>
    <p class="muted">Members’ likes, saves, follows and battle votes shape the global rankings. Sign in with your email. There’s no password to remember.</p>
    <label class="field"><span>Email</span>
      <input id="auth-email" type="email" autocomplete="email" inputmode="email" placeholder="you@example.com" value="${esc(auth.email)}"></label>
    ${inviteRequired ? `<label class="field"><span>Invite code (new members)</span>
      <input id="auth-invite" autocapitalize="characters" autocomplete="off" maxlength="10" placeholder="10 characters" value="${esc(auth.invite || '')}"></label>
      <p class="fine">Abremi is invite-only during the beta. Already a member? Leave this empty.</p>` : ''}
    ${auth.error ? `<p class="form-error" role="alert">${esc(auth.error)}</p>` : ''}
    <div class="detail-actions">${PremiumButton(auth.busy ? 'Sending…' : 'Email me a sign-in link', { act: 'send-link', size: 'lg', attrs: auth.busy ? 'disabled' : '' })}</div>
    ${local ? `<p class="fine">The ${local} work${local === 1 ? '' : 's'} you liked or saved on this device will be added to your account.</p>` : ''}
  </div>`;
}

/**
 * The account card on Profile.
 * @param {{ community: boolean, me: { email?: string } | null, members: number, publicLeaderboards: boolean, isAdmin: boolean }} o
 */
export function accountCardHTML({ community, me, members, publicLeaderboards, isAdmin }) {
  if (!community) {
    return `<section class="account-card"><div><p class="eyebrow">Demo mode</p><p class="muted">Everything you do is saved on this device only.</p></div></section>`;
  }
  if (!me) {
    return `<section class="account-card is-invite">
      <div><p class="eyebrow">Community</p><h3 class="display-sm">Make your taste count</h3>
      <p class="muted">Sign in so your likes, saves, follows and battle votes count in the global rankings${members ? `, alongside ${fmt(members)} member${members === 1 ? '' : 's'}` : ''}.</p></div>
      ${PremiumButton('Sign in with email', { act: 'sign-in', size: 'lg' })}
    </section>`;
  }
  return `<section class="account-card">
    <div><p class="eyebrow">Signed in</p><p><b>${esc(me.email || 'Member')}</b></p>
    <p class="muted">Synced with the community${members ? ` · ${fmt(members)} member${members === 1 ? '' : 's'}` : ''}</p></div>
    <div class="account-actions">
      <label class="check"><input type="checkbox" id="public-leaderboards" ${publicLeaderboards ? 'checked' : ''}> Appear on member leaderboards</label>
      ${isAdmin ? '<a class="btn btn-secondary" href="#admin"><span>Review applications</span></a>' : ''}
      ${PremiumButton('Sign out', { act: 'sign-out', variant: 'secondary' })}
    </div>
  </section>`;
}
