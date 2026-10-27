import { parse } from './parser.js';
import { LEVELS } from './levels.js';

const CONFIG = {
  LOCK_THRESHOLD: 100, LOCK_MS: 30000, LOCK_RESET_ALERT: 70, HIGH_ALERT: 80,
  PENALTY: { wrong: 10, unknown: 5, unavailable: 3, tick: 4, hint: 5, repeat: 5 },
  REPEAT_AFTER: 3, // consecutive wrong answers before extra penalty
  SCORE: { base: 10000, perSecond: 5, perFail: 100, perHint: 250, perPeak: 10 },
  SESSION_TTL_MS: 3 * 3600 * 1000,
  MAX_SESSIONS: 5000, // in-memory store only: bounds memory for the local dev API
  MAX_PER_PLAYER: 5, // sessions kept per signed-in player; older ones are deleted on restart
  RATE: { windowMs: 60000, max: 120 } // requests per player (or per IP when signed out)
};
const ALL_CMDS = new Set(['help', 'status', 'notes', 'clear', 'hint', 'scan', 'connect', 'inspect', 'logs', 'authenticate', 'decrypt', 'escalate', 'extract']);
const clamp = n => Math.max(0, Math.min(100, n));

// A session is plain JSON so it can live in a Postgres jsonb column. Stores (Postgres, in-memory) own persistence.
function createSession(now = Date.now()) {
  return { id: crypto.randomUUID(), level: 1, alert: 0, peak: 0, failures: 0, hints: 0, hintsLevel: 0, consecWrong: 0, intel: [],
    solved: false, finished: false, submitted: false, score: null, lockedUntil: 0, startedAt: now, finishedAt: null, history: [] };
}
const isLocked = (s, now) => now < s.lockedUntil;
const isExpired = (s, now) => now - s.startedAt > CONFIG.SESSION_TTL_MS;

function addAlert(s, n, now, events) {
  s.alert = clamp(s.alert + n);
  s.peak = Math.max(s.peak, s.alert);
  if (s.alert >= CONFIG.LOCK_THRESHOLD) {
    s.lockedUntil = now + CONFIG.LOCK_MS;
    s.alert = CONFIG.LOCK_RESET_ALERT;
    s.consecWrong = 0; // the lockout is the punishment for the streak; don't carry it past the lock
    events.push('lock');
  } else if (s.alert >= CONFIG.HIGH_ALERT && n > 0) events.push('high');
}

function computeScore(s) {
  const c = CONFIG.SCORE, secs = Math.floor((s.finishedAt - s.startedAt) / 1000);
  return Math.max(0, c.base - secs * c.perSecond - s.failures * c.perFail - s.hints * c.perHint - s.peak * c.perPeak);
}

