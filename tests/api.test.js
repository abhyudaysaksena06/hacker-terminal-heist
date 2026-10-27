// The game API exactly as the Edge Function serves it (same handler and HTTP adapter), on the in-memory store.
// Only the Postgres store and Supabase's token check are swapped out; see supabase/functions/game/index.ts.
import test from 'node:test';
import assert from 'node:assert';
import * as E from '../supabase/functions/_shared/engine/state.js';
import { LEVELS } from '../supabase/functions/_shared/engine/levels.js';
import { memoryStore } from '../supabase/functions/_shared/memory-store.js';
import { createHandler } from '../supabase/functions/_shared/api.js';
import { serve } from '../supabase/functions/_shared/http.js';
import { devVerifyPlayer } from '../dev/local-api.js';

delete process.env.ANTHROPIC_API_KEY;
const BASE = 'http://local/functions/v1/game';
const STATE_KEYS = 'alert,finished,level,lockRemaining,locked,missions,objective,score,solved,stats,submitted,title';

function setup({ clock } = {}) {
  const store = memoryStore();
  const api = serve(createHandler({ store, verifyPlayer: devVerifyPlayer, ...(clock ? { clock } : {}) }));
  const call = async (path, { player, sid, body, method, raw, ip } = {}) => {
    const headers = { 'content-type': 'application/json' };
    if (player) headers.authorization = 'Bearer ' + player;
    if (sid) headers['x-game-session'] = sid;
    if (ip) headers['x-forwarded-for'] = ip;
    const r = await api(new Request(BASE + path, { method: method || (body !== undefined || raw ? 'POST' : 'GET'), headers, body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined) }));
    return { status: r.status, json: await r.json(), headers: r.headers };
  };
  const newGame = async (player = crypto.randomUUID()) => ({ player, ...(await call('/session', { player, body: {} })).json });
  return { store, call, newGame };
}

test('players are identified by their token; sessions belong to one player', async () => {
  const { call, newGame } = setup();
  const { player, sid, state } = await newGame();
  assert.equal(Object.keys(state).sort().join(), STATE_KEYS);
  assert.equal((await call('/session', { body: {} })).json.error.code, 'NO_TOKEN');
  assert.equal((await call('/state', { sid })).status, 401);
  const bad = await call('/state', { player: 'not-a-real-token', sid });
  assert.equal(bad.status, 401); assert.equal(bad.json.error.code, 'BAD_TOKEN');
  const other = await call('/state', { player: crypto.randomUUID(), sid });
  assert.equal(other.status, 401); assert.equal(other.json.error.code, 'NO_SESSION', "another player's session is not found");
  assert.equal((await call('/state', { player })).json.error.code, 'NO_SESSION', 'missing X-Game-Session');
  assert.equal((await call('/state', { player, sid: 'nope' })).status, 401);
  assert.equal((await call('/state', { player, sid })).status, 200);
});

test('sessions expire after the TTL, server-side', async () => {
  let now = 1_000_000;
  const { call, newGame } = setup({ clock: () => now });
  const { player, sid } = await newGame();
  now += E.CONFIG.SESSION_TTL_MS + 1;
  assert.equal((await call('/state', { player, sid })).json.error.code, 'NO_SESSION');
});

test('client-supplied level/alert/score are ignored; completion is gated', async () => {
  const { call, newGame } = setup();
  const { player, sid } = await newGame();
  let r = await call('/command', { player, sid, body: { command: 'scan', level: 5, alert: 0, score: 99999 } });
  assert.equal(r.json.state.level, 1);
  assert.equal((await call('/mission/complete', { player, sid, body: {} })).status, 409);
  assert.equal((await call('/score', { player, sid, body: { name: 'x', score: 99999 } })).status, 409);
  r = await call('/command', { player, sid, body: { command: 'extract --file PROJECT_HELIX.DAT --key ORCHID' } });
  assert.equal(r.json.state.solved, false);
});

test('bad request shapes return consistent JSON errors', async () => {
  const { call, newGame } = setup();
  const { player, sid } = await newGame();
  const r = await call('/command', { player, sid, body: { cmd: 'scan' } });
  assert.equal(r.status, 400); assert.equal(r.json.error.code, 'BAD_REQUEST');
  assert.equal((await call('/nope')).status, 404);
  const bad = await call('/session', { player, raw: '{nope' });
  assert.equal(bad.status, 400); assert.equal(bad.json.error.code, 'BAD_JSON');
  const big = await call('/session', { player, body: { x: 'a'.repeat(5000) } });
  assert.equal(big.status, 413); assert.equal(big.json.error.code, 'TOO_LARGE');
});

test('endpoint response shapes match the documented contract', async () => {
  const { call, newGame } = setup();
  const { player, sid } = await newGame();
  const keys = o => Object.keys(o).sort().join();
  const c = await call('/command', { player, sid, body: { command: 'scan' } });
  assert.equal(c.status, 200); assert.equal(keys(c.json), 'clear,out,sentinel,state');
  assert.ok(Array.isArray(c.json.out) && typeof c.json.clear === 'boolean');
  assert.equal((await call('/command', { player, sid, body: { command: 'CLEAR now' } })).json.clear, true, 'server flags clear for any casing/args');
  const h = await call('/hint', { player, sid, body: {} });
  assert.equal(h.status, 200); assert.equal(keys(h.json), 'out,sentinel,state');
  assert.match(h.json.out[0], /^\[HINT 1\]/);
  assert.equal(keys((await call('/sentinel', { player, sid })).json), 'sentinel');
  const st = (await call('/state', { player, sid })).json.state;
  assert.equal(keys(st), STATE_KEYS);
  assert.equal(keys(st.stats), 'elapsed,failures,hints,peak');
  for (const [res, code] of [[await call('/state'), 401], [await call('/nope'), 404], [await call('/mission/complete', { player, sid, body: {} }), 409]]) {
    assert.equal(res.status, code);
    assert.ok(typeof res.json.error.code === 'string' && typeof res.json.error.message === 'string');
  }
});

