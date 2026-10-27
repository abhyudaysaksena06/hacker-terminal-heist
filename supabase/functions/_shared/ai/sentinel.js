import { SYSTEM, userPrompt } from './prompts.js';

const LINES = {
  wrong: ['Three attempts, and you are still knocking on the wrong door.', 'Your command history is becoming interesting.', 'That was a guess. I can tell the difference.', 'Incorrect. I logged it anyway.'],
  high: ['I have narrowed your access window. Make your next move count.', 'Access is temporary. My patience is not.', 'Your alert level is not a number I would ignore.'],
  lock: ['Session frozen. Think about what you did.', 'Lockout engaged. Thirty seconds of silence will do you good.'],
  solved: ['You found it. Congratulations. That was the easy part.', 'Progress is not the same as permission.', 'Interesting. Do not get comfortable.'],
  hint: ['Asking for help leaves a trace.', 'A clue, at a price. I keep the receipt.'],
  finished: ['Extraction confirmed. I will remember your signature.']
};
const PRIORITY = ['lock', 'solved', 'high', 'wrong', 'hint'];
const AI_EVENTS = new Set(['lock', 'solved', 'high']);
const AI_COOLDOWN_MS = 10000, AI_MAX_PER_SESSION = 20; // bounds paid model calls per player

// Runs in Deno (Supabase Edge Function) and Node (local dev API, tests).
const env = k => (globalThis.Deno ? globalThis.Deno.env.get(k) : globalThis.process?.env[k]) || undefined;

function fallback(event, s) {
  const arr = LINES[event];
  return arr[(s.level + s.history.length + s.failures) % arr.length];
}

async function callModel(s, events) {
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 3000);
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: ctl.signal,
      headers: { 'content-type': 'application/json', 'x-api-key': env('ANTHROPIC_API_KEY'), 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: env('SENTINEL_MODEL') || 'claude-haiku-5-5', max_tokens: 60, system: SYSTEM, messages: [{ role: 'user', content: userPrompt(s, events) }] })
    });
    if (!r.ok) return null;
    const j = await r.json();
    return validate(j.content && j.content[0] && j.content[0].text);
  } catch { return null; } finally { clearTimeout(timer); }
}

function validate(t) {
  if (typeof t !== 'string') return null;
  t = t.replace(/[\u0000-\u001f]+/g, ' ').replace(/^["'\s]+|["'\s]+$/g, '').trim();
  return t.length >= 3 && t.length <= 160 ? t : null;
}

// Cosmetic only: output never affects game state.
async function line(events, s, now = Date.now()) {
  const ev = PRIORITY.find(e => events.includes(e));
  if (!ev) return null;
  if (ev === 'wrong' && s.consecWrong < 2) return null; // keep SENTINEL from nagging every command
  if (env('ANTHROPIC_API_KEY') && AI_EVENTS.has(ev) && (s.aiCalls || 0) < AI_MAX_PER_SESSION && now - (s.aiAt ?? -Infinity) >= AI_COOLDOWN_MS) {
    s.aiAt = now; s.aiCalls = (s.aiCalls || 0) + 1; // counted before the call so failures cannot be retried for free
    const t = await callModel(s, events);
    if (t) return t;
  }
  return fallback(ev, s);
}

export { line, fallback, validate, LINES, AI_COOLDOWN_MS, AI_MAX_PER_SESSION };
