// Real-browser tests: the React app on the Vite dev server, against the local game API (same handler as the
// Edge Function, in-memory store). Needs: npm i -D playwright && npx playwright install chromium
// Run: npm run test:e2e   (not part of `npm test`; takes ~45s because it waits out a real 30s lockout)
// Leave VITE_SUPABASE_URL unset (no .env.local) so the app uses the local API.
delete process.env.ANTHROPIC_API_KEY;
import test from 'node:test';
import assert from 'node:assert';
import { chromium } from 'playwright';
import { createServer } from 'vite';

let server, base, browser;
test.before(async () => {
  server = await createServer({ server: { port: 0, host: '127.0.0.1' }, logLevel: 'silent' });
  await server.listen(); base = server.resolvedUrls.local[0]; browser = await chromium.launch();
});
test.after(async () => { await browser.close(); await server.close(); });

async function open({ viewport = { width: 1100, height: 800 }, init, keepDialogs } = {}) {
  const ctx = await browser.newContext({ viewport, reducedMotion: 'reduce' });
  if (init) await ctx.addInitScript(init);
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort()); // sandbox is offline; the app must degrade to system mono
  const page = await ctx.newPage(), problems = [], dialogs = [];
  const font = u => /fonts\.g/.test(u || '');
  page.on('pageerror', e => problems.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !font(m.location().url)) problems.push(`console: ${m.text()} @${m.location().url}`); });
  page.on('requestfailed', r => { if (!font(r.url())) problems.push('requestfailed: ' + r.url()); });
  page.on('dialog', d => { (keepDialogs ? dialogs : problems).push('dialog: ' + d.message()); d.dismiss(); });
  await page.goto(base);
  await page.waitForSelector('#menu:not([hidden])');
  return { page, ctx, problems, dialogs };
}
const start = async page => { await page.click('[data-act=start]'); await page.waitForSelector('#game:not([hidden])'); await page.waitForSelector('#cmd:not([disabled])'); };
async function send(page, command) {
  const [res] = await Promise.all([page.waitForResponse(r => r.url().endsWith('/game/command')), (async () => { await page.fill('#cmd', command); await page.press('#cmd', 'Enter'); })()]);
  const j = await res.json();
  if (j.state && j.state.solved) await page.waitForResponse(r => r.url().endsWith('/game/mission/complete'));
  await page.waitForFunction(() => !document.querySelector('#cmd').disabled || document.querySelector('#conn').textContent === 'LOCKED');
  return j;
}
const text = (page, sel) => page.textContent(sel);

test('full playthrough through the UI: five missions, HUD state, extraction, score, leaderboard', async () => {
  const { page, ctx, problems } = await open();
  assert.ok(await page.locator('[data-act=resume]').isHidden(), 'no resume without a session');
  await start(page);
  assert.equal(await text(page, '#mTitle'), 'Network Recon');
  assert.equal(await text(page, '#mCount'), 'mission 1/5');
  assert.equal(await text(page, '#bar'), '[' + '.'.repeat(20) + ']');
  await send(page, 'connect nx-01');
  assert.equal(await text(page, '#alertN'), '10%');
  assert.equal((await text(page, '#bar')).split('#').length - 1, 2);
  assert.match(await text(page, '#stats'), /fails 1/);
  assert.ok(await page.locator('.line.t-bad').count() >= 1, 'denied output is styled as failure');
  await send(page, 'hint');
  assert.equal(await text(page, '#alertN'), '15%');
  assert.ok(await page.locator('.t-hint').count() >= 1);
  const plan = [['connect nx-07', 'Authentication Breach'], ['inspect auth_node', null], ['logs', null], ['authenticate --key glass-harbor-lantern', 'Decryption'],
    ['inspect cipher', null], ['decrypt --key 3', 'Privilege Escalation'], ['escalate --via deploy', 'Data Extraction'], ['extract --file project_helix.dat --key orchid', null]];
  for (const [cmd, nextTitle] of plan) {
    await send(page, cmd);
    if (nextTitle) assert.equal(await text(page, '#mTitle'), nextTitle, 'after ' + cmd);
  }
  await page.waitForSelector('#victory:not([hidden])', { timeout: 5000 });
  assert.match(await text(page, '#debrief'), /EXTRACTION COMPLETE[\s\S]*score \.+ \d+/);
  await page.fill('#pname', 'JUDGE'); await page.click('#scoreForm button');
  await page.waitForFunction(() => document.querySelector('#scoreMsg').textContent === 'Score submitted.');
  await page.click('#victory [data-act=board]');
  await page.waitForFunction(() => document.querySelector('#boardList').textContent.includes('JUDGE'));
  assert.deepEqual(problems, []);
  await ctx.close();
});

