// Build step (Vercel "Build Command": node scripts/write-config.js). Also stamps sw.js.
// Copies the public Supabase URL and anon/publishable key from the environment into
// src/config.js. Refuses secret keys: they must never reach the browser.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { stampServiceWorker } from './gen-sw.js';

const pick = (env, names) => names.map((n) => env[n]).find((v) => v && v.trim())?.trim() || '';

function jwtRole(key) {
  try {
    const part = key.split('.')[1];
    return JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')).role;
  } catch {
    return undefined;
  }
}

export function resolveConfig(env) {
  const url = pick(env, ['SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL', 'VITE_SUPABASE_URL']);
  const key = pick(env, ['SUPABASE_ANON_KEY', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_PUBLISHABLE_KEY', 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'VITE_SUPABASE_ANON_KEY']);
  if (!url || !key) return { url: '', key: '', mode: 'demo' };
  if (!/^https:\/\/[^\s'"\\]+$/.test(url)) throw new Error('SUPABASE_URL must be an https:// URL');
  if (key.startsWith('sb_secret_') || jwtRole(key) === 'service_role') {
    throw new Error('Refusing to publish a secret Supabase key. Use the anon / publishable key.');
  }
  if (/['"\\\s]/.test(key)) throw new Error('Supabase key contains unexpected characters');
  return { url: url.replace(/\/+$/, ''), key, mode: 'community' };
}

export function configSource({ url, key }) {
  return `// Written at deploy time by scripts/write-config.js from the project's environment variables.
// Empty values run Abremi in demo mode: everything stays on the visitor's device.
export const SUPABASE_URL = ${JSON.stringify(url)};
export const SUPABASE_ANON_KEY = ${JSON.stringify(key)};
`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const cfg = resolveConfig(process.env);
  writeFileSync(new URL('../src/config.js', import.meta.url), configSource(cfg));
  console.log(cfg.mode === 'community' ? `Abremi: community mode (${new URL(cfg.url).host})` : 'Abremi: demo mode (no Supabase environment variables found)');
  // The config is part of the offline app, so the service worker version must reflect it.
  console.log(`Abremi: service worker version ${stampServiceWorker()}`);
}
