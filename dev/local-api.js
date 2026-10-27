// Local stand-in for the Supabase Edge Function, used by `npm run dev` / `npm run preview` when
// VITE_SUPABASE_URL is not set. Same routes and engine, in-memory store, no real auth: the bearer token
// is a random player id the browser makes up. Never deploy this; production runs supabase/functions/game.
import { createHandler } from '../supabase/functions/_shared/api.js';
import { serve } from '../supabase/functions/_shared/http.js';
import { memoryStore } from '../supabase/functions/_shared/memory-store.js';

const PLAYER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const devVerifyPlayer = async token => (PLAYER_ID.test(token) ? token : null);
export const createLocalApi = (store = memoryStore()) => serve(createHandler({ store, verifyPlayer: devVerifyPlayer }));

// Connect middleware mounted at /functions/v1/game, the path the real function is served on.
function middleware(api) {
  return async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const r = await api(new Request('http://local/functions/v1/game' + req.url, {
      method: req.method, headers: req.headers, body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body
    }));
    res.statusCode = r.status;
    r.headers.forEach((v, k) => res.setHeader(k, v));
    res.end(Buffer.from(await r.arrayBuffer()));
  };
}

export function localGameApi({ enabled }) {
  const api = createLocalApi();
  const mount = server => { if (enabled) server.middlewares.use('/functions/v1/game', middleware(api)); };
  return { name: 'local-game-api', configureServer: mount, configurePreviewServer: mount };
}
