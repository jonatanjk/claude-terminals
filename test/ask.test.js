// Ask badges: a session raises an ask, the count and summary are stored and broadcast, typing in the tab clears it.
// Runs a throwaway daemon on a random port with its own data directory and home. Run with `npm test`.
const assert = require('assert');
const { spawn, spawnSync } = require('child_process'), fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const PORT = 47900 + Math.floor(Math.random() * 90);
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-ask-'));
const DATA = path.join(HOME, 'data');
const TAB = 'asktab1';
fs.mkdirSync(DATA);
// Seed one shell tab so the daemon restores it instead of starting a default `claude` tab.
fs.writeFileSync(path.join(DATA, 'state.json'), JSON.stringify({ order: [{ id: TAB, kind: 'bash', name: 'ask-test', color: 'red', cwd: HOME }] }));
// Relative on purpose: the daemon runs from HOME and must hand its tabs the absolute path.
const env = { ...process.env, HOME, USERPROFILE: HOME, CLAUDE_TERMINALS_PORT: String(PORT), CLAUDE_TERMINALS_DATA: 'data' };
delete env.CLAUDE_TERMINALS_ID;

const sleep = ms => new Promise(r => setTimeout(r, ms));
let daemon, log = '';
function startDaemon() {
  daemon = spawn(process.execPath, [path.join(ROOT, 'server.js')], { env, cwd: HOME, stdio: ['ignore', 'pipe', 'pipe'] });
  daemon.stdout.on('data', d => log += d); daemon.stderr.on('data', d => log += d);
}
async function stopDaemon() { const d = daemon; const gone = new Promise(r => d.once('exit', r)); d.kill(); await gone; }
const token = () => fs.readFileSync(path.join(DATA, 'token'), 'utf8').trim();
function api(method, p, body, tok = token()) {
  return new Promise((res, rej) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers: { 'x-token': tok, 'content-type': 'application/json' } }, x => {
      let b = ''; x.on('data', c => b += c); x.on('end', () => { let j; try { j = JSON.parse(b); } catch { j = { raw: b }; } res({ status: x.statusCode, body: j }); });
    });
    r.on('error', rej); if (body) r.write(JSON.stringify(body)); r.end();
  });
}
async function waitFor(fn, ms) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(150)) { try { const v = await fn(); if (v) return v; } catch {} }
  return null;
}
const tab = async () => (await api('GET', '/api/sessions')).body.find(s => s.id === TAB);
function connectWs() {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${token()}`);
    ws.last = null; ws.on('message', d => { const m = JSON.parse(d); if (m.t === 'sessions') ws.last = m.sessions; });
    ws.on('open', () => res(ws)); ws.on('error', rej);
  });
}
function ctAsk(args, extra = {}) {
  return spawnSync(process.execPath, [path.join(ROOT, 'bin', 'ct-ask'), ...args], { env: { ...env, CLAUDE_TERMINALS_DATA: DATA, ...extra }, encoding: 'utf8' });
}
function mcpCall(name, args, extra = {}) {
  return new Promise((res, rej) => {
    const p = spawn(process.execPath, [path.join(ROOT, 'mcp.js')], { env: { ...env, CLAUDE_TERMINALS_DATA: DATA, ...extra }, stdio: ['pipe', 'pipe', 'inherit'] });
    let out = '';
    p.stdout.on('data', d => {
      out += d;
      for (const line of out.split('\n')) { let m; try { m = JSON.parse(line); } catch { continue; } if (m.id === 2) { p.kill(); res(m.result); } }
    });
    p.on('error', rej);
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n');
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } }) + '\n');
  });
}

const steps = [];
const step = (name, fn) => steps.push([name, fn]);

step('wrong token is refused with 401', async () => {
  assert.strictEqual((await api('POST', '/api/ask', { session: TAB, summary: 'x' }, 'nope')).status, 401);
});
step('unknown session is 404', async () => {
  assert.strictEqual((await api('POST', '/api/ask', { session: 'nosuch', summary: 'x' })).status, 404);
  assert.strictEqual((await api('POST', '/api/ask/clear', { session: 'nosuch' })).status, 404);
});
step('missing or blank summary is 400', async () => {
  assert.strictEqual((await api('POST', '/api/ask', { session: TAB })).status, 400);
  assert.strictEqual((await api('POST', '/api/ask', { session: TAB, summary: '   ' })).status, 400);
  assert.strictEqual((await tab()).asks, 0);
});
let ws;
step('two asks give a count of 2 and keep the latest summary', async () => {
  ws = await connectWs();
  const a = await api('POST', '/api/ask', { session: TAB, summary: '  first ask  ' });
  assert.strictEqual(a.status, 200); assert.strictEqual(a.body.asks, 1); assert.strictEqual(a.body.ask_summary, 'first ask');
  const b = await api('POST', '/api/ask', { session: TAB, summary: 'Approve the deploy to prod? It needs your SSO.' });
  assert.strictEqual(b.body.asks, 2); assert.strictEqual(b.body.total, 2);
});
step('/api/sessions and the UI broadcast show the ask', async () => {
  const t = await tab();
  assert.strictEqual(t.asks, 2); assert.strictEqual(t.ask_summary, 'Approve the deploy to prod? It needs your SSO.');
  assert.ok(Date.now() - t.ask_at < 60000, 'ask_at is a recent timestamp');
  assert.ok(await waitFor(() => ws.last && ws.last.find(s => s.id === TAB).asks === 2, 3000), 'ws clients got the new count');
});
step('a long summary is cut to 200 characters', async () => {
  const r = await api('POST', '/api/ask', { session: TAB, summary: 'y'.repeat(500) });
  assert.ok(r.body.ask_summary.length <= 200, 'summary length ' + r.body.ask_summary.length);
  await api('POST', '/api/ask/clear', { session: TAB }); // back to the two-ask state for the next steps
  await api('POST', '/api/ask', { session: TAB, summary: 'first ask' });
  await api('POST', '/api/ask', { session: TAB, summary: 'Approve the deploy to prod? It needs your SSO.' });
});
step('output alone, API input and terminal reports do not clear it', async () => {
  ws.send(JSON.stringify({ t: 'attach', id: TAB }));
  await api('POST', '/api/input/' + TAB, { text: 'echo ASK_$((6*7))' }); // another session typing via the API is not the user
  assert.ok(await waitFor(async () => /ASK_42/.test((await api('GET', '/api/output/' + TAB + '?chars=20000')).body.output), 15000), 'shell produced output');
  ws.send(JSON.stringify({ t: 'input', id: TAB, d: '\x1b[I' })); // focus report: xterm sends it, the user did not type it
  await sleep(400);
  assert.strictEqual((await tab()).asks, 2);
});
step('tabs get the daemon\'s absolute data directory and port', async () => {
  await api('POST', '/api/input/' + TAB, { text: 'echo "DIR=[$CLAUDE_TERMINALS_DATA] PORT=[$CLAUDE_TERMINALS_PORT]"' });
  const want = `DIR=[${fs.realpathSync(DATA)}] PORT=[${PORT}]`, alt = `DIR=[${DATA}] PORT=[${PORT}]`;
  assert.ok(await waitFor(async () => { const o = (await api('GET', '/api/output/' + TAB + '?chars=20000')).body.output; return o.includes(want) || o.includes(alt); }, 10000),
    'tab env should carry ' + alt);
  assert.strictEqual((await tab()).asks, 2, 'API input did not clear asks');
});
step('typing into the tab over the ws clears it', async () => {
  ws.send(JSON.stringify({ t: 'input', id: TAB, d: 'l', user: true }));
  assert.ok(await waitFor(async () => (await tab()).asks === 0, 3000), 'asks reset after the user typed');
  assert.ok(await waitFor(() => ws.last.find(s => s.id === TAB).asks === 0, 3000), 'ws clients saw the reset');
  ws.send(JSON.stringify({ t: 'input', id: TAB, d: '\x7f', user: true }));
});
step('the clear route resets it', async () => {
  await api('POST', '/api/ask', { session: TAB, summary: 'again' });
  const r = await api('POST', '/api/ask/clear', { session: TAB });
  assert.strictEqual(r.status, 200); assert.strictEqual(r.body.asks, 0);
  assert.strictEqual((await tab()).asks, 0);
});
step('asks persist across a daemon restart', async () => {
  await api('POST', '/api/ask', { session: TAB, summary: 'survive a restart' });
  ws.close(); await stopDaemon(); startDaemon();
  const t = await waitFor(tab, 10000);
  assert.ok(t, 'daemon came back'); assert.strictEqual(t.asks, 1); assert.strictEqual(t.ask_summary, 'survive a restart');
  await api('POST', '/api/ask/clear', { session: TAB });
});
step('ct-ask raises and clears, and refuses outside a tab', async () => {
  let r = ctAsk(['Need your call on the schema'], { CLAUDE_TERMINALS_ID: TAB });
  assert.strictEqual(r.status, 0, r.stderr); assert.strictEqual(r.stdout.trim(), 'ask raised: 1 open');
  assert.ok(!r.stdout.includes(token()) && !r.stderr.includes(token()), 'token never printed');
  assert.strictEqual((await tab()).ask_summary, 'Need your call on the schema');
  r = ctAsk(['--clear'], { CLAUDE_TERMINALS_ID: TAB });
  assert.strictEqual(r.status, 0, r.stderr); assert.strictEqual((await tab()).asks, 0);
  r = ctAsk(['hello']);
  assert.notStrictEqual(r.status, 0); assert.match(r.stderr, /not inside a Claude Terminals tab/);
  r = ctAsk([], { CLAUDE_TERMINALS_ID: TAB });
  assert.notStrictEqual(r.status, 0); assert.match(r.stderr, /usage/i);
});
step('MCP ask_user raises an ask for the calling tab', async () => {
  const r = await mcpCall('ask_user', { summary: 'Pick a colour for the logo' }, { CLAUDE_TERMINALS_ID: TAB });
  assert.ok(!r.isError, JSON.stringify(r));
  const t = await tab(); assert.strictEqual(t.asks, 1); assert.strictEqual(t.ask_summary, 'Pick a colour for the logo');
  await api('POST', '/api/ask/clear', { session: TAB });
});

(async () => {
  let failed = 0;
  startDaemon();
  try {
    if (!await waitFor(tab, 10000)) throw new Error('daemon did not start or did not restore the seeded tab');
    for (const [name, fn] of steps) {
      try { await fn(); console.log('PASS: ' + name); }
      catch (e) { failed++; console.error('FAIL: ' + name + '\n  ' + e.message); }
    }
  } catch (e) { failed++; console.error('FAIL: ' + e.message + '\n--- daemon log ---\n' + log); }
  finally {
    try { ws && ws.close(); } catch {}
    await stopDaemon().catch(() => {});
    try { fs.rmSync(HOME, { recursive: true, force: true }); } catch {}
    console.log(failed ? `ask tests: ${failed} failed` : 'ask tests: all passed');
    process.exit(failed ? 1 : 0);
  }
})();
