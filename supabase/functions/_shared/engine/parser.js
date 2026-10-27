const MAX_LEN = 200;

function tokenize(s) {
  const out = [], re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(s))) out.push(m[1] !== undefined ? m[1] : m[2]);
  return out;
}

// Returns { empty } | { error } | { cmd, args, flags, raw }
function parse(input) {
  if (typeof input !== 'string') return { error: 'Command must be text.' };
  const raw = input.trim();
  if (!raw) return { empty: true };
  if (raw.length > MAX_LEN) return { error: `Command too long (max ${MAX_LEN} characters).` };
  if (/[\u0000-\u001f\u007f]/.test(raw)) return { error: 'Command contains invalid characters.' };
  const toks = tokenize(raw);
  const cmd = toks.shift().toLowerCase();
  const args = [], flags = {};
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.startsWith('--')) {
      let k = t.slice(2), v; // accepts both `--key value` and `--key=value`
      const eq = k.indexOf('=');
      if (eq !== -1) { v = k.slice(eq + 1); k = k.slice(0, eq); }
      k = k.toLowerCase();
      if (!k) return { error: 'Empty flag. Use --name value.' };
      if (v === undefined) {
        v = toks[i + 1];
        if (v === undefined || v.startsWith('--')) return { error: `Flag --${k} needs a value.` };
        i++;
      } else if (v === '') return { error: `Flag --${k} needs a value.` };
      flags[k] = v;
    } else args.push(t);
  }
  return { cmd, args, flags, raw };
}

export { parse, tokenize, MAX_LEN };
