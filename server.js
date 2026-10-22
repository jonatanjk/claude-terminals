// Claude Terminals daemon: owns the ptys, persists tab state, serves UI + API.
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');
const { WebSocketServer } = require('ws');
const pty = require('@homebridge/node-pty-prebuilt-multiarch');
const { pickShell, claudeCmd: buildClaudeCmd } = require('./shell');

const PORT = +process.env.CLAUDE_TERMINALS_PORT || 47821, HOST = '127.0.0.1';
// CLAUDE_TERMINALS_DATA lets a test daemon keep its own state.json and token away from the live one.
const DATA = path.resolve(process.env.CLAUDE_TERMINALS_DATA || path.join(os.homedir(), '.claude-terminals'));
fs.mkdirSync(DATA, { recursive: true });
const STATE = path.join(DATA, 'state.json'), TOKEN_FILE = path.join(DATA, 'token');
if (!fs.existsSync(TOKEN_FILE)) fs.writeFileSync(TOKEN_FILE, crypto.randomBytes(24).toString('hex'));
const TOKEN = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
const SHELL = pickShell();
const MAX_BUF = 400 * 1024;
const COLORS = ['red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'purple', 'pink', 'white'];

const sessions = new Map(); // id -> {meta, pty, buf, clients:Set}
function uniqueName(base) {
  const used = new Set([...sessions.values()].map(s => s.meta.name));
  for (let i = 1; ; i++) { const n = base + ' ' + i; if (!used.has(n)) return n; }
}
function leastUsedColor() {
  const n = Object.fromEntries(COLORS.map(c => [c, 0]));
  for (const s of sessions.values()) if (s.meta.color in n) n[s.meta.color]++;
  return COLORS.reduce((a, b) => (n[b] < n[a] ? b : a));
}

function save() {
  fs.writeFileSync(STATE, JSON.stringify({ order: [...sessions.values()].map(s => s.meta) }, null, 1));
}
function publicMeta(s) { return { ...s.meta, alive: !!s.pty, state: s.pty ? s.state || '' : '' }; }
function broadcast(msg) {
  const d = JSON.stringify(msg);
  for (const c of wss.clients) if (c.readyState === 1 && c.authed) c.send(d);
}
function listMeta() { return [...sessions.values()].map(publicMeta); }

// Claude Code sets the terminal title: a braille spinner glyph while working, a static glyph when waiting for input.
function trackState(s, d) {
  let t = null;
  for (const x of d.matchAll(/\x1b\][02];([^\x07\x1b]*)(?:\x07|\x1b\\)/g)) t = x[1];
  if (t === null) return;
  const st = t.startsWith('\u2733') ? 'idle' : /^[\u25d0-\u25d3\u2800-\u28ff\u280b]/.test(t) ? 'busy' : null;
  if (!st) { if (s.state) { s.state = ''; broadcast({ t: 'sessions', sessions: listMeta() }); } return; }
  s.title = t;
  if (st !== s.state) { s.state = st; broadcast({ t: 'sessions', sessions: listMeta() }); }
}

function startPty(s, startup) {
  const m = s.meta;
  const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', CLAUDE_TERMINALS: '1', CLAUDE_TERMINALS_ID: m.id,
    CLAUDE_TERMINALS_PORT: String(PORT), CLAUDE_TERMINALS_DATA: DATA }; // so ct-ask / mcp.js in the tab reach this daemon
  for (const k of Object.keys(env)) if (/^(CLAUDECODE|CLAUDE_CODE_|CLAUDE_AGENT|MCP_)/.test(k) && k !== 'CLAUDE_CODE_GIT_BASH_PATH') delete env[k];
  env.CLAUDE_CODE_FORCE_SESSION_PERSISTENCE = '1';
  const p = pty.spawn(SHELL.file, SHELL.args, { name: 'xterm-256color', cwd: m.cwd, cols: s.cols, rows: s.rows, env });
  s.pty = p;
  p.onData(d => {
    if (m.kind === 'claude') trackState(s, d);
    s.buf += d; if (s.buf.length > MAX_BUF) s.buf = s.buf.slice(-MAX_BUF);
    for (const c of s.clients) if (c.readyState === 1) c.send(JSON.stringify({ t: 'data', id: m.id, d }));
  });
  p.onExit(() => {
    if (s.pty !== p) return;
    s.pty = null;
    broadcast({ t: 'sessions', sessions: listMeta() });
  });
  if (startup) setTimeout(() => { if (s.pty === p) p.write(startup + '\r'); }, 1500);
}

const claudeCmd = (m, resume) => buildClaudeCmd(m, resume, SHELL.flavour);

