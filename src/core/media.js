// Upload rules shared by the studio form, the image pipeline and the tests.
// The database enforces the same limits (supabase/migrations/0002_artist_uploads.sql).

import { CATEGORIES, STYLES } from './seed.js';

export const IMAGE_MAX = 1600; // longest side of the full image, in pixels
export const THUMB_MAX = 480; // longest side of the grid thumbnail
export const MAX_SOURCE_BYTES = 30 * 1024 * 1024; // phone photos can be large; we shrink them first
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024; // storage bucket limit
export const PRICE_MIN = 10;
export const PRICE_MAX = 10_000_000;

/** Scale (width, height) to fit within max × max, never enlarging. */
export function fitWithin(width, height, max) {
  const scale = Math.min(1, max / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** Returns a list of problems with the form, empty when it can be published. */
export function validateUpload({ title, category, style, price, year, fileType, fileSize }) {
  const errors = [];
  const t = String(title ?? '').trim();
  if (!t) errors.push('Give your work a title.');
  else if (t.length > 60) errors.push('Keep the title under 60 characters.');
  if (!CATEGORIES.some((c) => c.id === category)) errors.push('Choose a medium.');
  if (!STYLES.includes(style)) errors.push('Choose a movement.');
  const p = Number(price);
  if (!Number.isFinite(p) || p < PRICE_MIN || p > PRICE_MAX) errors.push(`Set a price between $${PRICE_MIN} and $${PRICE_MAX.toLocaleString('en-US')}.`);
  if (year != null && (!Number.isInteger(year) || year < 1900 || year > 2100)) errors.push('Enter a valid year.');
  if (fileType != null && !/^image\//.test(fileType)) errors.push('Choose an image file (JPG, PNG, HEIC or WebP).');
  if (fileSize != null && fileSize > MAX_SOURCE_BYTES) errors.push('That image is over 30 MB. Choose a smaller one.');
  return errors;
}
