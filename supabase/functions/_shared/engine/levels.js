// Puzzle data and rules. Handlers return { out: string[], r: 'ok'|'wrong'|'usage'|'solved' }.
const caesar = (t, k) => t.replace(/[A-Z]/gi, c => {
  const b = c <= 'Z' ? 65 : 97;
  return String.fromCharCode(((c.charCodeAt(0) - b + k) % 26 + 26) % 26 + b);
});

const SHIFT = 3;
const VAULT_KEY = 'ORCHID', TARGET_FILE = 'PROJECT_HELIX.DAT';
const PLAIN = `VAULT KEY: ${VAULT_KEY}. TARGET FILE: ${TARGET_FILE}`;
const CIPHER = caesar(PLAIN, SHIFT);
const PASSPHRASE = 'glass-harbor-lantern';
const lc = v => String(v || '').trim().toLowerCase();

const LEVELS = [
  {
    id: 1, title: 'Network Recon',
    objective: 'Find the host that has no DNS record and connect to it.',
    commands: ['scan', 'connect'],
    intel: ['nx-07 (192.0.2.7) is the auth-gateway with no DNS record.'],
    hints: ['Hosts that are supposed to exist have names. One does not.', 'Look at the DNS column in the scan output.', 'Connect to the host whose record is missing.'],
    run(p) {
      if (p.cmd === 'scan') return { r: 'ok', out: [
        'HOST    ADDRESS      SERVICE        DNS',
        'nx-01   192.0.2.1    gateway        gw.nexus.corp',
        'nx-03   192.0.2.3    mail-relay     mail.nexus.corp',
        'nx-05   192.0.2.5    print-spool    print.nexus.corp',
        'nx-07   192.0.2.7    auth-gateway   (no record)'] };
      if (!p.args[0]) return { r: 'usage', out: ['Usage: connect <host>'] };
      const h = lc(p.args[0]);
      if (h === 'nx-07') return { r: 'solved', out: ['[OK] connected to nx-07', '[OK] auth-gateway reachable'] };
      if (['nx-01', 'nx-03', 'nx-05'].includes(h)) return { r: 'wrong', out: [`[DENIED] ${h} is monitored and logs your address.`] };
      return { r: 'wrong', out: [`[ERR] unknown host "${p.args[0]}".`] };
    }
  },
  {
    id: 2, title: 'Authentication Breach',
    objective: 'Rebuild the passphrase and authenticate.',
    commands: ['inspect', 'logs', 'authenticate'],
    intel: ['Passphrase accepted: ' + PASSPHRASE],
    hints: ['The auth node explains how the passphrase is built.', 'The log lines are not in order. Time is.', 'Three fragments, earliest first, joined with hyphens.'],
    run(p) {
      if (p.cmd === 'logs') return { r: 'ok', out: [
        '03:41:12  rotate  FRAGMENT harbor',
        '03:12:09  rotate  FRAGMENT glass',
        '04:02:55  rotate  FRAGMENT lantern',
        '04:03:01  note    old passphrase retired'] };
      if (p.cmd === 'inspect') {
        if (!p.args[0]) return { r: 'usage', out: ['Usage: inspect <target>. Try auth_node.'] };
        if (lc(p.args[0]) === 'auth_node') return { r: 'ok', out: [
          '[INFO] Authentication node detected.',
          '[INFO] Passphrase = rotation fragments in chronological order, joined by "-", lowercase.',
          '[INFO] Fragments are in logs.'] };
        return { r: 'usage', out: [`[ERR] nothing named "${p.args[0] || ''}" here. Try auth_node.`] };
      }
      if (!p.flags.key) return { r: 'usage', out: ['Usage: authenticate --key <passphrase>'] };
      if (lc(p.flags.key) === PASSPHRASE) return { r: 'solved', out: ['[OK] credentials accepted'] };
      return { r: 'wrong', out: ['[DENIED] passphrase rejected.'] };
    }
  },
  {
    id: 3, title: 'Decryption',
    objective: 'Recover the encrypted vault file.',
    commands: ['inspect', 'decrypt'],
    intel: [`Vault key: ${VAULT_KEY}`, `Target file: ${TARGET_FILE}`],
    hints: ['The file uses a simple letter shift.', 'The header gives one known plaintext/ciphertext pair.', 'Count how far N moved to reach Q.'],
    run(p) {
      if (p.cmd === 'inspect') {
        if (!p.args[0]) return { r: 'usage', out: ['Usage: inspect <target>. Try cipher.'] };
        if (lc(p.args[0]) === 'cipher') return { r: 'ok', out: [
          'CIPHER: letter shift (A-Z), digits and punctuation untouched',
          `SAMPLE: NEXUS -> ${caesar('NEXUS', SHIFT)}`,
          `DATA:   ${CIPHER}`] };
        return { r: 'usage', out: [`[ERR] nothing named "${p.args[0] || ''}" here. Try cipher.`] };
      }
      if (!p.flags.key) return { r: 'usage', out: ['Usage: decrypt --key <number 1-25>'] };
      if (!/^\d{1,2}$/.test(p.flags.key) || +p.flags.key < 1 || +p.flags.key > 25)
        return { r: 'usage', out: ['Key must be a whole number from 1 to 25.'] };
      const k = +p.flags.key;
      if (k === SHIFT) return { r: 'solved', out: ['[OK] file recovered:', PLAIN] };
      return { r: 'wrong', out: ['[FAIL] output is noise:', caesar(CIPHER, -k)] };
    }
  },
  {
    id: 4, title: 'Privilege Escalation',
    objective: 'Find a usable path to administrator rights.',
    commands: ['inspect', 'escalate'],
    intel: ['Admin access path: deploy -> admin.'],
    hints: ['Expired and locked accounts are dead ends.', 'Admin rights are not only held. They can be assumed.', 'Which active account can assume admin?'],
    run(p) {
      if (p.cmd === 'inspect') {
        if (!p.args[0]) return { r: 'usage', out: ['Usage: inspect <target>. Try perms.'] };
        if (lc(p.args[0]) === 'perms') return { r: 'ok', out: [
          'ACCOUNT  STATUS   ROLE      CAN_ASSUME',
          'ghost    expired  admin     -',
          'backup   active   reader    -',
          'audit    locked   admin     -',
          'deploy   active   operator  admin',
          'RULE: an escalation path needs an ACTIVE account that can assume ADMIN.'] };
        return { r: 'usage', out: [`[ERR] nothing named "${p.args[0] || ''}" here. Try perms.`] };
      }
      if (!p.flags.via) return { r: 'usage', out: ['Usage: escalate --via <account>'] };
      const a = lc(p.flags.via);
      if (a === 'deploy') return { r: 'solved', out: ['[OK] deploy assumed role admin', '[OK] administrator access'] };
      if (['ghost', 'audit'].includes(a)) return { r: 'wrong', out: [`[DENIED] ${a} cannot authenticate.`] };
      if (a === 'backup') return { r: 'wrong', out: ['[DENIED] backup cannot assume admin.'] };
      return { r: 'wrong', out: [`[ERR] no account "${p.flags.via}".`] };
    }
  },
  {
    id: 5, title: 'Data Extraction',
    objective: 'Extract the classified file before SENTINEL closes in.',
    commands: ['scan', 'extract'],
    tick: true, // every information command raises alert: time pressure
    hints: ['The file name came from your decrypted output.', 'The vault key came from there too.', 'extract --file <name> --key <key>'],
    run(p) {
      if (p.cmd === 'scan') return { r: 'ok', out: [
        'report_q3.pdf', 'helix_notes.txt', 'PROJECT_HELIX.DAT  [CLASSIFIED]', 'SENTINEL trace: active'] };
      if (!p.flags.file || !p.flags.key) return { r: 'usage', out: ['Usage: extract --file <name> --key <key>'] };
      if (lc(p.flags.file) !== lc(TARGET_FILE)) return { r: 'wrong', out: ['[FAIL] not the target file.'] };
      if (lc(p.flags.key) !== lc(VAULT_KEY)) return { r: 'wrong', out: ['[FAIL] vault key rejected.'] };
      return { r: 'solved', out: ['[OK] PROJECT_HELIX.DAT streaming...', '[OK] 100%'] };
    }
  }
];

export { LEVELS, caesar, SHIFT, PLAIN, CIPHER, PASSPHRASE, VAULT_KEY, TARGET_FILE };
