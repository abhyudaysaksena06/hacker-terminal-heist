// The game API, independent of where it runs. The Supabase Edge Function wires it to Postgres;
// the local dev server and the tests wire it to the in-memory store.
import * as E from './engine/state.js';
import * as sentinel from './ai/sentinel.js';

const fail = (status, code, message, extra = {}) => ({ status, json: { error: { code, message }, ...extra } });
const ok = json => ({ status: 200, json });
const NAME = /^[A-Za-z0-9_ -]{1,16}$/;

// auth: 'none' (public), 'player' (signed in), 'session' (signed in and owns the game in X-Game-Session).
// save: the route changes the session, so it is written back afterwards.
const ROUTES = {
  'POST /session': { auth: 'player', async run({ player, store, now }) {
    const s = E.createSession(now);
    await store.create(player, s);
    return ok({ sid: s.id, state: E.view(s, now) });
  } },
  'GET /state': { auth: 'session', run: ({ s, now }) => ok({ state: E.view(s, now) }) },
  'POST /command': { auth: 'session', save: true, async run({ s, body, now }) {
    const cmd = body && body.command;
    if (typeof cmd !== 'string') return fail(400, 'BAD_REQUEST', 'Expected JSON {"command": string}.');
    const r = E.execute(s, cmd, now);
    if (r.locked) return fail(423, 'LOCKED', 'Terminal locked by SENTINEL.', { state: E.view(s, now) });
    const line = await sentinel.line(r.events, s, now);
    return ok({ out: r.out, clear: !!r.clear, sentinel: line, state: E.view(s, now) });
  } },
  'POST /hint': { auth: 'session', save: true, async run({ s, now }) {
    const r = E.hint(s, now);
    if (r.locked) return fail(423, 'LOCKED', 'Terminal locked by SENTINEL.', { state: E.view(s, now) });
    return ok({ out: r.out, sentinel: await sentinel.line(r.events, s, now), state: E.view(s, now) });
  } },
  'GET /sentinel': { auth: 'session', save: true, run: async ({ s, now }) => ok({ sentinel: await sentinel.line(['high'], s, now) }) },
  'POST /mission/complete': { auth: 'session', save: true, run({ s, now }) {
    const r = E.advance(s, now);
    if (!r.ok) return fail(409, 'NOT_COMPLETE', r.reason);
    return ok({ out: r.out, sentinel: s.finished ? sentinel.LINES.finished[0] : null, state: E.view(s, now) });
  } },
  'POST /score': { auth: 'session', save: true, run({ s, body, now }) {
    if (!s.finished) return fail(409, 'NOT_FINISHED', 'Finish all missions first.');
    if (s.submitted) return fail(409, 'ALREADY_SUBMITTED', 'Score already submitted.');
    const name = body && body.name;
    if (typeof name !== 'string' || !NAME.test(name.trim())) return fail(400, 'BAD_NAME', 'Name: 1-16 letters, digits, space, _ or -.');
    s.submitted = true; // score comes from the server, never the request body
    return ok({ ok: true, state: E.view(s, now), entry: { sessionId: s.id, name: name.trim(), score: s.score, time: E.view(s, now).stats.elapsed } });
  } },
  'GET /leaderboard': { auth: 'none', run: async ({ store }) => ok({ entries: await store.top(10) }) }
};

// store: { create, get, save, hit, addScore, top }. verifyPlayer(token) resolves to a player id or null.
export function createHandler({ store, verifyPlayer, clock = () => Date.now() }) {
  return async function handle({ method, path, token, sid, ip, body }) {
    const now = clock();
    const player = token ? await verifyPlayer(token) : null;
    if (!await store.hit(player || 'ip:' + (ip || 'unknown'))) return fail(429, 'RATE_LIMITED', 'Too many requests. Slow down.');
    const route = ROUTES[method + ' ' + path];
    if (!route) return fail(404, 'NOT_FOUND', 'No such endpoint.');
    if (route.auth !== 'none') {
      if (!token) return fail(401, 'NO_TOKEN', 'Missing bearer token.');
      if (!player) return fail(401, 'BAD_TOKEN', 'Invalid or expired token.');
    }
    let loaded = null;
    if (route.auth === 'session') {
      loaded = sid ? await store.get(player, sid, now) : null;
      if (!loaded) return fail(401, 'NO_SESSION', 'Session not found. Start a new one.');
    }
    const r = await route.run({ player, store, body, now, s: loaded && loaded.s });
    if (r.status === 200 && route.save) {
      if (!await store.save(player, loaded.s, loaded.version)) return fail(409, 'CONFLICT', 'Another command changed this session. Try again.');
      if (r.json.entry) { await store.addScore(r.json.entry); delete r.json.entry; }
    }
    return r;
  };
}
