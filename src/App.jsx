import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Api } from './api.js';
import { Snd } from './sounds.js';

const CELLS = 20; // 5% per cell, matching the smallest penalty step
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
const mmss = t => String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0');
const gauge = (n, total) => '[' + '#'.repeat(n) + '.'.repeat(total - n) + ']';

// Output line styles. The first class in each is a stable hook (tests, devtools); the rest is presentation.
const C = {
  ok: 't-ok text-hi', bad: 't-bad text-red', hint: 't-hint text-amber', info: 't-info text-dim',
  head: 't-head text-dim underline decoration-dotted underline-offset-3',
  banner: 'banner bg-amber text-glass font-bold mt-4 px-[1ch] w-max max-w-full',
  sentinel: 'sentinel text-amber my-1 pl-[10ch] -indent-[10ch]',
  dim: 'dim text-dim', warn: 'warn text-amber', crit: 'crit text-red'
};
// Presentation only: colors server lines by their leading tag. Text is never altered.
const tag = l =>
  /^\[OK\]/.test(l) ? C.ok :
  /^\[(DENIED|FAIL|ERR)\]/.test(l) ? C.bad :
  /^\[HINT \d+\]/.test(l) ? C.hint :
  /^(\[INFO\]|RULE:|\(\+\d+% alert)/.test(l) ? C.info :
  /^>> MISSION/.test(l) ? C.banner :
  /^[A-Z_]+( {2,}[A-Z_]+)+$/.test(l) ? C.head : '';

const BOOT = ['NEXUS CORP', 'SECURITY INFRASTRUCTURE', 'UNAUTHORIZED ACCESS IS PROHIBITED', '', '[ OK ] loading kernel modules', '[ OK ] mounting /vault (read-only)', '[ OK ] SENTINEL online', '[ !! ] environment is SIMULATED: no real systems are touched'];
const LOGO = ['#   #  #####  #   #  #   #   ####', '##  #  #       # #   #   #  #    ', '# # #  ####     #    #   #   ### ', '#  ##  #       # #   #   #      #', '#   #  #####  #   #   ###   #### '].join('\n');
const ZONE_LABEL = { calm: 'low', elevated: 'elevated', critical: 'critical', locked: 'locked' };

const SCREEN = 'max-w-[92ch] mx-auto p-4 min-h-full';
const MENU = 'menu flex flex-col items-start gap-2 mt-6';
const H2 = "font-bold text-hi mb-4 before:content-['#_'] before:text-dim";
const FOOT_BTN = 'text-dim hover:text-glass focus-visible:text-glass';
const LINE = 'line whitespace-pre-wrap [word-break:break-word]';

function readScan() { try { return localStorage.getItem('scan') !== '0'; } catch { return true; /* storage blocked */ } }

export default function App() {
  const [screen, setScreen] = useState('boot');
  const [bootLines, setBootLines] = useState([]);
  const [g, setG] = useState(null); // latest server view of the session
  const [lines, setLines] = useState([]);
  const [clock, setClock] = useState('00:00');
  const [locked, setLocked] = useState(false);
  const [lockText, setLockText] = useState(null);
  const [muted, setMuted] = useState(Snd.isMuted);
  const [scan, setScan] = useState(readScan);
  const [debrief, setDebrief] = useState('');
  const [scoreHidden, setScoreHidden] = useState(false);
  const [scoreMsg, setScoreMsg] = useState('');
  const [boardText, setBoardText] = useState('');
  const outRef = useRef(null), cmdRef = useRef(null), nameRef = useRef(null);
  // Values read by timers and async flows, which must see the latest value rather than a render's snapshot.
  const r = useRef({ state: null, screen: 'boot', locked: false, hist: [], hi: 0, busy: false, t0: 0, e0: 0, lineId: 0,
    bootDone: false, bootTimer: null, lock: { gen: 0, timer: null, end: 0, total: 0, polling: false } }).current;

  function show(id) { r.screen = id; setScreen(id); }
  const print = (t, cls = '') => setLines(ls => [...ls, { id: ++r.lineId, t, cls }]);
  const echo = t => setLines(ls => [...ls, { id: ++r.lineId, t, echo: true }]);
  const clearOut = () => setLines([]);
  useLayoutEffect(() => { const o = outRef.current; o.scrollTop = o.scrollHeight; }, [lines]);

  // --- boot ---
  function endBoot() { if (r.bootDone) return; r.bootDone = true; clearInterval(r.bootTimer); show('menu'); }
  useEffect(() => {
    let i = 0, done;
    r.bootTimer = setInterval(() => {
      if (i >= BOOT.length) { clearInterval(r.bootTimer); done = setTimeout(endBoot, 500); return; }
      const line = BOOT[i++];
      setBootLines(ls => [...ls, line]);
    }, reduce ? 0 : 260);
    const onKey = () => { if (!r.bootDone) endBoot(); };
    addEventListener('keydown', onKey);
    return () => { clearInterval(r.bootTimer); clearTimeout(done); removeEventListener('keydown', onKey); };
  }, []);

  // --- HUD ---
  function render(s) {
    r.state = s; r.t0 = Date.now(); r.e0 = s.stats.elapsed;
    setG(s);
    applyLock(s);
  }
  function applyLock(s) {
    const L = r.lock;
    clearInterval(L.timer);
    const gen = ++L.gen; // invalidates any in-flight poll from an earlier lock or session
    L.polling = false;
    if (!s.locked) { L.total = 0; r.locked = false; setLocked(false); setLockText(null); return; }
    L.end = Date.now() + s.lockRemaining; L.total = Math.max(L.total, s.lockRemaining); r.locked = true; setLocked(true);
    const tick = async () => {
      const ms = L.end - Date.now(), left = Math.ceil(ms / 1000);
      if (left > 0) {
        const f = Math.max(0, Math.min(CELLS, Math.round(ms / L.total * CELLS)));
        setLockText(`[LOCKOUT] terminal frozen by SENTINEL\n${gauge(f, CELLS)} ${left}s`);
        return;
      }
      if (L.polling) return;
      L.polling = true;
      setLockText('[LOCKOUT] lock expired. Contacting server...');
      try {
        const res = await Api.state();
        if (gen === L.gen) render(res.state); // render() re-arms the timer if the server says it is still locked
      } catch (e) {
        if (gen !== L.gen) return;
        if (e.status === 401) { clearInterval(L.timer); setLockText('[SESSION] expired or invalid. Press restart.'); }
        // any other failure: keep the interval running so the next tick retries; the terminal must never stay frozen
      } finally { if (gen === L.gen) L.polling = false; }
    };
    tick(); L.timer = setInterval(tick, 500);
  }
  useEffect(() => () => clearInterval(r.lock.timer), []);
  useEffect(() => {
    const id = setInterval(() => {
      if (!r.state || r.state.finished) return;
      setClock(mmss(r.e0 + Math.floor((Date.now() - r.t0) / 1000)));
    }, 1000);
    return () => clearInterval(id);
  }, []);
  const zone = !g ? 'calm' : g.locked ? 'locked' : g.alert >= 80 ? 'critical' : g.alert >= 50 ? 'elevated' : 'calm';
  useEffect(() => { if (g) document.body.dataset.zone = zone; }, [g, zone]);
  useEffect(() => { if (screen === 'game' && !locked) cmdRef.current.focus(); }, [screen, locked]);

  // --- game flow ---
  async function startNew() {
    try {
      const res = await Api.newSession(); Api.setSession(res.sid);
      clearOut(); r.hist = []; r.hi = 0;
      show('game'); render(res.state);
      print('NEXUS SECURE SHELL. Session active.', C.dim);
      print('Type help for commands, notes for recovered intel. This is a simulation.', C.dim);
    } catch (e) { alert('Could not start: ' + e.message); }
  }
  async function resume() {
    try {
      const res = await Api.state(); clearOut();
      show('game'); render(res.state); print('Session resumed. Type notes to review recovered intel.', C.dim);
      if (res.state.finished) return victory(res.state);
      if (res.state.solved) await complete(); // solved but never advanced (e.g. the tab closed mid-transition)
    } catch (e) {
      if (e.status === 401) { Api.setSession(null); startNew(); } // only a rejected session means it is gone
      else alert('Could not resume: ' + e.message);
    }
  }

  async function run(text) {
    echo(text);
    if (/^clear$/i.test(text.trim())) { clearOut(); return; }
    try {
      const res = await Api.command(text);
      if (res.clear) clearOut(); // the server decides what counts as clear (any casing, extra args)
      res.out.forEach(l => print(l, tag(l)));
      if (res.sentinel) print('SENTINEL: ' + res.sentinel, C.sentinel);
      render(res.state);
      if (res.state.alert >= 80 || res.state.locked) {
        Snd.warn();
        if (!reduce) { document.body.classList.add('glitch'); setTimeout(() => document.body.classList.remove('glitch'), 200); }
      } else Snd.ok();
      if (res.state.solved) await complete();
    } catch (e) {
      if (e.status === 423) { print('[LOCKED] ' + e.message, C.crit); render(e.data.state); }
      else if (e.status === 401) print('[SESSION] expired or invalid. Press restart.', C.crit);
      else print('[ERR] ' + e.message, C.crit);
    }
  }
  async function complete() {
    const res = await Api.complete();
    res.out.forEach(l => print(l, l.startsWith('>> MISSION') ? C.banner : C.warn));
    if (res.sentinel) print('SENTINEL: ' + res.sentinel, C.sentinel);
    render(res.state);
    if (res.state.finished) setTimeout(() => {
      // only if the player is still looking at this finished run (not exited to the menu or restarted)
      if (r.state && r.state.finished && r.screen === 'game') victory(r.state);
    }, 1200);
  }
  function victory(s) {
    setDebrief([
      'EXTRACTION COMPLETE', '',
      'PROJECT_HELIX.DAT copied. SENTINEL logged the intrusion', 'but not the intruder.', '',
      `time ........ ${mmss(s.stats.elapsed)}`, `failed ...... ${s.stats.failures}`, `hints ....... ${s.stats.hints}`,
      `peak alert .. ${s.stats.peak}%`, `score ....... ${s.score}`].join('\n'));
    setScoreHidden(s.submitted);
    setScoreMsg(s.submitted ? 'Score submitted.' : '');
    show('victory');
  }

  // --- input ---
  async function onSubmit(e) {
    e.preventDefault();
    const cmd = cmdRef.current, v = cmd.value;
    if (r.busy || !v.trim()) return;
    cmd.value = ''; r.hist.push(v); r.hi = r.hist.length; r.busy = true;
    try { await run(v); } finally { r.busy = false; if (!r.locked) cmd.focus(); }
  }
  function onKeyDown(e) {
    Snd.key();
    const cmd = cmdRef.current;
    if (e.key === 'ArrowUp') { e.preventDefault(); if (r.hi > 0) cmd.value = r.hist[--r.hi]; }
    else if (e.key === 'ArrowDown') { e.preventDefault(); cmd.value = r.hi < r.hist.length - 1 ? r.hist[++r.hi] : (r.hi = r.hist.length, ''); }
    else if (e.key === 'Escape') clearOut();
  }
  async function onScore(e) {
    e.preventDefault();
    try { await Api.score(nameRef.current.value); setScoreHidden(true); setScoreMsg('Score submitted.'); }
    catch (err) { setScoreMsg(err.message); }
  }
  async function board() {
    show('board');
    const row = (n, name, sc, t) => `${n.padStart(2)}  ${name.padEnd(16)} ${sc.padStart(6)}  ${t}`;
    try {
      const { entries } = await Api.leaderboard();
      setBoardText(entries.length
        ? [row('#', 'callsign', 'score', 'time'), '-'.repeat(34), ...entries.map((x, i) => row(String(i + 1), x.name, String(x.score), x.time + 's'))].join('\n')
        : 'No entries yet. Finish a breach to claim the first.');
    } catch (e) { setBoardText('Could not load: ' + e.message); }
  }

  function toggleMute() { Snd.toggle(); setMuted(Snd.isMuted()); }
  function toggleScan() { const next = !scan; try { localStorage.setItem('scan', next ? '1' : '0'); } catch { /* not persisted */ } setScan(next); }
  useEffect(() => { document.body.classList.toggle('noscan', !scan); }, [scan]);

  const barCls = zone === 'critical' || zone === 'locked' ? 'text-red' : zone === 'elevated' ? 'text-amber' : '';
  const nodeCls = { done: 'text-ph', active: 'bg-amber text-glass font-bold', locked: 'text-dim' };

  return <>
    <div id="crt" aria-hidden="true" className="fixed inset-0 pointer-events-none z-10" />

    <section id="boot" className={SCREEN} hidden={screen !== 'boot'} onClick={endBoot}>
      <div id="bootlog" className="mb-4 whitespace-pre-wrap">
        {bootLines.map((t, i) => {
          const m = /^\[ (OK|!!) \]/.exec(t);
          return <div key={i}>{m ? <><span className={m[1] === 'OK' ? 'boot-ok text-hi' : 'text-amber'}>{m[0]}</span>{t.slice(m[0].length)}</> : t || ' '}</div>;
        })}
      </div>
      <p className="text-dim">Press any key to skip.</p>
    </section>

    <section id="menu" className={SCREEN} hidden={screen !== 'menu'}>
      <pre className="logo text-hi text-[clamp(9px,3.2vw,18px)] leading-[1.1] whitespace-pre mb-2" aria-label="NEXUS CORP">{LOGO}</pre>
      <p className="text-dim mb-6">CORP secure shell // node nx-00</p>
      <p className="text-hi font-bold">THE SYSTEM IS WATCHING.</p>
      <p className="text-dim">Status: NODE NX-00 online. Threat level: elevated.<br />This environment is a simulation. No real systems are touched.</p>
      <nav className={MENU}>
        <button data-act="resume" hidden={!Api.hasSession()} onClick={resume}>&gt; resume session</button>
        <button data-act="start" onClick={startNew}>&gt; initialize breach</button>
        <button data-act="brief" onClick={() => show('briefing')}>&gt; mission briefing</button>
        <button data-act="board" onClick={board}>&gt; leaderboard</button>
      </nav>
    </section>

    <section id="briefing" className={SCREEN} hidden={screen !== 'briefing'}>
      <h2 className={H2}>Mission briefing</h2>
      <p>You are an intruder inside Nexus Corp's simulated network. Five missions stand between you and a classified file. SENTINEL, the company's security AI, is watching every command.</p>
      <dl className="man grid grid-cols-[9ch_1fr] gap-4 m-0 max-w-[78ch] max-[560px]:grid-cols-1 max-[560px]:gap-0">
        <dt className="text-dim">commands</dt><dd className="m-0 max-[560px]:mb-4">Typed as <code>name argument --flag value</code>, for example <code>connect &lt;host&gt;</code> or <code>decrypt --key 5</code>. Each mission accepts only some commands. <code>help</code> lists them.</dd>
        <dt className="text-dim">alert</dt><dd className="m-0 max-[560px]:mb-4">Rises when you guess wrong, run commands that don't apply, or ask for hints. At 100% the terminal locks for 30 seconds. In the final mission every <code>scan</code> also raises alert.</dd>
        <dt className="text-dim">hints</dt><dd className="m-0 max-[560px]:mb-4">Cost 5% alert and 250 points. <code>↑</code> and <code>↓</code> recall earlier commands. <code>notes</code> lists intel you have recovered, which survives a reload. <code>clear</code> wipes the screen.</dd>
        <dt className="text-dim">try it</dt><dd className="m-0 max-[560px]:mb-4">Start a breach, type <code>scan</code>, and read the DNS column.</dd>
      </dl>
      <nav className={MENU}><button data-act="menu" onClick={() => show('menu')}>&gt; back</button></nav>
    </section>

    <section id="game" className="flex flex-col h-dvh min-h-0 max-w-[100ch] mx-auto p-4" hidden={screen !== 'game'}>
      <header id="hud" className="border-y border-frame py-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span id="mTitle" className="font-bold text-hi">{g && g.title}</span>
          <span className="text-dim" id="mCount">{g && `mission ${g.level}/${g.missions.length}`}</span>
          <span className="flex-1" />
          <span id="conn" className={'lamp px-[.5ch] font-bold text-glass ' + (zone === 'locked' ? 'bg-red' : 'bg-ph')}>{locked ? 'LOCKED' : 'CONNECTED'}</span>
          <span className="text-dim" id="clock">{clock}</span>
        </div>
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-dim">trace</span>
          <span id="bar" className={'whitespace-pre ' + barCls}>{g && gauge(Math.round(g.alert / 100 * CELLS), CELLS)}</span>
          <span id="alertN">{g ? g.alert : 0}%</span>
          <span className="text-dim" id="zone">{ZONE_LABEL[zone]}</span>
          <span className="flex-1" />
          <span className="text-dim whitespace-pre" id="stats">{g && `hints ${g.stats.hints}  fails ${g.stats.failures}  peak ${g.stats.peak}%`}</span>
        </div>
      </header>
      <div id="nodes" className="flex flex-wrap gap-x-4 pt-2">
        {g && g.missions.map(m => (
          <span key={m.id} className={`node ${m.status} whitespace-pre ${nodeCls[m.status]}`} title={m.status === 'locked' ? 'locked' : m.title}>
            {(m.status === 'done' ? '[x] ' : m.status === 'active' ? '[>] ' : '[ ] ') + m.id}
          </span>
        ))}
      </div>
      <div id="objective" className="text-dim py-2 border-b border-dashed border-frame">{g && 'objective: ' + g.objective}</div>
      <div id="out" ref={outRef} role="log" aria-live="polite" className="flex-1 overflow-y-auto overscroll-contain py-2" onClick={() => { if (!r.locked) cmdRef.current.focus(); }}>
        {lines.map(l => l.echo
          ? <div key={l.id} className={LINE + ' echo mt-4 first:mt-0 text-hi'}><span className="ps text-dim">operator@nexus:~$ </span>{l.t}</div>
          : <div key={l.id} className={LINE + ' ' + l.cls}>{l.t}</div>)}
      </div>
      <div id="lockbar" hidden={lockText === null} className="whitespace-pre bg-red text-glass py-1 px-2 font-bold overflow-hidden">{lockText}</div>
      <form id="prompt" autoComplete="off" onSubmit={onSubmit} className="flex gap-2 border-t border-frame py-2 focus-within:border-ph">
        <label htmlFor="cmd" className="text-dim whitespace-nowrap">operator@nexus:~$</label>
        <input id="cmd" ref={cmdRef} onKeyDown={onKeyDown} disabled={locked} spellCheck={false} autoCapitalize="off" autoCorrect="off" maxLength={200} aria-label="command"
          className="flex-1 min-w-0 border-0 caret-hi text-[16px] disabled:opacity-40" />
      </form>
      <footer className="flex gap-4 flex-wrap items-center text-[.85rem] border-t border-dashed border-frame pt-1">
        <button id="muteBtn" className={FOOT_BTN} onClick={toggleMute}>sound: {muted ? 'off' : 'on'}</button>
        <button id="crtBtn" className={FOOT_BTN} onClick={toggleScan}>scanlines: {scan ? 'on' : 'off'}</button>
        <button id="restartBtn" className={FOOT_BTN} onClick={startNew}>restart</button>
        <button data-act="menu" className={FOOT_BTN} onClick={() => show('menu')}>exit</button>
        <span className="text-dim">type help</span>
      </footer>
    </section>

    <section id="victory" className={SCREEN} hidden={screen !== 'victory'}>
      <pre id="debrief" className="border-l-2 border-frame pl-4 mb-6 first-line:bg-ph first-line:text-glass first-line:font-bold">{debrief}</pre>
      <form id="scoreForm" hidden={scoreHidden} onSubmit={onScore} className="flex flex-wrap items-baseline gap-2">
        <label htmlFor="pname">callsign</label>
        <input id="pname" ref={nameRef} maxLength={16} placeholder="1-16 characters" className="w-[18ch] py-[2px] border-b-ph" />
        <button className="border border-ph py-1 px-2">submit score</button>
      </form>
      <p id="scoreMsg" className="text-dim">{scoreMsg}</p>
      <nav className={MENU}>
        <button data-act="start" onClick={startNew}>&gt; replay</button>
        <button data-act="board" onClick={board}>&gt; leaderboard</button>
      </nav>
    </section>

    <section id="board" className={SCREEN} hidden={screen !== 'board'}>
      <h2 className={H2}>Leaderboard</h2>
      <pre id="boardList" className="text-ph mb-4">{boardText}</pre>
      <p className="text-dim">{Api.persistent ? 'Top 10 breaches, stored in the game database.' : 'In-memory board for this server. It resets when the server restarts.'}</p>
      <nav className={MENU}><button data-act="menu" onClick={() => show('menu')}>&gt; back</button></nav>
    </section>
  </>;
}
