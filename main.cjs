'use strict';

const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, shell, screen, dialog, safeStorage, desktopCapturer } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { pathToFileURL } = require('url');
const { VlcController } = require('./vlcController.cjs');
const { Scheduler, nextOccurrenceStart } = require('./scheduler.cjs');
const {
  normalizeAsset,
  normalizeSchedule,
  normalizeSyncPayload
} = require('./contracts.cjs');
const { MediaManager } = require('./mediaManager.cjs');
const { scanMediaLibrary } = require('./mediaLibrary.cjs');
const { buildAssetInventory } = require('./assetInventory.cjs');
const { scanBeforeRemoteDistribution } = require('./assetRefresh.cjs');
const { MediaProbe } = require('./mediaProbe.cjs');
const { PlaybackWatchdog } = require('./playbackWatchdog.cjs');
const {
  ManualPlaybackSession,
  manualPlaybackAvailability,
  normalizeManualRange
} = require('./manualPlayback.cjs');
const {
  isPlaybackAlertStatus,
  isPlaybackExpected,
  isVlcPlaybackHealthy: resolveVlcPlaybackHealth,
  resolvePlaybackTelemetry
} = require('./playbackState.cjs');
const { resolveResumeTarget } = require('./playbackResume.cjs');
const { MediaHealthMonitor } = require('./mediaHealth.cjs');
const { CmsClient, normalizeServerUrl, parseSessionExpiry } = require('./cmsClient.cjs');
const { RealtimeClient } = require('./realtimeClient.cjs');
const { DeviceCredentials } = require('./deviceCredentials.cjs');
const { removeManagedAsset } = require('./managedAssetCleanup.cjs');
const { normalizeRevision, revisionSyncAction } = require('./revisionSync.cjs');
const { choosePlaybackDisplay, chooseIdleDisplay } = require('./displaySelector.cjs');
const {
  DEFAULT_PLAYBACK_SETTINGS,
  normalizePlaybackSettings,
  resolveOutputSize
} = require('./playbackSettings.cjs');
const { LdgGateway } = require('./ldg.cjs');
const { resolveVlcRcPort } = require('./runtimeIsolation.cjs');
const { listWindowsAudioOutputs } = require('./windowsAudioDevices.cjs');
const {
  PREVIEW_WIDTH,
  PREVIEW_HEIGHT,
  PREVIEW_INTERVAL_MS,
  resolvePreviewState,
  selectDisplaySource,
  shouldCapturePreview
} = require('./playbackPreview.cjs');
const CFG = require('./config.cjs');

