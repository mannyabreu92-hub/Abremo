// Certificates of authenticity (#certificate/CODE): issued for every paid sale, printable, and
// checkable by anyone with the code. Shows the artwork, the artist and the date of sale; never the
// buyer. Pure HTML builders; app.js supplies the data.

import { esc, Icon, PremiumButton } from '../components.js';

const date = (iso) => (iso ? new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : '');
export const CODE_RE = /^ABR-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/;

/** The form to check a certificate by its code. */
export function certificateCheckHTML({ code = '', error = '' } = {}) {
  return `<div class="shell certificate-check">
    <header class="page-head"><p class="eyebrow">Certificates of authenticity</p>
      <h1 class="display-lg">Check a certificate</h1>
      <p class="lede">Every work sold on Abremi comes with a certificate and a unique code. Enter the code to confirm it’s genuine.</p></header>
    <div class="cert-form">
      <label class="field"><span>Certificate code</span><input id="cert-code" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="18" placeholder="ABR-XXXX-XXXX-XXXX" value="${esc(code)}"></label>
      ${PremiumButton('Check', { act: 'certificate-check' })}
    </div>
    ${error ? `<p class="notice" role="alert">${Icon('info', { size: 16 })} ${esc(error)}</p>` : ''}
  </div>`;
}

/**
 * The certificate itself.
 * @param {any} c from verify_certificate()
 * @param {{ image: string, medium: string, origin: string }} opts image is ArtImage HTML (or '')
 */
export function certificateHTML(c, { image, medium, origin }) {
  const banner = c.status === 'void'
    ? `<p class="cert-status is-void">${Icon('x', { size: 16 })} This certificate is void: the sale was refunded.</p>`
    : c.status === 'under_review'
      ? `<p class="cert-status is-review">${Icon('info', { size: 16 })} A problem with this sale is being reviewed by Abremi.</p>`
      : `<p class="cert-status is-valid">${Icon('check', { size: 16 })} Genuine: this certificate matches a sale recorded by Abremi.</p>`;
  const row = (k, v) => (v ? `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>` : '');
  return `<div class="shell certificate-page">
    ${banner}
    <article class="certificate" aria-label="Certificate of authenticity">
      <header class="cert-head"><span class="brand-word">Abremi</span><p class="eyebrow">Certificate of authenticity</p></header>
      ${image ? `<div class="cert-art">${image}</div>` : ''}
      <h1 class="cert-title">${esc(c.title)}</h1>
      <p class="cert-artist">${esc(c.artist)}${c.verified ? ` <span class="verified-badge" title="Identity confirmed by Abremi">${Icon('check', { size: 12 })}<span>Verified</span></span>` : ''}</p>
      <dl class="cert-details">
        ${row('Year', c.year ? String(c.year) : '')}
        ${row('Medium', c.medium || medium)}
        ${row('Dimensions', c.dimensions)}
        ${row('Edition', c.edition_number ? `Print ${c.edition_number}${c.edition_size ? ` of ${c.edition_size}` : ''}` : 'Original work')}
        ${row('Date of sale', date(c.issued_at))}
        ${row('Certificate', c.code)}
      </dl>
      <p class="cert-text">Abremi certifies that this work by ${esc(c.artist)} was sold through Abremi on ${esc(date(c.issued_at))}${c.verified ? ', by an artist whose identity Abremi has confirmed' : ''}. Anyone can check this certificate at ${esc(origin.replace(/^https?:\/\//, ''))}/#certificate/${esc(c.code)}.</p>
      <footer class="cert-foot"><span>${esc(origin.replace(/^https?:\/\//, ''))}</span><span>${esc(c.code)}</span></footer>
    </article>
    <div class="detail-actions cert-actions">
      ${PremiumButton('Print or save as PDF', { act: 'certificate-print' })}
      <a class="btn btn-ghost" href="#certificate"><span>Check another code</span></a>
    </div>
  </div>`;
}