test('API does not reveal titles of missions the player has not reached', async () => {
  const { call, newGame } = setup();
  const { player, sid, state } = await newGame();
  const hidden = LEVELS.slice(1).map(l => l.title);
  for (const m of state.missions.filter(m => m.status === 'locked')) assert.ok(!hidden.includes(m.title), 'locked title leaked: ' + m.title);
  const st = (await call('/state', { player, sid })).json.state;
  assert.equal(st.missions[0].title, LEVELS[0].title, 'active mission keeps its title');
  assert.equal(st.missions.length, LEVELS.length);
});

test('full playthrough, score submission once, leaderboard; lockout survives a reload', async () => {
  const { call, newGame } = setup();
  const { player, sid } = await newGame();
  const steps = ['connect nx-07', 'authenticate --key glass-harbor-lantern', 'decrypt --key 3', 'escalate --via deploy', 'extract --file project_helix.dat --key orchid'];
  for (const command of steps) {
    const r = await call('/command', { player, sid, body: { command } });
    assert.equal(r.json.state.solved, true, command);
    assert.equal((await call('/mission/complete', { player, sid, body: {} })).status, 200);
  }
  const st = (await call('/state', { player, sid })).json.state;
  assert.ok(st.finished && st.score > 0);
  assert.equal((await call('/score', { player, sid, body: { name: '<script>' } })).status, 400);
  assert.equal((await call('/score', { player, sid, body: { name: 'Shivain' } })).status, 200);
  assert.equal((await call('/score', { player, sid, body: { name: 'Again' } })).status, 409);
  const lb = (await call('/leaderboard')).json.entries;
  assert.equal(lb.length, 1);
  assert.deepEqual(Object.keys(lb[0]).sort(), ['name', 'score', 'time']);
  assert.equal(lb[0].name, 'Shivain'); assert.equal(lb[0].score, st.score);

  const g2 = await newGame();
  let last;
  for (let i = 0; i < 15; i++) { last = await call('/command', { player: g2.player, sid: g2.sid, body: { command: 'connect nx-01' } }); if (last.json.state.locked) break; }
  assert.ok(last.json.state.locked);
  const blocked = await call('/command', { player: g2.player, sid: g2.sid, body: { command: 'connect nx-07' } });
  assert.equal(blocked.status, 423);
  assert.equal((await call('/hint', { player: g2.player, sid: g2.sid, body: {} })).status, 423, 'hint is blocked during lockout');
  assert.equal((await call('/state', { player: g2.player, sid: g2.sid })).json.state.locked, true, 'refresh does not clear lock');
});

test('notes work over HTTP and survive a fresh GET /state (reload)', async () => {
  const { call, newGame } = setup();
  const { player, sid } = await newGame();
  await call('/command', { player, sid, body: { command: 'connect nx-07' } });
  await call('/mission/complete', { player, sid, body: {} });
  assert.equal((await call('/state', { player, sid })).json.state.level, 2, 'progress was saved');
  const r = await call('/command', { player, sid, body: { command: 'notes' } });
  assert.match(r.json.out.join('\n'), /nx-07/);
  assert.equal(Object.keys(r.json.state).sort().join(), STATE_KEYS, 'notes must not add fields to the state contract');
});

test('a save that lost a race is rejected instead of overwriting newer progress', async () => {
  const { store } = setup();
  const s = E.createSession(0), player = crypto.randomUUID();
  await store.create(player, s);
  const a = await store.get(player, s.id, 0), b = await store.get(player, s.id, 0);
  a.s.alert = 10; b.s.alert = 50;
  assert.equal(await store.save(player, a.s, a.version), true);
  assert.equal(await store.save(player, b.s, b.version), false, 'stale version');
  assert.equal((await store.get(player, s.id, 0)).s.alert, 10);
});

test('sessions are capped per player and overall', async () => {
  const store = memoryStore({ max: 20 }), player = crypto.randomUUID();
  const mine = [];
  for (let i = 0; i < 8; i++) { const s = E.createSession(i); mine.push(s.id); await store.create(player, s); }
  assert.equal([...store.sessions.values()].filter(e => e.player === player).length, E.CONFIG.MAX_PER_PLAYER);
  assert.ok(await store.get(player, mine.at(-1), 8), 'newest session survives');
  assert.equal(await store.get(player, mine[0], 8), null, 'oldest session is gone');
  for (let i = 0; i < 50; i++) await store.create(crypto.randomUUID(), E.createSession(100));
  assert.ok(store.sessions.size <= 20);
});

test('API responses carry security headers, CORS, and are not cacheable', async () => {
  const { call } = setup();
  const r = await call('/leaderboard');
  assert.match(r.headers.get('cache-control') || '', /no-store/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.match(r.headers.get('access-control-allow-headers'), /x-game-session/);
  const pre = await serve(createHandler({ store: memoryStore(), verifyPlayer: devVerifyPlayer }))(new Request(BASE + '/command', { method: 'OPTIONS' }));
  assert.equal(pre.status, 204);
});

test('rate limiter answers 429 with the standard error envelope', async () => {
  const { call } = setup();
  let r;
  for (let i = 0; i < E.CONFIG.RATE.max + 20; i++) { r = await call('/leaderboard', { ip: '203.0.113.9' }); if (r.status === 429) break; }
  assert.equal(r.status, 429); assert.equal(r.json.error.code, 'RATE_LIMITED');
  assert.equal((await call('/leaderboard', { ip: '203.0.113.10' })).status, 200, 'limits are per client');
});
