'use strict';

const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, shell, screen, dialog, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { io } = require('socket.io-client');
const { VlcController } = require('./vlcController.cjs');
const { Scheduler, nextOccurrenceStart } = require('./scheduler.cjs');
const {
  normalizeAsset,
  normalizeSchedule,
  normalizeSyncPayload
} = require('./contracts.cjs');
const { MediaManager } = require('./mediaManager.cjs');
const { listManagedAssets, scanMediaLibrary } = require('./mediaLibrary.cjs');
const { MediaProbe } = require('./mediaProbe.cjs');
const { PlaybackWatchdog } = require('./playbackWatchdog.cjs');
const { resolveResumeTarget } = require('./playbackResume.cjs');
const { MediaHealthMonitor } = require('./mediaHealth.cjs');
const { CmsClient, CmsApiError, normalizeServerUrl, parseSessionExpiry } = require('./cmsClient.cjs');
const { DeviceCredentials } = require('./deviceCredentials.cjs');
const CFG = require('./config.cjs');

if (process.env.PLAYER_USER_DATA) {
  app.setPath('userData', process.env.PLAYER_USER_DATA);
}
const DATA_DIR = app.getPath('userData');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const INSTALLATION_PATH = path.join(DATA_DIR, 'installation.json');
const CACHE_PATH = path.join(DATA_DIR, 'schedules.json');
const DURATION_CACHE_PATH = path.join(DATA_DIR, 'media-durations.json');

let tray = null;
let loginWin = null;
let dashboardWin = null;
let scheduleAdderWin = null;
let scheduleManagerWin = null;
let socket = null;
let cmsClient = null;
let cmsState = { status: 'offline', lastHeartbeatAt: null, lastError: null };
let setupSession = null;
let operatorSession = null;
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
let mediaProbe = null;
let playbackWatchdog = null;
let playbackCheckpoint = null;
let lastResumeInfo = null;
let mediaHealthMonitor = null;
let mediaHealthSnapshot = null;
let mediaHealthCheck = null;
let syncQueue = Promise.resolve();
const credentialStore = new DeviceCredentials({
  configPath: CONFIG_PATH,
  installationPath: INSTALLATION_PATH,
  safeStorage
});
const DASHBOARD_IDLE_LOCK_MS = 15 * 60 * 1000;

function isTestModeEnabled() {
  return !app.isPackaged && process.env.PLAYER_ENABLE_TEST_MODE === '1';
}

function operatorAccessError(touch = true) {
  if (cfg && cfg.bypass) return null;
  const now = Date.now();
  if (!operatorSession || now >= operatorSession.expiresAt || now - operatorSession.lastActivityAt >= DASHBOARD_IDLE_LOCK_MS) {
    operatorSession = null;
    return { ok: false, code: 'dashboard_locked', error: 'Dashboard is locked. Sign in as an operator.' };
  }
  if (touch) operatorSession.lastActivityAt = now;
  return null;
}

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

function resetTestCachePreservingAssets() {
  const existing = readJson(CACHE_PATH, { assets: [] });
  const testSchedules = existing.mock && Array.isArray(existing.schedules)
    ? existing.schedules
    : [];
  const testAssets = Array.isArray(existing.assets)
    ? existing.assets.filter(asset => String(asset.id || '').startsWith('test-'))
    : [];
  writeJson(CACHE_PATH, {
    revision: 0,
    updatedAt: new Date().toISOString(),
    schedules: testSchedules,
    assets: testAssets,
    mock: true
  });
}

