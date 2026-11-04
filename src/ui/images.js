// Prepares a photo for upload, entirely on the device:
// - honours the camera's rotation, then resizes to IMAGE_MAX (full) and THUMB_MAX (grid thumbnail);
// - re-encodes to WebP (JPEG where the browser cannot encode WebP), which also strips EXIF
//   metadata such as GPS location from the published file.

import { fitWithin, IMAGE_MAX, THUMB_MAX, MAX_UPLOAD_BYTES } from '../core/media.js';

async function decode(file) {
  if ('createImageBitmap' in window) {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch { /* fall back to <img> (e.g. older Safari) */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function toBlob(canvas, type, quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

async function encode(source, srcW, srcH, max, quality) {
  const { width, height } = fitWithin(srcW, srcH, max);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, width, height);
  let blob = await toBlob(canvas, 'image/webp', quality);
  if (!blob || blob.type !== 'image/webp') blob = await toBlob(canvas, 'image/jpeg', quality); // Safari can't encode WebP
  // Very detailed images: step quality down until the file fits the storage limit.
  for (let q = quality - 0.12; blob && blob.size > MAX_UPLOAD_BYTES && q > 0.4; q -= 0.12) {
    blob = await toBlob(canvas, blob.type, q);
  }
  return { blob, width, height };
}

/** → { image: Blob, thumb: Blob, width, height, previewURL } */
export async function prepareImage(file) {
  const source = /** @type {any} */ (await decode(file)); // ImageBitmap or <img>
  const srcW = source.naturalWidth || source.width;
  const srcH = source.naturalHeight || source.height;
  if (!srcW || !srcH) throw new Error('That image could not be read.');
  const full = await encode(source, srcW, srcH, IMAGE_MAX, 0.86);
  const thumb = await encode(source, srcW, srcH, THUMB_MAX, 0.8);
  source.close?.();
  if (!full.blob || full.blob.size > MAX_UPLOAD_BYTES) throw new Error('That image is too large to publish. Try a smaller photo.');
  return { image: full.blob, thumb: thumb.blob, width: full.width, height: full.height, previewURL: URL.createObjectURL(thumb.blob) };
}

export function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}
