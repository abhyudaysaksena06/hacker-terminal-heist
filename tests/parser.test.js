import test from 'node:test';
import assert from 'node:assert';
import { parse, MAX_LEN } from '../supabase/functions/_shared/engine/parser.js';

test('tokenizes whitespace, case, args and flags', () => {
  const p = parse('  CONNECT   nx-07 ');
  assert.deepEqual([p.cmd, p.args], ['connect', ['nx-07']]);
  const q = parse('authenticate --key "glass-harbor lantern"');
  assert.equal(q.flags.key, 'glass-harbor lantern');
});
test('empty input is flagged', () => assert.ok(parse('   ').empty));
test('missing flag value is an error', () => {
  assert.match(parse('decrypt --key').error, /needs a value/);
  assert.match(parse('decrypt --key --x 1').error, /needs a value/);
});
test('rejects non-strings, control chars, overlong input', () => {
  assert.ok(parse(42).error);
  assert.ok(parse('scan\u0007').error);
  assert.ok(parse('a'.repeat(MAX_LEN + 1)).error);
});

test('--flag=value is accepted alongside --flag value', () => {
  assert.equal(parse('authenticate --key=glass-harbor-lantern').flags.key, 'glass-harbor-lantern');
  assert.equal(parse('decrypt --KEY=3').flags.key, '3');
  assert.equal(parse('extract --file=a.dat --key b').flags.file, 'a.dat');
  assert.equal(parse('x --k=a=b').flags.k, 'a=b', 'only the first = splits');
});
test('--flag= with no value, and --=x, are errors', () => {
  assert.match(parse('decrypt --key=').error, /needs a value/);
  assert.match(parse('decrypt --=3').error, /Empty flag/);
  assert.match(parse('decrypt --').error, /Empty flag/);
});
