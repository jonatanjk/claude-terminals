// Smoke test: start the daemon against a throwaway home directory, open a shell tab and check it runs commands.
// Works on Windows (Git Bash or PowerShell) and macOS/Linux ($SHELL). Run with `npm test`.
const { spawn } = require('child_process'), fs = require('fs'), os = require('os'), path = require('path'), http = require('http');

const { pickShell } = require('../shell');
const PORT = 47900 + Math.floor(Math.random() * 90);
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-smoke-'));
// Set the data directory explicitly: a tab exports its own daemon's CLAUDE_TERMINALS_DATA, which must not leak in here.
const env = { ...process.env, HOME, USERPROFILE: HOME, CLAUDE_TERMINALS_PORT: String(PORT), CLAUDE_TERMINALS_DATA: path.join(HOME, '.claude-terminals') };
// Arithmetic, so the echoed command line itself can't match CT_OK_42.
const PROBE = pickShell({ env }).flavour === 'powershell' ? 'echo ("CT_OK_" + 6*7)' : 'echo CT_OK_$((6*7))';
const daemon = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
daemon.stdout.on('data', d => log += d); daemon.stderr.on('data', d => log += d);

const sleep = ms => new Promise(r => setTimeout(r, ms));
function api(method, p, body) {
  const token = fs.readFileSync(path.join(HOME, '.claude-terminals', 'token'), 'utf8').trim();
  return new Promise((res, rej) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers: { 'x-token': token, 'content-type': 'application/json' } }, x => {
      let b = ''; x.on('data', c => b += c); x.on('end', () => { try { res(JSON.parse(b)); } catch { res({ raw: b }); } });
    });
    r.on('error', rej); if (body) r.write(JSON.stringify(body)); r.end();
  });
}
async function waitFor(fn, ms) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(250)) { try { const v = await fn(); if (v) return v; } catch {} }
  return null;
}

(async () => {
  let ok = false;
  try {
    if (!await waitFor(() => api('GET', '/api/sessions').then(Array.isArray), 10000)) throw new Error('daemon did not start');
    const tab = await api('POST', '/api/open', { kind: 'bash', name: 'smoke' });
    if (!tab.id) throw new Error('open failed: ' + JSON.stringify(tab));
    const marker = await waitFor(async () => {
      await api('POST', '/api/input/' + tab.id, { text: PROBE });
      await sleep(750);
      const { output = '' } = await api('GET', '/api/output/' + tab.id + '?chars=20000');
      return /CT_OK_42/.test(output);
    }, 15000);
    const [info] = (await api('GET', '/api/sessions')).filter(s => s.id === tab.id);
    if (!info || !info.alive) throw new Error('shell tab is not alive');
    if (!marker) throw new Error('shell did not run the command');
    ok = true;
    console.log('PASS: shell tab started and ran a command on ' + process.platform);
  } catch (e) {
    console.error('FAIL: ' + e.message + '\n--- daemon log ---\n' + log);
  } finally {
    daemon.kill();
    await sleep(500);
    try { fs.rmSync(HOME, { recursive: true, force: true }); } catch {}
    process.exit(ok ? 0 : 1);
  }
})();