// ---- past Claude sessions (for resume) ----
const PROJECTS = path.join(os.homedir(), '.claude', 'projects');
function sessionInfo(file) {
  try {
    const st = fs.statSync(file);
    const fd = fs.openSync(file, 'r'); const b = Buffer.alloc(Math.min(st.size, 262144)); fs.readSync(fd, b, 0, b.length, 0); fs.closeSync(fd);
    let cwd, title = '';
    for (const line of b.toString('utf8').split(/\r?\n/)) {
      let d; try { d = JSON.parse(line); } catch { continue; }
      if (!cwd && d.cwd) cwd = d.cwd;
      if (!title && d.type === 'user' && !d.isMeta) {
        const c = d.message && d.message.content;
        const t = typeof c === 'string' ? c : Array.isArray(c) ? c.filter(x => x.type === 'text').map(x => x.text).join(' ') : '';
        if (t && !t.startsWith('<')) title = t.replace(/\s+/g, ' ').slice(0, 90);
      }
      if (cwd && title) break;
    }
    return { id: path.basename(file, '.jsonl'), cwd, title, mtime: st.mtimeMs };
  } catch { return null; }
}
function history(limit = 30) {
  const out = [];
  try {
    for (const dir of fs.readdirSync(PROJECTS)) {
      const d = path.join(PROJECTS, dir);
      let files; try { files = fs.readdirSync(d).filter(f => f.endsWith('.jsonl')); } catch { continue; }
      for (const f of files) { try { out.push({ file: path.join(d, f), mtime: fs.statSync(path.join(d, f)).mtimeMs }); } catch {} }
    }
  } catch {}
  out.sort((a, b) => b.mtime - a.mtime);
  return out.slice(0, limit).map(o => sessionInfo(o.file)).filter(Boolean);
}
function findSession(id) {
  try {
    for (const dir of fs.readdirSync(PROJECTS)) {
      const f = path.join(PROJECTS, dir, id + '.jsonl');
      if (fs.existsSync(f)) return sessionInfo(f);
    }
  } catch {}
  return null;
}

// restoring: tab came from state.json; resume claude if it was ever launched
function create(o = {}, restoring = false) {
  const id = o.id || crypto.randomUUID().slice(0, 8);
  const kind = o.kind || 'claude';
  if (kind === 'claude' && o.resumeId && !restoring) {
    const info = findSession(o.resumeId);
    if (info) { if (!o.cwd && info.cwd) o.cwd = info.cwd; if (!o.name && info.title) o.name = info.title.slice(0, 28); }
  }
  const meta = {
    id, kind,
    name: o.name || uniqueName(kind === 'claude' ? 'Claude' : 'bash'),
    color: o.color || leastUsedColor(),
    cwd: (o.cwd || os.homedir()).replace(/\\/g, '/'),
    claudeSessionId: kind === 'claude' ? (o.resumeId || o.claudeSessionId || crypto.randomUUID()) : undefined,
    args: o.args,
    asks: 0, ask_summary: '', ask_at: 0,
    // asklist: the open questions, newest last: {id, text, at}
    asklist: Array.isArray(o.asklist) ? o.asklist : (+o.asks > 0 ? [{ id: crypto.randomUUID().slice(0, 8), text: o.ask_summary || 'Needs you', at: o.ask_at || Date.now() }] : []),
  };
  recount(meta);
  let startup;
  if (kind === 'claude') {
    startup = claudeCmd({ ...meta, prompt: restoring ? undefined : o.prompt }, restoring || !!o.resumeId);
  } else if (o.command && !restoring) startup = o.command;
  const s = { meta, pty: null, buf: '', clients: new Set(), cols: 120, rows: 30 };
  sessions.set(id, s);
  startPty(s, startup);
  save();
  broadcast({ t: 'sessions', sessions: listMeta() });
  return s;
}