if (process.env.PLAYER_USER_DATA) {
  app.setPath('userData', process.env.PLAYER_USER_DATA);
}
const DATA_DIR = app.getPath('userData');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const INSTALLATION_PATH = path.join(DATA_DIR, 'installation.json');
const CACHE_PATH = path.join(DATA_DIR, 'schedules.json');
const DURATION_CACHE_PATH = path.join(DATA_DIR, 'media-durations.json');
const PLAYBACK_SETTINGS_PATH = path.join(DATA_DIR, 'playback-settings.json');
const VLC_RC_PORT = resolveVlcRcPort(
  CFG.VLC_RC_PORT,
  DATA_DIR,
  process.env.PLAYER_VLC_RC_PORT,
  Boolean(process.env.PLAYER_USER_DATA)
);

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();
else {
  app.on('second-instance', () => {
    const win = dashboardWin && !dashboardWin.isDestroyed() ? dashboardWin : loginWin;
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
}

let tray = null;
let loginWin = null;
let dashboardWin = null;
let scheduleAdderWin = null;
let scheduleManagerWin = null;
let realtimeClient = null;
let cmsClient = null;
let cmsState = { status: 'offline', lastHeartbeatAt: null, lastError: null };
let realtimeState = {
  status: 'disabled', connected: false, url: '', lastConnectedAt: null,
  lastEventAt: null, lastError: null
};
let setupSession = null;
let operatorSession = null;
let vlc = null;
let windowsAudioDevices = [];
let windowsAudioLastError = null;
let windowsAudioRefreshPromise = null;
let scheduler = null;
let cfg = null;
let statusLabel = 'offline';
let nowSchedule = null;
let broadcastHandle = null;
let playbackPreviewHandle = null;
let playbackPreviewBusy = false;
let playbackPreviewSignature = '';
let playbackPreviewStreaming = false;
let secondDisplay = null;
let idleDisplay = null;
let hasDedicatedPlaybackDisplay = false;
let hasSecondaryPlaybackDisplay = false;
let idleDisplayPreferenceAvailable = true;
let transitionWin = null;
let filmOutputWin = null;
let filmOutputDisplayId = null;
let filmOutputHwnd = null;
let filmOutputPromise = null;
let idleOutputWin = null;
let idleOutputDisplayId = null;
let idleOutputPromise = null;
let identifyDisplayWindows = [];
let testOutputWin = null;
let singleDisplayWarningVisible = false;
let singleDisplayWarningAcknowledged = false;
let playbackSettings = { ...DEFAULT_PLAYBACK_SETTINGS };
let appliedPlaybackSettings = { ...DEFAULT_PLAYBACK_SETTINGS };
let playbackSettingsPending = false;
let isShuttingDown = false;
let mediaManager = null;
let ldgGateway = null;
let mediaProbe = null;
let playbackWatchdog = null;
let manualPlayback = null;
let playbackCheckpoint = null;
let lastResumeInfo = null;
let mediaHealthMonitor = null;
let mediaHealthSnapshot = null;
let mediaHealthCheck = null;
let syncQueue = Promise.resolve();
let pairingNotice = '';
let refreshPromise = null;
let refreshState = { status: 'idle', lastRefreshedAt: null, lastError: null };
let assetUploadPromise = null;
let remoteDistributionPromise = null;
let scheduleSyncQueue = Promise.resolve();
let initialAssetSyncStarted = false;
let nextAssetSyncAttemptAt = 0;
let nextLdgLicenseRefreshAt = 0;
let appliedAssetRevision = null;
let appliedScheduleRevision = null;
let heartbeatRevisionSyncPromise = null;
let pendingRemovalRetry = false;
let playbackShutdownPromise = null;
let quitPromise = null;
let allowAppQuit = false;
let assetSyncState = { status: 'idle', lastSyncedAt: null, lastError: null, summary: null };
let remoteDownloadState = { status: 'idle', assignedCount: 0, updatedAt: null, lastError: null, items: [] };
const downloadProgressBroadcastAt = new Map();
const credentialStore = new DeviceCredentials({
  configPath: CONFIG_PATH,
  installationPath: INSTALLATION_PATH,
  safeStorage
});
const DASHBOARD_IDLE_LOCK_MS = 15 * 60 * 1000;

function isTestModeEnabled() {
  return !app.isPackaged && process.env.PLAYER_ENABLE_TEST_MODE === '1';
}

function getDevelopmentDownloadLimitBytesPerSecond() {
  if (app.isPackaged) return 0;
  const kilobytesPerSecond = Number(process.env.PLAYER_DOWNLOAD_LIMIT_KBPS);
  return Number.isFinite(kilobytesPerSecond) && kilobytesPerSecond > 0
    ? Math.round(kilobytesPerSecond * 1024)
    : 0;
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

function applyDeviceMetadata(data) {
  if (!cfg || cfg.bypass || !data || typeof data !== 'object') return false;
  const fields = {
    deviceId: data.device_id,
    deviceName: data.device_name,
    deviceLocation: data.device_location,
    deviceTimezone: data.device_timezone,
    realtimeUrl: data.realtime_url
  };
  let changed = false;
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    const normalized = value === null ? '' : String(value);
    if (cfg[key] !== normalized) {
      cfg[key] = normalized;
      changed = true;
    }
  }
  if (changed) saveConfig(cfg);
  return changed;
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
    { label: `Realtime: ${trayRealtimeLabel()}`, enabled: false },
    { label: `Device: ${cfg && cfg.deviceId || '-'}`, enabled: false },
    { label: next, enabled: false }
  ];
  if (statusLabel === 'vlc-error') {
    items.push({ label: 'VLC not found — drop vlc.exe in vlc-portable/', enabled: false });
  }
  items.push({ type: 'separator' });
  items.push({ label: 'Open Player', click: () => showPlayerWindow() });
  items.push({
    label: refreshState.status === 'refreshing' ? 'Refreshing from CMS...' : 'Refresh from CMS',
    enabled: refreshState.status !== 'refreshing',
    click: () => { void refreshPlayer('tray'); }
  });
  items.push({
    label: 'Reconnect CMS',
    click: () => {
      if (cfg && !cfg.bypass) startCmsConnection();
      if (CFG.SOCKET_ENABLED) ensureRealtimeConnection();
    }
  });
  items.push({
    label: 'Retry VLC',
    enabled: Boolean(
      isPlaybackExpected(scheduler && scheduler.getNow()) &&
      !(playbackWatchdog && ['degraded', 'recovering', 'waiting'].includes(playbackWatchdog.state))
    ),
    click: () => { void retryVlcPlayback(); }
  });
  items.push({ label: 'Open Config Folder', click: () => { shell.openPath(DATA_DIR); } });
  items.push({ label: 'Logout', click: () => { void logout(); } });
  items.push({ type: 'separator' });
  items.push({ label: 'Quit Player', click: () => { void quitApp(); } });
  return Menu.buildFromTemplate(items);
}

function trayRealtimeLabel() {
  if (realtimeState.status === 'connected') return 'SOCKET.IO CONNECTED';
  if (realtimeState.status === 'connecting' || realtimeState.status === 'reconnecting') return 'RECONNECTING';
  if (realtimeState.status === 'session-replaced') return 'SESSION REPLACED — REST FALLBACK';
  if (realtimeState.status === 'authentication-error') return 'PAIRING INVALID';
  if (realtimeState.status === 'test-mode') return 'DISABLED IN TEST MODE';
  if (realtimeState.status === 'fallback') return 'REST FALLBACK';
  return 'REST HEARTBEAT';
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
  dashboardWin.webContents.once('did-finish-load', () => {
    startPlaybackPreviewLoop();
    void capturePlaybackPreview();
  });
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

function showPlayerWindow() {
  if (cfg && cfg.token) {
    showDashboard();
    return;
  }
  createLoginWindow();
  if (loginWin && !loginWin.isDestroyed()) {
    loginWin.show();
    loginWin.focus();
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
  const targetDisplay = vlc && !vlc.idleMode ? secondDisplay : (idleDisplay || secondDisplay);
  if (!targetDisplay || !hasSecondaryPlaybackDisplay) return;
  if (transitionWin && !transitionWin.isDestroyed()) return;
  transitionWin = new BrowserWindow({
    x: targetDisplay.bounds.x,
    y: targetDisplay.bounds.y,
    width: targetDisplay.bounds.width,
    height: targetDisplay.bounds.height,
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
  transitionWin.__playerDisplayId = String(targetDisplay.id);
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
    const targetDisplay = vlc && !vlc.idleMode ? secondDisplay : (idleDisplay || secondDisplay);
    if (
      transitionWin && !transitionWin.isDestroyed() && targetDisplay &&
      transitionWin.__playerDisplayId !== String(targetDisplay.id)
    ) {
      destroyTransitionOverlay();
    }
    if (!transitionWin || transitionWin.isDestroyed()) createTransitionWindow();
    if (transitionWin && !transitionWin.isDestroyed()) {
      transitionWin.showInactive();
      // filmOutputWin uses the same screen-saver always-on-top level and may
      // have been shown after this cover. Reassert and move the cover to the
      // top so VLC's pre-seek frame can never flash through.
      transitionWin.setAlwaysOnTop(true, 'screen-saver');
      if (typeof transitionWin.moveTop === 'function') transitionWin.moveTop();
    }
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

function resolveIdleOutputMediaPath() {
  const candidates = [
    path.join(process.resourcesPath || '', 'idle', 'idle-black.mp4'),
    path.join(__dirname, 'assets', 'idle-black.mp4')
  ];
  return candidates.find(candidate => candidate && fs.existsSync(candidate)) || null;
}

function packagedFileUrl(filePath, query = {}) {
  const url = pathToFileURL(path.resolve(filePath));
  for (const [key, value] of Object.entries(query)) {
    if (value != null && value !== '') url.searchParams.set(key, String(value));
  }
  return url.href;
}

function nativeWindowHandleToString(handle) {
  if (!Buffer.isBuffer(handle) || handle.length < 4) {
    throw new Error('Electron did not provide a valid native output window handle');
  }
  return handle.length >= 8
    ? handle.readBigUInt64LE(0).toString()
    : String(handle.readUInt32LE(0));
}

function filmOutputGeometry(display = secondDisplay) {
  if (!display) return null;
  const fullscreen = appliedPlaybackSettings.outputMode === 'fullscreen';
  const output = resolveOutputSize(appliedPlaybackSettings, display);
  return {
    fullscreen,
    x: fullscreen ? display.bounds.x : display.bounds.x + Math.max(0, Math.round((display.bounds.width - output.width) / 2)),
    y: fullscreen ? display.bounds.y : display.bounds.y + Math.max(0, Math.round((display.bounds.height - output.height) / 2)),
    width: fullscreen ? display.bounds.width : output.width,
    height: fullscreen ? display.bounds.height : output.height
  };
}

function outputRectangle(geometry) {
  return {
    x: geometry.x,
    y: geometry.y,
    width: geometry.width,
    height: geometry.height
  };
}

function destroyFilmOutput() {
  filmOutputPromise = null;
  filmOutputDisplayId = null;
  filmOutputHwnd = null;
  if (vlc) vlc.drawableHwnd = null;
  try {
    if (filmOutputWin && !filmOutputWin.isDestroyed()) filmOutputWin.destroy();
  } catch (_) {}
  filmOutputWin = null;
}

function hideFilmOutput() {
  try {
    if (filmOutputWin && !filmOutputWin.isDestroyed()) filmOutputWin.hide();
  } catch (_) {}
}

function createFilmOutputWindow() {
  if (!secondDisplay || isShuttingDown) return null;
  const targetId = String(secondDisplay.id);
  if (
    filmOutputWin && !filmOutputWin.isDestroyed() &&
    filmOutputDisplayId === targetId && filmOutputHwnd
  ) {
    if (vlc) vlc.drawableHwnd = filmOutputHwnd;
    return filmOutputHwnd;
  }

  destroyFilmOutput();
  const target = secondDisplay;
  const geometry = filmOutputGeometry(target);
  const win = new BrowserWindow({
    x: geometry.x,
    y: geometry.y,
    width: geometry.width,
    height: geometry.height,
    frame: false,
    fullscreen: geometry.fullscreen,
    kiosk: geometry.fullscreen,
    alwaysOnTop: true,
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
      devTools: false,
      backgroundThrottling: false
    }
  });
  filmOutputWin = win;
  filmOutputDisplayId = targetId;
  filmOutputHwnd = nativeWindowHandleToString(win.getNativeWindowHandle());
  win.removeMenu();
  try {
    win.setBounds(outputRectangle(geometry), false);
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setVisibleOnAllWorkspaces(true);
    win.setIgnoreMouseEvents(true);
  } catch (_) {}
  win.on('closed', () => {
    if (filmOutputWin === win) {
      filmOutputWin = null;
      filmOutputDisplayId = null;
      filmOutputHwnd = null;
      filmOutputPromise = null;
      if (vlc) vlc.drawableHwnd = null;
    }
  });
  filmOutputPromise = win.loadURL(packagedFileUrl(path.join(__dirname, 'filmOutput.html'))).catch(error => {
    if (filmOutputWin === win) destroyFilmOutput();
    throw error;
  }).finally(() => {
    if (filmOutputWin === win) filmOutputPromise = null;
  });
  if (vlc) vlc.drawableHwnd = filmOutputHwnd;
  return filmOutputHwnd;
}

async function showFilmOutput() {
  const handle = createFilmOutputWindow();
  if (!handle || !filmOutputWin || filmOutputWin.isDestroyed()) {
    throw new Error('Film output window is unavailable');
  }
  if (filmOutputPromise) await filmOutputPromise;
  if (!filmOutputWin || filmOutputWin.isDestroyed()) throw new Error('Film output window was closed');
  const geometry = filmOutputGeometry(secondDisplay);
  filmOutputWin.setBounds(outputRectangle(geometry), false);
  filmOutputWin.showInactive();
  try {
    filmOutputWin.setFullScreen(geometry.fullscreen);
    filmOutputWin.setKiosk(geometry.fullscreen);
    filmOutputWin.setAlwaysOnTop(true, 'screen-saver');
  } catch (_) {}
  if (vlc) vlc.drawableHwnd = filmOutputHwnd;
  return filmOutputHwnd;
}

function destroyIdleOutput() {
  idleOutputPromise = null;
  idleOutputDisplayId = null;
  try {
    if (idleOutputWin && !idleOutputWin.isDestroyed()) idleOutputWin.destroy();
  } catch (_) {}
  idleOutputWin = null;
}

function hideIdleOutput() {
  try {
    if (idleOutputWin && !idleOutputWin.isDestroyed()) idleOutputWin.hide();
  } catch (_) {}
}

async function showIdleOutput() {
  if (!hasSecondaryPlaybackDisplay || !idleDisplay || isShuttingDown) {
    destroyIdleOutput();
    hideFilmOutput();
    hideTransitionOverlay();
    return;
  }
  const targetId = String(idleDisplay.id);
  if (idleOutputPromise && idleOutputDisplayId === targetId) return idleOutputPromise;
  if (idleOutputWin && !idleOutputWin.isDestroyed() && idleOutputDisplayId === targetId) {
    idleOutputWin.showInactive();
    hideFilmOutput();
    hideTransitionOverlay();
    return;
  }

  destroyIdleOutput();
  const target = idleDisplay;
  const mediaPath = resolveIdleOutputMediaPath();
  if (!mediaPath) appendVlcLog('[idle] bundled video unavailable; using the HTML black-screen fallback');

  idleOutputDisplayId = targetId;
  const win = new BrowserWindow({
    x: target.bounds.x,
    y: target.bounds.y,
    width: target.bounds.width,
    height: target.bounds.height,
    frame: false,
    fullscreen: true,
    kiosk: true,
    alwaysOnTop: true,
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
      devTools: false,
      backgroundThrottling: false
    }
  });
  idleOutputWin = win;
  win.removeMenu();
  try {
    win.setBounds(target.bounds, false);
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setVisibleOnAllWorkspaces(true);
    win.setIgnoreMouseEvents(true);
  } catch (_) {}
  win.on('closed', () => {
    if (idleOutputWin === win) {
      idleOutputWin = null;
      idleOutputDisplayId = null;
      idleOutputPromise = null;
    }
  });

  idleOutputPromise = win.loadURL(packagedFileUrl(path.join(__dirname, 'idleOutput.html'), {
    media: mediaPath ? pathToFileURL(mediaPath).href : ''
  })).then(() => {
    if (win.isDestroyed() || idleOutputWin !== win) return;
    win.setBounds(target.bounds, false);
    win.showInactive();
    try {
      win.setFullScreen(true);
      win.setKiosk(true);
      win.setAlwaysOnTop(true, 'screen-saver');
    } catch (_) {}
    hideFilmOutput();
    hideTransitionOverlay();
  }).catch(error => {
    if (idleOutputWin === win) destroyIdleOutput();
    throw error;
  }).finally(() => {
    if (idleOutputWin === win) idleOutputPromise = null;
  });
  return idleOutputPromise;
}

async function showSingleDisplayWarning() {
  if (
    hasSecondaryPlaybackDisplay ||
    singleDisplayWarningVisible ||
    singleDisplayWarningAcknowledged
  ) return;

  singleDisplayWarningVisible = true;
  let recheckRequested = false;
  try {
    const playbackImpact = appliedPlaybackSettings.outputMode === 'windowed'
      ? 'Windowed playback will use this monitor. Other applications remain available, but the film shares the operator display.'
      : 'Fullscreen playback will use this monitor, so the Player dashboard and other applications will be hidden while a film is playing.';
    const result = await dialog.showMessageBox({
      type: 'warning',
      title: 'Single Monitor Mode',
      message: 'Only one monitor was detected.',
      detail: [
        playbackImpact,
        '',
        'When the schedule finishes, VLC will close and this monitor will return to the desktop.',
        '',
        'Connect a second monitor to keep the dashboard on the primary monitor and use the other monitor exclusively for film output.'
      ].join('\n'),
      buttons: ['Continue with One Monitor', 'Check Again'],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    });

    if (result.response === 1) {
      recheckRequested = true;
      refreshPlaybackDisplay();
    } else {
      singleDisplayWarningAcknowledged = true;
    }
  } catch (error) {
    console.error('Single-display warning failed', error);
    singleDisplayWarningAcknowledged = true;
  } finally {
    singleDisplayWarningVisible = false;
  }

  if (recheckRequested && !hasSecondaryPlaybackDisplay) {
    setTimeout(() => showSingleDisplayWarning(), 0);
  }
}

function refreshPlaybackDisplay() {
  const previouslySecondary = hasSecondaryPlaybackDisplay;
  const displays = screen.getAllDisplays();
  const primaryDisplay = screen.getPrimaryDisplay();
  const selection = choosePlaybackDisplay(
    displays,
    primaryDisplay,
    appliedPlaybackSettings.displayId
  );
  const idleSelection = chooseIdleDisplay(
    displays,
    selection.display,
    appliedPlaybackSettings.idleDisplayId
  );
  const previousDisplayId = secondDisplay && secondDisplay.id;
  const previousIdleDisplayId = idleDisplay && idleDisplay.id;
  const nextDisplayId = selection.display && selection.display.id;
  const nextIdleDisplayId = idleSelection.display && idleSelection.display.id;
  const displayChanged = (
    (previousDisplayId != null && previousDisplayId !== nextDisplayId) ||
    (previousIdleDisplayId != null && previousIdleDisplayId !== nextIdleDisplayId)
  );

  secondDisplay = selection.display;
  idleDisplay = idleSelection.display;
  hasDedicatedPlaybackDisplay = selection.hasDedicatedDisplay;
  hasSecondaryPlaybackDisplay = selection.hasSecondaryDisplay;
  idleDisplayPreferenceAvailable = idleSelection.preferredAvailable;

  if (hasSecondaryPlaybackDisplay) {
    singleDisplayWarningAcknowledged = false;
  } else if (previouslySecondary) {
    // A newly disconnected output monitor is a new warning incident.
    singleDisplayWarningAcknowledged = false;
  }

  destroyTransitionOverlay();
  if (displayChanged) destroyIdleOutput();

  if (vlc) {
    vlc.playbackDisplay = secondDisplay;
    vlc.idleDisplay = idleDisplay;
    vlc.display = vlc.idleMode ? idleDisplay : secondDisplay;
    vlc.settings = appliedPlaybackSettings;
    if (!scheduler || !scheduler.getNow()) {
      destroyFilmOutput();
      vlc.drawableHwnd = createFilmOutputWindow();
    }
  }

  if (hasSecondaryPlaybackDisplay && vlc) createTransitionWindow();

  if (scheduler && !scheduler.getNow() && vlc) {
    showTransitionOverlay();
    Promise.resolve(vlc.playIdle()).catch(error => {
      appendVlcLog(`[display] idle refresh failed: ${error.message}`);
    });
    Promise.resolve(showIdleOutput()).catch(error => {
      appendVlcLog(`[display] idle output failed: ${error.message}`);
    });
  }

  pushDashboard();
  if (!hasSecondaryPlaybackDisplay) {
    setTimeout(() => showSingleDisplayWarning(), 0);
  }
}

function applyPendingPlaybackSettings() {
  if (!playbackSettingsPending) return false;
  playbackSettingsPending = false;
  appliedPlaybackSettings = { ...playbackSettings };
  refreshPlaybackDisplay();
  // During a direct schedule-to-schedule transition the previous occurrence
  // is still current while the finish event runs, so refreshPlaybackDisplay
  // does not enter idle mode. Stop the old VLC instance before activation of
  // the next playlist so its new interface/display flags are guaranteed.
  if (scheduler && scheduler.getNow() && vlc) {
    Promise.resolve(vlc.playIdle()).catch(error => {
      appendVlcLog(`[settings] VLC reconfiguration failed: ${error.message}`);
    });
    destroyFilmOutput();
    vlc.drawableHwnd = createFilmOutputWindow();
  }
  return true;
}

function playbackDisplayOptions() {
  const primary = screen.getPrimaryDisplay();
  return screen.getAllDisplays().map((display, index) => ({
    id: String(display.id),
    number: index + 1,
    label: display.label || `Display ${index + 1}`,
    primary: display.id === primary.id,
    width: display.bounds.width,
    height: display.bounds.height,
    x: display.bounds.x,
    y: display.bounds.y
  }));
}

function destroyIdentifyDisplayWindows() {
  for (const win of identifyDisplayWindows) {
    try { if (win && !win.isDestroyed()) win.destroy(); } catch (_) {}
  }
  identifyDisplayWindows = [];
  if (!isShuttingDown && scheduler && !scheduler.getNow() && hasSecondaryPlaybackDisplay) {
    Promise.resolve(showIdleOutput()).catch(error => {
      appendVlcLog(`[display] idle output restore failed: ${error.message}`);
    });
  }
}

function identifyDisplays() {
  destroyIdentifyDisplayWindows();
  hideTransitionOverlay();
  hideIdleOutput();
  const displays = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();
  identifyDisplayWindows = displays.map((display, index) => {
    const win = new BrowserWindow({
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
      frame: false,
      fullscreen: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      focusable: false,
      resizable: false,
      backgroundColor: '#111111',
      webPreferences: { nodeIntegration: false, contextIsolation: true, devTools: false }
    });
    const label = display.label || `Display ${index + 1}`;
    const primaryText = display.id === primary.id ? 'PRIMARY DISPLAY' : 'PLAYBACK DISPLAY';
    const html = `<body style="margin:0;display:grid;place-items:center;background:#111;color:white;font-family:Segoe UI,sans-serif"><div style="text-align:center"><div style="font-size:180px;font-weight:800;line-height:1">${index + 1}</div><div style="font-size:28px;margin-top:18px">${label}</div><div style="font-size:18px;margin-top:10px;color:#ff8b8b">${primaryText} · ${display.bounds.width} × ${display.bounds.height}</div></div></body>`;
    win.removeMenu();
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setIgnoreMouseEvents(true);
    win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`).catch(() => {});
    return win;
  });
  setTimeout(destroyIdentifyDisplayWindows, 3500);
}

function destroyTestOutput() {
  try { if (testOutputWin && !testOutputWin.isDestroyed()) testOutputWin.destroy(); } catch (_) {}
  testOutputWin = null;
  if (!isShuttingDown && scheduler && !scheduler.getNow() && hasSecondaryPlaybackDisplay) {
    Promise.resolve(showIdleOutput()).catch(error => {
      appendVlcLog(`[display] idle output restore failed: ${error.message}`);
    });
  }
}

function showTestOutput(targetDisplay = secondDisplay, title = 'PLAYER TEST OUTPUT') {
  destroyTestOutput();
  if (!targetDisplay) throw new Error('No output display is available');
  hideTransitionOverlay();
  hideIdleOutput();
  const fullscreen = appliedPlaybackSettings.outputMode === 'fullscreen';
  const width = fullscreen ? targetDisplay.bounds.width : Math.min(1280, targetDisplay.bounds.width);
  const height = fullscreen ? targetDisplay.bounds.height : Math.min(720, targetDisplay.bounds.height);
  const x = fullscreen ? targetDisplay.bounds.x : targetDisplay.bounds.x + Math.round((targetDisplay.bounds.width - width) / 2);
  const y = fullscreen ? targetDisplay.bounds.y : targetDisplay.bounds.y + Math.round((targetDisplay.bounds.height - height) / 2);
  testOutputWin = new BrowserWindow({
    x, y, width, height, fullscreen, frame: !fullscreen, alwaysOnTop: true,
    skipTaskbar: true, focusable: false, resizable: false, backgroundColor: '#000000',
    webPreferences: { nodeIntegration: false, contextIsolation: true, devTools: false }
  });
  const label = targetDisplay.label || `Display ${targetDisplay.id}`;
  const html = `<body style="margin:0;display:grid;grid-template-rows:1fr auto;background:linear-gradient(90deg,#fff 0 14.28%,#ff0 14.28% 28.56%,#0ff 28.56% 42.84%,#0f0 42.84% 57.12%,#f0f 57.12% 71.4%,#f00 71.4% 85.68%,#00f 85.68%);font-family:Segoe UI,sans-serif"><div></div><div style="padding:22px;background:#000;color:#fff;text-align:center;font-size:24px;font-weight:700">${title} · ${label}</div></body>`;
  testOutputWin.removeMenu();
  testOutputWin.setAlwaysOnTop(true, 'screen-saver');
  testOutputWin.setIgnoreMouseEvents(true);
  testOutputWin.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`).catch(() => {});
  testOutputWin.on('closed', () => { testOutputWin = null; });
  setTimeout(destroyTestOutput, 5000);
}

function appendVlcLog(line) {
  try {
    const logPath = path.join(DATA_DIR, 'vlc-stderr.log');
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${line}\n`);
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
  const active = scheduler && scheduler.getNow();
  return resolveVlcPlaybackHealth(vlc, active);
}

function resetPlaybackAlertStatus() {
  if (playbackWatchdog) playbackWatchdog.reset();
  if (isPlaybackAlertStatus(statusLabel)) setStatus(getRuntimeStatus());
}

async function retryVlcPlayback() {
  const active = scheduler && scheduler.getNow();
  if (!isPlaybackExpected(active)) {
    resetPlaybackAlertStatus();
    pushDashboard();
    return { ok: true, standby: true };
  }
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
  } catch (error) {
    setStatus('vlc-error');
    pushDashboard();
    return { ok: false, error: error.message || String(error) };
  }
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

async function collectAssetInventory() {
  if (!mediaProbe) throw new Error('Media inventory is not initialized');
  return buildAssetInventory({
    mediaLibraryDir: CFG.MEDIA_LIBRARY_DIR,
    cachedAssets: getCachedAssets(),
    mediaManager,
    mediaProbe,
    probeConcurrency: 2
  });
}

function readyMediaPaths(inventory) {
  return new Map((inventory && Array.isArray(inventory.displayItems) ? inventory.displayItems : [])
    .filter(item => ['available', 'downloaded'].includes(item.status) && item.mediaKey && item.path)
    .map(item => [item.mediaKey, item.path]));
}

async function prepareRuntimeSchedules(schedules, assets, inventory = null, options = {}) {
  const resolvedInventory = inventory || await collectAssetInventory();
  return mediaManager.prepareSchedules(schedules, assets, readyMediaPaths(resolvedInventory), options);
}

async function uploadAssetInventory(inventory) {
  if (!cfg || cfg.bypass) return null;
  if (assetUploadPromise) return assetUploadPromise;
  if (inventory.assets.length > 2000) {
    throw new Error('The Media Folder contains more than the 2,000 assets allowed in one sync.');
  }

  assetSyncState = {
    status: 'syncing',
    lastSyncedAt: assetSyncState.lastSyncedAt,
    lastError: null,
    summary: assetSyncState.summary
  };
  pushDashboard();
  const client = cmsClient || new CmsClient({ serverURL: cfg.serverURL });
  assetUploadPromise = client.syncAssets(cfg.token, { assets: inventory.assets })
    .then(summary => {
      initialAssetSyncStarted = true;
      nextAssetSyncAttemptAt = 0;
      assetSyncState = {
        status: 'synced',
        lastSyncedAt: summary.synced_at || new Date().toISOString(),
        lastError: null,
        summary
      };
      appendVlcLog(`[assets] synced ${summary.reported} items at revision ${summary.inventory_revision}`);
      return summary;
    })
    .catch(error => {
      initialAssetSyncStarted = false;
      nextAssetSyncAttemptAt = Date.now() + 60000;
      assetSyncState = {
        status: 'error',
        lastSyncedAt: assetSyncState.lastSyncedAt,
        lastError: error.message || String(error),
        summary: assetSyncState.summary
      };
      appendVlcLog(`[assets] sync failed: ${assetSyncState.lastError}`);
      throw error;
    })
    .finally(() => {
      assetUploadPromise = null;
      pushDashboard();
    });
  return assetUploadPromise;
}

async function syncAssetInventory() {
  const inventory = await collectAssetInventory();
  const summary = await uploadAssetInventory(inventory);
  return { inventory, summary };
}

async function scanVisibleAssetsAndContinueInBackground() {
  return scanBeforeRemoteDistribution({
    collectInventory: collectAssetInventory,
    onInventory: sendAssetInventory,
    uploadInventory: uploadAssetInventory,
    synchronizeDistribution: syncRemoteDistribution,
    onBackgroundError: (error, phase) => {
      appendVlcLog(`[assets] background ${phase} failed: ${error.message || error}`);
    }
  });
}

function replaceRemoteAssignments(assets) {
  const previous = new Map(remoteDownloadState.items.map(item => [item.assetId, item]));
  remoteDownloadState = {
    status: assets.length ? 'syncing' : 'complete',
    assignedCount: assets.length,
    updatedAt: new Date().toISOString(),
    lastError: null,
    items: assets.map(asset => {
      const old = previous.get(asset.id);
      return {
        assetId: asset.id,
        filename: asset.filename,
        totalBytes: asset.size,
        downloadedBytes: old && old.status === 'ready' ? asset.size : 0,
        status: old && old.status === 'ready' ? 'ready' : 'queued',
        cached: Boolean(old && old.cached),
        error: null
      };
    })
  };
  pushDashboard();
}

function updateRemoteDownload(asset, changes, broadcast = true) {
  const assetId = String(asset && asset.id || '');
  const index = remoteDownloadState.items.findIndex(item => item.assetId === assetId);
  const current = index >= 0 ? remoteDownloadState.items[index] : {
    assetId, filename: asset && asset.filename || assetId,
    totalBytes: Number(asset && asset.size) || 0, downloadedBytes: 0,
    status: 'queued', cached: false, error: null
  };
  const next = { ...current, ...changes };
  const items = [...remoteDownloadState.items];
  if (index >= 0) items[index] = next; else items.push(next);
  remoteDownloadState = { ...remoteDownloadState, updatedAt: new Date().toISOString(), items };
  if (broadcast) pushDashboard();
}

function sendAssetInventory(inventory) {
  if (!dashboardWin || dashboardWin.isDestroyed() || !dashboardWin.webContents) return;
  dashboardWin.webContents.send('assets:inventory-updated', {
    directory: inventory.directory || '',
    items: Array.isArray(inventory.displayItems) ? inventory.displayItems : []
  });
}

function syncScheduleSnapshot(options = {}) {
  const task = scheduleSyncQueue.then(async () => {
    if (!cfg || cfg.bypass) return { revision: 0, schedules: [] };
    const client = cmsClient || new CmsClient({ serverURL: cfg.serverURL });
    const snapshot = await client.schedules(cfg.token);
    const cached = normalizeSyncPayload(readJson(CACHE_PATH, { revision: 0, schedules: [], assets: [] }));
    const assets = Array.isArray(options.assets) ? options.assets : cached.assets;
    const incoming = normalizeSyncPayload({
      revision: snapshot.revision,
      schedules: snapshot.schedules,
      assets
    });
    const inventory = options.inventory || await collectAssetInventory();
    const prepared = await prepareRuntimeSchedules(incoming.schedules, assets, inventory, { downloadMissing: false });
    writeJson(CACHE_PATH, {
      revision: incoming.revision,
      updatedAt: new Date().toISOString(),
      schedules: prepared,
      assets
    });
    await refreshMediaHealth(prepared, assets, { force: true });
    if (scheduler) scheduler.update(prepared);
    appendVlcLog(`[schedules] synchronized revision ${incoming.revision} (${prepared.length} schedules)`);
    pushDashboard();
    return { revision: incoming.revision, schedules: prepared };
  });
  scheduleSyncQueue = task.catch(() => {});
  return task;
}

async function syncRemoteDistribution() {
  if (!cfg || cfg.bypass) return syncAssetInventory();
  if (remoteDistributionPromise) return remoteDistributionPromise;
  remoteDistributionPromise = (async () => {
    const client = cmsClient || new CmsClient({ serverURL: cfg.serverURL });
    const [assignedResponse, removals] = await Promise.all([
      client.assignedAssets(cfg.token), client.pendingAssetRemovals(cfg.token)
    ]);
    const assigned = assignedResponse.map(normalizeAsset);
    const licenseExpiries = assigned
      .filter(asset => asset.encryptionFormat === 'ldg-v1')
      .map(asset => Date.parse(asset.encryption.license.expiresAt))
      .filter(Number.isFinite);
    nextLdgLicenseRefreshAt = licenseExpiries.length
      ? Math.max(Date.now() + 60000, Math.min(...licenseExpiries) - 60 * 60 * 1000)
      : 0;
    replaceRemoteAssignments(assigned);
    const cached = normalizeSyncPayload(readJson(CACHE_PATH, { revision: 0, schedules: [], assets: [] }));
    writeJson(CACHE_PATH, {
      revision: cached.revision,
      updatedAt: new Date().toISOString(),
      schedules: cached.schedules,
      assets: assigned
    });

    let deferredRemoval = false;
    for (const removal of removals) {
      const activePath = vlc && vlc.getPlaybackStatus ? vlc.getPlaybackStatus().currentPath : '';
      const activeSchedule = scheduler ? scheduler.getNow() : null;
      const activeAssetId = activeSchedule && activeSchedule.files
        ? (activeSchedule.files.find(file => String(file.assetId || '') === String(removal.id)) || {}).assetId
        : null;
      const result = removeManagedAsset({ asset: removal, mediaManager, activePath, activeAssetId });
      if (result.status === 'deferred') {
        deferredRemoval = true;
        appendVlcLog(`[media] removal deferred while playing ${removal.id}`);
        continue;
      }
      if (ldgGateway) ldgGateway.unregister(removal.id);
      await client.acknowledgeAssetRemoval(cfg.token, removal.id);
      appendVlcLog(`[media] removed expired or unassigned asset ${removal.id}`);
    }
    pendingRemovalRetry = deferredRemoval;

    const downloads = await mediaManager.prepareAssets(assigned);
    const inventory = await collectAssetInventory();
    const summary = await uploadAssetInventory(inventory);
    sendAssetInventory(inventory);
    const scheduleResult = await syncScheduleSnapshot({ assets: assigned, inventory });
    remoteDownloadState = {
      ...remoteDownloadState,
      status: downloads.failed.length ? 'warning' : 'complete',
      updatedAt: new Date().toISOString(),
      lastError: downloads.failed.length ? `${downloads.failed.length} download(s) failed.` : null
    };
    pushDashboard();
    return { inventory, summary, assigned, downloads, scheduleRevision: scheduleResult.revision };
  })().catch(error => {
    remoteDownloadState = {
      ...remoteDownloadState, status: 'error', updatedAt: new Date().toISOString(),
      lastError: error.message || String(error)
    };
    pushDashboard();
    throw error;
  }).finally(() => { remoteDistributionPromise = null; });
  return remoteDistributionPromise;
}

function synchronizeHeartbeatRevisions(data = {}) {
  if (!cfg || cfg.bypass) return Promise.resolve({ ok: true, skipped: true });
  if (heartbeatRevisionSyncPromise) {
    return heartbeatRevisionSyncPromise.then(() => synchronizeHeartbeatRevisions(data));
  }

  const assetRevision = normalizeRevision(data.asset_revision);
  const scheduleRevision = normalizeRevision(data.schedule_revision);
  const licenseRefreshNeeded = nextLdgLicenseRefreshAt > 0 && Date.now() >= nextLdgLicenseRefreshAt;
  const initialSyncNeeded = !initialAssetSyncStarted || licenseRefreshNeeded;
  if (initialSyncNeeded && Date.now() < nextAssetSyncAttemptAt) {
    return Promise.resolve({ ok: false, deferred: true, error: 'Asset synchronization is waiting for its retry window.' });
  }
  const action = revisionSyncAction({
    initialSyncNeeded, pendingRemovalRetry, assetRevision, appliedAssetRevision,
    scheduleRevision, appliedScheduleRevision
  });
  if (action === null) return Promise.resolve({ ok: true, unchanged: true });

  heartbeatRevisionSyncPromise = (async () => {
    if (action === 'assets') {
      await syncRemoteDistribution();
      appliedAssetRevision = assetRevision;
      appliedScheduleRevision = scheduleRevision;
      return { ok: true, action };
    }
    if (action === 'schedules') {
      await syncScheduleSnapshot();
      appliedScheduleRevision = scheduleRevision;
      return { ok: true, action };
    }
  })().catch(error => {
    nextAssetSyncAttemptAt = Date.now() + 60000;
    appendVlcLog(`[cms] automatic revision sync failed: ${error.message || error}`);
    return { ok: false, error: error.message || String(error) };
  }).finally(() => {
    heartbeatRevisionSyncPromise = null;
  });
  return heartbeatRevisionSyncPromise;
}

async function applyRealtimeHint(hint) {
  if (!cfg || cfg.bypass || hint.deviceId !== cfg.deviceId) return;
  realtimeState.lastEventAt = new Date().toISOString();
  pushDashboard();
  const result = await synchronizeHeartbeatRevisions({
    asset_revision: hint.assetRevision,
    schedule_revision: hint.scheduleRevision
  });
  if (realtimeClient) {
    realtimeClient.reportApplied({
      eventId: hint.eventId,
      assetRevision: appliedAssetRevision === null ? 0 : appliedAssetRevision,
      scheduleRevision: appliedScheduleRevision === null ? 0 : appliedScheduleRevision,
      ok: Boolean(result && result.ok),
      error: result && result.error
    });
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

function getCombinedAudioStatus() {
  const vlcAudio = vlc ? vlc.getAudioStatus() : {
    devices: [], selectedDeviceId: playbackSettings.audioDeviceId,
    currentDeviceId: null, volumePercent: playbackSettings.volumePercent,
    available: false
  };
  const devicesById = new Map();

  for (const device of windowsAudioDevices) {
    devicesById.set(String(device.id).toLowerCase(), { ...device, active: false });
  }
  for (const device of Array.isArray(vlcAudio.devices) ? vlcAudio.devices : []) {
    const key = String(device.id).toLowerCase();
    devicesById.set(key, { ...(devicesById.get(key) || {}), ...device, source: 'vlc' });
  }

  return {
    ...vlcAudio,
    devices: [...devicesById.values()],
    systemDetected: windowsAudioDevices.length > 0,
    detectionError: windowsAudioLastError
  };
}

async function refreshWindowsAudioOutputs() {
  if (process.platform !== 'win32') {
    windowsAudioDevices = [];
    windowsAudioLastError = 'Windows audio endpoint detection is unavailable on this platform.';
    return windowsAudioDevices;
  }
  if (windowsAudioRefreshPromise) return windowsAudioRefreshPromise;

  windowsAudioRefreshPromise = listWindowsAudioOutputs()
    .then(devices => {
      windowsAudioDevices = devices;
      windowsAudioLastError = null;
      pushDashboard();
      return devices;
    })
    .catch(error => {
      windowsAudioLastError = error.message || String(error);
      appendVlcLog(`[audio] Windows output detection failed: ${windowsAudioLastError}`);
      pushDashboard();
      return windowsAudioDevices;
    })
    .finally(() => {
      windowsAudioRefreshPromise = null;
    });

  return windowsAudioRefreshPromise;
}

function pushDashboard() {
  if (!dashboardWin || dashboardWin.isDestroyed() || !dashboardWin.webContents) return;
  const now = scheduler ? scheduler.getNow() : null;
  const upcoming = scheduler ? scheduler.getUpcoming(6) : [];
  const skipped = scheduler ? scheduler.getSkipped() : [];
  const preview = currentPlaybackPreviewState(now);
  const watchdog = playbackWatchdog ? playbackWatchdog.getStatus() : { state: 'idle', attempts: 0 };
  const manualStatus = manualPlayback ? manualPlayback.getStatus() : { active: false };
  const payload = {
    status: statusLabel,
    deviceId: cfg && cfg.deviceId || '',
    device: {
      id: cfg && cfg.deviceId || '',
      name: cfg && cfg.deviceName || os.hostname(),
      location: cfg && cfg.deviceLocation || '',
      timezone: cfg && cfg.deviceTimezone || (Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Jakarta')
    },
    appVersion: app.getVersion(),
    development: !app.isPackaged,
    bypass: !!(cfg && cfg.bypass),
    serverURL: cfg && cfg.serverURL || '',
    cms: { ...cmsState },
    realtime: { ...realtimeState },
    refresh: { ...refreshState },
    assetSync: { ...assetSyncState },
    remoteDownloads: { ...remoteDownloadState, items: remoteDownloadState.items.map(item => ({ ...item })) },
    display: {
      mode: hasSecondaryPlaybackDisplay ? 'multi' : 'single',
      hasDedicatedDisplay: hasDedicatedPlaybackDisplay,
      hasSecondaryDisplay: hasSecondaryPlaybackDisplay,
      outputId: secondDisplay ? secondDisplay.id : null,
      outputLabel: secondDisplay && secondDisplay.label || '',
      idleOutputId: idleDisplay ? idleDisplay.id : null,
      idleOutputLabel: idleDisplay && idleDisplay.label || '',
      idleDisplayPreferenceAvailable,
      displays: playbackDisplayOptions(),
      settings: { ...playbackSettings },
      pending: playbackSettingsPending
    },
    operator: {
      unlocked: Boolean(!operatorAccessError(false)),
      user: operatorSession && operatorSession.user || null
    },
    now,
    manualPlayback: {
      ...manualStatus,
      availability: manualPlaybackAvailability(now, watchdog)
    },
    upcoming,
    skipped,
    preview,
    vlc: {
      state: vlc ? vlc.state : 'idle',
      rcReady: vlc ? vlc.ready : false,
      idleMode: vlc ? vlc.idleMode : false,
      playback: vlc ? vlc.getPlaybackStatus() : null,
      audio: getCombinedAudioStatus()
    },
    watchdog,
    recoveryResume: lastResumeInfo,
    mediaHealth: mediaHealthSnapshot
  };
  try {
    dashboardWin.webContents.send('dashboard:update', payload);
  } catch (e) {
    console.error('pushDashboard send failed', e);
  }
}

function currentPlaybackPreviewState(now = scheduler ? scheduler.getNow() : null) {
  const manualStatus = manualPlayback ? manualPlayback.getStatus() : { active: false };
  return {
    ...resolvePreviewState({
      hasDedicatedDisplay: hasDedicatedPlaybackDisplay,
      now: now || (manualStatus.active ? { phase: 'media' } : null),
      vlcState: vlc ? vlc.state : 'idle',
      idleMode: vlc ? vlc.idleMode : false
    }),
    displayId: secondDisplay ? String(secondDisplay.id) : null,
    displayLabel: secondDisplay && secondDisplay.label || ''
  };
}

function sendPlaybackPreview(payload) {
  if (!dashboardWin || dashboardWin.isDestroyed() || !dashboardWin.webContents) return;
  try { dashboardWin.webContents.send('playback-preview:update', payload); }
  catch (error) { console.error('playback preview send failed', error); }
}

async function capturePlaybackPreview() {
  if (
    playbackPreviewStreaming || playbackPreviewBusy || isShuttingDown || !dashboardWin || dashboardWin.isDestroyed() ||
    !dashboardWin.isVisible() || dashboardWin.isMinimized()
  ) return;
  const preview = currentPlaybackPreviewState();
  if (!shouldCapturePreview(preview.status)) {
    const signature = `${preview.status}:${preview.message}:${preview.displayId || ''}`;
    if (signature !== playbackPreviewSignature) {
      playbackPreviewSignature = signature;
      sendPlaybackPreview({ ...preview, frame: null, capturedAt: null });
    }
    return;
  }

  playbackPreviewBusy = true;
  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: PREVIEW_WIDTH, height: PREVIEW_HEIGHT },
      fetchWindowIcons: false
    });
    const source = selectDisplaySource(sources, preview.displayId);
    if (!source || !source.thumbnail || source.thumbnail.isEmpty()) {
      throw new Error('The selected output monitor could not be captured.');
    }
    const jpeg = source.thumbnail.toJPEG(52);
    if (!jpeg || jpeg.length === 0) throw new Error('The output monitor returned an empty frame.');
    playbackPreviewSignature = `${preview.status}:${preview.displayId || ''}:frame`;
    sendPlaybackPreview({
      ...preview,
      frame: `data:image/jpeg;base64,${jpeg.toString('base64')}`,
      capturedAt: new Date().toISOString()
    });
  } catch (error) {
    const failed = { ...preview, status: 'unavailable', label: 'Preview unavailable', message: error.message || String(error) };
    const signature = `${failed.status}:${failed.message}:${failed.displayId || ''}`;
    if (signature !== playbackPreviewSignature) {
      playbackPreviewSignature = signature;
      sendPlaybackPreview({ ...failed, frame: null, capturedAt: null });
    }
  } finally {
    playbackPreviewBusy = false;
  }
}

function startPlaybackPreviewLoop() {
  if (playbackPreviewHandle) clearInterval(playbackPreviewHandle);
  playbackPreviewHandle = setInterval(() => { void capturePlaybackPreview(); }, PREVIEW_INTERVAL_MS);
  if (playbackPreviewHandle.unref) playbackPreviewHandle.unref();
}

function stopPlaybackPreviewLoop() {
  if (playbackPreviewHandle) clearInterval(playbackPreviewHandle);
  playbackPreviewHandle = null;
  playbackPreviewBusy = false;
  playbackPreviewSignature = '';
  playbackPreviewStreaming = false;
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
    ldg_version: 'ldg-v1',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Jakarta'
  });
  if (!data || !data.token || !data.device_id) {
    throw new Error('CMS registration response is incomplete');
  }
  return { url, data, installId };
}

ipcMain.handle('get-pairing-defaults', async () => {
  const notice = pairingNotice;
  pairingNotice = '';
  return { serverURL: CFG.SERVER_URL, appVersion: app.getVersion(), testModeEnabled: isTestModeEnabled(), notice };
});

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
      ldg_version: 'ldg-v1',
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Jakarta'
    });
    await client.operatorLogout(setupSession.token).catch(() => {});
    const next = {
      serverURL: setupSession.serverURL, installId, deviceId: data.device_id,
      deviceName: data.device_name || os.hostname(), deviceLocation: data.device_location || '',
      deviceTimezone: data.device_timezone || 'Asia/Jakarta', realtimeUrl: data.realtime_url || '',
      token: data.token, bypass: false
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

ipcMain.handle('refresh-player', async () => refreshPlayer('dashboard'));

ipcMain.handle('operator-login', async (_event, payload) => {
  if (!cfg || cfg.bypass) return { ok: true, bypass: true };
  const client = new CmsClient({ serverURL: cfg.serverURL });
  let auth = null;
  try {
    auth = await client.operatorLogin(String(payload && payload.email || '').trim(), String(payload && payload.password || ''));
    await client.authorizeDeviceControl(auth.token, cfg.deviceId);
    operatorSession = {
      token: auth.token, user: auth.user,
      expiresAt: parseSessionExpiry(auth.expires_at),
      lastActivityAt: Date.now()
    };
    pushDashboard();
    return { ok: true, user: auth.user };
  } catch (error) {
    if (auth && auth.token) await client.operatorLogout(auth.token).catch(() => {});
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
      deviceLocation: data.device_location || '',
      deviceTimezone: data.device_timezone || 'Asia/Jakarta',
      realtimeUrl: data.realtime_url || '',
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
      deviceName: 'Development Player',
      deviceLocation: 'Local testing',
      deviceTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Jakarta',
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
  if (!vlc) return { ok: false, error: 'VLC controller not initialized' };
  try {
    const playback = await vlc.pause();
    pushDashboard();
    return { ok: true, playback };
  } catch (error) {
    pushDashboard();
    return { ok: false, error: error.message || String(error) };
  }
});

ipcMain.handle('vlc-resume', async () => {
  const denied = operatorAccessError(); if (denied) return denied;
  if (!vlc) return { ok: false, error: 'VLC controller not initialized' };
  try {
    const playback = await vlc.resume();
    pushDashboard();
    return { ok: true, playback };
  } catch (error) {
    pushDashboard();
    return { ok: false, error: error.message || String(error) };
  }
});

ipcMain.handle('playback-preview-source', async event => {
  if (
    !dashboardWin || dashboardWin.isDestroyed() ||
    !dashboardWin.webContents || event.sender !== dashboardWin.webContents
  ) {
    return { ok: false, error: 'Preview capture is only available to the Player dashboard.' };
  }
  const preview = currentPlaybackPreviewState();
  if (!shouldCapturePreview(preview.status) || !preview.displayId) {
    return { ok: false, error: 'Film output is not currently available for live preview.' };
  }
  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 0, height: 0 },
      fetchWindowIcons: false
    });
    const source = selectDisplaySource(sources, preview.displayId);
    if (!source || !source.id) throw new Error('The selected output monitor could not be captured.');
    return {
      ok: true,
      sourceId: source.id,
      displayId: preview.displayId,
      displayLabel: preview.displayLabel || source.name || 'Output monitor'
    };
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
});

ipcMain.on('playback-preview-stream-state', (event, payload) => {
  if (
    dashboardWin && !dashboardWin.isDestroyed() && dashboardWin.webContents &&
    event.sender === dashboardWin.webContents
  ) {
    playbackPreviewStreaming = Boolean(payload && payload.active);
  }
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
  return retryVlcPlayback();
});

ipcMain.handle('vlc-set-volume', async (_event, value) => {
  const denied = operatorAccessError(); if (denied) return denied;
  try {
    const normalized = normalizePlaybackSettings({ ...playbackSettings, volumePercent: value });
    playbackSettings = { ...playbackSettings, volumePercent: normalized.volumePercent };
    appliedPlaybackSettings = { ...appliedPlaybackSettings, volumePercent: normalized.volumePercent };
    writeJson(PLAYBACK_SETTINGS_PATH, playbackSettings);
    const audio = vlc ? vlc.setVolumePercent(normalized.volumePercent) : null;
    pushDashboard();
    return { ok: true, volumePercent: normalized.volumePercent, audio };
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
});

ipcMain.handle('refresh-vlc-audio-devices', async () => {
  const denied = operatorAccessError(); if (denied) return denied;
  if (!vlc) return { ok: false, error: 'VLC controller is not initialized.' };
  try {
    await refreshWindowsAudioOutputs();
    if (vlc.ready) await vlc.refreshAudioDevices();
    const audio = getCombinedAudioStatus();
    pushDashboard();
    return {
      ok: true,
      audio,
      message: audio.devices.length
        ? `${audio.devices.length} audio output${audio.devices.length === 1 ? '' : 's'} detected.`
        : 'Windows did not report any active audio outputs. System default remains available.'
    };
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
});

ipcMain.handle('test-vlc-recovery', async () => {
  const denied = operatorAccessError(); if (denied) return denied;
  if (app.isPackaged) {
    return { ok: false, error: 'VLC recovery simulation is disabled in packaged builds.' };
  }
  const active = scheduler && scheduler.getNow();
  if (!active || !active.files || !active.files.length) {
    return { ok: false, error: 'Start a schedule before testing VLC recovery.' };
  }
  if (!vlc) return { ok: false, error: 'VLC controller is not initialized.' };
  if (playbackWatchdog && playbackWatchdog.inFlight) {
    return { ok: false, error: 'A VLC recovery attempt is already running.' };
  }
  try {
    const result = vlc.simulateCrashForRecoveryTest();
    appendVlcLog(`[test] operator triggered VLC recovery simulation${result.pid ? ` for pid ${result.pid}` : ''}`);
    return {
      ok: true,
      pid: result.pid,
      expectedDetectionSeconds: playbackWatchdog
        ? Math.ceil((playbackWatchdog.intervalMs * playbackWatchdog.failureThreshold) / 1000)
        : 6
    };
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
});

ipcMain.handle('open-config-folder', async () => {
  const denied = operatorAccessError(); if (denied) return denied;
  shell.openPath(DATA_DIR);
  return { ok: true };
});

ipcMain.handle('save-playback-settings', async (_event, payload) => {
  const denied = operatorAccessError(); if (denied) return denied;
  try {
    playbackSettings = normalizePlaybackSettings(payload);
    writeJson(PLAYBACK_SETTINGS_PATH, playbackSettings);
    const active = Boolean(scheduler && scheduler.getNow());
    playbackSettingsPending = active;
    if (!active) {
      appliedPlaybackSettings = { ...playbackSettings };
      refreshPlaybackDisplay();
    } else {
      // Volume is safe to apply without restarting the active film. Display
      // and audio-device routing changes remain deferred until it finishes.
      appliedPlaybackSettings = {
        ...appliedPlaybackSettings,
        volumePercent: playbackSettings.volumePercent
      };
      if (vlc) vlc.setVolumePercent(playbackSettings.volumePercent);
      pushDashboard();
    }
    return { ok: true, settings: playbackSettings, appliesAfterCurrentSchedule: active };
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
});

ipcMain.handle('restore-playback-settings', async () => {
  const denied = operatorAccessError(); if (denied) return denied;
  playbackSettings = { ...DEFAULT_PLAYBACK_SETTINGS };
  writeJson(PLAYBACK_SETTINGS_PATH, playbackSettings);
  const active = Boolean(scheduler && scheduler.getNow());
  playbackSettingsPending = active;
  if (!active) {
    appliedPlaybackSettings = { ...playbackSettings };
    refreshPlaybackDisplay();
  } else {
    appliedPlaybackSettings = {
      ...appliedPlaybackSettings,
      volumePercent: playbackSettings.volumePercent
    };
    if (vlc) vlc.setVolumePercent(playbackSettings.volumePercent);
    pushDashboard();
  }
  return { ok: true, settings: playbackSettings, appliesAfterCurrentSchedule: active };
});

ipcMain.handle('identify-displays', async () => {
  const denied = operatorAccessError(); if (denied) return denied;
  if (scheduler && scheduler.getNow()) {
    return { ok: false, error: 'Identify Displays is unavailable while a schedule is active.' };
  }
  identifyDisplays();
  return { ok: true };
});

ipcMain.handle('test-playback-output', async () => {
  const denied = operatorAccessError(); if (denied) return denied;
  if (scheduler && scheduler.getNow()) {
    return { ok: false, error: 'Test Output is unavailable while a schedule is active.' };
  }
  try {
    showTestOutput();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
});

ipcMain.handle('test-idle-output', async (_event, payload) => {
  const denied = operatorAccessError(); if (denied) return denied;
  if (scheduler && scheduler.getNow()) {
    return { ok: false, error: 'Test Idle Monitor is unavailable while a schedule is active.' };
  }
  try {
    const previewSettings = normalizePlaybackSettings(payload);
    const displays = screen.getAllDisplays();
    const previewPlayback = choosePlaybackDisplay(
      displays,
      screen.getPrimaryDisplay(),
      previewSettings.displayId
    );
    const previewIdle = chooseIdleDisplay(
      displays,
      previewPlayback.display,
      previewSettings.idleDisplayId
    );
    showTestOutput(previewIdle.display, 'IDLE LOOP MONITOR');
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
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
    const prepared = await prepareRuntimeSchedules(cache.schedules, cache.assets);
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
    let inventory;
    let sync = null;
    let syncError = '';
    if (cfg && !cfg.bypass) {
      const scan = await scanVisibleAssetsAndContinueInBackground();
      inventory = scan.inventory;
      sync = assetSyncState.summary;
      syncError = assetSyncState.lastError || '';
    } else {
      inventory = await collectAssetInventory();
    }
    return {
      ok: true,
      directory: inventory.directory,
      items: inventory.displayItems,
      sync,
      syncError
    };
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
});

async function resolveManualPlaybackAsset(mediaId) {
  const normalizedId = String(mediaId || '').trim();
  if (!normalizedId) throw new Error('Select an asset to play.');
  const inventory = await collectAssetInventory();
  const selected = inventory.displayItems.find(item => String(item.id) === normalizedId);
  if (!selected) throw new Error('The selected asset is no longer available. Refresh Assets.');
  if (selected.healthStatus !== 'ready') throw new Error('Only assets with Ready status can be played manually.');

  let playbackSource = selected.path;
  if (selected.source === 'managed') {
    const asset = getCachedAssets().find(item => String(item.id) === String(selected.assetId));
    if (!asset) throw new Error('The downloaded asset is no longer assigned to this Player.');
    if (!await mediaManager.isReady(asset)) throw new Error('The downloaded asset failed its integrity check. Refresh Assets.');
    playbackSource = await mediaManager.resolvePlaybackSource(asset, selected.path);
  }
  if (!playbackSource) throw new Error('A safe playback source could not be resolved for this asset.');
  return { selected, playbackSource };
}

ipcMain.handle('manual-playback-start', async (_event, payload) => {
  const denied = operatorAccessError(); if (denied) return denied;
  if (!vlc || !manualPlayback || !scheduler) return { ok: false, error: 'Playback runtime is not initialized.' };
  try {
    let active = scheduler.getNow();
    let availability = manualPlaybackAvailability(
      active,
      playbackWatchdog ? playbackWatchdog.getStatus() : { state: 'idle' }
    );
    if (!availability.allowed) throw new Error(availability.error);

    // A terminally broken occurrence must not keep reconciling underneath the
    // emergency playback session. Skip only this in-memory occurrence; cached
    // schedules and the CMS revision remain unchanged.
    if (active) {
      scheduler.skip();
      active = scheduler.getNow();
      availability = manualPlaybackAvailability(
        active,
        playbackWatchdog ? playbackWatchdog.getStatus() : { state: 'idle' }
      );
      if (!availability.allowed) throw new Error('Another valid schedule became active and has priority.');
    }

    const { selected, playbackSource } = await resolveManualPlaybackAsset(payload && payload.mediaId);
    const range = normalizeManualRange(payload, selected.durationMs);
    const latestActive = scheduler.getNow();
    const latestAvailability = manualPlaybackAvailability(
      latestActive,
      playbackWatchdog ? playbackWatchdog.getStatus() : { state: 'idle' }
    );
    if (!latestAvailability.allowed) throw new Error('A valid schedule started while the asset was being prepared and has priority.');
    manualPlayback.preempt('replaced-by-operator');
    const sessionDetails = {
      mediaId: selected.id,
      title: selected.title || selected.filename,
      ...range,
      reason: latestAvailability.reason
    };
    try {
      await vlc.replacePlaylist([playbackSource], {
        loop: false,
        startPositionSeconds: range.startSeconds,
        volumePercent: playbackSettings.volumePercent
      });
    } catch (error) {
      manualPlayback.preempt('start-failed');
      throw error;
    }
    if (scheduler.getNow()) {
      throw new Error('A valid schedule started during VLC preparation and has priority.');
    }
    manualPlayback.begin(sessionDetails);
    appendVlcLog(
      `[manual] ${operatorSession && operatorSession.user && (operatorSession.user.email || operatorSession.user.name) || 'operator'} ` +
      `started ${selected.id} from ${range.startSeconds}s to ${range.endSeconds}s (${latestAvailability.reason})`
    );
    pushDashboard();
    return { ok: true, manualPlayback: manualPlayback.getStatus() };
  } catch (error) {
    appendVlcLog(`[manual] start rejected: ${error.message || error}`);
    pushDashboard();
    return { ok: false, error: error.message || String(error) };
  }
});

ipcMain.handle('manual-playback-stop', async () => {
  const denied = operatorAccessError(); if (denied) return denied;
  if (!manualPlayback) return { ok: true, manualPlayback: { active: false } };
  try {
    await manualPlayback.stop('operator-stop');
    appendVlcLog(`[manual] stopped by operator`);
    pushDashboard();
    return { ok: true, manualPlayback: manualPlayback.getStatus() };
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
});

ipcMain.handle('retry-asset-download', async (_event, assetId) => {
  let asset = null;
  try {
    if (!cfg || cfg.bypass) throw new Error('Remote downloads require a paired CMS Player.');
    const cache = normalizeSyncPayload(readJson(CACHE_PATH, { revision: 0, schedules: [], assets: [] }));
    asset = cache.assets.find(item => item.id === String(assetId || ''));
    if (!asset) throw new Error('This asset is no longer assigned to the Player. Refresh Assets.');
    updateRemoteDownload(asset, { status: 'queued', downloadedBytes: 0, cached: false, error: null });
    await mediaManager.prepareAsset(asset);
    const result = await syncAssetInventory();
    sendAssetInventory(result.inventory);
    remoteDownloadState = {
      ...remoteDownloadState,
      status: remoteDownloadState.items.some(item => item.status === 'failed') ? 'warning' : 'complete',
      updatedAt: new Date().toISOString(), lastError: null
    };
    pushDashboard();
    return { ok: true };
  } catch (error) {
    if (asset) updateRemoteDownload(asset, { status: 'failed', cached: false, error: error.message || String(error) });
    remoteDownloadState = { ...remoteDownloadState, status: 'warning', lastError: error.message || String(error) };
    pushDashboard();
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
  if (!cfg || !cfg.bypass) return { ok: false, error: 'Pairing can only be revoked by a CMS administrator.' };
  await logout();
  return { ok: true };
});

ipcMain.handle('quit', async () => {
  await quitApp();
  return { ok: true };
});

async function shutdownPlaybackComponents() {
  if (playbackShutdownPromise) return playbackShutdownPromise;
  playbackShutdownPromise = (async () => {
    const oldWatchdog = playbackWatchdog;
    playbackWatchdog = null;
    if (oldWatchdog) oldWatchdog.stop();

    if (manualPlayback) manualPlayback.preempt('runtime-shutdown');
    manualPlayback = null;

    const oldScheduler = scheduler;
    scheduler = null;
    if (oldScheduler) oldScheduler.clear();

    const oldVlc = vlc;
    if (oldVlc) await oldVlc.quit().catch(error => {
      appendVlcLog(`[shutdown] VLC close failed: ${error.message || error}`);
    });
    if (vlc === oldVlc) vlc = null;

    const oldGateway = ldgGateway;
    ldgGateway = null;
    if (oldGateway) await oldGateway.close().catch(error => {
      appendVlcLog(`[shutdown] LDG gateway close failed: ${error.message || error}`);
    });

    destroyIdentifyDisplayWindows();
    destroyTestOutput();
    destroyIdleOutput();
    destroyFilmOutput();
    destroyTransitionOverlay();
  })().finally(() => { playbackShutdownPromise = null; });
  return playbackShutdownPromise;
}

async function startRuntime() {
  if (!cfg || !cfg.token) return;
  void refreshWindowsAudioOutputs();
  stopCmsConnection();
  stopRealtimeConnection(cfg.bypass ? 'test-mode' : 'connecting');
  await shutdownPlaybackComponents();
  remoteDownloadState = { status: 'idle', assignedCount: 0, updatedAt: null, lastError: null, items: [] };
  downloadProgressBroadcastAt.clear();
  try {
    fs.mkdirSync(CFG.MEDIA_LIBRARY_DIR, { recursive: true });
  } catch (error) {
    assetSyncState = { status: 'error', lastSyncedAt: null, lastError: `Media Folder unavailable: ${error.message}`, summary: null };
    appendVlcLog(`[assets] ${assetSyncState.lastError}`);
  }
  playbackCheckpoint = null;
  lastResumeInfo = null;
  mediaHealthMonitor = null;
  mediaHealthSnapshot = null;
  mediaHealthCheck = null;
  if (!cfg.bypass) {
    ldgGateway = new LdgGateway({ playerToken: cfg.token, deviceId: cfg.deviceId });
    ldgGateway.onError = error => appendVlcLog(`[ldg] playback gateway failed: ${error.message || error}`);
  }
  mediaManager = new MediaManager({
    mediaDir: path.join(DATA_DIR, 'media'),
    concurrency: 2,
    getDownloadOptions: asset => {
      const limitBytesPerSecond = getDevelopmentDownloadLimitBytesPerSecond();
      try {
        const cmsOrigin = new URL(cfg.serverURL).origin;
        return new URL(asset.downloadUrl).origin === cmsOrigin
          ? { headers: { Authorization: `Bearer ${cfg.token}` }, authOrigin: cmsOrigin, limitBytesPerSecond }
          : { limitBytesPerSecond };
      } catch (_) {
        return { limitBytesPerSecond };
      }
    },
    resolvePlaybackSource: async (asset, localPath) => {
      if (asset.encryptionFormat !== 'ldg-v1') return localPath;
      if (!ldgGateway) throw new Error('LDG decryption gateway is unavailable');
      return ldgGateway.register(asset, localPath);
    }
  });
  mediaHealthMonitor = new MediaHealthMonitor({ storagePath: mediaManager.mediaDir });
  mediaHealthSnapshot = mediaHealthMonitor.getSnapshot();
  mediaProbe = new MediaProbe({ cachePath: DURATION_CACHE_PATH });
  mediaManager.on('download-start', ({ asset, speedLimitKbps }) => {
    appendVlcLog(`[media] downloading ${asset.id}`);
    updateRemoteDownload(asset, { status: 'downloading', cached: false, error: null, speedLimitKbps });
  });
  mediaManager.on('download-progress', ({ asset, downloadedBytes, totalBytes }) => {
    const now = Date.now();
    const last = downloadProgressBroadcastAt.get(asset.id) || 0;
    const shouldBroadcast = now - last >= 250 || downloadedBytes >= totalBytes;
    updateRemoteDownload(asset, { status: 'downloading', downloadedBytes, totalBytes }, shouldBroadcast);
    if (shouldBroadcast) downloadProgressBroadcastAt.set(asset.id, now);
  });
  mediaManager.on('verifying', ({ asset }) => {
    updateRemoteDownload(asset, { status: 'verifying', downloadedBytes: asset.size, totalBytes: asset.size });
  });
  mediaManager.on('download-retry', ({ asset, reason }) => {
    appendVlcLog(`[media] retrying ${asset.id} from zero after ${reason}`);
  });
  mediaManager.on('ready', ({ asset, cached }) => {
    appendVlcLog(`[media] ready ${asset.id} (${cached ? 'cached' : 'downloaded'})`);
    downloadProgressBroadcastAt.delete(asset.id);
    const existing = remoteDownloadState.items.find(item => item.assetId === asset.id);
    updateRemoteDownload(asset, {
      status: 'ready', downloadedBytes: asset.size, totalBytes: asset.size,
      cached: existing && existing.status === 'ready' ? existing.cached : Boolean(cached), error: null
    });
  });
  mediaManager.on('download-error', ({ asset, error }) => {
    appendVlcLog(`[media] failed ${asset.id}: ${error.message}`);
    downloadProgressBroadcastAt.delete(asset.id);
    updateRemoteDownload(asset, { status: 'failed', cached: false, error: error.message || String(error) });
    console.error('Media download failed', asset.id, error);
  });
  createTransitionWindow();
  const drawableHwnd = createFilmOutputWindow();
  vlc = new VlcController({
    rcPort: VLC_RC_PORT,
    display: secondDisplay,
    playbackDisplay: secondDisplay,
    idleDisplay,
    drawableHwnd,
    settings: appliedPlaybackSettings,
    transitionDuration: 500,
    onTransitionStart: async () => {
      showTransitionOverlay();
      try {
        await showFilmOutput();
        // showFilmOutput can move the film window above an already-visible
        // transition window. Restack black only after film output is ready.
        showTransitionOverlay();
      } catch (error) {
        appendVlcLog(`[display] film output failed: ${error.message}`);
      }
    },
    onTransitionEnd: () => {
      destroyIdleOutput();
      hideTransitionOverlay();
    }
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
    if (manualPlayback) manualPlayback.handleProgress(playback);
    const active = scheduler ? scheduler.getNow() : null;
    const activeFile = active && Array.isArray(active.files) && active.files[playback && playback.currentIndex];
    const expectedSource = activeFile && (activeFile.playbackSource || activeFile.localPath || activeFile.path);
    const playbackMatchesActiveFile = Boolean(
      expectedSource && playback && playback.currentPath &&
      String(expectedSource).toLowerCase() === String(playback.currentPath).toLowerCase()
    );
    if (
      active && !vlc.idleMode &&
      (vlc.state === 'playing' || vlc.state === 'paused') &&
      playback && Number.isInteger(playback.currentIndex) && playback.currentIndex >= 0 &&
      playback.inputConfirmed !== false && playback.metricsReady !== false && playbackMatchesActiveFile
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
    const active = scheduler && scheduler.getNow();
    if (!isShuttingDown && isPlaybackExpected(active)) {
      setStatus('vlc-error');
      pushDashboard();
    }
  });
  vlc.on('state-change', () => {
    const active = scheduler && scheduler.getNow();
    if (manualPlayback && manualPlayback.getStatus().active && vlc.state === 'idle' && !vlc.idleMode) {
      void manualPlayback.stop('media-ended');
    }
    if (vlc.state === 'error' && isPlaybackExpected(active)) {
      setStatus('vlc-error');
    } else if (isPlaybackAlertStatus(statusLabel) && isVlcPlaybackHealthy()) {
      setStatus(getRuntimeStatus());
    } else {
      pushDashboard();
    }
  });
  vlc.on('audio-change', () => pushDashboard());
  scheduler = new Scheduler(vlc, {
    isMediaReady: file => mediaHealthMonitor.isReady(file)
  });
  scheduler.on('activate', (info) => {
    if (manualPlayback && manualPlayback.preempt('schedule-started')) {
      appendVlcLog(`[manual] preempted by schedule ${info.schedule.id}`);
    }
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
  scheduler.on('media', () => {
    // A checkpoint belongs to one concrete film, not merely to the enclosing
    // schedule occurrence. Never carry its position into the next item.
    playbackCheckpoint = null;
  });
  scheduler.on('gap', () => {
    playbackCheckpoint = null;
  });
  scheduler.on('expire', () => {
    nowSchedule = null;
    refreshTray();
    pushDashboard();
  });
  scheduler.on('idle', () => {
    nowSchedule = null;
    resetPlaybackAlertStatus();
    applyPendingPlaybackSettings();
    // Keep the film output completely black while the Player is idle. Calling
    // this here as well as from VlcController makes the idle screen resilient
    // even when VLC is not running or its RC connection has just closed.
    showTransitionOverlay();
    Promise.resolve(showIdleOutput()).catch(error => {
      appendVlcLog(`[idle] Electron output failed: ${error.message}`);
    });
    refreshTray();
    pushDashboard();
  });
  scheduler.on('finish', () => {
    nowSchedule = null;
    resetPlaybackAlertStatus();
    applyPendingPlaybackSettings();
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

  manualPlayback = new ManualPlaybackSession({
    stopPlayback: async reason => {
      appendVlcLog(`[manual] playback ended (${reason})`);
      if (!scheduler || !scheduler.getNow()) await vlc.playIdle();
      pushDashboard();
    }
  });
  manualPlayback.on('change', () => pushDashboard());

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
    isRecoveryDeferred: () => Boolean(vlc && vlc.isStarting()),
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
        vlc.applyVolumePercent(Number.isFinite(Number(file && file.volumePercent)) ? Number(file.volumePercent) : 100);
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
  vlc.on('ready', () => {
    // Re-evaluate against wall-clock time after a cold start. A playlist
    // request for an elapsed short film will be superseded by this target.
    if (scheduler) scheduler.reconcileNow(new Date());
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

  const cache = readJson(CACHE_PATH, { revision: 0, schedules: [], assets: [] });
  try {
    const normalizedCache = normalizeSyncPayload(cache);
    const prepared = await prepareRuntimeSchedules(
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
  if (CFG.SOCKET_ENABLED) ensureRealtimeConnection();
  refreshTray();
}

function stopCmsConnection() {
  if (cmsClient) cmsClient.stop();
  cmsClient = null;
}

function startCmsConnection() {
  stopCmsConnection();
  initialAssetSyncStarted = false;
  nextAssetSyncAttemptAt = 0;
  nextLdgLicenseRefreshAt = 0;
  appliedAssetRevision = null;
  appliedScheduleRevision = null;
  heartbeatRevisionSyncPromise = null;
  pendingRemovalRetry = false;
  if (!cfg || cfg.bypass) {
    cmsState = { status: 'test-mode (no server)', lastHeartbeatAt: null, lastError: null };
    setStatus(cmsState.status);
    return;
  }

  cmsClient = new CmsClient({
    serverURL: cfg.serverURL,
    heartbeatIntervalMs: CFG.HEARTBEAT_INTERVAL_MS,
    metadataProvider: playbackTelemetry
  });
  cmsState = { status: 'connecting', lastHeartbeatAt: null, lastError: null };
  cmsClient.on('status', status => {
    cmsState.status = status;
    setStatus(status);
  });
  cmsClient.on('heartbeat', data => {
    cmsState.lastHeartbeatAt = new Date().toISOString();
    cmsState.lastError = null;
    const metadataChanged = applyDeviceMetadata(data);
    if (metadataChanged && CFG.SOCKET_ENABLED) ensureRealtimeConnection();
    pushDashboard();
    void synchronizeHeartbeatRevisions(data);
  });
  cmsClient.on('connection-error', error => {
    cmsState.lastError = error.message || String(error);
    appendVlcLog(`[cms] ${cmsState.lastError}`);
    pushDashboard();
  });
  cmsClient.on('authentication-error', error => {
    cmsState.lastError = error.message || String(error);
    appendVlcLog(`[cms] authentication failed: ${cmsState.lastError}`);
    if (error && error.code === 'invalid_player_token') {
      const notice = 'This Player was revoked by the CMS administrator. Pairing is required before it can be used again.';
      void logout(notice);
      if (loginWin && !loginWin.isDestroyed()) {
        void dialog.showMessageBox(loginWin, { type: 'warning', title: 'Player revoked', message: 'Player revoked', detail: notice, buttons: ['Continue'] });
      }
      return;
    }
    pushDashboard();
  });
  cmsClient.start(cfg.token, {
    app_version: app.getVersion(),
    platform: `${process.platform}-${process.arch}`,
    ldg_version: 'ldg-v1',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Jakarta'
  });
}

function playbackTelemetry() {
  const active = scheduler ? scheduler.getNow() : null;
  const vlcState = vlc ? String(vlc.state || '') : '';
  const telemetry = resolvePlaybackTelemetry(active, vlcState, statusLabel);
  return {
    playback_state: telemetry.state,
    playback_schedule_id: active ? String(active.scheduleId || '') : '',
    playback_error: telemetry.error
  };
}

function sendPairingRefresh(result) {
  if (!loginWin || loginWin.isDestroyed() || !loginWin.webContents) return;
  loginWin.webContents.send('pairing:refresh-result', result);
}

async function performPlayerRefresh(source) {
  refreshState = {
    status: 'refreshing',
    lastRefreshedAt: refreshState.lastRefreshedAt,
    lastError: null
  };
  refreshTray();
  pushDashboard();
  sendPairingRefresh({ ok: true, refreshing: true, source });

  try {
    if (!cfg || !cfg.token) {
      if (!setupSession) {
        const result = {
          ok: true,
          mode: 'pairing',
          requiresLogin: true,
          message: 'Pairing page refreshed. Sign in to retrieve assigned Players.'
        };
        refreshState = { status: 'success', lastRefreshedAt: new Date().toISOString(), lastError: null };
        sendPairingRefresh(result);
        return result;
      }
      if (Date.now() >= setupSession.expiresAt) {
        setupSession = null;
        throw new Error('Operator setup session expired. Sign in again.');
      }
      const client = new CmsClient({ serverURL: setupSession.serverURL });
      const devices = await client.availableDevices(setupSession.token);
      const result = {
        ok: true,
        mode: 'pairing',
        devices: Array.isArray(devices) ? devices : [],
        message: 'Assigned Players refreshed from CMS.'
      };
      refreshState = { status: 'success', lastRefreshedAt: new Date().toISOString(), lastError: null };
      sendPairingRefresh(result);
      return result;
    }

    if (cfg.bypass) {
      const cache = readJson(CACHE_PATH, { schedules: [], assets: [] });
      await refreshMediaHealth(cache.schedules || [], cache.assets || [], { force: true });
      await collectAssetInventory();
      const result = { ok: true, mode: 'test', message: 'Local Player data refreshed.' };
      refreshState = { status: 'success', lastRefreshedAt: new Date().toISOString(), lastError: null };
      return result;
    }

    if (!cmsClient) startCmsConnection();
    if (!cmsClient) throw new Error('CMS connection is unavailable.');
    await cmsClient.heartbeatNow();
    let operatorAccessRevoked = false;
    if (operatorSession) {
      const client = new CmsClient({ serverURL: cfg.serverURL });
      try {
        await client.authorizeDeviceControl(operatorSession.token, cfg.deviceId);
        operatorSession.lastActivityAt = Date.now();
      } catch (error) {
        operatorSession = null;
        operatorAccessRevoked = true;
        appendVlcLog(`[cms] dashboard locked after refresh: ${error.message || error}`);
      }
    }
    const scan = await scanVisibleAssetsAndContinueInBackground();
    const scheduleResult = await syncScheduleSnapshot({ inventory: scan.inventory });
    const assetCount = scan.inventory.assets.length;
    const result = {
      ok: true,
      mode: 'dashboard',
      dashboardLocked: operatorAccessRevoked,
      assetCount,
      message: operatorAccessRevoked
        ? 'Player refreshed. Operator access changed, so the dashboard was locked; remote downloads continue in the background.'
        : `Player refreshed. ${assetCount} local assets scanned and schedule revision ${scheduleResult.revision} synchronized; remote downloads continue in the background.`
    };
    refreshState = { status: 'success', lastRefreshedAt: new Date().toISOString(), lastError: null };
    return result;
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    refreshState = { status: 'error', lastRefreshedAt: refreshState.lastRefreshedAt, lastError: message };
    const result = { ok: false, error: message };
    sendPairingRefresh(result);
    return result;
  } finally {
    refreshTray();
    pushDashboard();
  }
}

function refreshPlayer(source = 'manual') {
  if (refreshPromise) return refreshPromise;
  refreshPromise = performPlayerRefresh(source).finally(() => { refreshPromise = null; });
  return refreshPromise;
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
  const prepared = await prepareRuntimeSchedules(schedules, assets);
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
  const prepared = await prepareRuntimeSchedules(remaining, current.assets);
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

function stopRealtimeConnection(status = 'disabled') {
  if (realtimeClient) realtimeClient.stop();
  realtimeClient = null;
  realtimeState = {
    ...realtimeState, status, connected: false,
    url: cfg && cfg.realtimeUrl || '', lastError: null
  };
  refreshTray();
  pushDashboard();
}

function ensureRealtimeConnection() {
  if (!CFG.SOCKET_ENABLED || !cfg || cfg.bypass || !cfg.realtimeUrl) {
    stopRealtimeConnection(cfg && cfg.bypass ? 'test-mode' : 'disabled');
    return;
  }
  const expectedUrl = String(cfg.realtimeUrl).replace(/\/+$/, '');
  if (realtimeClient && realtimeState.url === expectedUrl) {
    realtimeClient.reconnect();
    return;
  }
  stopRealtimeConnection('connecting');
  const client = new RealtimeClient();
  realtimeClient = client;
  client.on('status', next => {
    realtimeState = { ...realtimeState, ...next };
    refreshTray();
    pushDashboard();
  });
  client.on('hint', hint => {
    void applyRealtimeHint(hint).catch(error => {
      realtimeState = { ...realtimeState, lastError: error.message || String(error) };
      appendVlcLog(`[realtime] revision hint failed: ${realtimeState.lastError}`);
      pushDashboard();
    });
  });
  client.on('message-error', error => {
    realtimeState = { ...realtimeState, lastError: error.message || String(error) };
    appendVlcLog(`[realtime] invalid message: ${realtimeState.lastError}`);
    pushDashboard();
  });
  client.on('connect-error', error => {
    const code = error && error.data && error.data.code || error && error.code || '';
    const message = error && error.message || 'Realtime connection failed.';
    realtimeState = {
      ...realtimeState,
      status: code === 'invalid_player_token' ? 'authentication-error' : 'fallback',
      connected: false, url: expectedUrl, lastError: message
    };
    appendVlcLog(`[realtime] ${message}; REST heartbeat remains active.`);
    refreshTray();
    pushDashboard();
    if (code === 'invalid_player_token') handleRealtimeRevocation();
  });
  client.on('revoked', () => handleRealtimeRevocation());
  client.on('session-replaced', payload => {
    client.stop();
    realtimeState = {
      ...realtimeState, status: 'session-replaced', connected: false,
      lastError: payload && payload.reason || 'A newer Player connection replaced this realtime session.'
    };
    appendVlcLog(`[realtime] ${realtimeState.lastError} REST heartbeat remains active.`);
    refreshTray();
    pushDashboard();
  });
  try {
    client.start({ url: expectedUrl, token: cfg.token, deviceId: cfg.deviceId });
  } catch (error) {
    realtimeState = {
      ...realtimeState, status: 'fallback', connected: false,
      url: expectedUrl, lastError: error.message || String(error)
    };
    appendVlcLog(`[realtime] ${realtimeState.lastError}; REST heartbeat remains active.`);
    refreshTray();
    pushDashboard();
  }
}

let realtimeRevocationHandled = false;
function handleRealtimeRevocation() {
  if (realtimeRevocationHandled || !cfg) return;
  realtimeRevocationHandled = true;
  const notice = 'This Player was revoked by the CMS administrator. Pairing is required before it can be used again.';
  void logout(notice).then(() => {
    if (loginWin && !loginWin.isDestroyed()) {
      return dialog.showMessageBox(loginWin, {
        type: 'warning', title: 'Player revoked', message: 'Player revoked',
        detail: notice, buttons: ['Continue']
      });
    }
  }).finally(() => { realtimeRevocationHandled = false; });
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

async function logout(notice = '') {
  pairingNotice = notice;
  isShuttingDown = true;
  setupSession = null;
  operatorSession = null;
  playbackCheckpoint = null;
  lastResumeInfo = null;
  const wasBypass = Boolean(cfg && cfg.bypass);
  stopRealtimeConnection('disabled');
  stopCmsConnection();
  if (broadcastHandle) { clearInterval(broadcastHandle); broadcastHandle = null; }
  stopPlaybackPreviewLoop();
  await shutdownPlaybackComponents();
  if (scheduleAdderWin && !scheduleAdderWin.isDestroyed()) scheduleAdderWin.destroy();
  if (scheduleManagerWin && !scheduleManagerWin.isDestroyed()) scheduleManagerWin.destroy();
  if (wasBypass) resetTestCachePreservingAssets();
  else if (fs.existsSync(CACHE_PATH)) fs.unlinkSync(CACHE_PATH);
  saveConfig(null);
  nowSchedule = null;
  setStatus('offline');
  createLoginWindow();
  isShuttingDown = false;
}

function quitApp() {
  if (quitPromise) return quitPromise;
  isShuttingDown = true;
  quitPromise = (async () => {
    stopRealtimeConnection('disabled');
    stopCmsConnection();
    if (broadcastHandle) { clearInterval(broadcastHandle); broadcastHandle = null; }
    stopPlaybackPreviewLoop();
    await shutdownPlaybackComponents();
    allowAppQuit = true;
    app.quit();
  })();
  return quitPromise;
}

app.on('ready', () => {
  console.log('Displays:', screen.getAllDisplays());
  playbackSettings = normalizePlaybackSettings(
    readJson(PLAYBACK_SETTINGS_PATH, DEFAULT_PLAYBACK_SETTINGS)
  );
  appliedPlaybackSettings = { ...playbackSettings };
  refreshPlaybackDisplay();
  screen.on('display-added', refreshPlaybackDisplay);
  screen.on('display-removed', refreshPlaybackDisplay);
  screen.on('display-metrics-changed', refreshPlaybackDisplay);
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

app.on('before-quit', event => {
  if (!allowAppQuit) {
    event.preventDefault();
    void quitApp();
    return;
  }
  isShuttingDown = true;
  stopPlaybackPreviewLoop();
  stopRealtimeConnection('disabled');
  stopCmsConnection();
});

app.on('will-quit', () => {
  isShuttingDown = true;
});

process.on('uncaughtException', (err) => {
  console.error('uncaughtException', err);
});
process.on('unhandledRejection', (err) => {
  console.error('unhandledRejection', err);
});
