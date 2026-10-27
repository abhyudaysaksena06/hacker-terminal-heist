// In-memory store with the same contract as pg-store.js. Used by the local dev API and the tests.
// Sessions are deep-copied in and out so a request only changes stored state by saving, as with Postgres.
import { CONFIG, isExpired } from './engine/state.js';

export function memoryStore({ rate = CONFIG.RATE, max = CONFIG.MAX_SESSIONS, perPlayer = CONFIG.MAX_PER_PLAYER } = {}) {
  const sessions = new Map(), hits = new Map(), board = [];
  return {
    sessions, board,
    async create(player, s, now = s.startedAt) {
      for (const [id, e] of sessions) if (isExpired(e.s, now)) sessions.delete(id);
      const mine = [...sessions].filter(([, e]) => e.player === player);
      for (const [id] of mine.slice(0, Math.max(0, mine.length - perPlayer + 1))) sessions.delete(id); // Map order = oldest first
      while (sessions.size >= max) sessions.delete(sessions.keys().next().value);
      sessions.set(s.id, { player, s: structuredClone(s), version: 0 });
    },
    async get(player, sid, now) {
      const e = sessions.get(sid);
      if (!e || e.player !== player || isExpired(e.s, now)) return null;
      return { s: structuredClone(e.s), version: e.version };
    },
    async save(player, s, version) {
      const e = sessions.get(s.id);
      if (!e || e.player !== player || e.version !== version) return false;
      e.s = structuredClone(s); e.version++;
      return true;
    },
    async hit(key, now = Date.now()) {
      let h = hits.get(key);
      if (!h || now > h.reset) h = { n: 0, reset: now + rate.windowMs };
      h.n++; hits.set(key, h);
      if (hits.size > 5000) for (const [k, v] of hits) if (now > v.reset) hits.delete(k);
      return h.n <= rate.max;
    },
    async addScore({ sessionId, name, score, time }) {
      if (board.some(e => e.sessionId === sessionId)) return;
      board.push({ sessionId, name, score, time });
      board.sort((a, b) => b.score - a.score); // stable: earlier submission wins a tie
      board.length = Math.min(board.length, 50);
    },
    top: async n => board.slice(0, n).map(({ name, score, time }) => ({ name, score, time }))
  };
}