function execute(s, input, now = Date.now()) {
  const events = [];
  if (s.finished) return { out: ['Session complete.'], events };
  if (isLocked(s, now)) return { locked: true, out: [], events };
  const p = parse(input);
  if (p.empty) return { out: [], events };
  if (p.error) { addAlert(s, CONFIG.PENALTY.unavailable, now, events); return { out: [`[ERR] ${p.error}`], events }; }
  s.history.push(p.cmd); if (s.history.length > 8) s.history.shift();
  const L = LEVELS[s.level - 1];

  if (p.cmd === 'help') return { out: ['Commands for this mission: ' + L.commands.join(', '), 'Always available: help, status, notes, hint, clear'], events };
  if (p.cmd === 'status') return { out: [`Mission ${s.level}/${LEVELS.length}: ${L.title}`, `Objective: ${L.objective}`, `Alert: ${s.alert}%`], events };
  if (p.cmd === 'notes') return { out: s.intel.length ? ['INTEL RECOVERED', ...s.intel.map(l => '- ' + l)] : ['No intel recovered yet.'], events };
  if (p.cmd === 'clear') return { out: [], clear: true, events };
  if (p.cmd === 'hint') return hint(s, now);
  if (s.solved) return { out: ['Mission complete. Advancing...'], events };

  let res;
  if (!L.commands.includes(p.cmd)) {
    if (ALL_CMDS.has(p.cmd)) res = { r: 'unavailable', out: [`[ERR] "${p.cmd}" does nothing useful in this mission. Try: ${L.commands.join(', ')}`] };
    else res = { r: 'unknown', out: [`[ERR] unknown command "${p.cmd}". Type help.`] };
  } else res = L.run(p, s);

  let pen = 0;
  if (res.r === 'wrong') {
    s.failures++; s.consecWrong++; pen = CONFIG.PENALTY.wrong;
    if (s.consecWrong >= CONFIG.REPEAT_AFTER) pen += CONFIG.PENALTY.repeat;
    events.push('wrong');
  } else {
    if (res.r === 'unknown') pen = CONFIG.PENALTY.unknown;
    else if (res.r === 'unavailable' || res.r === 'usage') pen = CONFIG.PENALTY.unavailable;
    if (res.r === 'ok' && L.tick) pen = CONFIG.PENALTY.tick;
    if (res.r === 'solved') { s.solved = true; s.consecWrong = 0; s.intel.push(...(L.intel || [])); events.push('solved'); }
    else if (res.r === 'ok') s.consecWrong = 0;
  }
  if (pen) addAlert(s, pen, now, events);
  return { out: res.out, events };
}

function hint(s, now = Date.now()) {
  const events = [];
  if (s.finished || s.solved) return { out: ['No hints needed right now.'], events };
  if (isLocked(s, now)) return { locked: true, out: [], events };
  const L = LEVELS[s.level - 1];
  // Once every hint is spent, repeating the last one is free: it adds no new information.
  if (s.hintsLevel >= L.hints.length) return { out: [`No more hints for this mission. Last hint: ${L.hints[L.hints.length - 1]}`], events };
  const text = L.hints[s.hintsLevel];
  s.hints++; s.hintsLevel++;
  addAlert(s, CONFIG.PENALTY.hint, now, events);
  events.push('hint');
  return { out: [`[HINT ${s.hintsLevel}] ${text}`, `(+${CONFIG.PENALTY.hint}% alert, -${CONFIG.SCORE.perHint} score)`], events };
}

// Only the server moves a session forward, and only after the mission is solved.
function advance(s, now = Date.now()) {
  if (s.finished) return { ok: false, reason: 'Session already finished.' };
  if (!s.solved) return { ok: false, reason: 'Current mission is not complete.' };
  if (s.level === LEVELS.length) {
    s.finished = true; s.finishedAt = now; s.score = computeScore(s);
    return { ok: true, out: ['EXTRACTION COMPLETE', 'SENTINEL lost the trace. For now.'] };
  }
  s.level++; s.solved = false; s.hintsLevel = 0; s.consecWrong = 0;
  return { ok: true, out: [`>> MISSION ${s.level}: ${LEVELS[s.level - 1].title}`, LEVELS[s.level - 1].objective] };
}

function view(s, now = Date.now()) {
  const L = LEVELS[s.level - 1];
  return {
    level: s.level, title: L.title, objective: L.objective, alert: s.alert, solved: s.solved, finished: s.finished,
    locked: isLocked(s, now), lockRemaining: Math.max(0, s.lockedUntil - now),
    missions: LEVELS.map(l => {
      const status = s.finished || l.id < s.level ? 'done' : l.id === s.level ? (s.solved ? 'done' : 'active') : 'locked';
      return { id: l.id, title: status === 'locked' ? null : l.title, status }; // unreached titles stay server-side
    }),
    stats: { failures: s.failures, hints: s.hints, peak: s.peak, elapsed: Math.floor(((s.finishedAt || now) - s.startedAt) / 1000) },
    score: s.score, submitted: s.submitted
  };
}

export { CONFIG, ALL_CMDS, createSession, execute, hint, advance, view, computeScore, isLocked, isExpired };
