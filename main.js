const { app, BrowserWindow, Menu, shell } = require('electron');
const path = require('path'), http = require('http'), { spawn } = require('child_process');
const URL_ = 'http://127.0.0.1:' + (process.env.CLAUDE_TERMINALS_PORT || 47821) + '/';
function up() { return new Promise(r => { const q = http.get(URL_ + 'xterm.css', x => { x.resume(); r(true); }); q.on('error', () => r(false)); q.setTimeout(800, () => { q.destroy(); r(false); }); }); }
async function ensureDaemon() {
  if (await up()) return;
  const c = spawn('node', [path.join(__dirname, 'server.js')], { cwd: __dirname, detached: true, stdio: 'ignore', windowsHide: true, shell: false });
  c.unref();
  for (let i = 0; i < 40 && !(await up()); i++) await new Promise(r => setTimeout(r, 250));
}
if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => { const w = BrowserWindow.getAllWindows()[0]; if (w) { if (w.isMinimized()) w.restore(); w.focus(); } });
app.whenReady().then(async () => {
  await ensureDaemon();
  Menu.setApplicationMenu(null);
  const w = new BrowserWindow({ width: 1400, height: 800, backgroundColor: '#181818', title: 'Claude Terminals', autoHideMenuBar: true,
    titleBarStyle: 'hidden', titleBarOverlay: { color: "#181818", symbolColor: "#cccccc", height: 35 } });
  w.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  w.maximize();
  w.loadURL(URL_);
  w.webContents.on('before-input-event', (e, i) => { if (i.type === 'keyDown' && i.control && i.shift && i.key.toLowerCase() === 'r') w.webContents.reloadIgnoringCache(); if (i.control && i.shift && i.key.toLowerCase() === 'i') w.webContents.toggleDevTools(); });
});
app.on('window-all-closed', () => app.quit()); // daemon keeps sessions alive