test('lockout freezes input, survives reload, and releases when the server says so', async () => {
  const { page, ctx, problems } = await open();
  await start(page);
  for (let i = 0; i < 14 && (await text(page, '#conn')) !== 'LOCKED'; i++) await send(page, 'connect nx-01');
  assert.equal(await text(page, '#conn'), 'LOCKED');
  assert.ok(await page.locator('#cmd').isDisabled());
  assert.match(await text(page, '#lockbar'), /LOCKOUT[\s\S]*\d+s/);
  assert.equal(await page.getAttribute('body', 'data-zone'), 'locked');
  await page.reload(); await page.waitForSelector('#menu:not([hidden])');
  await page.click('[data-act=resume]');
  await page.waitForFunction(() => document.querySelector('#conn').textContent === 'LOCKED');
  await page.waitForFunction(() => document.querySelector('#conn').textContent === 'CONNECTED', null, { timeout: 40000 });
  assert.ok(await page.locator('#cmd').isEnabled());
  assert.equal(await text(page, '#alertN'), '70%');
  assert.deepEqual(problems, []);
  await ctx.close();
});

test('clear works for any casing and with arguments, and Escape clears', async () => {
  const { page, ctx } = await open();
  await start(page);
  for (const cmd of ['clear', 'CLEAR', 'clear please']) {
    await send(page, 'help'); assert.ok(await page.locator('#out .line').count() > 2);
    // exact `clear` (any casing) is handled locally; `clear please` goes to the server, which flags clear:true
    if (/^clear$/i.test(cmd)) { await page.fill('#cmd', cmd); await page.press('#cmd', 'Enter'); } else await send(page, cmd);
    await page.waitForFunction(() => document.querySelectorAll('#out .line').length === 0);
  }
  await send(page, 'help'); await page.press('#cmd', 'Escape');
  assert.equal(await page.locator('#out .line').count(), 0);
  await ctx.close();
});

test('a transient network failure on resume keeps the saved session', async () => {
  const { page, ctx, dialogs } = await open({ keepDialogs: true });
  await start(page);
  const saved = await page.evaluate(() => sessionStorage.getItem('nx-session'));
  await page.route('**/game/state', r => r.abort());
  await page.click('footer [data-act=menu]'); await page.click('[data-act=resume]');
  await page.waitForTimeout(400);
  assert.equal(await page.evaluate(() => sessionStorage.getItem('nx-session')), saved, 'session must survive a network error');
  await page.unroute('**/game/state');
  await page.click('[data-act=resume]'); await page.waitForSelector('#game:not([hidden])');
  assert.ok(dialogs.length >= 1, 'user is told the resume failed');
  await ctx.close();
});

test('resuming a session that was solved but not yet advanced completes the mission', async () => {
  const { page, ctx, problems } = await open();
  await start(page);
  await api(page, '/command', { command: 'connect nx-07' });
  await page.reload(); await page.waitForSelector('#menu:not([hidden])');
  await page.click('[data-act=resume]');
  await page.waitForFunction(() => document.querySelector('#mTitle').textContent === 'Authentication Breach', null, { timeout: 4000 });
  assert.deepEqual(problems, []);
  await ctx.close();
});

test('app still loads and plays when browser storage throws', async () => {
  const { page, ctx, problems } = await open({ init: () => { for (const k of ['localStorage', 'sessionStorage']) Object.defineProperty(window, k, { get() { throw new DOMException('denied', 'SecurityError'); } }); } });
  await start(page);
  await send(page, 'scan');
  assert.match(await text(page, '#out'), /nx-07/);
  assert.deepEqual(problems, []);
  await ctx.close();
});

test('keyboard history, sound and scanline toggles persist', async () => {
  const { page, ctx } = await open();
  await start(page);
  await send(page, 'scan'); await send(page, 'help');
  await page.press('#cmd', 'ArrowUp'); assert.equal(await page.inputValue('#cmd'), 'help');
  await page.press('#cmd', 'ArrowUp'); assert.equal(await page.inputValue('#cmd'), 'scan');
  await page.press('#cmd', 'ArrowDown'); await page.press('#cmd', 'ArrowDown'); assert.equal(await page.inputValue('#cmd'), '');
  await page.click('#muteBtn'); assert.equal(await text(page, '#muteBtn'), 'sound: off');
  await page.click('#crtBtn'); assert.equal(await text(page, '#crtBtn'), 'scanlines: off');
  assert.ok(await page.evaluate(() => document.body.classList.contains('noscan')));
  await page.reload(); await page.waitForSelector('#menu:not([hidden])'); await start(page);
  assert.equal(await text(page, '#muteBtn'), 'sound: off'); assert.equal(await text(page, '#crtBtn'), 'scanlines: off');
  await ctx.close();
});

test('phone viewport: no horizontal overflow, prompt stays on screen', async () => {
  const { page, ctx } = await open({ viewport: { width: 360, height: 560 } });
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  assert.ok(await overflow() <= 1, 'menu');
  assert.ok(await page.evaluate(() => { const l = document.querySelector('.logo'); return l.scrollWidth <= l.clientWidth + 1; }), 'logo clipped');
  await page.click('[data-act=brief]'); assert.ok(await overflow() <= 1, 'briefing');
  await page.click('#briefing [data-act=menu]'); await start(page);
  await send(page, 'scan');
  assert.ok(await overflow() <= 1, 'game');
  const box = await page.locator('#prompt').boundingBox();
  assert.ok(box.y + box.height <= 560, 'prompt below the fold');
  assert.ok((await page.locator('#out').boundingBox()).height > 80, 'output area collapsed');
  await ctx.close();
});