function kill(id) {
  const s = sessions.get(id); if (!s) return false;
  const p = s.pty; s.pty = null;
  try { p && p.kill(); } catch {}
  sessions.delete(id); save();
  broadcast({ t: 'sessions', sessions: listMeta() });
  return true;
}
function patch(id, o) {
  const s = sessions.get(id); if (!s) return null;
  if (typeof o.name === 'string' && o.name.trim()) s.meta.name = o.name.trim();
  if (o.color) s.meta.color = o.color;
  save(); broadcast({ t: 'sessions', sessions: listMeta() });
  return s;
}
function reorder(ids) {
  const next = new Map();
  for (const id of ids) if (sessions.has(id)) next.set(id, sessions.get(id));
  for (const [id, s] of sessions) if (!next.has(id)) next.set(id, s);
  sessions.clear(); for (const [k, v] of next) sessions.set(k, v);
  save(); broadcast({ t: 'sessions', sessions: listMeta() });
}
function restart(s) {
  const p = s.pty; s.pty = null;
  try { p && p.kill(); } catch {}
  s.buf = '';
  for (const c of s.clients) if (c.readyState === 1) c.send(JSON.stringify({ t: 'replay', id: s.meta.id, d: '' }));
  setTimeout(() => {
    startPty(s, s.meta.kind === 'claude' ? claudeCmd(s.meta, true) : undefined);
    broadcast({ t: 'sessions', sessions: listMeta() });
  }, 300);
}
// ---- asks: a session raises a question for its user. Each open ask is a card in the tab's dock (read-only) and adds to
// the tab's red count. The user answers in the session itself: sending a message in the tab clears its asks, or Dismiss a card. ----
const ASK_MAX = 200, ASK_TEXT_MAX = 2000;
const totalAsks = () => [...sessions.values()].reduce((n, s) => n + (s.meta.asks || 0), 0);
const oneLine = t => { t = t.replace(/\s+/g, ' ').trim(); return t.length > ASK_MAX ? t.slice(0, ASK_MAX - 1) + '\u2026' : t; };
function recount(m) { // keep the summary fields (asks, ask_summary, ask_at) in step with the list
  const l = m.asklist, last = l[l.length - 1];
  m.asks = l.length; m.ask_summary = last ? oneLine(last.text) : ''; m.ask_at = last ? last.at : 0;
}
const changed = s => { recount(s.meta); save(); broadcast({ t: 'sessions', sessions: listMeta() }); };
function raiseAsk(s, text) {
  const a = { id: crypto.randomUUID().slice(0, 8), text: text.trim().slice(0, ASK_TEXT_MAX), at: Date.now() };
  s.meta.asklist.push(a); changed(s); return a;
}
function removeAsk(s, id) {
  const i = s.meta.asklist.findIndex(a => a.id === id); if (i < 0) return false;
  s.meta.asklist.splice(i, 1); changed(s); return true;
}
function clearAsks(s) {
  if (!s.meta.asklist.length) return;
  s.meta.asklist = []; changed(s);
}
// Enter sends \r. Shift+Enter (\x1b\r) is a newline in the prompt, and a newline inside a bracketed paste is pasted text.
const PASTE = /\x1b\[200~[\s\S]*?(?:\x1b\[201~|$)/g;
const isSubmit = d => /(?:^|[^\x1b])\r/.test(String(d).replace(PASTE, ''));
const askReply = (s, a) => ({ session: s.meta.id, ...(a ? { id: a.id } : {}), asks: s.meta.asks, ask_summary: s.meta.ask_summary, ask_at: s.meta.ask_at, total: totalAsks() });

const ANSI = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[()][A-Za-z0-9]/g;
const strip = s => s.replace(ANSI, '');

// ---------- HTTP ----------
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.ttf': 'font/ttf', '.png': 'image/png' };
const NM = path.join(__dirname, 'node_modules');
const ASSETS = {
  '/xterm.js': path.join(NM, '@xterm/xterm/lib/xterm.js'),
  '/xterm.css': path.join(NM, '@xterm/xterm/css/xterm.css'),
  '/addon-fit.js': path.join(NM, '@xterm/addon-fit/lib/addon-fit.js'),
  '/addon-webgl.js': path.join(NM, '@xterm/addon-webgl/lib/addon-webgl.js'),
};
const authed = (req, u) => req.headers['x-token'] === TOKEN || u.searchParams.get('token') === TOKEN;
function body(req) { return new Promise(r => { let b = ''; req.on('data', d => b += d); req.on('end', () => { try { r(JSON.parse(b || '{}')); } catch { r({}); } }); }); }
const json = (res, code, o) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://' + HOST);
  if (req.headers.host && !/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host)) return json(res, 403, { error: 'host' });
  const p = u.pathname;
  if (p === '/' || p === '/index.html') {
    const html = fs.readFileSync(path.join(__dirname, 'ui/index.html'), 'utf8').replace('__TOKEN__', TOKEN)
      .replace("'__PLATFORM__'", JSON.stringify(process.platform)).replace("'__HOME__'", JSON.stringify(os.homedir().replace(/\\/g, '/')))
      .replace("'__SHELL_LABEL__'", JSON.stringify(SHELL.label));
    res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' }); return res.end(html);
  }
  if (ASSETS[p]) { res.writeHead(200, { 'content-type': MIME[path.extname(p)] }); return fs.createReadStream(ASSETS[p]).pipe(res); }
  if (p.startsWith('/ui/')) {
    const f = path.join(__dirname, p);
    if (!f.startsWith(path.join(__dirname, 'ui')) || !fs.existsSync(f)) return json(res, 404, {});
    res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' });
    return fs.createReadStream(f).pipe(res);
  }
  if (!p.startsWith('/api/')) return json(res, 404, {});
  if (!authed(req, u)) return json(res, 401, { error: 'bad token' });
  try {
    const b = req.method === 'POST' ? await body(req) : {};
    if (p === '/api/sessions') return json(res, 200, listMeta());
    if (p === '/api/history') return json(res, 200, history(+u.searchParams.get('limit') || 30));
    if (p === '/api/open') return json(res, 200, publicMeta(create(b)));
    if (p === '/api/ask' || p === '/api/ask/clear' || p === '/api/ask/dismiss') {
      if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
      const s = sessions.get(String(b.session || ''));
      if (!s) return json(res, 404, { error: 'no such session' });
      if (p === '/api/ask/clear') { clearAsks(s); return json(res, 200, askReply(s)); }
      if (p === '/api/ask/dismiss') { if (!removeAsk(s, String(b.id || ''))) return json(res, 404, { error: 'no such ask' }); return json(res, 200, askReply(s)); }
      if (typeof b.summary !== 'string' || !b.summary.trim()) return json(res, 400, { error: 'summary (what you need and why) is required' });
      return json(res, 200, askReply(s, raiseAsk(s, b.summary)));
    }
    const m = p.match(/^\/api\/(close|rename|input|output|restart)\/([\w-]+)$/);
    if (m) {
      const [, act, id] = m; const s = sessions.get(id);
      if (!s) return json(res, 404, { error: 'no such session' });
      if (act === 'close') return json(res, 200, { ok: kill(id) });
      if (act === 'rename') { patch(id, b); return json(res, 200, publicMeta(s)); }
      if (act === 'restart') { restart(s); return json(res, 200, { ok: true }); }
      if (act === 'input') {
        if (!s.pty) return json(res, 409, { error: 'session not running' });
        s.pty.write(String(b.text || '')); if (b.enter !== false) setTimeout(() => s.pty && s.pty.write('\r'), 150);
        return json(res, 200, { ok: true });
      }
      if (act === 'output') { const n = +u.searchParams.get('chars') || 4000; return json(res, 200, { output: strip(s.buf).replace(/\r/g, '').slice(-n) }); }
    }
    json(res, 404, { error: 'unknown' });
  } catch (e) { json(res, 500, { error: String(e) }); }
});

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, sock, head) => {
  const u = new URL(req.url, 'http://' + HOST);
  const o = req.headers.origin;
  const okOrigin = !o || o === `http://${HOST}:${PORT}` || o === `http://localhost:${PORT}`;
  if (u.pathname !== '/ws' || !okOrigin || u.searchParams.get('token') !== TOKEN) { sock.destroy(); return; }
  wss.handleUpgrade(req, sock, head, ws => { ws.authed = true; wss.emit('connection', ws); });
});
wss.on('connection', ws => {
  ws.send(JSON.stringify({ t: 'sessions', sessions: listMeta() }));
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    const s = m.id && sessions.get(m.id);
    switch (m.t) {
      case 'attach': if (s) { s.clients.add(ws); ws.send(JSON.stringify({ t: 'replay', id: s.meta.id, d: s.buf })); } break;
      case 'dbg': fs.appendFileSync(path.join(DATA,'dbg.log'), JSON.stringify(m) + String.fromCharCode(10)); break;
      case 'detach': if (s) s.clients.delete(ws); break;
      // user: the UI saw a keystroke or paste in the focused tab; terminal reports and API input from other sessions carry
      // no flag. Only the user sending a message (Enter) clears the asks, not every keystroke while they type it.
      case 'input': if (s && s.pty) { s.pty.write(m.d); if (m.user && isSubmit(m.d)) clearAsks(s); } break;
      case 'askDismiss': if (s) removeAsk(s, String(m.askId || '')); break;
      case 'resize': if (s && s.pty && m.cols > 1 && m.rows > 1) { s.cols = m.cols; s.rows = m.rows; try { s.pty.resize(m.cols, m.rows); } catch {} } break;
      case 'create': create(m.opts || {}); break;
      case 'close': kill(m.id); break;
      case 'patch': patch(m.id, m); break;
      case 'reorder': reorder(m.ids); break;
      case 'restart': if (s) restart(s); break;
    }
  });
  ws.on('close', () => { for (const s of sessions.values()) s.clients.delete(ws); });
});

// restore persisted tabs
try {
  const st = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  for (const m of st.order || []) create(m, true);
} catch {}
if (!sessions.size) create({ name: 'Claude', kind: 'claude', color: 'orange' });
server.listen(PORT, HOST, () => console.log('claude-terminals on http://' + HOST + ':' + PORT));
server.on('error', e => { console.error(e.message); process.exit(1); });
