import { app, BrowserWindow, dialog, ipcMain, protocol } from 'electron';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../dist/', import.meta.url));
protocol.registerSchemesAsPrivileged([{ scheme: 'revia', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
if (process.env.REVIA_USER_DATA) app.setPath('userData', process.env.REVIA_USER_DATA);
const dictionaries = JSON.parse(readFileSync(new URL('../dist/i18n.json', import.meta.url), 'utf8'));
let language = 'en', quitRequested = false;
app.on('before-quit', () => { quitRequested = true; });
if (!app.requestSingleInstanceLock()) app.quit();
else app.whenReady().then(async () => {
  const locale = app.getLocale().toLowerCase();
  language = locale.startsWith('zh') ? /hant|tw|hk|mo/.test(locale) ? 'zh-Hant' : 'zh-Hans' : locale.startsWith('ja') ? 'ja' : locale.startsWith('ko') ? 'ko' : 'en';
  protocol.handle('revia', async request => {
    const url = new URL(request.url), path = resolve(root, `.${decodeURIComponent(url.pathname)}`);
    if (url.host !== 'editor' || !path.startsWith(root.endsWith(sep) ? root : root + sep)) return new Response(null, { status: 403 });
    try {
      const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm' };
      return new Response(await readFile(path), { headers: { 'Content-Type': types[extname(path)] ?? 'application/octet-stream' } });
    } catch { return new Response(null, { status: 404 }); }
  });
  function createWindow() {
    const window = new BrowserWindow({ width: 1440, height: 960, minWidth: 760, minHeight: 650, title: 'Revia', backgroundColor: '#171a18', autoHideMenuBar: true, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false, preload: fileURLToPath(new URL('./preload.cjs', import.meta.url)) } });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    void window.loadURL('revia://editor/index.html');
    return window;
  }
  let window = createWindow();
  ipcMain.on('revia:locale', (_event, locale) => { if (Object.hasOwn(dictionaries, locale)) language = locale; });
  app.on('second-instance', () => { if (!window || window.isDestroyed()) window = createWindow(); else { window.restore(); window.focus(); } });
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) window = createWindow(); });
  app.on('window-all-closed', () => { if (quitRequested || process.platform !== 'darwin') app.quit(); });
  app.on('render-process-gone', (_event, _contents, details) => { if (details.reason !== 'clean-exit') dialog.showErrorBox('Revia', dictionaries[language].applicationCrashed); });
}).catch(error => { console.error(error); app.exit(1); });
