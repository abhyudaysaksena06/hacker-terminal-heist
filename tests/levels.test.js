import test from 'node:test';
import assert from 'node:assert';
import * as E from '../supabase/functions/_shared/engine/state.js';
import { LEVELS, VAULT_KEY, TARGET_FILE } from '../supabase/functions/_shared/engine/levels.js';
import { userPrompt } from '../supabase/functions/_shared/ai/prompts.js';
const { CONFIG } = E;

const solve = [
  ['connect nx-07'], ['authenticate --key glass-harbor-lantern'], ['decrypt --key 3'],
  ['escalate --via deploy'], ['extract --file PROJECT_HELIX.DAT --key ORCHID']
];

test('all five missions are completable; progression only via advance()', () => {
  const s = E.createSession(1000);
  solve.forEach(([cmd], i) => {
    assert.equal(s.level, i + 1);
    assert.equal(E.advance(s, 1000).ok, false, 'cannot advance before solving');
    const r = E.execute(s, cmd, 1000);
    assert.ok(r.events.includes('solved'), cmd);
    assert.equal(s.level, i + 1, 'solving does not advance by itself');
    assert.ok(E.advance(s, 1000).ok);
  });
  assert.ok(s.finished);
  assert.equal(E.advance(s).ok, false);
  assert.equal(E.view(s).missions.every(m => m.status === 'done'), true);
});

test('wrong answers fail and raise alert; correct actions do not', () => {
  const s = E.createSession(0);
  E.execute(s, 'scan', 0);
  assert.equal(s.alert, 0);
  E.execute(s, 'connect nx-01', 0);
  assert.equal(s.alert, CONFIG.PENALTY.wrong);
  assert.equal(s.solved, false);
  E.execute(s, 'connect nx-07', 0);
  assert.equal(s.solved, true);
  assert.equal(s.alert, CONFIG.PENALTY.wrong);
});

test('wrong answers in each mission do not solve it', () => {
  const bad = ['connect nx-03', 'authenticate --key nope', 'decrypt --key 4', 'escalate --via ghost', 'extract --file x --key y'];
  const s = E.createSession(0);
  bad.forEach(cmd => {
    E.execute(s, cmd, 0);
    assert.equal(s.solved, false, cmd);
    s.solved = true; E.advance(s, 0);
  });
});

test('unavailable and unknown commands are handled without leaking solutions', () => {
  const s = E.createSession(0);
  const a = E.execute(s, 'decrypt --key 3', 0);
  assert.match(a.out[0], /does nothing useful/);
  const b = E.execute(s, 'sudo rm', 0);
  assert.match(b.out[0], /unknown command/);
  assert.equal(s.alert, CONFIG.PENALTY.unavailable + CONFIG.PENALTY.unknown);
});

test('repeated wrong answers escalate the penalty', () => {
  const s = E.createSession(0);
  for (let i = 0; i < 3; i++) E.execute(s, 'connect nx-01', 0);
  assert.equal(s.alert, 10 + 10 + 10 + CONFIG.PENALTY.repeat);
});

test('alert is bounded and lockout lasts 30s, server-side', () => {
  const s = E.createSession(0);
  let r;
  for (let i = 0; i < 20 && !s.lockedUntil; i++) r = E.execute(s, 'connect nx-01', 0);
  assert.ok(r.events.includes('lock'));
  assert.ok(s.alert >= 0 && s.alert <= 100);
  assert.equal(s.lockedUntil, CONFIG.LOCK_MS);
  assert.equal(E.execute(s, 'scan', 29999).locked, true);
  assert.equal(E.hint(s, 29999).locked, true);
  assert.equal(E.view(s, 29999).lockRemaining, 1);
  assert.ok(!E.execute(s, 'scan', 30000).locked);
});

test('hints cost alert and score, and are progressively more specific', () => {
  const s = E.createSession(0);
  const h1 = E.hint(s, 0), h2 = E.hint(s, 0);
  assert.equal(s.hints, 2);
  assert.equal(s.alert, CONFIG.PENALTY.hint * 2);
  assert.notEqual(h1.out[0].slice(9), h2.out[0].slice(9));
  s.finishedAt = 0; s.peak = 0; s.failures = 0;
  assert.equal(E.computeScore(s), CONFIG.SCORE.base - 2 * CONFIG.SCORE.perHint);
});

test('level 5 time pressure raises alert on info commands', () => {
  const s = E.createSession(0); s.level = 5;
  E.execute(s, 'scan', 0);
  assert.equal(s.alert, CONFIG.PENALTY.tick);
});

test('score is never negative', () => {
  const s = E.createSession(0); s.finishedAt = 10 ** 9; s.failures = 99;
  assert.equal(E.computeScore(s), 0);
});

