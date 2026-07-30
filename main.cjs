'use strict';

const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, shell, screen, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { io } = require('socket.io-client');
const { VlcController } = require('./vlcController.cjs');
const { Scheduler } = require('./scheduler.cjs');
const {
  normalizeAsset,
  normalizeSchedule,
  normalizeSyncPayload
} = require('./contracts.cjs');
const { MediaManager } = require('./mediaManager.cjs');
const { scanMediaLibrary } = require('./mediaLibrary.cjs');
const CFG = require('./config.cjs');

if (process.env.PLAYER_USER_DATA) {
  app.setPath('userData', process.env.PLAYER_USER_DATA);
}
const DATA_DIR = app.getPath('userData');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const CACHE_PATH = path.join(DATA_DIR, 'schedules.json');

let tray = null;
let loginWin = null;
let dashboardWin = null;
let scheduleAdderWin = null;
let socket = null;
let vlc = null;
let scheduler = null;
let cfg = null;
let connecting = false;
let statusLabel = 'offline';
let nowSchedule = null;
let broadcastHandle = null;
let secondDisplay = null;
let transitionWin = null;
let isShuttingDown = false;
let mediaManager = null;
let syncQueue = Promise.resolve();

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

function createScheduleAdderWindow() {
  if (scheduleAdderWin && !scheduleAdderWin.isDestroyed()) {
    scheduleAdderWin.show();
    scheduleAdderWin.focus();
    return;
  }
  const parent = (dashboardWin && !dashboardWin.isDestroyed()) ? dashboardWin : undefined;
  scheduleAdderWin = new BrowserWindow({
    width: 560,
    height: 760,
    minHeight: 620,
    resizable: true,
    minimizable: false,
    maximizable: false,
    parent,
    modal: !!parent,
    title: 'Player — Add Test Schedule',
    autoHideMenuBar: true,
    background: '#0b1220',
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: true
    }
  });
  scheduleAdderWin.removeMenu();
  scheduleAdderWin.loadFile(path.join(__dirname, 'scheduleAdder.html'));
  scheduleAdderWin.on('closed', () => { scheduleAdderWin = null; });
}

function createTransitionWindow() {
  if (!secondDisplay) return;
  if (transitionWin && !transitionWin.isDestroyed()) return;
  transitionWin = new BrowserWindow({
    x: secondDisplay.bounds.x,
    y: secondDisplay.bounds.y,
    width: secondDisplay.bounds.width,
    height: secondDisplay.bounds.height,
    fullscreen: true,
    frame: false,
    skipTaskbar: true,
    focusable: false,
    resizable: false,
    movable: false,
    show: false,
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      devTools: false
    }
  });
  transitionWin.removeMenu();
  try {
    transitionWin.setAlwaysOnTop(true, 'screen-saver');
    transitionWin.setVisibleOnAllWorkspaces(true);
  } catch (_) {}
  transitionWin.loadURL('data:text/html,<body style="margin:0;background:#000"></body>').catch(() => {});
  transitionWin.on('closed', () => { transitionWin = null; });
}

function showTransitionOverlay() {
  try {
    if (!transitionWin || transitionWin.isDestroyed()) createTransitionWindow();
    if (transitionWin && !transitionWin.isDestroyed()) transitionWin.showInactive();
  } catch (e) {
    console.error('showTransitionOverlay failed', e);
  }
}

function hideTransitionOverlay() {
  try {
    if (transitionWin && !transitionWin.isDestroyed()) transitionWin.hide();
  } catch (e) {
    console.error('hideTransitionOverlay failed', e);
  }
}

