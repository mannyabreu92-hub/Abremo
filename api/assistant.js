// The Abremi Guide: a Vercel server function (streaming). One assistant, three modes: discovery
// ("visitor"), artist and collector. It shares the AI connection with the Career Coach (api/_ai.js).
//
// Flow: the app sends { mode, messages, page } with the member's session token. The database
// (begin_assistant_request, migration 0013) decides whether they may ask, applies the daily
// allowance, and returns the public catalog plus the member's own data. This function picks
// suggestions, asks the model, and streams the reply back as lines of JSON:
//   {"type":"text","text":"…"}   … then {"type":"done","usage":{…}} or {"type":"error","error":"…"}
// Replies only ever reference works and artists that exist and are visible. Nothing is stored
// except that a request happened (mode, time, outcome).
import { MODELS, FALLBACK, aiClient, aiErrorMessage, memberRpc, storageUrl } from './_ai.js';
import { MODES, enrichCatalog, selectCandidates, describePage, validMessages, buildGuideRequest, referenceFilter, VOCABULARY } from './_guide.js';

export const MODEL = MODELS.guide;
const PAGE_TYPES = ['artwork', 'artist', 'collection', 'ranking', 'battle', 'competition'];

/** deps: { anthropic, fetchImpl, supabaseUrl, supabaseKey } → ({ method, token, body }, out) */
export function createGuide(deps) {
  /**
   * @param {{ method: string, token: string | null, body: any }} req
   * @param {{ json: (status: number, body: object) => void, start: () => void, write: (line: object) => void, end: () => void }} out
   */
  return async function guide({ method, token, body }, out) {
    if (method !== 'POST') return out.json(405, { error: 'Use POST' });
    if (!token) return out.json(401, { error: 'Sign in to use the Guide' });
    const mode = body?.mode;
    if (!MODES.includes(mode)) return out.json(400, { error: 'Choose a mode' });
    const messages = validMessages(body?.messages);
    if (!messages) return out.json(400, { error: 'Messages must alternate, end with yours, and be under 2,000 characters.' });
    const pageType = PAGE_TYPES.includes(body?.page?.type) ? body.page.type : null;
    const pageId = pageType ? String(body.page.id || '').slice(0, 120) : null;
    if (!deps.anthropic) return out.json(503, { error: 'The Guide isn’t switched on yet.' });
    if (!deps.supabaseUrl || !deps.supabaseKey) return out.json(503, { error: 'The Guide needs accounts to be switched on.' });
    const db = { supabaseUrl: deps.supabaseUrl, supabaseKey: deps.supabaseKey, token };

    let ctx;
    try {
      ctx = await memberRpc(deps.fetchImpl, db, 'begin_assistant_request', { p_mode: mode, p_page_type: pageType, p_page_id: pageId });
    } catch (e) {
      return out.json(e.status === 401 || e.status === 403 ? 401 : 400, { error: e.message });
    }
    const finish = (ok) => memberRpc(deps.fetchImpl, db, 'finish_assistant_request', { p_id: ctx.request_id, p_ok: ok }).catch(() => {});

    const catalog = enrichCatalog(ctx.catalog);
    const candidates = selectCandidates({ catalog, page: ctx.page, personal: ctx.personal || {}, messages, mode });
    const context = {
      member: ctx.member,
      page: describePage(ctx.page, catalog),
      suggestion_candidates: candidates,
      personal: ctx.personal?.interests ? { interests: ctx.personal.interests } : undefined,
      your_collections: ctx.collections || undefined,
      your_studio: ctx.studio || undefined,
      search_vocabulary: VOCABULARY,
    };
    const imageUrl = ctx.page?.type === 'artwork' && ctx.page.artwork?.thumb_path ? storageUrl(deps.supabaseUrl, ctx.page.artwork.thumb_path) : null;
    const filter = referenceFilter({ artworkIds: new Set(catalog.artworks.map((w) => w.id)), artistIds: new Set(catalog.artists.map((a) => a.id)) });

    out.start();
    let sent = '';
    try {
      const stream = deps.anthropic.beta.messages.stream({ ...buildGuideRequest({ mode, messages, context, imageUrl, model: MODEL }), ...FALLBACK });
      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
          const safe = filter.push(event.delta.text);
          if (safe) { sent += safe; out.write({ type: 'text', text: safe }); }
        }
      }
      const final = await stream.finalMessage();
      const rest = filter.end();
      if (rest) { sent += rest; out.write({ type: 'text', text: rest }); }
      if (final.stop_reason === 'refusal' || !sent.trim()) {
        await finish(false);
        out.write({ type: 'error', error: 'The Guide couldn’t help with that one. Try asking another way.', retry: false });
      } else {
        await finish(true);
        const usage = await memberRpc(deps.fetchImpl, db, 'assistant_usage', {}).catch(() => null);
        out.write({ type: 'done', usage, refs: filter.refs });
      }
    } catch (e) {
      await finish(false);
      out.write({ type: 'error', ...aiErrorMessage(e, 'The Guide'), retry: true });
    }
    out.end();
  };
}

let guide = null;
/** Vercel entry point. */
export default async function handler(req, res) {
  guide ||= createGuide({
    anthropic: aiClient(process.env),
    fetchImpl: fetch,
    supabaseUrl: process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL,
    supabaseKey: process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  });
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '') || null;
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = null; } }
  await guide({ method: req.method, token, body }, {
    json: (status, out) => { res.setHeader('Cache-Control', 'no-store'); res.status(status).json(out); },
    start: () => {
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
    },
    write: (line) => res.write(`${JSON.stringify(line)}\n`),
    end: () => res.end(),
  });
}
