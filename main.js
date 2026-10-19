const { app, BrowserWindow, Menu, shell, ipcMain, nativeImage } = require('electron');
const path = require('path'), http = require('http'), { spawn } = require('child_process');
const IS_MAC = process.platform === 'darwin';
const URL_ = 'http://127.0.0.1:' + (process.env.CLAUDE_TERMINALS_PORT || 47821) + '/';
function up() { return new Promise(r => { const q = http.get(URL_ + 'xterm.css', x => { x.resume(); r(true); }); q.on('error', () => r(false)); q.setTimeout(800, () => { q.destroy(); r(false); }); }); }
async function ensureDaemon() {
  if (await up()) return;
  const c = spawn('node', [path.join(__dirname, 'server.js')], { cwd: __dirname, detached: true, stdio: 'ignore', windowsHide: true, shell: false });
  c.unref();
  for (let i = 0; i < 40 && !(await up()); i++) await new Promise(r => setTimeout(r, 250));
}
// A window pointed at a test daemon (CLAUDE_TERMINALS_DATA) gets its own profile, so its single-instance lock
// does not hand off to, or block, the live app.
if (process.env.CLAUDE_TERMINALS_DATA) app.setPath('userData', path.join(process.env.CLAUDE_TERMINALS_DATA, 'electron'));
if (!app.requestSingleInstanceLock()) app.quit();
// Total open asks from the UI -> Dock badge (macOS), badge count (Linux), taskbar overlay icon (Windows).
ipcMain.on('ct-badge', (e, n, overlay) => {
  n = Math.max(0, Math.floor(+n || 0));
  if (IS_MAC) app.dock.setBadge(n ? String(n) : '');
  else app.setBadgeCount(n);
  const w = BrowserWindow.fromWebContents(e.sender);
  if (process.platform === 'win32' && w) w.setOverlayIcon(n && overlay ? nativeImage.createFromDataURL(overlay) : null, n ? n + ' waiting for you' : '');
  if (process.env.CLAUDE_TERMINALS_BADGE_LOG) console.log('ct-badge ' + n + ' -> ' + JSON.stringify(IS_MAC ? app.dock.getBadge() : app.getBadgeCount()));
});
app.on('second-instance', () => { const w = BrowserWindow.getAllWindows()[0]; if (w) { if (w.isMinimized()) w.restore(); w.focus(); } });
app.whenReady().then(async () => {
  await ensureDaemon();
  // macOS needs an app menu for Cmd+C/V/A/Q to work; Windows runs menu-less.
  Menu.setApplicationMenu(IS_MAC ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]) : null);
  const frame = IS_MAC ? { titleBarStyle: 'hidden', trafficLightPosition: { x: 12, y: 11 } }
    : { titleBarStyle: 'hidden', titleBarOverlay: { color: "#181818", symbolColor: "#cccccc", height: 35 } };
  const w = new BrowserWindow({ width: 1400, height: 800, backgroundColor: '#181818', title: 'Claude Terminals', autoHideMenuBar: true, ...frame,
    webPreferences: { preload: path.join(__dirname, 'preload.js') } });
  w.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  w.maximize();
  w.loadURL(URL_);
  w.webContents.on('before-input-event', (e, i) => {
    const mod = IS_MAC ? i.meta : i.control; // Ctrl+Shift+R/I on Windows, Cmd+Shift+R/I on macOS
    if (i.type === 'keyDown' && mod && i.shift && i.key.toLowerCase() === 'r') w.webContents.reloadIgnoringCache();
    if (mod && i.shift && i.key.toLowerCase() === 'i') w.webContents.toggleDevTools();
  });
});
app.on('window-all-closed', () => app.quit()); // daemon keeps sessions alive
