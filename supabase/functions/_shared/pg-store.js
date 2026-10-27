// Postgres-backed store for the Edge Function. `db` is a supabase-js client using the service role key.
import { CONFIG, isExpired } from './engine/state.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const check = ({ data, error }) => { if (error) throw error; return data; };

export function pgStore(db, { rate = CONFIG.RATE, perPlayer = CONFIG.MAX_PER_PLAYER } = {}) {
  return {
    async create(player, s) {
      check(await db.from('game_sessions').insert({ id: s.id, user_id: player, data: s, started_at: new Date(s.startedAt).toISOString() }));
      const old = check(await db.from('game_sessions').select('id').eq('user_id', player).order('started_at', { ascending: false }).range(perPlayer, perPlayer + 99));
      if (old.length) check(await db.from('game_sessions').delete().in('id', old.map(r => r.id)));
    },
    async get(player, sid, now) {
      if (!UUID.test(sid)) return null;
      const row = check(await db.from('game_sessions').select('data, version').eq('id', sid).eq('user_id', player).maybeSingle());
      if (!row || isExpired(row.data, now)) return null;
      return { s: row.data, version: row.version };
    },
    // Succeeds only if nobody saved since this request read the session.
    async save(player, s, version) {
      const rows = check(await db.from('game_sessions').update({ data: s, version: version + 1, updated_at: new Date().toISOString() })
        .eq('id', s.id).eq('user_id', player).eq('version', version).select('id'));
      return rows.length === 1;
    },
    hit: async key => check(await db.rpc('hit_rate_limit', { p_key: key, p_window_ms: rate.windowMs, p_max: rate.max })),
    addScore: async e => check(await db.rpc('submit_score', { p_session: e.sessionId, p_name: e.name, p_score: e.score, p_time: e.time })),
    async top(n) {
      const rows = check(await db.from('leaderboard').select('name, score, time_s').order('score', { ascending: false }).order('id').limit(n));
      return rows.map(r => ({ name: r.name, score: r.score, time: r.time_s }));
    }
  };
}