test('notes: recovered intel is stored server-side so a reload cannot soft-lock mission 5', () => {
  const s = E.createSession(0);
  assert.deepEqual(E.execute(s, 'notes', 0).out, ['No intel recovered yet.']);
  assert.equal(s.alert, 0, 'notes is free');
  for (const [cmd] of solve.slice(0, 4)) { E.execute(s, cmd, 0); E.advance(s, 0); }
  assert.equal(s.level, 5);
  const out = E.execute(s, 'notes', 0).out.join('\n');
  assert.match(out, /Vault key: ORCHID/);
  assert.match(out, /Target file: PROJECT_HELIX\.DAT/);
  assert.equal(s.alert, 0, 'notes costs nothing and does not touch failures');
  // the facts in notes must be exactly what mission 5 accepts
  E.execute(s, `extract --file ${TARGET_FILE} --key ${VAULT_KEY}`, 0);
  assert.ok(s.solved);
});

test('notes does not reveal intel from missions not yet solved', () => {
  const s = E.createSession(0);
  E.execute(s, 'connect nx-07', 0); E.advance(s, 0);
  const out = E.execute(s, 'notes', 0).out.join('\n');
  assert.match(out, /nx-07/);
  assert.doesNotMatch(out, /ORCHID|glass-harbor-lantern/i);
});

test('notes and help are listed, and help mentions notes', () => {
  const s = E.createSession(0);
  assert.match(E.execute(s, 'help', 0).out[1], /notes/);
  assert.ok(E.ALL_CMDS.has('notes'));
});

test('bare inspect and wrong targets are cheap usage errors, not failed guesses (missions 2-4)', () => {
  const s = E.createSession(0); s.level = 2;
  for (const lvl of [2, 3, 4]) {
    s.level = lvl; s.alert = 0; s.failures = 0;
    const r = E.execute(s, 'inspect', 0);
    assert.match(r.out[0], /^Usage: inspect <target>/, 'mission ' + lvl);
    assert.equal(s.failures, 0, 'no failure recorded, mission ' + lvl);
    assert.equal(s.alert, CONFIG.PENALTY.unavailable);
    assert.ok(!r.events.includes('wrong'));
  }
  for (const lvl of [2, 3, 4]) {
    s.level = lvl; s.alert = 0;
    const r = E.execute(s, 'inspect nonsense', 0);
    assert.match(r.out[0], /nothing named "nonsense"/, 'mission ' + lvl);
    assert.equal(s.failures, 0, 'exploring a wrong target is not a failed answer, mission ' + lvl);
    assert.equal(s.alert, CONFIG.PENALTY.unavailable);
    assert.ok(!r.events.includes('wrong'));
  }
});

test('hints past the last one are free and add no new text', () => {
  const s = E.createSession(0);
  const n = LEVELS[0].hints.length;
  for (let i = 0; i < n; i++) E.hint(s, 0);
  assert.equal(s.hints, n);
  const r = E.hint(s, 0);
  assert.match(r.out[0], /^No more hints/);
  assert.ok(r.out[0].endsWith(LEVELS[0].hints[n - 1]), 'repeats the last hint');
  assert.ok(!r.events.includes('hint'));
  assert.equal(s.hints, n, 'not counted against the score');
  assert.equal(s.alert, n * CONFIG.PENALTY.hint, 'no extra alert');
  E.execute(s, 'connect nx-07', 0); E.advance(s, 0);
  assert.match(E.hint(s, 0).out[0], /^\[HINT 1\]/, 'the next mission gets its own hints');
});

test('a lockout resets the wrong-answer streak', () => {
  const s = E.createSession(0);
  for (let i = 0; i < 20 && !s.lockedUntil; i++) E.execute(s, 'connect nx-01', 0);
  assert.equal(s.alert, CONFIG.LOCK_RESET_ALERT);
  assert.equal(s.consecWrong, 0);
  const t = CONFIG.LOCK_MS;
  E.execute(s, 'connect nx-01', t);
  assert.equal(s.alert, CONFIG.LOCK_RESET_ALERT + CONFIG.PENALTY.wrong, 'first wrong after a lock is a plain wrong');
  E.execute(s, 'connect nx-01', t);
  assert.ok(!E.isLocked(s, t), 'two mistakes after a lock do not relock');
});

test('status and the SENTINEL prompt derive the mission count from LEVELS', () => {
  const s = E.createSession(0);
  assert.match(E.execute(s, 'status', 0).out[0], new RegExp('^Mission 1/' + LEVELS.length + ':'));
  assert.match(userPrompt(s, ['high']), new RegExp('Mission 1/' + LEVELS.length + '\\.'));
  LEVELS.push({ id: 6, title: 'x', objective: 'y', commands: [], hints: [], run() { return { r: 'ok', out: [] }; } });
  try { assert.match(E.execute(s, 'status', 0).out[0], /^Mission 1\/6:/); } finally { LEVELS.pop(); }
});
