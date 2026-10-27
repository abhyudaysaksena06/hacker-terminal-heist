import { createClient } from '@supabase/supabase-js';

// With VITE_SUPABASE_URL set, the game talks to the Supabase Edge Function and players sign in anonymously.
// Without it, it talks to the local dev API that Vite serves at the same path (see dev/local-api.js).
const URL = import.meta.env.VITE_SUPABASE_URL, KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;
const supabase = URL && KEY ? createClient(URL, KEY) : null;
const BASE = (supabase ? URL : '') + '/functions/v1/game';

// Storage can throw (blocked cookies, some private modes). Fall back to in-memory for this page load.
const store = {
  get: k => { try { return sessionStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { sessionStorage.setItem(k, v); } catch { /* memory only */ } },
  del: k => { try { sessionStorage.removeItem(k); } catch { /* memory only */ } }
};
let sid = store.get('nx-session');
let devPlayer = store.get('nx-dev-player');

async function accessToken() {
  if (!supabase) {
    if (!devPlayer) { devPlayer = crypto.randomUUID(); store.set('nx-dev-player', devPlayer); }
    return devPlayer;
  }
  const { data } = await supabase.auth.getSession();
  if (data.session) return data.session.access_token;
  const { data: signed, error } = await supabase.auth.signInAnonymously();
  if (error) throw new Error('Sign-in failed: ' + error.message);
  return signed.session.access_token;
}

async function call(path, body, { auth = true } = {}) {
  const opts = { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' } };
  try {
    if (auth) opts.headers.Authorization = 'Bearer ' + await accessToken();
    else if (KEY) opts.headers.Authorization = 'Bearer ' + KEY;
  } catch (e) { throw Object.assign(new Error(e.message || 'Server unreachable.'), { status: 0 }); }
  if (KEY) opts.headers.apikey = KEY;
  if (sid) opts.headers['X-Game-Session'] = sid;
  if (body) opts.body = JSON.stringify(body);
  let r;
  try { r = await fetch(BASE + path, opts); } catch { throw Object.assign(new Error('Server unreachable.'), { status: 0 }); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error((j.error && j.error.message) || 'Request failed.'), { status: r.status, data: j });
  return j;
}

export const Api = {
  call,
  persistent: !!supabase, // the local dev API keeps the leaderboard in memory
  hasSession: () => !!sid,
  setSession(id) { sid = id; id ? store.set('nx-session', id) : store.del('nx-session'); },
  newSession: () => call('/session', {}),
  state: () => call('/state'),
  command: command => call('/command', { command }),
  complete: () => call('/mission/complete', {}),
  score: name => call('/score', { name }),
  leaderboard: () => call('/leaderboard', null, { auth: false })
};
