// Upload several works at once: pick many photos, fill in each work's details in one list (with
// "apply to all" for what they share), then publish them one after another. Pure HTML builders;
// app.js keeps the state and does the uploading.

import { esc, Icon, PremiumButton } from '../components.js';

export const BATCH_MAX = 20; // the database allows 20 new works a day per artist

/**
 * @param {{ items: any[], defaults: any, categories: any[], styles: string[], availability: Record<string,string>, running: boolean, year: number }} s
 */
export function batchSheet({ items, defaults, categories, styles, availability, running, year }) {
  const opt = (list, value) => list.map(([v, label]) => `<option value="${esc(v)}"${String(v) === String(value) ? ' selected' : ''}>${esc(label)}</option>`).join('');
  const cats = categories.map((c) => [c.id, c.label]);
  const styl = styles.map((x) => [x, x]);
  const avail = Object.entries(availability).filter(([k]) => k !== 'sold');
  const done = items.filter((i) => i.status === 'done').length;
  const pending = items.filter((i) => i.status !== 'done');
  const head = `<p class="eyebrow">Studio</p><h2 class="display-md" id="modal-title">Upload several works</h2>`;
  if (!items.length) {
    return `<div class="batch">${head}
      <p class="lede">Choose up to ${BATCH_MAX} photos at once. You’ll fill in each work’s details next, then publish them together.</p>
      <label class="dropzone"><input type="file" id="batch-files" accept="image/*" multiple>
        ${Icon('plus', { size: 22 })}<b>Choose photos</b><small>JPG, PNG or HEIC, up to 30 MB each</small></label>
    </div>`;
  }
  const field = (i, k, label, input) => `<label class="field"><span>${esc(label)}</span>${input}</label>`;
  const row = (it, n) => {
    const locked = running || it.status === 'done' || it.status === 'uploading';
    const dis = locked ? ' disabled' : '';
    const status = it.status === 'done' ? `<span class="batch-ok">${Icon('check', { size: 14 })} Published</span>`
      : it.status === 'uploading' ? '<span class="batch-busy">Uploading…</span>'
        : it.error ? `<span class="batch-err" role="alert">${esc(it.error)}</span>` : '';
    return `<li class="batch-row${it.status === 'done' ? ' is-done' : ''}${it.error ? ' has-error' : ''}" data-i="${n}">
      <img class="batch-thumb" src="${esc(it.preview)}" alt="">
      <div class="batch-fields">
        <div class="batch-row-head"><b>${n + 1}.</b> <small class="muted">${esc(it.file.name)}</small> ${status}
          ${locked ? '' : `<button class="link batch-remove" data-act="batch-remove" data-v="${n}" aria-label="Remove ${esc(it.title || it.file.name)}">${Icon('x', { size: 14 })} Remove</button>`}</div>
        <div class="field-row">
          ${field(n, 'title', 'Title', `<input data-batch="${n}" data-k="title" maxlength="60" value="${esc(it.title)}"${dis}>`)}
          ${field(n, 'price', 'Price (USD)', `<input data-batch="${n}" data-k="price" type="number" inputmode="numeric" min="10" step="10" value="${esc(it.price)}"${dis}>`)}
        </div>
        <div class="field-row">
          ${field(n, 'materials', 'Materials', `<input data-batch="${n}" data-k="materials" maxlength="80" placeholder="Mixed media on linen" value="${esc(it.materials)}"${dis}>`)}
          ${field(n, 'dimensions', 'Size', `<input data-batch="${n}" data-k="dimensions" maxlength="60" placeholder="40 × 40 cm" value="${esc(it.dimensions)}"${dis}>`)}
        </div>
        <div class="field-row batch-row-3">
          ${field(n, 'year', 'Year', `<input data-batch="${n}" data-k="year" type="number" inputmode="numeric" min="1900" max="2100" value="${esc(it.year)}"${dis}>`)}
          ${field(n, 'category', 'Medium', `<select data-batch="${n}" data-k="category"${dis}>${opt(cats, it.category)}</select>`)}
          ${field(n, 'availability', 'Availability', `<select data-batch="${n}" data-k="availability"${dis}>${opt(avail, it.availability)}</select>`)}
        </div>
        ${field(n, 'description', 'Description (optional)', `<textarea data-batch="${n}" data-k="description" rows="2" maxlength="2000" placeholder="e.g. Exhibited in …"${dis}>${esc(it.description)}</textarea>`)}
      </div>
    </li>`;
  };
  return `<div class="batch">${head}
    <section class="batch-defaults panel" aria-label="Apply to all">
      <p class="eyebrow">Apply to all</p>
      <div class="field-row batch-row-3">
        <label class="field"><span>Materials</span><input data-batch="all" data-k="materials" maxlength="80" placeholder="Mixed media on linen" value="${esc(defaults.materials)}"${running ? ' disabled' : ''}></label>
        <label class="field"><span>Size</span><input data-batch="all" data-k="dimensions" maxlength="60" placeholder="40 × 40 cm" value="${esc(defaults.dimensions)}"${running ? ' disabled' : ''}></label>
        <label class="field"><span>Year</span><input data-batch="all" data-k="year" type="number" inputmode="numeric" min="1900" max="2100" value="${esc(defaults.year || year)}"${running ? ' disabled' : ''}></label>
      </div>
      <div class="field-row batch-row-3">
        <label class="field"><span>Medium</span><select data-batch="all" data-k="category"${running ? ' disabled' : ''}>${opt(cats, defaults.category)}</select></label>
        <label class="field"><span>Movement</span><select data-batch="all" data-k="style"${running ? ' disabled' : ''}>${opt(styl, defaults.style)}</select></label>
        <label class="field"><span>Price (USD)</span><input data-batch="all" data-k="price" type="number" inputmode="numeric" min="10" step="10" placeholder="Same price" value="${esc(defaults.price)}"${running ? ' disabled' : ''}></label>
      </div>
      ${running ? '' : PremiumButton('Apply to all works', { act: 'batch-apply', variant: 'secondary', size: 'sm' })}
    </section>
    <ol class="batch-list">${items.map(row).join('')}</ol>
    <div class="batch-foot">
      <p class="muted" role="status" aria-live="polite">${done ? `${done} of ${items.length} published. ` : ''}${pending.length ? `${pending.length} to publish.` : 'All published.'}</p>
      ${pending.length ? PremiumButton(running ? 'Publishing…' : `Publish ${pending.length} work${pending.length === 1 ? '' : 's'}`, { act: 'batch-publish', attrs: running ? 'disabled' : '' }) : PremiumButton('Done', { act: 'batch-close' })}
    </div>
    <p class="fine">Up to ${BATCH_MAX} new works a day. Photos are resized and their hidden data (such as location) is removed before upload.</p>
  </div>`;
}
