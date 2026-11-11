const { app, BrowserWindow, Menu, dialog, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const PRODUCT_NAME = '每日票价';
const flags = process.argv.slice(app.isPackaged ? 1 : 2);
const noWindow = flags.includes('--no-window');
const rootIndex = flags.indexOf('--data-root');
const defaultRoot = path.join(process.env.LOCALAPPDATA || app.getPath('appData'), 'XinlePriceDashboard');
const dataRoot = path.resolve(rootIndex >= 0 && flags[rootIndex + 1] ? flags[rootIndex + 1] : defaultRoot);
const sessionFile = path.join(dataRoot, 'session.json');
let window = null;
let server = null;
let localUrl = null;
let quitting = false;
let shutdownPromise = null;
let startupComplete = false;

// 继续沿用原 EXE 的账户与价格目录，Electron 的页面缓存另存。
fs.mkdirSync(dataRoot, { recursive: true });
app.setName(PRODUCT_NAME);
const electronProfile = path.join(dataRoot, 'electron-profile');
fs.mkdirSync(electronProfile, { recursive: true });
app.setPath('userData', electronProfile);
app.setAppUserModelId('link.xyj.xinle.price-dashboard');
app.commandLine.appendSwitch('no-proxy-server');

function log(message) {
  try { fs.appendFileSync(path.join(dataRoot, 'launcher.log'), `${new Date().toISOString()} ${message}\n`, 'utf8'); }
  catch { /* 日志不可写不影响清理子进程。 */ }
}

function deleteOwnSession() {
  try {
    const current = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    if (current.launcherPid === process.pid) fs.unlinkSync(sessionFile);
  } catch { /* 其他实例的会话文件不能删除。 */ }
}

function focusWindow() {
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

function stopServerTree() {
  const owned = server;
  if (!owned || !owned.pid || owned.exitCode !== null || owned.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      owned.once('exit', resolve);
      owned.kill('SIGTERM');
      setTimeout(() => { if (owned.exitCode === null) owned.kill('SIGKILL'); resolve(); }, 3000).unref();
      return;
    }
    // PID 来自本次 spawn 返回值；只结束本实例的服务及其采集浏览器。
    const taskkill = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
    const killer = spawn(taskkill, ['/PID', String(owned.pid), '/T', '/F'], {
      windowsHide: true, shell: false, stdio: 'ignore',
    });
    let settled = false;
    const finish = () => { if (!settled) { settled = true; clearTimeout(timer); resolve(); } };
    const timer = setTimeout(() => {
      try { owned.kill(); } catch { }
      finish();
    }, 8000);
    killer.once('close', finish);
    killer.once('error', () => { try { owned.kill(); } catch { } finish(); });
  });
}

function shutdown(exitCode = 0) {
  if (shutdownPromise) return shutdownPromise;
  quitting = true;
  shutdownPromise = stopServerTree().finally(() => {
    deleteOwnSession();
    app.exit(exitCode);
  });
  return shutdownPromise;
}

function fail(message) {
  if (quitting) return;
  log(message);
  if (!noWindow) dialog.showErrorBox(`${PRODUCT_NAME}无法启动`, message);
  void shutdown(1);
}

function runtimePaths() {
  const source = path.resolve(__dirname, '..');
  const runtimeDirectory = app.isPackaged ? path.join(process.resourcesPath, 'runtime') : source;
  const developmentRuntime = path.join(source, 'build', 'portable', 'staging');
  const nodePath = app.isPackaged
    ? path.join(runtimeDirectory, 'runtime', 'node.exe')
    : path.resolve(process.env.XINLE_NODE_PATH || process.env.npm_node_execpath || path.join(developmentRuntime, 'runtime', 'node.exe'));
  const browserPath = app.isPackaged
    ? path.join(runtimeDirectory, 'browser', 'chrome-win64', 'chrome.exe')
    : path.resolve(process.env.XINLE_BROWSER_PATH || path.join(developmentRuntime, 'browser', 'chrome-win64', 'chrome.exe'));
  for (const filename of [nodePath, browserPath, path.join(runtimeDirectory, 'server.ts')]) {
    if (!fs.existsSync(filename)) throw new Error('内置运行文件不完整，请重新下载完整 EXE 后再打开。');
  }
  return { runtimeDirectory, nodePath, browserPath, dataDirectory: path.join(dataRoot, 'data') };
}

function checkReady(url) {
  return new Promise((resolve, reject) => {
    // 原生 http 明确直连 loopback，不读取系统或环境代理配置。
    const request = http.get(url + '/', { timeout: 10_000, agent: false }, (response) => {
      response.resume();
      if (response.statusCode === 200) resolve();
      else reject(new Error('本地价格页面启动失败，请重新打开程序。'));
    });
    request.once('timeout', () => request.destroy(new Error('本地价格页面启动超时，请重新打开程序。')));
    request.once('error', () => reject(new Error('无法连接本地价格服务，请重新打开程序。')));
  });
}

