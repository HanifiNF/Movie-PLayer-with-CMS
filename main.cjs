'use strict';

const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, shell, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { io } = require('socket.io-client');
const { VlcController } = require('./vlcController.cjs');
const { Scheduler } = require('./scheduler.cjs');
const CFG = require('./config.cjs');

const DATA_DIR = app.getPath('userData');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const CACHE_PATH = path.join(DATA_DIR, 'schedules.json');

let tray = null;
let loginWin = null;
let dashboardWin = null;
let socket = null;
let vlc = null;
let scheduler = null;
let cfg = null;
let connecting = false;
let statusLabel = 'offline';
let nowSchedule = null;
let broadcastHandle = null;
let secondDisplay = null;

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function writeJson(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('writeJson failed', file, e);
  }
}

function saveConfig(c, persist = true) {
  cfg = c;
  if (!persist) return;
  if (c) writeJson(CONFIG_PATH, c);
  else if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH);
}

function makeFallbackIcon() {
  // 16x16 raw BGRA bitmap so Windows taskbar tray shows a visible icon.
  const W = 16, H = 16;
  const buf = Buffer.alloc(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    buf[i * 4 + 0] = 0xf8; // B
    buf[i * 4 + 1] = 0x5d; // G
    buf[i * 4 + 2] = 0x38; // R
    buf[i * 4 + 3] = 0xff; // A
  }
  return nativeImage.createFromBitmap(buf, { width: W, height: H });
}

function getTrayIcon() {
  const p = path.join(__dirname, 'assets', 'tray.png');
  if (fs.existsSync(p)) {
    const img = nativeImage.createFromPath(p);
    if (!img.isEmpty()) return img;
  }
  return makeFallbackIcon();
}

function buildTrayMenu() {
  const next = nowSchedule
    ? `Now: ${nowSchedule.title || nowSchedule.id}`
    : (statusLabel === 'online' ? 'Idle (no active schedule)' : (statusLabel && statusLabel.indexOf('test-mode') === 0 ? 'Test Mode — idle' : 'Offline'));
  const items = [
    { label: `Status: ${statusLabel.toUpperCase()}`, enabled: false },
    { label: `Device: ${cfg && cfg.deviceId || '-'}`, enabled: false },
    { label: next, enabled: false }
  ];
  if (statusLabel === 'vlc-error') {
    items.push({ label: 'VLC not found — drop vlc.exe in vlc-portable/', enabled: false });
  }
  items.push({ type: 'separator' });
  items.push({ label: 'Show Dashboard', click: () => showDashboard() });
  items.push({ label: 'Reconnect', click: () => { if (socket) socket.connect(); } });
  items.push({
    label: 'Retry VLC',
    click: async () => {
        try {
            await vlc.start();
        } catch (e) {
            console.error("VLC start failed", e);
            setStatus("vlc-error");
        }
    }
});
  items.push({ label: 'Open Config Folder', click: () => { shell.openPath(DATA_DIR); } });
  items.push({ label: 'Logout', click: () => logout() });
  items.push({ type: 'separator' });
  items.push({ label: 'Quit Player', click: () => quitApp() });
  return Menu.buildFromTemplate(items);
}

function refreshTray() {
  if (!tray) return;
  tray.setToolTip(`Player — ${statusLabel.toUpperCase()} | ${cfg && cfg.deviceId || ''}`);
  tray.setContextMenu(buildTrayMenu());
}

function setStatus(s) {
  statusLabel = s;
  refreshTray();
  if (loginWin && !loginWin.isDestroyed()) {
    loginWin.webContents.send('status', s);
  }
  pushDashboard();
}

function createLoginWindow() {
  if (dashboardWin && !dashboardWin.isDestroyed()) {
    dashboardWin.destroy();
    dashboardWin = null;
  }
  if (loginWin && !loginWin.isDestroyed()) {
    loginWin.show();
    return;
  }
  loginWin = new BrowserWindow({
    width: 420,
    height: 560,
    resizable: false,
    minimizable: true,
    maximizable: false,
    title: 'Player — Login',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: true
    }
  });
  loginWin.removeMenu();
  loginWin.loadFile(path.join(__dirname, 'login.html'));
  loginWin.on('close', (e) => {
    if (cfg && cfg.token) {
      e.preventDefault();
      loginWin.hide();
    }
  });
}

