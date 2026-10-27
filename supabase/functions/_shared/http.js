// Adapts the game API to web-standard Request/Response, so the same code serves Deno.serve (Supabase)
// and Node (local dev server, tests).
export const MAX_BODY = 2048;

const SECURITY = { 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' };
const CORS = {
  'Access-Control-Allow-Origin': '*', // tokens travel in the Authorization header, never in cookies
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info, x-game-session',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
};
const error = (code, message) => ({ error: { code, message } });

// Everything up to and including /game is the deployment prefix (/functions/v1/game on Supabase).
export function serve(handle) {
  const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { ...CORS, ...SECURITY, 'Content-Type': 'application/json' } });
  return async req => {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...CORS, ...SECURITY } });
    try {
      const path = new URL(req.url).pathname.replace(/^.*?\/game(?=\/|$)/, '') || '/';
      const text = req.method === 'GET' || req.method === 'HEAD' ? '' : await req.text();
      if (new TextEncoder().encode(text).length > MAX_BODY) return json(413, error('TOO_LARGE', 'Request too large.'));
      let body = {};
      if (text) { try { body = JSON.parse(text); } catch { return json(400, error('BAD_JSON', 'Malformed JSON.')); } }
      const bearer = /^Bearer (.+)$/.exec(req.headers.get('authorization') || '');
      const ip = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim();
      const r = await handle({ method: req.method, path, token: bearer && bearer[1], sid: req.headers.get('x-game-session'), ip, body });
      return json(r.status, r.json);
    } catch (e) {
      console.error(e);
      return json(500, error('SERVER_ERROR', 'Internal error.'));
    }
  };
}
