// Minimal stdio MCP server letting Claude manage Claude Terminals tabs via the daemon's HTTP API.
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), { spawn } = require('child_process');
const DATA = path.resolve(process.env.CLAUDE_TERMINALS_DATA || path.join(os.homedir(), '.claude-terminals'));
const TOKEN = fs.readFileSync(path.join(DATA, 'token'), 'utf8').trim();
function api(method, p, body) {
  return new Promise((res, rej) => {
    const d = body ? JSON.stringify(body) : null;
    const r = http.request({ host: '127.0.0.1', port: +process.env.CLAUDE_TERMINALS_PORT || 47821, path: p, method, headers: { 'x-token': TOKEN, 'content-type': 'application/json' } }, x => {
      let b = ''; x.on('data', c => b += c); x.on('end', () => { try { res(JSON.parse(b)); } catch { res({ raw: b }); } });
    });
    r.on('error', rej); if (d) r.write(d); r.end();
  });
}
const S = (props, req = []) => ({ type: 'object', properties: props, required: req });
const str = d => ({ type: 'string', description: d });
const TOOLS = [
  ['list_sessions', 'List all Claude Terminals tabs (id, name, color, cwd, claudeSessionId, alive).', S({}),
    () => api('GET', '/api/sessions')],
  ['open_session', 'Open a new tab. kind=claude starts Claude Code (optionally resuming resumeId and/or with a first prompt); kind=bash opens a plain shell tab: Git Bash or PowerShell on Windows, the login shell on macOS/Linux (optional command).',
    S({ name: str('Tab name'), color: str('red|orange|yellow|green|cyan|blue|purple|pink|white'), cwd: str('Working directory, e.g. C:/projects/app or ~/projects/app'), kind: str('claude (default) or bash'),
      resumeId: str('Existing Claude session id to resume'), prompt: str('First prompt for a new claude session'), command: str('Startup command (bash kind)') }),
    a => api('POST', '/api/open', a)],
  ['close_session', 'Close (kill) a tab by id. The Claude conversation itself stays resumable via its claudeSessionId.', S({ id: str('tab id') }, ['id']),
    a => api('POST', '/api/close/' + a.id, {})],
  ['rename_session', 'Rename and/or recolour a tab.', S({ id: str('tab id'), name: str('new name'), color: str('new color') }, ['id']),
    a => api('POST', '/api/rename/' + a.id, a)],
  ['send_input', 'Type text into a tab (Enter pressed after unless enter=false). Use this to give another Claude session a prompt.',
    S({ id: str('tab id'), text: str('text to type'), enter: { type: 'boolean' } }, ['id', 'text']),
    a => api('POST', '/api/input/' + a.id, { text: a.text, enter: a.enter })],
  ['read_output', 'Read the recent terminal output of a tab (ANSI stripped).', S({ id: str('tab id'), chars: { type: 'number', description: 'max chars, default 4000' } }, ['id']),
    a => api('GET', `/api/output/${a.id}?chars=${a.chars || 4000}`)],
  ['ask_user', 'Ask the human a question. It appears as a card at the bottom of this tab in Claude Terminals (full text) and puts a red count on the tab and the Dock/taskbar icon. Use it whenever you need input, a decision or an approval, then wait: the user answers in this session\'s chat, and sending their message clears the ask.',
    S({ summary: str('The question: what you need from the user and why. Up to ~2000 characters; make it self-contained'), session: str('Tab id; defaults to the tab this MCP server runs in ($CLAUDE_TERMINALS_ID)') }, ['summary']),
    a => {
      const session = a.session || process.env.CLAUDE_TERMINALS_ID;
      if (!session) return Promise.resolve({ error: 'not inside a Claude Terminals tab; pass session (a tab id from list_sessions)' });
      return api('POST', '/api/ask', { session, summary: a.summary });
    }],
  ['restart_session', 'Restart a tab\'s shell (claude tabs resume their conversation).', S({ id: str('tab id') }, ['id']),
    a => api('POST', '/api/restart/' + a.id, {})],
];
function reply(id, result, error) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, ...(error ? { error } : { result }) }) + '\n'); }
let buf = '';
process.stdin.on('data', c => {
  buf += c; let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!line) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    handle(m);
  }
});
async function handle(m) {
  if (m.method === 'initialize') return reply(m.id, { protocolVersion: m.params?.protocolVersion || '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'claude-terminals', version: '1.0.0' } });
  if (m.method === 'tools/list') return reply(m.id, { tools: TOOLS.map(([name, description, inputSchema]) => ({ name, description, inputSchema })) });
  if (m.method === 'tools/call') {
    const t = TOOLS.find(x => x[0] === m.params.name);
    if (!t) return reply(m.id, null, { code: -32602, message: 'unknown tool' });
    try { const r = await t[3](m.params.arguments || {}); reply(m.id, { ...(r && r.error ? { isError: true } : {}), content: [{ type: 'text', text: JSON.stringify(r, null, 1) }] }); }
    catch (e) { reply(m.id, { isError: true, content: [{ type: 'text', text: 'Claude Terminals daemon not reachable (' + e.message + '). Start the app first.' }] }); }
    return;
  }
  if (m.id !== undefined) reply(m.id, {});
}