function createDashboardWindow() {
  if (loginWin && !loginWin.isDestroyed()) {
    loginWin.destroy();
    loginWin = null;
  }
  if (dashboardWin && !dashboardWin.isDestroyed()) {
    dashboardWin.show();
    return;
  }
  dashboardWin = new BrowserWindow({
    width: 920,
    height: 620,
    minWidth: 720,
    minHeight: 480,
    title: 'Player — Dashboard',
    autoHideMenuBar: true,
    background: '#0b1220',
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: true
    }
  });
  dashboardWin.removeMenu();
  dashboardWin.loadFile(path.join(__dirname, 'dashboard.html'));
  dashboardWin.on('close', (e) => {
    if (!app.isQuiting) {
        e.preventDefault();
        dashboardWin.hide();
    }
  });
  dashboardWin.on('minimize', () => {
    //e.preventDefault();
    //dashboardWin.hide();
  });
  startBroadcastLoop();
}

function showDashboard() {
  if (dashboardWin && !dashboardWin.isDestroyed()) {
    dashboardWin.show();
    dashboardWin.focus();
  }
}

function appendVlcLog(line) {
  try {
    const logPath = path.join(DATA_DIR, 'vlc-stderr.log');
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(logPath, line + '\n');
    const stats = fs.statSync(logPath);
    if (stats.size > 200 * 1024) {
      const content = fs.readFileSync(logPath, 'utf8');
      const lines = content.split(/\r?\n/).slice(-200);
      fs.writeFileSync(logPath, lines.join('\n') + '\n');
    }
  } catch (e) {
    console.error('appendVlcLog failed', e);
  }
}

function pushDashboard() {
  if (!dashboardWin || dashboardWin.isDestroyed() || !dashboardWin.webContents) return;
  const now = scheduler ? scheduler.getNow() : null;
  const upcoming = scheduler ? scheduler.getUpcoming(6) : [];
  const payload = {
    status: statusLabel,
    deviceId: cfg && cfg.deviceId || '',
    bypass: !!(cfg && cfg.bypass),
    now,
    upcoming,
    vlc: { state: vlc ? vlc.state : 'idle', rcReady: vlc ? vlc.ready : false }
  };
  try {
    dashboardWin.webContents.send('dashboard:update', payload);
  } catch (e) {
    console.error('pushDashboard send failed', e);
  }
}

function startBroadcastLoop() {
  if (broadcastHandle) clearInterval(broadcastHandle);
  broadcastHandle = setInterval(() => pushDashboard(), 1000);
  if (broadcastHandle.unref) broadcastHandle.unref();
  pushDashboard();
}

async function performLogin({ username, password }) {
  const url = CFG.SERVER_URL.replace(/\/+$/, '');
  const r = await fetch(url + '/api/player/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error('Login failed (' + r.status + '): ' + (text || r.statusText));
  }
  const data = await r.json();
  if (!data || !data.token) throw new Error('Server response missing token');
  return { url, data };
}