// ---- regression tests from the judge audit ----
const api = (page, path, body) => page.evaluate(async ([path, body]) => (await fetch('/functions/v1/game' + path, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + sessionStorage.getItem('nx-dev-player'), 'x-game-session': sessionStorage.getItem('nx-session') }, body: JSON.stringify(body || {}) })).status, [path, body]);
async function toMission5(page) {
  for (const c of ['connect nx-07', 'authenticate --key glass-harbor-lantern', 'decrypt --key 3', 'escalate --via deploy']) { await api(page, '/command', { command: c }); await api(page, '/mission/complete'); }
}

test('reload in mission 5 does not lose the vault key: `notes` recovers it and the run can finish', async () => {
  const { page, ctx, problems } = await open();
  await start(page);
  await toMission5(page);
  await page.reload(); await page.waitForSelector('#menu:not([hidden])'); await page.click('[data-act=resume]');
  await page.waitForFunction(() => document.querySelector('#mCount').textContent === 'mission 5/5');
  assert.ok(!/ORCHID/i.test(await text(page, '#out')), 'scrollback is (expectedly) gone after a reload');
  await send(page, 'notes');
  const shown = await text(page, '#out');
  assert.match(shown, /Vault key: ORCHID/); assert.match(shown, /Target file: PROJECT_HELIX\.DAT/);
  assert.equal(await text(page, '#alertN'), '0%', 'notes is free');
  await send(page, 'extract --file PROJECT_HELIX.DAT --key ORCHID');
  await page.waitForSelector('#victory:not([hidden])', { timeout: 5000 });
  assert.deepEqual(problems, []);
  await ctx.close();
});

test('leaving the game during the victory transition is not hijacked by the victory screen', async () => {
  const { page, ctx, problems } = await open();
  await start(page);
  await toMission5(page);
  await send(page, 'extract --file project_helix.dat --key orchid'); // schedules victory() 1.2s out
  await page.click('footer [data-act=menu]');
  await page.waitForTimeout(1800);
  assert.ok(await page.locator('#menu').isVisible(), 'still on the menu');
  assert.ok(await page.locator('#victory').isHidden(), 'victory screen must not appear over the menu');
  await page.click('[data-act=resume]'); // the finished run is still reachable
  await page.waitForSelector('#victory:not([hidden])');
  assert.deepEqual(problems, []);
  await ctx.close();
});

test('a dropped request when the lock expires does not leave the terminal frozen', async () => {
  const { page, ctx, problems } = await open();
  await start(page);
  for (let i = 0; i < 14 && (await text(page, '#conn')) !== 'LOCKED'; i++) await send(page, 'connect nx-01');
  assert.equal(await text(page, '#conn'), 'LOCKED');
  let dropped = 0;
  await page.route('**/game/state', r => (dropped++ < 2 ? r.abort() : r.continue()));
  await page.waitForFunction(() => document.querySelector('#conn').textContent === 'CONNECTED', null, { timeout: 45000 });
  assert.ok(dropped >= 3, 'the poll retried after failures (saw ' + dropped + ' requests)');
  assert.ok(await page.locator('#cmd').isEnabled());
  await send(page, 'scan');
  assert.match(await text(page, '#out'), /nx-07/);
  assert.ok(problems.every(p => /requestfailed|ERR_FAILED|Failed to load resource/.test(p)), 'only the injected network failures: ' + problems.join(' | '));
  await ctx.close();
});

test('UI copy: briefing gives no mission answer; every menu/briefing/board control works', async () => {
  const { page, ctx, problems } = await open();
  assert.ok(!/nx-07/i.test(await page.textContent('body')), 'menu leaks mission 1 answer');
  await page.click('[data-act=brief]'); await page.waitForSelector('#briefing:not([hidden])');
  assert.ok(!/nx-07/i.test(await text(page, '#briefing')), 'briefing leaks mission 1 answer');
  assert.match(await text(page, '#briefing'), /every scan also raises alert/i);
  await page.click('#briefing [data-act=menu]'); await page.waitForSelector('#menu:not([hidden])');
  await page.click('[data-act=board]'); await page.waitForSelector('#board:not([hidden])');
  await page.waitForFunction(() => /No entries yet|callsign/.test(document.querySelector('#boardList').textContent));
  await page.click('#board [data-act=menu]'); await page.waitForSelector('#menu:not([hidden])');
  await start(page);
  await send(page, 'status'); assert.match(await text(page, '#out'), /Mission 1\/5: Network Recon/);
  await page.click('#restartBtn'); await page.waitForSelector('#cmd:not([disabled])');
  assert.equal(await text(page, '#mCount'), 'mission 1/5');
  await page.click('footer [data-act=menu]'); await page.waitForSelector('#menu:not([hidden])');
  assert.ok(await page.locator('[data-act=resume]').isVisible());
  assert.deepEqual(problems, []);
  await ctx.close();
});