function startServer(paths) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(paths.dataDirectory, { recursive: true });
    const environment = { ...process.env };
    for (const name of ['NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE', 'XINLE_USERNAME', 'XINLE_PASSWORD']) delete environment[name];
    Object.assign(environment, {
      XINLE_DATA_DIR: paths.dataDirectory,
      XINLE_BROWSER_PATH: paths.browserPath,
      PORT: '0',
    });
    server = spawn(paths.nodePath, ['server.ts'], {
      cwd: paths.runtimeDirectory, env: environment,
      windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let settled = false;
    let pending = '';
    const timeout = setTimeout(() => finish(new Error('本地价格服务启动超时，请重新打开程序。')), 45_000);
    const finish = (error, url) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error); else resolve(url);
    };
    server.stdout.setEncoding('utf8');
    server.stdout.on('data', (chunk) => {
      pending = (pending + chunk).slice(-8192);
      const match = pending.match(/价格看板已启动：(http:\/\/127\.0\.0\.1:(\d{1,5}))/);
      if (match && Number(match[2]) > 0 && Number(match[2]) <= 65535) finish(null, match[1]);
    });
    // 不把服务的原始输出写入桌面日志，避免将第三方响应或凭据带入日志。
    server.stderr.resume();
    server.once('error', () => finish(new Error('无法启动内置价格服务，请重新下载完整 EXE 后再打开。')));
    server.once('exit', (code) => {
      if (quitting) return;
      if (!settled) finish(new Error('本地价格服务启动失败，请重新打开程序。'));
      else if (startupComplete) {
        log(`本地价格服务已退出，退出码 ${code ?? 'unknown'}。`);
        if (!noWindow) dialog.showErrorBox(PRODUCT_NAME, '本地价格服务已停止，请重新打开程序。已保存的数据会保留。');
        void shutdown(code === 0 ? 0 : 1);
      }
    });
  });
}

async function createWindow(url) {
  const dashboardSession = session.fromPartition('persist:dashboard');
  await dashboardSession.setProxy({ mode: 'direct' });
  dashboardSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  dashboardSession.setPermissionCheckHandler(() => false);
  dashboardSession.webRequest.onBeforeRequest((details, callback) => {
    const allowed = details.url === 'about:blank' || details.url.startsWith(url + '/');
    callback({ cancel: !allowed });
  });
  window = new BrowserWindow({
    width: 1440, height: 960, minWidth: 760, minHeight: 540,
    title: PRODUCT_NAME, backgroundColor: '#f4f7f5', show: false,
    autoHideMenuBar: true,
    webPreferences: {
      session: dashboardSession,
      sandbox: true, contextIsolation: true, nodeIntegration: false,
      webSecurity: true, allowRunningInsecureContent: false,
      devTools: !app.isPackaged,
    },
  });
  window.setMenu(null);
  const sameOrigin = (target) => {
    try { return new URL(target).origin === url; } catch { return false; }
  };
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, target) => { if (!sameOrigin(target)) event.preventDefault(); });
  window.webContents.on('will-redirect', (event, target) => { if (!sameOrigin(target)) event.preventDefault(); });
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  window.webContents.once('render-process-gone', () => {
    if (!quitting) fail('价格页面意外关闭，请重新打开程序。已保存的数据会保留。');
  });
  window.once('ready-to-show', () => { if (!quitting) window.show(); });
  window.on('closed', () => { window = null; void shutdown(); });
  // Electron 自带下载保存对话框，导出仍由 /api/download 返回的文件名决定。
  dashboardSession.on('will-download', (_event, item) => {
    if (!sameOrigin(item.getURL())) { item.cancel(); return; }
    item.setSaveDialogOptions({ title: '导出价格 JSON', defaultPath: 'ticket-prices.json', filters: [{ name: 'JSON 数据', extensions: ['json'] }] });
  });
  await window.loadURL(url + '/');
}

if (!app.requestSingleInstanceLock({ dataRoot, noWindow })) {
  app.exit(0);
} else {
  app.on('second-instance', () => focusWindow());
  app.on('before-quit', (event) => {
    if (!quitting) { event.preventDefault(); void shutdown(); }
  });
  app.on('window-all-closed', () => { if (!noWindow) void shutdown(); });
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
  process.on('uncaughtException', () => fail('桌面程序遇到异常，请重新打开。已保存的数据会保留。'));
  process.on('unhandledRejection', () => fail('桌面程序遇到异常，请重新打开。已保存的数据会保留。'));
  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    const paths = runtimePaths();
    localUrl = await startServer(paths);
    await checkReady(localUrl);
    if (quitting) return;
    fs.writeFileSync(sessionFile, JSON.stringify({
      launcherPid: process.pid, serverPid: server.pid, url: localUrl,
      runtimeDirectory: paths.runtimeDirectory, dataDirectory: paths.dataDirectory,
      electronVersion: process.versions.electron,
    }, null, 2), 'utf8');
    startupComplete = true;
    log(`Electron ${process.versions.electron} 已启动本地价格看板。`);
    if (!noWindow) await createWindow(localUrl);
  }).catch((error) => fail(error.message || '桌面程序启动失败，请重新打开。'));
}