ipcMain.handle('login', async (_e, payload) => {
  try {
    const { url, data } = await performLogin(payload);
    const next = {
      serverURL: url,
      username: payload.username,
      deviceId: data.deviceId || ('dev-' + os.hostname()),
      token: data.token,
      user: data.user || { username: payload.username },
      bypass: false
    };
    saveConfig(next);
    await startRuntime();
    createDashboardWindow();
    if (loginWin && !loginWin.isDestroyed()) loginWin.hide();
    return { ok: true, deviceId: next.deviceId };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

ipcMain.handle('login-bypass', async () => {
  try {
    const url = CFG.SERVER_URL.replace(/\/+$/, '');
    const next = {
      serverURL: url,
      username: CFG.TEST_USERNAME,
      deviceId: CFG.TEST_DEVICE_ID,
      token: CFG.TEST_TOKEN,
      user: { username: CFG.TEST_USERNAME },
      bypass: true
    };
    saveConfig(next, false);
    if (fs.existsSync(CACHE_PATH)) fs.unlinkSync(CACHE_PATH);
    await startRuntime();
    injectMockSchedule();
    createDashboardWindow();
    if (loginWin && !loginWin.isDestroyed()) loginWin.hide();
    return { ok: true, deviceId: next.deviceId, bypass: true };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

ipcMain.handle('vlc-pause', async () => {
  if (vlc) vlc.pause();
  pushDashboard();
  return { ok: true };
});

ipcMain.handle('vlc-resume', async () => {
  if (vlc) vlc.resume();
  pushDashboard();
  return { ok: true };
});

ipcMain.handle('vlc-skip', async () => {
  if (scheduler) scheduler.skip();
  pushDashboard();
  return { ok: true };
});

ipcMain.handle('vlc-retry', async () => {
  if (!vlc) return { ok: false, error: 'VLC controller not initialized' };
  try {
    await vlc.start();
    setStatus(cfg && cfg.bypass ? 'test-mode (no server)' : (socket && socket.connected ? 'online' : 'offline'));
    pushDashboard();
    return { ok: true };
  } catch (e) {
    setStatus('vlc-error');
    pushDashboard();
    return { ok: false, error: e.message || String(e) };
  }
});

ipcMain.handle('open-config-folder', async () => {
  shell.openPath(DATA_DIR);
  return { ok: true };
});

ipcMain.handle('logout', async () => {
  logout();
  return { ok: true };
});

ipcMain.handle('quit', async () => {
  quitApp();
  return { ok: true };
});

function parseTestScheduleStartAt(at) {
  if (!at || typeof at !== 'string') return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(at.trim());
  if (!m) return null;
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), parseInt(m[1], 10), parseInt(m[2], 10), 0, 0);
  // If the time has already passed today, schedule for tomorrow.
  if (start.getTime() <= now.getTime()) {
    start.setTime(start.getTime() + 24 * 60 * 60 * 1000);
  }
  return start;
}

function injectMockSchedule() {
  if (!scheduler) return;
  const file = CFG.TEST_FILE && CFG.TEST_FILE.trim();
  const files = file ? [{ path: file, title: 'Test Media' }] : [];
  const now = new Date();
  const configuredStart = parseTestScheduleStartAt(CFG.TEST_SCHEDULE_START_AT);
  const start = configuredStart || new Date(now.getTime() - 1000);
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  const mock = [{
    id: 'test-schedule-001',
    startTime: start.toISOString(),
    endTime: end.toISOString(),
    recurrence: null,
    loop: true,
    files: files,
    title: 'Test Schedule'
  }];
  console.log(`[injectMockSchedule] start=${start.toISOString()} end=${end.toISOString()}`);
  writeJson(CACHE_PATH, { updatedAt: new Date().toISOString(), schedules: mock, mock: true });
  scheduler.update(mock);
}

async function startRuntime() {
  if (!cfg || !cfg.token) return;
  if (vlc) vlc.quit();
  vlc = new VlcController({
    display: secondDisplay
});
  vlc.on('error', (e) => console.error('VLC error', e));
  vlc.on('vlc-stderr', (line) => {
    console.error('[VLC stderr]', line);
    appendVlcLog(line);
  });
  vlc.on('vlc-stdout', (line) => {
    console.log('[VLC stdout]', line.trim());
    appendVlcLog(line);
  });
  vlc.on('vlc-log', (line) => {
    appendVlcLog(line);
  });
  vlc.on('exit', (code) => {
    appendVlcLog(`[VLC exit] code=${code} at ${new Date().toISOString()}`);
  });
  vlc.on('state-change', () => {
    if (vlc.state === 'error') setStatus('vlc-error');
    pushDashboard();
  });
  scheduler = new Scheduler(vlc);
  scheduler.on('activate', (info) => {
    nowSchedule = info.schedule;
    refreshTray();
    pushDashboard();
  });
  scheduler.on('expire', () => {
    nowSchedule = null;
    refreshTray();
    pushDashboard();
  });
  scheduler.on('idle', () => {
    nowSchedule = null;
    refreshTray();
    pushDashboard();
  });
  scheduler.on('tick', () => {
    pushDashboard();
  });

  try {
        await vlc.start();
    } catch (e) {
        console.error("VLC start failed", e);
        setStatus("vlc-error");
        return;
    }

  const cache = readJson(CACHE_PATH, null);
  if (cache && Array.isArray(cache.schedules) && cache.schedules.length) {
    scheduler.update(cache.schedules);
  } else {
    await vlc.clear();
  }

  app.setLoginItemSettings({ openAtLogin: true, path: process.execPath });

  connectSocket();
  refreshTray();
}

function connectSocket() {
  if (socket) {
    try { socket.disconnect(); } catch (_) {}
    socket = null;
  }
  if (!cfg) return;
  if (cfg.bypass) {
    setStatus('test-mode (no server)');
    return;
  }
  connecting = true;
  setStatus('connecting');
  socket = io(cfg.serverURL + '/player', {
    auth: { token: cfg.token },
    transports: ['websocket'],
    reconnection: true,
    reconnectionDelay: 2000,
    reconnectionDelayMax: 15000
  });
  socket.on('connect', () => {
    connecting = false;
    setStatus('online');
    socket.emit('register', { deviceId: cfg.deviceId });
  });
  socket.on('disconnect', () => {
    if (connecting) setStatus('connecting');
    else setStatus('offline');
  });
  socket.on('connect_error', (err) => {
    console.error('socket connect_error', err && err.message);
    setStatus('offline');
  });
  socket.on('sync:initial', (schedules) => {
    writeJson(CACHE_PATH, { updatedAt: new Date().toISOString(), schedules: schedules || [] });
    scheduler.update(schedules || []);
  });
  socket.on('schedule:set', (payload) => {
    const merged = mergeSchedules(readJson(CACHE_PATH, { schedules: [] }).schedules, payload);
    writeJson(CACHE_PATH, { updatedAt: new Date().toISOString(), schedules: merged });
    scheduler.update(merged);
  });
  socket.on('schedule:clear', (payload) => {
    const cur = readJson(CACHE_PATH, { schedules: [] }).schedules;
    const ids = payload && Array.isArray(payload.ids) ? payload.ids : [];
    const remaining = cur.filter(s => !ids.includes(s.id));
    writeJson(CACHE_PATH, { updatedAt: new Date().toISOString(), schedules: remaining });
    scheduler.update(remaining);
  });
  socket.on('schedule:replaceAll', (schedules) => {
    writeJson(CACHE_PATH, { updatedAt: new Date().toISOString(), schedules: schedules || [] });
    scheduler.update(schedules || []);
  });
}

function mergeSchedules(current, incoming) {
  if (!incoming) return current;
  const byId = new Map((current || []).map(s => [s.id, s]));
  for (const s of incoming) byId.set(s.id, s);
  return Array.from(byId.values());
}

function logout() {
  try { if (socket) socket.disconnect(); } catch (_) {}
  socket = null;
  if (broadcastHandle) { clearInterval(broadcastHandle); broadcastHandle = null; }
  if (scheduler) { scheduler.clear(); scheduler = null; }
  if (vlc) { vlc.quit(); vlc = null; }
  if (fs.existsSync(CACHE_PATH)) fs.unlinkSync(CACHE_PATH);
  saveConfig(null);
  nowSchedule = null;
  setStatus('offline');
  createLoginWindow();
}

function quitApp() {
  try { if (socket) socket.disconnect(); } catch (_) {}
  if (broadcastHandle) { clearInterval(broadcastHandle); broadcastHandle = null; }
  if (scheduler) scheduler.clear();
  if (vlc) vlc.quit();
  app.quit();
}

app.on('ready', () => {
  const displays = screen.getAllDisplays();

  console.log("Displays:", displays);

  if (displays.length > 1) {
    secondDisplay = displays[1];
  } else {
    secondDisplay = displays[0];
  }
  cfg = readJson(CONFIG_PATH, null);
  if (cfg && cfg.bypass) {
    try { fs.unlinkSync(CONFIG_PATH); } catch (_) {}
    cfg = null;
  }
  if (cfg && cfg.token) {
    startRuntime().then(() => createDashboardWindow()).catch(e => console.error('startRuntime', e));
  } else {
    createLoginWindow();
    if (process.env.PLAYER_AUTO_TEST === '1') {
      setTimeout(() => {
        if (loginWin && !loginWin.isDestroyed()) {
          loginWin.webContents.executeJavaScript('document.getElementById("btnTest").click()').catch(() => {});
        }
      }, 1200);
    }
  }
  try {
    tray = new Tray(getTrayIcon());
    refreshTray();
  } catch (e) {
    console.error('Tray init failed', e);
  }
});

app.on('window-all-closed', (e) => {
  e.preventDefault();
});

app.on('before-quit', () => {
  try { if (socket) socket.disconnect(); } catch (_) {}
  if (scheduler) scheduler.clear();
  if (vlc) vlc.quit();
});

app.on('will-quit', () => {
  try { if (socket) socket.disconnect(); } catch (_) {}
  if (scheduler) scheduler.clear();
  if (vlc) vlc.quit();
});

process.on('uncaughtException', (err) => {
  console.error('uncaughtException', err);
});
process.on('unhandledRejection', (err) => {
  console.error('unhandledRejection', err);
});