function destroyTransitionOverlay() {
  try {
    if (transitionWin && !transitionWin.isDestroyed()) transitionWin.destroy();
  } catch (_) {}
  transitionWin = null;
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
  const skipped = scheduler ? scheduler.getSkipped() : [];
  const payload = {
    status: statusLabel,
    deviceId: cfg && cfg.deviceId || '',
    bypass: !!(cfg && cfg.bypass),
    now,
    upcoming,
    skipped,
    vlc: { state: vlc ? vlc.state : 'idle', rcReady: vlc ? vlc.ready : false, idleMode: vlc ? vlc.idleMode : false }
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

ipcMain.handle('vlc-reactivate', async (_e, scheduleId) => {
  if (!scheduler) return { ok: false, error: 'Scheduler not initialized' };
  try {
    scheduler.reactivate(scheduleId);
    pushDashboard();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
});

ipcMain.handle('vlc-retry', async () => {
  if (!vlc) return { ok: false, error: 'VLC controller not initialized' };
  try {
    await vlc.start();
    if (scheduler) {
      const cache = readJson(CACHE_PATH, { schedules: [] });
      scheduler.recover(cache.schedules);
    }
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

ipcMain.handle('open-schedule-adder', async () => {
  if (!cfg || !cfg.bypass) return { ok: false, error: 'Only available in Test Mode' };
  createScheduleAdderWindow();
  return { ok: true };
});

ipcMain.handle('list-local-media', async () => {
  if (!cfg || !cfg.bypass) return { ok: false, error: 'Only available in Test Mode' };
  try {
    fs.mkdirSync(CFG.MEDIA_LIBRARY_DIR, { recursive: true });
    return {
      ok: true,
      directory: CFG.MEDIA_LIBRARY_DIR,
      items: scanMediaLibrary(CFG.MEDIA_LIBRARY_DIR)
    };
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
});

ipcMain.handle('open-media-library', async () => {
  if (!cfg || !cfg.bypass) return { ok: false, error: 'Only available in Test Mode' };
  fs.mkdirSync(CFG.MEDIA_LIBRARY_DIR, { recursive: true });
  const error = await shell.openPath(CFG.MEDIA_LIBRARY_DIR);
  return error ? { ok: false, error } : { ok: true };
});

function parseStartDate(dateStr, timeStr) {
  const dateParts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || '').trim());
  if (!dateParts) return null;
  const year = parseInt(dateParts[1], 10);
  const month = parseInt(dateParts[2], 10) - 1;
  const day = parseInt(dateParts[3], 10);

  const timeMatch = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(timeStr || '').trim());
  if (!timeMatch) return null;
  const hour = parseInt(timeMatch[1], 10);
  const minute = parseInt(timeMatch[2], 10);
  const second = timeMatch[3] ? parseInt(timeMatch[3], 10) : 0;

  const start = new Date(year, month, day, hour, minute, second, 0);
  if (isNaN(start.getTime())) return null;
  return start;
}

ipcMain.handle('add-test-schedule', async (_e, payload) => {
  try {
    if (!cfg || !cfg.bypass) throw new Error('Only available in Test Mode');
    if (!payload) throw new Error('No payload');
    const title = String(payload.title || '').trim();
    const mediaSource = String(payload.mediaSource || 'library');
    const dateStr = String(payload.startDate || '').trim();
    const timeStr = String(payload.startTime || '').trim();
    const durationMinutes = parseInt(payload.durationMinutes, 10);
    const durationSeconds = parseInt(payload.durationSeconds, 10);
    const priority = Number(payload.priority) || 0;
    if (!title) throw new Error('Schedule name is required');
    if (!dateStr) throw new Error('Start date is required');
    if (!timeStr) throw new Error('Start time is required');
    if (!Number.isFinite(durationMinutes) || durationMinutes < 0) throw new Error('Duration minutes is invalid');
    if (!Number.isFinite(durationSeconds) || durationSeconds < 0 || durationSeconds > 59) throw new Error('Duration seconds must be 0–59');
    const durationMs = (durationMinutes * 60 + durationSeconds) * 1000;
    if (durationMs <= 0) throw new Error('Duration must be greater than 0');

    let start = parseStartDate(dateStr, timeStr);
    if (!start) throw new Error('Start date/time is invalid');

    const now = new Date();
    if (start.getTime() <= now.getTime()) {
      throw new Error('Start date/time has already passed');
    }

    const end = new Date(start.getTime() + durationMs);
    let playlistItem;
    let newAsset = null;

    if (mediaSource === 'library') {
      const mediaId = String(payload.mediaId || '').trim();
      const selected = scanMediaLibrary(CFG.MEDIA_LIBRARY_DIR)
        .find(item => item.id === mediaId);
      if (!selected) {
        throw new Error('Selected film is no longer available in the Media Library. Refresh the list.');
      }
      playlistItem = {
        localPath: selected.path,
        path: selected.path,
        title: selected.title,
        order: 0
      };
    } else if (mediaSource === 'remote') {
      newAsset = normalizeAsset({
        id: `test-${String(payload.sha256 || '').trim().toLowerCase().slice(0, 24)}`,
        filename: payload.filename,
        downloadUrl: payload.downloadUrl,
        size: Number(payload.size),
        sha256: payload.sha256,
        mimeType: 'video/mp4'
      });
      if (!mediaManager) throw new Error('Media manager is not initialized');
      const localPath = await mediaManager.prepareAsset(newAsset);
      playlistItem = {
        assetId: newAsset.id,
        localPath,
        path: localPath,
        title: path.basename(newAsset.filename, path.extname(newAsset.filename)),
        order: 0
      };
    } else {
      throw new Error('Unknown media source');
    }

    const newSchedule = normalizeSchedule({
      id: 'manual-' + Date.now(),
      title,
      priority,
      startTime: start.toISOString(),
      endTime: end.toISOString(),
      recurrence: null,
      loop: payload.loop !== false,
      playlist: [playlistItem]
    });

    const cache = normalizeSyncPayload(
      readJson(CACHE_PATH, { revision: 0, schedules: [], assets: [] })
    );
    const schedules = cache.schedules.slice();
    schedules.push(newSchedule);
    const assets = newAsset ? mergeAssets(cache.assets, [newAsset]) : cache.assets;
    writeJson(CACHE_PATH, {
      revision: cache.revision,
      updatedAt: new Date().toISOString(),
      schedules,
      assets,
      mock: true
    });
    if (scheduler) scheduler.update(schedules);
    pushDashboard();
    return { ok: true, schedule: newSchedule };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
});

ipcMain.handle('logout', async () => {
  logout();
  return { ok: true };
});

ipcMain.handle('quit', async () => {
  quitApp();
  return { ok: true };
});

async function startRuntime() {
  if (!cfg || !cfg.token) return;
  if (vlc) vlc.quit();
  mediaManager = new MediaManager({
    mediaDir: path.join(DATA_DIR, 'media'),
    concurrency: 2
  });
  mediaManager.on('download-start', ({ asset }) => {
    appendVlcLog(`[media] downloading ${asset.id}`);
  });
  mediaManager.on('ready', ({ asset, cached }) => {
    appendVlcLog(`[media] ready ${asset.id} (${cached ? 'cached' : 'downloaded'})`);
  });
  mediaManager.on('download-error', ({ asset, error }) => {
    appendVlcLog(`[media] failed ${asset.id}: ${error.message}`);
    console.error('Media download failed', asset.id, error);
  });
  createTransitionWindow();
  vlc = new VlcController({
    display: secondDisplay,
    transitionDuration: 1000,
    onTransitionStart: () => showTransitionOverlay(),
    onTransitionEnd: () => hideTransitionOverlay()
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
    if (!isShuttingDown) {
      setStatus('vlc-error');
      pushDashboard();
    }
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
  scheduler.on('finish', () => {
    nowSchedule = null;
    refreshTray();
    pushDashboard();
  });
  scheduler.on('tick', () => {
    pushDashboard();
  });
  scheduler.on('error', (error) => {
    appendVlcLog(`[scheduler] ${error.message}`);
    console.error('Scheduler error', error);
  });

  try {
        await vlc.start();
    } catch (e) {
        console.error("VLC start failed", e);
        setStatus("vlc-error");
        return;
    }

  const cache = readJson(CACHE_PATH, { revision: 0, schedules: [], assets: [] });
  try {
    const normalizedCache = normalizeSyncPayload(cache);
    const prepared = await mediaManager.prepareSchedules(
      normalizedCache.schedules,
      normalizedCache.assets
    );
    scheduler.update(prepared);
  } catch (error) {
    appendVlcLog(`[cache] invalid: ${error.message}`);
    scheduler.update([]);
  }

  app.setLoginItemSettings({ openAtLogin: true, path: process.execPath });

  connectSocket();
  refreshTray();
}

async function applySyncPayload(payload, mode = 'replace') {
  if (!scheduler || !mediaManager) return { applied: false, revision: 0 };
  const incoming = normalizeSyncPayload(payload);
  const currentRaw = readJson(CACHE_PATH, { revision: 0, schedules: [], assets: [] });
  const current = normalizeSyncPayload(currentRaw);

  if (incoming.revision && current.revision > incoming.revision) {
    return { applied: false, stale: true, revision: current.revision };
  }

  const schedules = mode === 'merge'
    ? mergeSchedules(current.schedules, incoming.schedules)
    : incoming.schedules;
  const assets = mergeAssets(current.assets, incoming.assets);
  const prepared = await mediaManager.prepareSchedules(schedules, assets);
  const revision = incoming.revision || current.revision;

  writeJson(CACHE_PATH, {
    revision,
    updatedAt: new Date().toISOString(),
    schedules: prepared,
    assets
  });
  scheduler.update(prepared);
  pushDashboard();
  return { applied: true, revision };
}

async function applyClearPayload(payload) {
  const currentRaw = readJson(CACHE_PATH, { revision: 0, schedules: [], assets: [] });
  const current = normalizeSyncPayload(currentRaw);
  const ids = payload && Array.isArray(payload.ids) ? payload.ids : [];
  const revision = Math.max(current.revision, Number(payload && payload.revision) || 0);
  const remaining = current.schedules.filter(schedule => !ids.includes(schedule.id));
  const prepared = await mediaManager.prepareSchedules(remaining, current.assets);
  writeJson(CACHE_PATH, {
    revision,
    updatedAt: new Date().toISOString(),
    schedules: prepared,
    assets: current.assets
  });
  scheduler.update(prepared);
  pushDashboard();
  return { applied: true, revision };
}

function queueSync(operation, acknowledgement) {
  syncQueue = syncQueue
    .then(operation)
    .then(result => {
      if (socket && socket.connected && result && result.applied) {
        socket.emit('sync:applied', {
          deviceId: cfg.deviceId,
          revision: result.revision,
          appliedAt: new Date().toISOString()
        });
      }
      if (typeof acknowledgement === 'function') acknowledgement({ ok: true, ...result });
      return result;
    })
    .catch(error => {
      console.error('Schedule synchronization failed', error);
      appendVlcLog(`[sync] ${error.message}`);
      if (typeof acknowledgement === 'function') {
        acknowledgement({
          ok: false,
          error: error.message,
          details: error.details || []
        });
      }
    });
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
    const cache = readJson(CACHE_PATH, { revision: 0 });
    socket.emit('register', {
      deviceId: cfg.deviceId,
      revision: Number(cache.revision) || 0,
      appVersion: app.getVersion()
    });
  });
  socket.on('disconnect', () => {
    if (connecting) setStatus('connecting');
    else setStatus('offline');
  });
  socket.on('connect_error', (err) => {
    console.error('socket connect_error', err && err.message);
    setStatus('offline');
  });
  socket.on('sync:initial', (payload, acknowledgement) => {
    queueSync(() => applySyncPayload(payload, 'replace'), acknowledgement);
  });
  socket.on('schedule:set', (payload, acknowledgement) => {
    queueSync(() => applySyncPayload(payload, 'merge'), acknowledgement);
  });
  socket.on('schedule:clear', (payload, acknowledgement) => {
    queueSync(() => applyClearPayload(payload), acknowledgement);
  });
  socket.on('schedule:replaceAll', (payload, acknowledgement) => {
    queueSync(() => applySyncPayload(payload, 'replace'), acknowledgement);
  });
}

function mergeSchedules(current, incoming) {
  if (!incoming) return current;
  const byId = new Map((current || []).map(s => [s.id, s]));
  for (const s of incoming) byId.set(s.id, s);
  return Array.from(byId.values());
}

function mergeAssets(current, incoming) {
  const byId = new Map((current || []).map(asset => [asset.id, asset]));
  for (const asset of incoming || []) byId.set(asset.id, asset);
  return Array.from(byId.values());
}

function logout() {
  isShuttingDown = true;
  try { if (socket) socket.disconnect(); } catch (_) {}
  socket = null;
  if (broadcastHandle) { clearInterval(broadcastHandle); broadcastHandle = null; }
  if (scheduler) { scheduler.clear(); scheduler = null; }
  if (vlc) { vlc.quit(); vlc = null; }
  destroyTransitionOverlay();
  if (fs.existsSync(CACHE_PATH)) fs.unlinkSync(CACHE_PATH);
  saveConfig(null);
  nowSchedule = null;
  setStatus('offline');
  createLoginWindow();
  isShuttingDown = false;
}

function quitApp() {
  isShuttingDown = true;
  try { if (socket) socket.disconnect(); } catch (_) {}
  if (broadcastHandle) { clearInterval(broadcastHandle); broadcastHandle = null; }
  if (scheduler) scheduler.clear();
  if (vlc) vlc.quit();
  destroyTransitionOverlay();
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
  isShuttingDown = true;
  try { if (socket) socket.disconnect(); } catch (_) {}
  if (scheduler) scheduler.clear();
  if (vlc) vlc.quit();
  destroyTransitionOverlay();
});

app.on('will-quit', () => {
  isShuttingDown = true;
  try { if (socket) socket.disconnect(); } catch (_) {}
  if (scheduler) scheduler.clear();
  if (vlc) vlc.quit();
  destroyTransitionOverlay();
});

process.on('uncaughtException', (err) => {
  console.error('uncaughtException', err);
});
process.on('unhandledRejection', (err) => {
  console.error('unhandledRejection', err);
});
