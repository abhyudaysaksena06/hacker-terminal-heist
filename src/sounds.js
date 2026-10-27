// Optional, quiet WebAudio blips. Created only after a user gesture.
let ctx, muted = false;
try { muted = localStorage.getItem('mute') === '1'; } catch { /* storage blocked: default to sound on */ }
const beep = (f, d, v = 0.03) => {
  if (muted) return;
  try {
    ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'square'; o.frequency.value = f; g.gain.value = v;
    o.connect(g); g.connect(ctx.destination); o.start(); o.stop(ctx.currentTime + d);
  } catch { /* audio unavailable: ignore */ }
};

export const Snd = {
  key: () => beep(900, 0.015, 0.012), ok: () => beep(660, 0.09), warn: () => beep(220, 0.18, 0.05),
  isMuted: () => muted, toggle() { muted = !muted; try { localStorage.setItem('mute', muted ? '1' : '0'); } catch { /* not persisted */ } return muted; }
};
