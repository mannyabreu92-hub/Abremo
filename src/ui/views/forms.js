// Phase 1 forms: the artist profile editor, the artwork editor and the collection editor.
// Pure HTML builders (data in, markup out); app.js wires up the actions. New views live in
// src/ui/views/ so app.js stops growing.

import { esc, Icon, PremiumButton, Avatar } from '../components.js';
import { CATEGORIES, STYLES } from '../../core/seed.js';
import { AVAILABILITY } from '../../core/community.js';

export const PROFILE_LIMITS = { bio: 1000, statement: 2000, city: 60, website: 200 };
export const ARTWORK_LIMITS = { description: 2000, dimensions: 60 };
export const INSTAGRAM_RE = /^[A-Za-z0-9._]{1,30}$/;

const counter = (id, value, max) => `<small class="char-count" id="${id}-count" data-max="${max}">${String(value || '').length} / ${max}</small>`;

/** The artist's public profile: portrait, city, bio, statement and links. */
export function artistProfileForm(artist) {
  const a = artist || {};
  return `<form class="auth profile-form" id="artist-profile-form" novalidate>
    <p class="eyebrow">Artist profile</p>
    <h2 class="display-md" id="modal-title">How collectors meet you</h2>
    <div class="portrait-pick">
      <span class="portrait-preview" id="portrait-preview">${Avatar(a, 'xl')}</span>
      <label class="btn btn-secondary file-btn">${Icon('plus', { size: 16 })}<span>${a.avatar ? 'Change portrait' : 'Add a portrait'}</span>
        <input type="file" id="portrait-file" accept="image/*"></label>
      ${a.avatar ? `<label class="check"><input type="checkbox" id="portrait-remove"> Remove portrait</label>` : ''}
    </div>
    <label class="field"><span>City</span><input id="profile-city" maxlength="${PROFILE_LIMITS.city}" autocomplete="address-level2" value="${esc(a.city)}" placeholder="Lisbon"></label>
    <label class="field"><span>Short bio</span><textarea id="profile-bio" rows="4" maxlength="${PROFILE_LIMITS.bio}" placeholder="Who you are and what you make.">${esc(a.bio)}</textarea>${counter('profile-bio', a.bio, PROFILE_LIMITS.bio)}</label>
    <label class="field"><span>Artist statement</span><textarea id="profile-statement" rows="6" maxlength="${PROFILE_LIMITS.statement}" placeholder="What your work is about.">${esc(a.statement)}</textarea>${counter('profile-statement', a.statement, PROFILE_LIMITS.statement)}</label>
    <label class="field"><span>Website</span><input id="profile-website" type="url" inputmode="url" maxlength="${PROFILE_LIMITS.website}" value="${esc(a.website)}" placeholder="https://"></label>
    <label class="field"><span>Instagram</span><input id="profile-instagram" maxlength="31" autocomplete="off" autocapitalize="none" value="${esc(a.instagram ? `@${a.instagram}` : '')}" placeholder="@yourname"></label>
    <p class="form-error" id="profile-error" role="alert" hidden></p>
    <div class="detail-actions">${PremiumButton('Save profile', { act: 'save-artist-profile' })}</div>
    <p class="fine">Everything here is public on your artist page. Portraits are resized and their hidden data (such as location) removed before upload.</p>
  </form>`;
}

/** Checks the profile fields the way the database does. Returns an error message or ''. */
export function validateArtistProfile({ bio = '', statement = '', website = '', instagram = '', city = '' }) {
  if (bio.length > PROFILE_LIMITS.bio) return `Keep the bio under ${PROFILE_LIMITS.bio} characters.`;
  if (statement.length > PROFILE_LIMITS.statement) return `Keep the statement under ${PROFILE_LIMITS.statement} characters.`;
  if (city.length > PROFILE_LIMITS.city) return 'That city name is too long.';
  if (website && (!/^https:\/\/[^\s<>"]+$/.test(website) || website.length > PROFILE_LIMITS.website)) return 'Your website must start with https://';
  const handle = instagram.replace(/^@/, '');
  if (handle && !INSTAGRAM_RE.test(handle)) return 'Instagram handles use letters, numbers, dots and underscores.';
  return '';
}

/** Edit an artwork you published: the details, plus description, size and availability. */
export function artworkEditForm(w) {
  const select = (name, options, value) => `<select id="edit-${name}">${options.map(([v, label]) => `<option value="${esc(v)}"${v === value ? ' selected' : ''}>${esc(label)}</option>`).join('')}</select>`;
  return `<form class="auth" id="artwork-edit-form" novalidate data-id="${esc(w.id)}">
    <p class="eyebrow">Edit artwork</p>
    <h2 class="display-md" id="modal-title">${esc(w.title)}</h2>
    <label class="field"><span>Title</span><input id="edit-title" maxlength="60" value="${esc(w.title)}"></label>
    <div class="field-row">
      <label class="field"><span>Medium</span>${select('category', CATEGORIES.map((c) => [c.id, c.label]), w.category)}</label>
      <label class="field"><span>Movement</span>${select('style', STYLES.map((s) => [s, s]), w.style)}</label>
    </div>
    <label class="field"><span>Materials</span><input id="edit-medium" maxlength="80" value="${esc(w.medium)}" placeholder="Oil on linen"></label>
    <div class="field-row">
      <label class="field"><span>Year</span><input id="edit-year" type="number" inputmode="numeric" min="1900" max="2100" value="${esc(w.year)}"></label>
      <label class="field"><span>Size</span><input id="edit-dimensions" maxlength="${ARTWORK_LIMITS.dimensions}" value="${esc(w.dimensions)}" placeholder="60 × 80 cm"></label>
      <label class="field"><span>Edition size (prints you make and ship; leave empty for an original)</span><input id="edit-edition" type="number" min="2" max="500" inputmode="numeric" value="${w.editionSize || ''}" placeholder="e.g. 50"></label>
    </div>
    <div class="field-row">
      <label class="field"><span>Availability</span>${select('availability', Object.entries(AVAILABILITY), w.availability || 'available')}</label>
      <label class="field"><span>Price (USD)</span><input id="edit-price" type="number" inputmode="numeric" min="10" step="10" value="${esc(w.price)}"></label>
    </div>
    <label class="field"><span>Description</span><textarea id="edit-description" rows="5" maxlength="${ARTWORK_LIMITS.description}" placeholder="The story behind the work.">${esc(w.description)}</textarea>${counter('edit-description', w.description, ARTWORK_LIMITS.description)}</label>
    <p class="form-error" id="edit-error" role="alert" hidden></p>
    <div class="detail-actions">${PremiumButton('Save changes', { act: 'save-artwork' })}</div>
    <p class="fine">“Sold” is what you report; Abremi doesn’t verify sales yet.</p>
  </form>`;
}

/** Rename a collection and describe it. */
export function collectionEditForm(c) {
  return `<form class="auth" id="collection-edit-form" novalidate data-id="${esc(c.id)}">
    <p class="eyebrow">Edit collection</p>
    <h2 class="display-md" id="modal-title">${esc(c.name)}</h2>
    <label class="field"><span>Name</span><input id="collection-edit-name" maxlength="60" value="${esc(c.name)}"></label>
    <label class="field"><span>Description</span><textarea id="collection-edit-description" rows="3" maxlength="500">${esc(c.description)}</textarea></label>
    <div class="detail-actions">${PremiumButton('Save', { act: 'save-collection', attrs: `data-v="${esc(c.id)}"` })}</div>
  </form>`;
}