function saveConfig(c, persist = true) {
  cfg = c;
  if (!persist) return;
  if (c) credentialStore.save(c);
  else credentialStore.clear();
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
  items.push({
    label: 'Reconnect CMS',
    click: () => {
      if (cfg && !cfg.bypass) startCmsConnection();
      if (CFG.SOCKET_ENABLED && socket) socket.connect();
    }
  });
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
    width: 440,
    height: 640,
    resizable: false,
    minimizable: true,
    maximizable: false,
    title: 'Player — Login',
    autoHideMenuBar: true,
    backgroundColor: '#f5f3f0',
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
    width: 1180,
    height: 760,
    minWidth: 900,
    minHeight: 620,
    title: 'Player — Dashboard',
    autoHideMenuBar: true,
    background: '#f5f3f0',
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

function createScheduleAdderWindow(scheduleId = '') {
  if (scheduleAdderWin && !scheduleAdderWin.isDestroyed()) {
    scheduleAdderWin.destroy();
    scheduleAdderWin = null;
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
  scheduleAdderWin.loadFile(path.join(__dirname, 'scheduleAdder.html'), {
    query: scheduleId ? { scheduleId } : {}
  });
  scheduleAdderWin.on('closed', () => { scheduleAdderWin = null; });
}

function createScheduleManagerWindow() {
  if (scheduleManagerWin && !scheduleManagerWin.isDestroyed()) {
    scheduleManagerWin.show();
    scheduleManagerWin.focus();
    return;
  }
  scheduleManagerWin = new BrowserWindow({
    width: 1040,
    height: 720,
    minWidth: 820,
    minHeight: 560,
    title: 'Player — Schedule Manager',
    autoHideMenuBar: true,
    background: '#0b1220',
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: true
    }
  });
  scheduleManagerWin.removeMenu();
  scheduleManagerWin.loadFile(path.join(__dirname, 'scheduleManager.html'));
  scheduleManagerWin.on('closed', () => { scheduleManagerWin = null; });
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

function getRuntimeStatus() {
  if (cfg && cfg.bypass) return 'test-mode (no server)';
  return cmsState.status || 'offline';
}

function isVlcPlaybackHealthy() {
  if (!vlc || !vlc.ready || vlc.state === 'error') return false;
  const active = scheduler && scheduler.getNow();
  const playbackExpected = Boolean(active && active.files && active.files.length);
  if (!playbackExpected) return true;
  return !vlc.idleMode && (vlc.state === 'playing' || vlc.state === 'paused');
}

async function refreshMediaHealth(schedules, assets, options = {}) {
  if (!mediaHealthMonitor) return null;
  if (mediaHealthCheck) {
    if (!options.force) return mediaHealthCheck;
    await mediaHealthCheck;
  }
  mediaHealthSnapshot = {
    ...mediaHealthMonitor.getSnapshot(),
    state: 'checking'
  };
  pushDashboard();
  mediaHealthCheck = mediaHealthMonitor.scan(schedules || [], assets || [])
    .then(snapshot => {
      mediaHealthSnapshot = snapshot;
      const problemCount = snapshot.counts.missing + snapshot.counts.corrupt + snapshot.counts.unreadable;
      appendVlcLog(
        `[media-health] ready=${snapshot.counts.ready} problems=${problemCount} ` +
        `free=${snapshot.disk.freeBytes == null ? 'unknown' : snapshot.disk.freeBytes}`
      );
      pushDashboard();
      return snapshot;
    })
    .catch(error => {
      appendVlcLog(`[media-health] scan failed: ${error.message}`);
      mediaHealthSnapshot = {
        ...mediaHealthMonitor.getSnapshot(),
        state: 'error',
        error: error.message || String(error)
      };
      pushDashboard();
      return mediaHealthSnapshot;
    })
    .finally(() => { mediaHealthCheck = null; });
  return mediaHealthCheck;
}

function getCachedAssets() {
  try {
    return normalizeSyncPayload(
      readJson(CACHE_PATH, { revision: 0, schedules: [], assets: [] })
    ).assets;
  } catch (_) {
    return [];
  }
}

async function waitForVlcRecovery(timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (isShuttingDown) throw new Error('Player is shutting down');
    if (isVlcPlaybackHealthy()) return;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('VLC did not return to a healthy playback state in time');
}

function pushDashboard() {
  if (!dashboardWin || dashboardWin.isDestroyed() || !dashboardWin.webContents) return;
  const now = scheduler ? scheduler.getNow() : null;
  const upcoming = scheduler ? scheduler.getUpcoming(6) : [];
  const skipped = scheduler ? scheduler.getSkipped() : [];
  const payload = {
    status: statusLabel,
    deviceId: cfg && cfg.deviceId || '',
    appVersion: app.getVersion(),
    bypass: !!(cfg && cfg.bypass),
    serverURL: cfg && cfg.serverURL || '',
    cms: { ...cmsState },
    operator: {
      unlocked: Boolean(!operatorAccessError(false)),
      user: operatorSession && operatorSession.user || null
    },
    now,
    upcoming,
    skipped,
    vlc: {
      state: vlc ? vlc.state : 'idle',
      rcReady: vlc ? vlc.ready : false,
      idleMode: vlc ? vlc.idleMode : false,
      playback: vlc ? vlc.getPlaybackStatus() : null
    },
    watchdog: playbackWatchdog ? playbackWatchdog.getStatus() : { state: 'idle', attempts: 0 },
    recoveryResume: lastResumeInfo,
    mediaHealth: mediaHealthSnapshot
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

async function performPairing({ serverURL, enrollmentCode }) {
  const url = normalizeServerUrl(serverURL || CFG.SERVER_URL);
  const installId = credentialStore.getInstallId();
  const client = new CmsClient({ serverURL: url });
  const data = await client.register({
    enrollment_code: String(enrollmentCode || '').trim(),
    device_fingerprint: installId,
    app_version: app.getVersion(),
    platform: `${process.platform}-${process.arch}`,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Jakarta'
  });
  if (!data || !data.token || !data.device_id) {
    throw new Error('CMS registration response is incomplete');
  }
  return { url, data, installId };
}

ipcMain.handle('get-pairing-defaults', async () => ({
  serverURL: CFG.SERVER_URL,
  appVersion: app.getVersion(),
  testModeEnabled: isTestModeEnabled()
}));

ipcMain.handle('setup-login', async (_event, payload) => {
  try {
    if (setupSession) {
      const previous = setupSession;
      setupSession = null;
      const previousClient = new CmsClient({ serverURL: previous.serverURL });
      await previousClient.operatorLogout(previous.token).catch(() => {});
    }
    const serverURL = normalizeServerUrl(payload && payload.serverURL || CFG.SERVER_URL);
    const client = new CmsClient({ serverURL });
    const auth = await client.operatorLogin(String(payload && payload.email || '').trim(), String(payload && payload.password || ''));
    const devices = await client.availableDevices(auth.token);
    setupSession = { serverURL, token: auth.token, user: auth.user, expiresAt: parseSessionExpiry(auth.expires_at) };
    return { ok: true, user: auth.user, devices: Array.isArray(devices) ? devices : [] };
  } catch (error) {
    setupSession = null;
    return { ok: false, error: error.message || String(error) };
  }
});

ipcMain.handle('claim-player', async (_event, payload) => {
  if (!setupSession || Date.now() >= setupSession.expiresAt) {
    setupSession = null;
    return { ok: false, error: 'Operator setup session expired. Sign in again.' };
  }
  try {
    const client = new CmsClient({ serverURL: setupSession.serverURL });
    const installId = credentialStore.getInstallId();
    const data = await client.claim(setupSession.token, {
      device_id: String(payload && payload.deviceId || ''),
      device_fingerprint: installId,
      app_version: app.getVersion(),
      platform: `${process.platform}-${process.arch}`,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Jakarta'
    });
    await client.operatorLogout(setupSession.token).catch(() => {});
    const next = {
      serverURL: setupSession.serverURL, installId, deviceId: data.device_id,
      deviceName: data.device_name || os.hostname(), token: data.token, bypass: false
    };
    setupSession = null;
    saveConfig(next);
    await startRuntime();
    createDashboardWindow();
    if (loginWin && !loginWin.isDestroyed()) loginWin.hide();
    return { ok: true, deviceId: next.deviceId };
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
});

ipcMain.handle('setup-cancel', async () => {
  const session = setupSession;
  setupSession = null;
  if (session) {
    const client = new CmsClient({ serverURL: session.serverURL });
    await client.operatorLogout(session.token).catch(() => {});
  }
  return { ok: true };
});

ipcMain.handle('operator-login', async (_event, payload) => {
  if (!cfg || cfg.bypass) return { ok: true, bypass: true };
  try {
    const client = new CmsClient({ serverURL: cfg.serverURL });
    const auth = await client.operatorLogin(String(payload && payload.email || '').trim(), String(payload && payload.password || ''));
    operatorSession = {
      token: auth.token, user: auth.user,
      expiresAt: parseSessionExpiry(auth.expires_at),
      lastActivityAt: Date.now()
    };
    pushDashboard();
    return { ok: true, user: auth.user };
  } catch (error) {
    operatorSession = null;
    return { ok: false, error: error.message || String(error) };
  }
});

ipcMain.handle('operator-logout', async () => {
  const session = operatorSession;
  operatorSession = null;
  pushDashboard();
  if (session && cfg && cfg.serverURL) {
    const client = new CmsClient({ serverURL: cfg.serverURL });
    await client.operatorLogout(session.token).catch(() => {});
  }
  return { ok: true };
});

ipcMain.handle('pair-player', async (_e, payload) => {
  try {
    const { url, data, installId } = await performPairing(payload || {});
    const next = {
      serverURL: url,
      installId,
      deviceId: data.device_id,
      deviceName: data.device_name || os.hostname(),
      token: data.token,
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
  if (!isTestModeEnabled()) return { ok: false, error: 'Test Mode is disabled.' };
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
    resetTestCachePreservingAssets();
    await startRuntime();
    createDashboardWindow();
    if (loginWin && !loginWin.isDestroyed()) loginWin.hide();
    return { ok: true, deviceId: next.deviceId, bypass: true };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

ipcMain.handle('vlc-pause', async () => {
  const denied = operatorAccessError(); if (denied) return denied;
  if (vlc) vlc.pause();
  pushDashboard();
  return { ok: true };
});

ipcMain.handle('vlc-resume', async () => {
  const denied = operatorAccessError(); if (denied) return denied;
  if (vlc) vlc.resume();
  pushDashboard();
  return { ok: true };
});

ipcMain.handle('vlc-seek-relative', async (_event, deltaSeconds) => {
  const denied = operatorAccessError(); if (denied) return denied;
  if (!vlc) return { ok: false, error: 'VLC controller not initialized' };
  try {
    const delta = Number(deltaSeconds);
    if (!Number.isFinite(delta)) throw new Error('Seek offset is invalid');
    const playback = await vlc.seekRelative(delta);
    pushDashboard();
    return { ok: true, playback };
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
});

ipcMain.handle('vlc-seek-to', async (_event, positionSeconds) => {
  const denied = operatorAccessError(); if (denied) return denied;
  if (!vlc) return { ok: false, error: 'VLC controller not initialized' };
  try {
    const position = Number(positionSeconds);
    if (!Number.isFinite(position) || position < 0) throw new Error('Jump position is invalid');
    const playback = await vlc.seekTo(position);
    pushDashboard();
    return { ok: true, playback };
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
});

ipcMain.handle('vlc-skip', async () => {
  const denied = operatorAccessError(); if (denied) return denied;
  if (scheduler) scheduler.skip();
  pushDashboard();
  return { ok: true };
});

ipcMain.handle('vlc-reactivate', async (_e, scheduleId) => {
  const denied = operatorAccessError(); if (denied) return denied;
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
  const denied = operatorAccessError(); if (denied) return denied;
  if (!vlc) return { ok: false, error: 'VLC controller not initialized' };
  try {
    if (playbackWatchdog) {
      const result = await playbackWatchdog.recoverNow();
      if (result.state !== 'healthy') throw new Error(result.lastError || 'VLC recovery failed');
    } else {
      await vlc.start();
    }
    setStatus(getRuntimeStatus());
    pushDashboard();
    return { ok: true };
  } catch (e) {
    setStatus('vlc-error');
    pushDashboard();
    return { ok: false, error: e.message || String(e) };
  }
});

ipcMain.handle('open-config-folder', async () => {
  const denied = operatorAccessError(); if (denied) return denied;
  shell.openPath(DATA_DIR);
  return { ok: true };
});

ipcMain.handle('recheck-media-health', async () => {
  const denied = operatorAccessError(); if (denied) return denied;
  if (!mediaManager || !mediaHealthMonitor) {
    return { ok: false, error: 'Media health monitor is not initialized' };
  }
  try {
    const cache = normalizeSyncPayload(
      readJson(CACHE_PATH, { revision: 0, schedules: [], assets: [] })
    );
    const activeId = scheduler && scheduler.getNow() && scheduler.getNow().scheduleId;
    const prepared = await mediaManager.prepareSchedules(cache.schedules, cache.assets);
    const snapshot = await refreshMediaHealth(prepared, cache.assets, { force: true });
    if (scheduler) {
      scheduler.update(prepared);
      if (activeId) scheduler.reactivate(activeId);
    }
    return { ok: true, mediaHealth: snapshot };
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
});

ipcMain.handle('open-schedule-adder', async (_event, scheduleId) => {
  if (!cfg || !cfg.bypass) return { ok: false, error: 'Only available in Test Mode' };
  createScheduleAdderWindow(String(scheduleId || ''));
  return { ok: true };
});

ipcMain.handle('open-schedule-manager', async () => {
  if (!cfg || !cfg.bypass) return { ok: false, error: 'Only available in Test Mode' };
  createScheduleManagerWindow();
  return { ok: true };
});

function getTestCache() {
  return normalizeSyncPayload(
    readJson(CACHE_PATH, { revision: 0, schedules: [], assets: [] })
  );
}

function persistTestSchedules(cache, schedules) {
  writeJson(CACHE_PATH, {
    revision: cache.revision,
    updatedAt: new Date().toISOString(),
    schedules,
    assets: cache.assets,
    mock: true
  });
  if (scheduler) scheduler.update(schedules);
  refreshMediaHealth(schedules, cache.assets).catch(() => {});
  pushDashboard();
}

function getTestScheduleStatus(schedule) {
  if (schedule.enabled === false) return 'disabled';
  if (scheduler && scheduler.currentScheduleId === schedule.id) return 'active';
  const now = new Date();
  const occurrence = nextOccurrenceStart(schedule, now);
  if (!occurrence) return 'completed';
  return occurrence.alreadyActive ? 'ready' : 'upcoming';
}

ipcMain.handle('list-test-schedules', async () => {
  if (!cfg || !cfg.bypass) return { ok: false, error: 'Only available in Test Mode' };
  try {
    const cache = getTestCache();
    return {
      ok: true,
      schedules: cache.schedules.map(schedule => ({
        ...schedule,
        status: getTestScheduleStatus(schedule)
      }))
    };
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
});

ipcMain.handle('get-test-schedule', async (_event, scheduleId) => {
  if (!cfg || !cfg.bypass) return { ok: false, error: 'Only available in Test Mode' };
  try {
    const schedule = getTestCache().schedules.find(item => item.id === scheduleId);
    return schedule
      ? { ok: true, schedule }
      : { ok: false, error: 'Schedule not found' };
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
});

ipcMain.handle('delete-test-schedule', async (_event, scheduleId) => {
  if (!cfg || !cfg.bypass) return { ok: false, error: 'Only available in Test Mode' };
  try {
    const cache = getTestCache();
    const schedules = cache.schedules.filter(item => item.id !== scheduleId);
    if (schedules.length === cache.schedules.length) throw new Error('Schedule not found');
    persistTestSchedules(cache, schedules);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
});

ipcMain.handle('toggle-test-schedule', async (_event, scheduleId) => {
  if (!cfg || !cfg.bypass) return { ok: false, error: 'Only available in Test Mode' };
  try {
    const cache = getTestCache();
    let nextEnabled = false;
    let found = false;
    const schedules = cache.schedules.map(schedule => {
      if (schedule.id !== scheduleId) return schedule;
      found = true;
      nextEnabled = schedule.enabled === false;
      return { ...schedule, enabled: nextEnabled, revision: schedule.revision + 1 };
    });
    if (!found) throw new Error('Schedule not found');
    persistTestSchedules(cache, schedules);
    if (nextEnabled && scheduler) scheduler.reactivate(scheduleId);
    return { ok: true, enabled: nextEnabled };
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
});

ipcMain.handle('duplicate-test-schedule', async (_event, scheduleId) => {
  if (!cfg || !cfg.bypass) return { ok: false, error: 'Only available in Test Mode' };
  try {
    const cache = getTestCache();
    const source = cache.schedules.find(item => item.id === scheduleId);
    if (!source) throw new Error('Schedule not found');
    const originalDuration = new Date(source.endTime).getTime() - new Date(source.startTime).getTime();
    const start = new Date(Date.now() + 5 * 60000);
    const duplicate = normalizeSchedule({
      ...source,
      id: `manual-${Date.now()}`,
      title: `${source.title} (Copy)`,
      revision: 0,
      enabled: true,
      startTime: start.toISOString(),
      endTime: new Date(start.getTime() + originalDuration).toISOString()
    });
    const schedules = [...cache.schedules, duplicate];
    persistTestSchedules(cache, schedules);
    return { ok: true, schedule: duplicate };
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
});

ipcMain.handle('list-local-media', async () => {
  try {
    fs.mkdirSync(CFG.MEDIA_LIBRARY_DIR, { recursive: true });
    const cached = normalizeSyncPayload(
      readJson(CACHE_PATH, { revision: 0, schedules: [], assets: [] })
    );
    const libraryItems = scanMediaLibrary(CFG.MEDIA_LIBRARY_DIR);
    const managedItems = mediaManager
      ? listManagedAssets(cached.assets, asset => mediaManager.getAssetPath(asset))
      : [];
    const items = [...libraryItems, ...managedItems].sort((a, b) => (
      a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }) ||
      a.sourceLabel.localeCompare(b.sourceLabel) ||
      a.relativePath.localeCompare(b.relativePath)
    ));
    return {
      ok: true,
      directory: CFG.MEDIA_LIBRARY_DIR,
      items
    };
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
});

ipcMain.handle('get-media-duration', async (_event, payload) => {
  if (!cfg || !cfg.bypass) return { ok: false, error: 'Only available in Test Mode' };
  try {
    if (!mediaProbe) throw new Error('Media duration probe is not initialized');
    const mediaId = String(payload && payload.mediaId || '').trim();
    if (!mediaId) throw new Error('Select a media item first');

    let filePath;
    let hintedDurationMs = 0;
    let assetId = null;
    let cache = null;

    if (mediaId.startsWith('asset:')) {
      assetId = mediaId.slice('asset:'.length);
      cache = normalizeSyncPayload(
        readJson(CACHE_PATH, { revision: 0, schedules: [], assets: [] })
      );
      const asset = cache.assets.find(item => item.id === assetId);
      if (!asset) throw new Error('Downloaded asset metadata was not found');
      filePath = mediaManager.getAssetPath(asset);
      hintedDurationMs = Number(asset.durationMs) || 0;
    } else {
      const selected = scanMediaLibrary(CFG.MEDIA_LIBRARY_DIR)
        .find(item => item.id === mediaId);
      if (!selected) throw new Error('Selected film is no longer available in the Media Folder');
      filePath = selected.path;
    }

    const result = await mediaProbe.probe(filePath, hintedDurationMs);
    if (assetId && cache && !hintedDurationMs) {
      const assets = cache.assets.map(asset => (
        asset.id === assetId ? { ...asset, durationMs: result.durationMs } : asset
      ));
      writeJson(CACHE_PATH, {
        revision: cache.revision,
        updatedAt: new Date().toISOString(),
        schedules: cache.schedules,
        assets,
        mock: true
      });
    }
    return {
      ok: true,
      durationMs: result.durationMs,
      source: result.source
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

async function resolveTestMediaItem(mediaId, order = 0) {
  const normalizedId = String(mediaId || '').trim();
  if (!normalizedId) throw new Error('Playlist contains an invalid media item');

  if (normalizedId.startsWith('asset:')) {
    const assetId = normalizedId.slice('asset:'.length);
    const cache = normalizeSyncPayload(
      readJson(CACHE_PATH, { revision: 0, schedules: [], assets: [] })
    );
    const asset = cache.assets.find(item => item.id === assetId);
    if (!asset) {
      throw new Error('A downloaded playlist item is no longer registered. Refresh the list.');
    }
    if (!mediaManager) throw new Error('Media manager is not initialized');
    const localPath = await mediaManager.prepareAsset(asset);
    if (!asset.durationMs && mediaProbe) {
      try {
        const duration = await mediaProbe.probe(localPath);
        asset.durationMs = duration.durationMs;
        writeJson(CACHE_PATH, {
          revision: cache.revision,
          updatedAt: new Date().toISOString(),
          schedules: cache.schedules,
          assets: cache.assets.map(item => item.id === asset.id ? asset : item),
          mock: true
        });
      } catch (error) {
        appendVlcLog(`[media-duration] ${asset.id}: ${error.message}`);
      }
    }
    return {
      assetId: asset.id,
      localPath,
      path: localPath,
      title: path.basename(asset.filename, path.extname(asset.filename)),
      order
    };
  }

  const selected = scanMediaLibrary(CFG.MEDIA_LIBRARY_DIR)
    .find(item => item.id === normalizedId);
  if (!selected) {
    throw new Error('A playlist item is no longer available in the Media Folder. Refresh the list.');
  }
  return {
    localPath: selected.path,
    path: selected.path,
    title: selected.title,
    order
  };
}

async function importTestRemoteAsset(payload) {
  if (!mediaManager) throw new Error('Media manager is not initialized');
  const sha256 = String(payload && payload.sha256 || '').trim().toLowerCase();
  const asset = normalizeAsset({
    id: `test-${sha256.slice(0, 24)}`,
    filename: payload && payload.filename,
    downloadUrl: payload && payload.downloadUrl,
    size: Number(payload && payload.size),
    sha256,
    mimeType: 'video/mp4'
  });
  const localPath = await mediaManager.prepareAsset(asset);
  if (mediaProbe) {
    try {
      const duration = await mediaProbe.probe(localPath);
      asset.durationMs = duration.durationMs;
    } catch (error) {
      appendVlcLog(`[media-duration] ${asset.id}: ${error.message}`);
    }
  }

  const cache = normalizeSyncPayload(
    readJson(CACHE_PATH, { revision: 0, schedules: [], assets: [] })
  );
  writeJson(CACHE_PATH, {
    revision: cache.revision,
    updatedAt: new Date().toISOString(),
    schedules: cache.schedules,
    assets: mergeAssets(cache.assets, [asset]),
    mock: true
  });
  return {
    mediaId: `asset:${asset.id}`,
    asset,
    localPath
  };
}

ipcMain.handle('import-test-asset', async (_event, payload) => {
  try {
    if (!cfg || !cfg.bypass) throw new Error('Only available in Test Mode');
    return { ok: true, ...(await importTestRemoteAsset(payload)) };
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
});

ipcMain.handle('add-test-schedule', async (_e, payload) => {
  try {
    if (!cfg || !cfg.bypass) throw new Error('Only available in Test Mode');
    if (!payload) throw new Error('No payload');
    const scheduleId = String(payload.scheduleId || '').trim();
    const title = String(payload.title || '').trim();
    const mediaSource = String(payload.mediaSource || 'library');
    const dateStr = String(payload.startDate || '').trim();
    const timeStr = String(payload.startTime || '').trim();
    const durationMinutes = parseInt(payload.durationMinutes, 10);
    const durationSeconds = parseInt(payload.durationSeconds, 10);
    const priority = Number(payload.priority) || 0;
    const recurrenceFreq = String(payload.recurrenceFreq || 'one-time');
    const recurrenceDays = Array.isArray(payload.daysOfWeek)
      ? payload.daysOfWeek.map(Number)
      : [];
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
    if (recurrenceFreq === 'one-time' && start.getTime() <= now.getTime()) {
      throw new Error('Start date/time has already passed');
    }

    const end = new Date(start.getTime() + durationMs);
    let mediaIds = Array.isArray(payload.mediaIds)
      ? payload.mediaIds.map(item => String(item || '').trim()).filter(Boolean)
      : [];

    // Compatibility with schedules submitted by the previous single-media form.
    if (!mediaIds.length && mediaSource === 'library') {
      const legacyMediaId = String(payload.mediaId || '').trim();
      if (legacyMediaId) mediaIds = [legacyMediaId];
    } else if (!mediaIds.length && mediaSource === 'remote') {
      const imported = await importTestRemoteAsset(payload);
      mediaIds = [imported.mediaId];
    }
    if (!mediaIds.length) throw new Error('Add at least one media item to the playlist');
    if (new Set(mediaIds).size !== mediaIds.length) {
      throw new Error('The same media item cannot appear twice in a playlist');
    }
    const playlist = [];
    for (let index = 0; index < mediaIds.length; index += 1) {
      playlist.push(await resolveTestMediaItem(mediaIds[index], index));
    }

    const cache = normalizeSyncPayload(
      readJson(CACHE_PATH, { revision: 0, schedules: [], assets: [] })
    );
    const existing = scheduleId
      ? cache.schedules.find(schedule => schedule.id === scheduleId)
      : null;
    if (scheduleId && !existing) throw new Error('Schedule to edit was not found');

    const recurrence = recurrenceFreq === 'one-time'
      ? null
      : {
          freq: recurrenceFreq,
          daysOfWeek: recurrenceFreq === 'weekly' ? recurrenceDays : []
        };
    const newSchedule = normalizeSchedule({
      id: scheduleId || ('manual-' + Date.now()),
      title,
      priority,
      revision: existing ? existing.revision + 1 : 0,
      enabled: existing ? existing.enabled : true,
      startTime: start.toISOString(),
      endTime: end.toISOString(),
      recurrence,
      loop: payload.loop !== false,
      playlist
    });

    const schedules = existing
      ? cache.schedules.map(schedule => schedule.id === existing.id ? newSchedule : schedule)
      : [...cache.schedules, newSchedule];
    writeJson(CACHE_PATH, {
      revision: cache.revision,
      updatedAt: new Date().toISOString(),
      schedules,
      assets: cache.assets,
      mock: true
    });
    await refreshMediaHealth(schedules, cache.assets, { force: true });
    if (scheduler) {
      scheduler.update(schedules);
      if (existing) scheduler.reactivate(existing.id);
    }
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

ipcMain.handle('reset-pairing', async () => {
  if (!cfg || cfg.bypass) {
    logout();
    return { ok: true };
  }
  const denied = operatorAccessError(); if (denied) return denied;
  try {
    const client = new CmsClient({ serverURL: cfg.serverURL });
    await client.unregister(cfg.token);
    logout();
    return { ok: true };
  } catch (error) {
    if (error instanceof CmsApiError && error.status === 401) {
      // The CMS already considers this token invalid, so keeping it locally
      // cannot recover the pairing. Clearing it lets the operator pair again.
      logout();
      return { ok: true };
    }
    return {
      ok: false,
      error: `CMS could not revoke this pairing. Local credentials were kept: ${error.message || error}`
    };
  }
});

ipcMain.handle('quit', async () => {
  quitApp();
  return { ok: true };
});

async function startRuntime() {
  if (!cfg || !cfg.token) return;
  playbackCheckpoint = null;
  lastResumeInfo = null;
  mediaHealthMonitor = null;
  mediaHealthSnapshot = null;
  mediaHealthCheck = null;
  if (playbackWatchdog) playbackWatchdog.stop();
  playbackWatchdog = null;
  if (vlc) vlc.quit();
  mediaManager = new MediaManager({
    mediaDir: path.join(DATA_DIR, 'media'),
    concurrency: 2
  });
  mediaHealthMonitor = new MediaHealthMonitor({ storagePath: mediaManager.mediaDir });
  mediaHealthSnapshot = mediaHealthMonitor.getSnapshot();
  mediaProbe = new MediaProbe({ cachePath: DURATION_CACHE_PATH });
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
    transitionDuration: 500,
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
  vlc.on('playback-progress', playback => {
    const active = scheduler ? scheduler.getNow() : null;
    if (
      active && !vlc.idleMode &&
      (vlc.state === 'playing' || vlc.state === 'paused') &&
      playback && Number.isInteger(playback.currentIndex) && playback.currentIndex >= 0
    ) {
      playbackCheckpoint = {
        scheduleId: active.scheduleId,
        occurrenceStart: active.startTime,
        currentIndex: playback.currentIndex,
        currentPath: playback.currentPath,
        positionSeconds: Math.max(0, Number(playback.positionSeconds) || 0),
        lengthSeconds: Math.max(0, Number(playback.lengthSeconds) || 0),
        capturedAt: new Date().toISOString()
      };
    }
    pushDashboard();
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
  scheduler = new Scheduler(vlc, {
    isMediaReady: file => mediaHealthMonitor.isReady(file)
  });
  scheduler.on('activate', (info) => {
    nowSchedule = info.schedule;
    const active = scheduler.getNow();
    if (!playbackCheckpoint || !active ||
        playbackCheckpoint.scheduleId !== active.scheduleId ||
        playbackCheckpoint.occurrenceStart !== active.startTime) {
      playbackCheckpoint = null;
    }
    lastResumeInfo = null;
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
  scheduler.on('media-unavailable', ({ schedule, files }) => {
    const titles = files.map(file => file.title || file.path || file.assetId).join(', ');
    appendVlcLog(`[media-health] schedule ${schedule.id} skipped unavailable media: ${titles}`);
    refreshMediaHealth(scheduler.schedules, getCachedAssets()).catch(() => {});
    pushDashboard();
  });

  playbackWatchdog = new PlaybackWatchdog({
    intervalMs: 3000,
    failureThreshold: 2,
    maxAttempts: 5,
    backoffMs: [0, 2000, 5000, 15000, 30000],
    isPlaybackExpected: () => {
      const active = scheduler && scheduler.getNow();
      return Boolean(active && active.files && active.files.length);
    },
    isHealthy: () => isVlcPlaybackHealthy(),
    recover: async ({ attempt, maxAttempts }) => {
      appendVlcLog(`[watchdog] recovery attempt ${attempt}/${maxAttempts}`);
      const checkpoint = playbackCheckpoint ? { ...playbackCheckpoint } : null;
      await vlc.start();
      if (scheduler) {
        const schedules = scheduler.schedules.slice();
        scheduler.recover(schedules);
      }
      await waitForVlcRecovery();
      const active = scheduler ? scheduler.getNow() : null;
      const resumeTarget = resolveResumeTarget(checkpoint, active);
      if (resumeTarget) {
        await vlc.resumePlaylistAt(resumeTarget.currentIndex, resumeTarget.positionSeconds);
        const file = resumeTarget.file;
        lastResumeInfo = {
          scheduleId: active.scheduleId,
          currentIndex: resumeTarget.currentIndex,
          positionSeconds: resumeTarget.positionSeconds,
          title: file && (file.title || file.path || file.assetId) || 'media',
          resumedAt: new Date().toISOString()
        };
        appendVlcLog(
          `[watchdog] resumed ${lastResumeInfo.title} at ${resumeTarget.positionSeconds}s ` +
          `(playlist index ${resumeTarget.currentIndex})`
        );
        pushDashboard();
      }
    }
  });
  playbackWatchdog.on('attempt', ({ attempt, maxAttempts }) => {
    appendVlcLog(`[watchdog] attempting automatic recovery ${attempt}/${maxAttempts}`);
    setStatus('vlc-recovering');
  });
  playbackWatchdog.on('failed-attempt', status => {
    appendVlcLog(`[watchdog] attempt ${status.attempts} failed: ${status.lastError}`);
    setStatus('vlc-recovering');
  });
  playbackWatchdog.on('recovered', status => {
    appendVlcLog(`[watchdog] playback recovered at ${status.lastRecoveredAt}`);
    setStatus(getRuntimeStatus());
  });
  playbackWatchdog.on('exhausted', status => {
    appendVlcLog(`[watchdog] stopped after ${status.attempts} attempts: ${status.lastError}`);
    setStatus('vlc-error');
  });
  playbackWatchdog.on('state-change', () => pushDashboard());
  playbackWatchdog.on('internal-error', error => {
    appendVlcLog(`[watchdog] internal error: ${error.message}`);
  });

  try {
        await vlc.start();
    } catch (e) {
        console.error("VLC start failed", e);
        setStatus("vlc-error");
    }

  const cache = readJson(CACHE_PATH, { revision: 0, schedules: [], assets: [] });
  try {
    const normalizedCache = normalizeSyncPayload(cache);
    const prepared = await mediaManager.prepareSchedules(
      normalizedCache.schedules,
      normalizedCache.assets
    );
    await refreshMediaHealth(prepared, normalizedCache.assets, { force: true });
    scheduler.update(prepared);
  } catch (error) {
    appendVlcLog(`[cache] invalid: ${error.message}`);
    await refreshMediaHealth([], [], { force: true });
    scheduler.update([]);
  }

  app.setLoginItemSettings({ openAtLogin: true, path: process.execPath });

  playbackWatchdog.start();
  startCmsConnection();
  if (CFG.SOCKET_ENABLED) connectSocket();
  refreshTray();
}

function stopCmsConnection() {
  if (cmsClient) cmsClient.stop();
  cmsClient = null;
}

function startCmsConnection() {
  stopCmsConnection();
  if (!cfg || cfg.bypass) {
    cmsState = { status: 'test-mode (no server)', lastHeartbeatAt: null, lastError: null };
    setStatus(cmsState.status);
    return;
  }

  cmsClient = new CmsClient({
    serverURL: cfg.serverURL,
    heartbeatIntervalMs: CFG.HEARTBEAT_INTERVAL_MS
  });
  cmsState = { status: 'connecting', lastHeartbeatAt: null, lastError: null };
  cmsClient.on('status', status => {
    cmsState.status = status;
    setStatus(status);
  });
  cmsClient.on('heartbeat', data => {
    cmsState.lastHeartbeatAt = new Date().toISOString();
    cmsState.lastError = null;
    if (data && data.device_id) cfg.deviceId = data.device_id;
    pushDashboard();
  });
  cmsClient.on('connection-error', error => {
    cmsState.lastError = error.message || String(error);
    appendVlcLog(`[cms] ${cmsState.lastError}`);
    pushDashboard();
  });
  cmsClient.on('authentication-error', error => {
    cmsState.lastError = error.message || String(error);
    appendVlcLog(`[cms] authentication failed: ${cmsState.lastError}`);
    pushDashboard();
  });
  cmsClient.start(cfg.token, {
    app_version: app.getVersion(),
    platform: `${process.platform}-${process.arch}`,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Jakarta'
  });
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
  await refreshMediaHealth(prepared, assets, { force: true });
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
  await refreshMediaHealth(prepared, current.assets, { force: true });
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
  setupSession = null;
  operatorSession = null;
  playbackCheckpoint = null;
  lastResumeInfo = null;
  const wasBypass = Boolean(cfg && cfg.bypass);
  try { if (socket) socket.disconnect(); } catch (_) {}
  socket = null;
  stopCmsConnection();
  if (broadcastHandle) { clearInterval(broadcastHandle); broadcastHandle = null; }
  if (playbackWatchdog) { playbackWatchdog.stop(); playbackWatchdog = null; }
  if (scheduler) { scheduler.clear(); scheduler = null; }
  if (vlc) { vlc.quit(); vlc = null; }
  if (scheduleAdderWin && !scheduleAdderWin.isDestroyed()) scheduleAdderWin.destroy();
  if (scheduleManagerWin && !scheduleManagerWin.isDestroyed()) scheduleManagerWin.destroy();
  destroyTransitionOverlay();
  if (wasBypass) resetTestCachePreservingAssets();
  else if (fs.existsSync(CACHE_PATH)) fs.unlinkSync(CACHE_PATH);
  saveConfig(null);
  nowSchedule = null;
  setStatus('offline');
  createLoginWindow();
  isShuttingDown = false;
}

function quitApp() {
  isShuttingDown = true;
  try { if (socket) socket.disconnect(); } catch (_) {}
  stopCmsConnection();
  if (broadcastHandle) { clearInterval(broadcastHandle); broadcastHandle = null; }
  if (playbackWatchdog) { playbackWatchdog.stop(); playbackWatchdog = null; }
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
  try {
    cfg = credentialStore.load();
  } catch (error) {
    console.error('Credential load failed', error);
    cfg = null;
    dialog.showErrorBox('Player credentials unavailable', error.message || String(error));
  }
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
  stopCmsConnection();
  if (playbackWatchdog) { playbackWatchdog.stop(); playbackWatchdog = null; }
  if (scheduler) scheduler.clear();
  if (vlc) vlc.quit();
  destroyTransitionOverlay();
});

app.on('will-quit', () => {
  isShuttingDown = true;
  try { if (socket) socket.disconnect(); } catch (_) {}
  stopCmsConnection();
  if (playbackWatchdog) { playbackWatchdog.stop(); playbackWatchdog = null; }
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
