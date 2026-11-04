// Abremi's one connection to the AI provider (Anthropic), shared by the Career Coach and the Abremi
// Guide. The API key is read only here, from the server's environment; nothing in this folder is sent
// to browsers. Files starting with "_" are not deployed as their own functions.
import Anthropic from '@anthropic-ai/sdk';

/** Which model each feature uses. Drafts get the most capable model; chat favours speed. */
export const MODELS = { coach: 'claude-opus-5-5', guide: 'claude-sonnet-5-5' };

/** If the model declines, the API retries on its server-defined fallback model. */
export const FALLBACK = { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' };

let client = null;
/**
 * The shared client, or null when no key is configured (the features then say they're not set up).
 * @param {Record<string, string | undefined>} env
 */
export function aiClient(env = process.env) {
  if (!env.ANTHROPIC_API_KEY) return null;
  client ||= new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 1, timeout: 55_000 });
  return client;
}

/**
 * A message for people, never the provider's own error text.
 * @param {unknown} e
 * @param {string} what e.g. 'The Coach'
 */
export function aiErrorMessage(e, what) {
  if (e instanceof Anthropic.RateLimitError) return { status: 503, error: `${what} is busy right now. Please try again in a minute.` };
  if (e instanceof Anthropic.AuthenticationError) return { status: 503, error: `${what} isn’t set up correctly yet.` };
  return { status: 502, error: `${what} is unavailable right now. Please try again.` };
}

/**
 * Calls a database function as the signed-in member (their token, the public key).
 * @param {typeof fetch} fetchImpl
 * @param {{ supabaseUrl: string, supabaseKey: string, token: string }} db
 * @param {string} name
 * @param {object} args
 */
export async function memberRpc(fetchImpl, { supabaseUrl, supabaseKey, token }, name, args) {
  const res = await fetchImpl(`${supabaseUrl.replace(/\/+$/, '')}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { apikey: supabaseKey, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw Object.assign(new Error(data?.message || `Request failed (${res.status})`), { status: res.status });
  return data;
}

/** The public URL of an uploaded artwork image (the bucket is public; paths are random). */
export function storageUrl(supabaseUrl, path) {
  const p = String(path);
  return /^https:\/\//.test(p) ? p : `${supabaseUrl.replace(/\/+$/, '')}/storage/v1/object/public/artworks/${p.split('/').map(encodeURIComponent).join('/')}`;
}
