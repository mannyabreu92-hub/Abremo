// Zero-dependency static server for local development: `npm start` → http://localhost:5173
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
// The same response headers as production (vercel.json), including the Content-Security-Policy,
// so local runs and the browser tests behave like the live site.
const vercel = JSON.parse(readFileSync(join(root, 'vercel.json'), 'utf8'));
const headerRules = (vercel.headers || []).map((r) => ({ re: new RegExp(`^${r.source}$`), headers: r.headers }));
const headersFor = (path) => Object.fromEntries(headerRules.filter((r) => r.re.test(path)).flatMap((r) => r.headers.map((h) => [h.key.toLowerCase(), h.value])));
const port = Number(process.env.PORT) || 5173;
const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.md': 'text/markdown; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.jpeg': 'image/jpeg', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = normalize(join(root, path === '/' ? 'index.html' : path));
  if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
  try {
    const body = await readFile(file);
    res.writeHead(200, { ...headersFor(path), 'content-type': types[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
  }
}).listen(port, () => console.log(`Abremi running at http://localhost:${port}`));
