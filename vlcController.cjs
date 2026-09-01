'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const net = require('net');
const { EventEmitter } = require('events');
const CFG = require('./config.cjs');
const { normalizePlaybackSettings, resolveOutputSize } = require('./playbackSettings.cjs');

function resolveVlcPath() {
  const candidates = [
    path.join(process.resourcesPath || '', 'vlc', 'vlc.exe'),
    path.join(__dirname, 'vlc-portable', 'vlc.exe'),
    path.join(__dirname, 'vlc-portable', 'VLC', 'vlc.exe'),
    path.join(__dirname, 'vlc-portable', 'vlc', 'vlc.exe')
  ];
  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p;
  }
  return 'vlc.exe';
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function aspectRatio(width, height) {
  let a = Math.max(1, Math.round(width));
  let b = Math.max(1, Math.round(height));
  while (b) [a, b] = [b, a % b];
  const divisor = a || 1;
  return `${Math.round(width / divisor)}:${Math.round(height / divisor)}`;
}

const VLC_VOLUME_AT_100_PERCENT = 256;

function parseAudioDeviceLine(line) {
  const match = String(line || '').trim().match(/^\|\s+(.+?)\s+-\s+(.+)$/);
  if (!match) return null;
  const id = match[1].trim();
  const active = /\s\*$/.test(match[2]);
  const name = match[2].replace(/\s\*$/, '').trim();
  if (!id || !name || /^(state|audio volume)$/i.test(id)) return null;
  return { id, name, active };
}

class VlcController extends EventEmitter {
  constructor(options = {}) {
    super();
    this.vlcPath = options.vlcPath || resolveVlcPath();
    this.rcPort = options.rcPort || CFG.VLC_RC_PORT || 4212;
    this.proc = null;
    this.rc = null;
    this.ready = false;
    this.currentPlaylist = [];
    this.state = 'idle';
    this.idleMode = false;
    this.transitionDuration = options.transitionDuration || 0;
    this.pollIntervalMs = Math.max(250, Number(options.pollIntervalMs) || 1000);
    this.resumeInputTimeoutMs = Math.max(250, Number(options.resumeInputTimeoutMs) || 3000);
    this.replacementStopTimeoutMs = Math.max(250, Number(options.replacementStopTimeoutMs) || 2000);
    this.existingRcTimeoutMs = Math.max(250, Number(options.existingRcTimeoutMs) || 1500);
    this.onTransitionStart = options.onTransitionStart || null;
    this.onTransitionEnd = options.onTransitionEnd || null;
    this._pollHandle = null;
    this._buffer = '';
    this._pendingMetricResponses = [];
    // RC metric replies do not carry a request/input id. During a playlist
    // replacement, ignore numeric replies until VLC confirms the new input so
    // late get_time/get_length values cannot leak into the next film.
    this._metricsBlockedUntilInput = true;
    // Unlike playback.currentIndex, this value is only updated from VLC's
    // "new input" response. It prevents optimistic UI state from being
    // mistaken for confirmation that an input is already seekable.
    this._confirmedInputIndex = -1;
    // Playlist replacement is a transaction. Serializing it prevents a
    // scheduler reconciliation from interleaving RC commands with a transition
    // that is still preparing the previous target.
    this._playlistOperation = Promise.resolve();
    this._audioDeviceCapture = null;
    this.audioDevices = [];
    this.playback = {
      currentPath: null,
      currentIndex: -1,
      positionSeconds: 0,
      lengthSeconds: 0,
      updatedAt: null
    };
    this.playbackDisplay = options.playbackDisplay || options.display || null;
    this.idleDisplay = options.idleDisplay || this.playbackDisplay;
    this.display = this.playbackDisplay;
    this.drawableHwnd = options.drawableHwnd == null ? null : String(options.drawableHwnd);
    this._startedDisplayId = null;
    this._startPromise = null;
    this.settings = normalizePlaybackSettings(options.settings);
    this.volumePercent = this.settings.volumePercent;
    this.currentAudioDeviceId = this.settings.audioDeviceId;
  }

  _setState(next) {
    if (this.state === next) return;
    this.state = next;
    this.emit('state-change', next);
  }

  _acknowledgeState(next) {
    this._setState(next);
    // Unlike state-change, this event is emitted for every fresh VLC response,
    // including when the cached state already has the same value.
    this.emit('state-acknowledged', next);
  }

  _resetVlc() {
    this._stopPoll();
    this.ready = false;
    this.proc = null;
    if (this.rc && !this.rc.destroyed) { this.rc.destroy(); this.rc = null; }
    this.currentPlaylist = [];
    this.idleMode = false;
    this._startedDisplayId = null;
    this._pendingMetricResponses = [];
    this._metricsBlockedUntilInput = true;
    this._confirmedInputIndex = -1;
    this._resetPlaybackProgress();
  }

  _resetPlaybackProgress(currentPath = null, currentIndex = -1) {
    this.playback = {
      currentPath,
      currentIndex,
      positionSeconds: 0,
      lengthSeconds: 0,
      updatedAt: new Date().toISOString()
    };
    this.emit('playback-progress', this.getPlaybackStatus());
  }

  getPlaybackStatus() {
    return { ...this.playback };
  }

  getAudioStatus() {
    return {
      devices: this.audioDevices.map(device => ({ ...device })),
      selectedDeviceId: this.settings.audioDeviceId,
      currentDeviceId: this.currentAudioDeviceId,
      volumePercent: this.volumePercent,
      available: this.ready
    };
  }

  _emitPlaybackProgress() {
    this.playback.updatedAt = new Date().toISOString();
    this.emit('playback-progress', this.getPlaybackStatus());
  }

  _setCurrentInput(mrl) {
    if (this.idleMode) return;
    const normalizedMrl = String(mrl || '').trim();
    const index = this.currentPlaylist.findIndex(file => (
      this._toMrl(file).toLowerCase() === normalizedMrl.toLowerCase()
    ));
    const currentPath = index >= 0 ? this.currentPlaylist[index] : normalizedMrl;
    const newlyConfirmed = this._confirmedInputIndex !== index;
    this._confirmedInputIndex = index;
    if (normalizedMrl && newlyConfirmed) {
      this._pendingMetricResponses = [];
      this._metricsBlockedUntilInput = false;
    }
    if (index !== this.playback.currentIndex || currentPath !== this.playback.currentPath) {
      this._resetPlaybackProgress(currentPath, index);
    } else if (newlyConfirmed) {
      this._emitPlaybackProgress();
    }
  }

  _waitForPlaylistIndex(targetIndex, timeoutMs = this.resumeInputTimeoutMs) {
    if (this._confirmedInputIndex === targetIndex) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const onProgress = () => {
        if (this._confirmedInputIndex !== targetIndex) return;
        cleanup();
        resolve();
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`VLC did not confirm playlist item ${targetIndex + 1}`));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.removeListener('playback-progress', onProgress);
      };
      this.on('playback-progress', onProgress);
    });
  }

  _waitForStopAcknowledgement(timeoutMs = this.replacementStopTimeoutMs) {
    return new Promise((resolve, reject) => {
      const onStopped = () => {
        cleanup();
        resolve();
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('VLC did not acknowledge the stop command'));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.removeListener('stop-acknowledged', onStopped);
      };
      this.on('stop-acknowledged', onStopped);
    });
  }

  _waitForPlaybackState(targetState, timeoutMs = this.resumeInputTimeoutMs, options = {}) {
    if (!options.fresh && this.state === targetState) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const onStateChange = nextState => {
        if (nextState !== targetState) return;
        cleanup();
        resolve();
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`VLC did not confirm ${targetState} state`));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.removeListener(options.fresh ? 'state-acknowledged' : 'state-change', onStateChange);
      };
      this.on(options.fresh ? 'state-acknowledged' : 'state-change', onStateChange);
    });
  }

  _waitForFreshPlaybackState(targetState, timeoutMs = this.resumeInputTimeoutMs) {
    return this._waitForPlaybackState(targetState, timeoutMs, { fresh: true });
  }

  _queryPlaybackState(timeoutMs = this.resumeInputTimeoutMs) {
    return new Promise((resolve, reject) => {
      const onState = nextState => {
        cleanup();
        resolve(nextState);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('VLC did not report its playback state'));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.removeListener('state-acknowledged', onState);
      };
      this.on('state-acknowledged', onState);
      this.send('status');
    });
  }

  _waitForPlaybackPosition(targetIndex, targetPosition, timeoutMs = this.resumeInputTimeoutMs) {
    return new Promise((resolve, reject) => {
      const onProgress = playback => {
        if (this._confirmedInputIndex !== targetIndex) return;
        if (Math.abs((Number(playback.positionSeconds) || 0) - targetPosition) > 1) return;
        cleanup();
        resolve();
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`VLC did not confirm playback position ${targetPosition}s`));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.removeListener('playback-progress', onProgress);
      };
      this.on('playback-progress', onProgress);
    });
  }

  _toMrl(p) {
    let s = String(p);
    if (/^https?:\/\//i.test(s)) return s.replace(/ /g, '%20');
    s = s.replace(/\\/g, '/');
    s = s.replace(/%/g, '%25').replace(/#/g, '%23').replace(/\?/g, '%3F').replace(/ /g, '%20');
    if (/^[A-Za-z]:/.test(s)) s = 'file:///' + s;
    else if (!/^file:/.test(s)) s = 'file://' + s;
    return s;
  }

  send(cmd) {
    if (!this.rc || !this.rc.writable) {
      this.emit('vlc-log', `[RC send] socket not writable`);
      return false;
    }
    const line = cmd.endsWith('\n') ? cmd : cmd + '\n';
    this.emit('vlc-log', `[RC send] ${line.trim()}`);
    return this.rc.write(line);
  }

  _parseRc(chunk) {
    this.emit('vlc-log', `[RC raw] ${JSON.stringify(chunk)}`);
    this._buffer += chunk;
    const lines = this._buffer.split(/\r?\n/);
    this._buffer = lines.pop() || '';
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      this.emit('rc-data', line);

      if (this._audioDeviceCapture) {
        const device = parseAudioDeviceLine(t);
        if (device && !this._audioDeviceCapture.devices.some(item => item.id === device.id)) {
          this._audioDeviceCapture.devices.push(device);
          if (device.active) this._audioDeviceCapture.currentDeviceId = device.id;
        }
      }

      const volumeMatch = t.match(/audio volume:\s*(\d+)/i);
      if (volumeMatch) {
        this.volumePercent = Math.max(0, Math.min(100, Math.round(
          (Number(volumeMatch[1]) / VLC_VOLUME_AT_100_PERCENT) * 100
        )));
        this.emit('audio-change', this.getAudioStatus());
      }

      const timeMatch = t.match(/\btime\s*:\s*(\d+)s\b/i);
      if (timeMatch && !this._metricsBlockedUntilInput && this._confirmedInputIndex >= 0) {
        this.playback.positionSeconds = Math.max(0, Number(timeMatch[1]) || 0);
        this._emitPlaybackProgress();
      }

      const inputMatch = t.match(/new input\s*:\s*(.+?)\s*\)?$/i);
      if (inputMatch) {
        this._setCurrentInput(inputMatch[1]);
        continue;
      }

      const numericMatch = t.match(/^>?\s*(-?\d+)\s*$/);
      if (numericMatch && this._pendingMetricResponses.length) {
        const metric = this._pendingMetricResponses.shift();
        const value = Math.max(0, Number(numericMatch[1]) || 0);
        if (metric === 'positionSeconds') this.playback.positionSeconds = value;
        if (metric === 'lengthSeconds') this.playback.lengthSeconds = value;
        this._emitPlaybackProgress();
        continue;
      }

      let raw = null;
      // console RC: "state: playing" or "| state: playing"
      let m = t.match(/(?:^\|\s*)?state\s*:\s*([a-zA-Z_]+)/i);
      if (m) raw = m[1];
      // TCP RC: "( state playing )" or "state playing"
      if (!raw) { m = t.match(/(?:state\s+)([a-zA-Z_]+)/i); if (m) raw = m[1]; }
      if (raw) {
        raw = raw.toLowerCase();
        const map = { playing: 'playing', paused: 'paused', opening: 'playing', buffering: 'playing', stopped: 'idle', ended: 'idle', error: 'error' };
        const next = map[raw] || 'idle';
        if (raw === 'stopped') this.emit('stop-acknowledged');
        this._acknowledgeState(this.idleMode && next === 'playing' ? 'idle' : next);
        continue;
      }
      // VLC TCP RC numeric status-change notifications.
      const l = t.toLowerCase();
      if (l.includes('play state:')) this._acknowledgeState(this.idleMode ? 'idle' : 'playing');
      else if (l.includes('pause state:')) this._acknowledgeState('paused');
      else if (l.includes("type 'pause' to continue")) this._acknowledgeState('paused');
      else if (l.includes('stop state:')) {
        this.emit('stop-acknowledged');
        this._acknowledgeState('idle');
      }
    }
  }

  _connectRc() {
    return new Promise((resolve, reject) => {
      if (this.rc && !this.rc.destroyed) return resolve();
      const sock = new net.Socket();
      let settled = false;
      sock.setEncoding('utf8');
      sock.on('connect', () => {
        this.rc = sock;
        if (!settled) { settled = true; resolve(); }
        this.emit('vlc-log', `[RC] TCP connected 127.0.0.1:${this.rcPort}`);
        this.ready = true;
        this.emit('ready');
        this._startPoll();
      });
      sock.on('data', (data) => { this._parseRc(data); });
      sock.on('error', (err) => {
        this.emit('vlc-log', `[RC] TCP error: ${err.message}`);
        if (!settled) { settled = true; reject(err); }
      });
      sock.on('close', () => {
        this.emit('vlc-log', `[RC] TCP closed`);
        this.rc = null;
        this.ready = false;
        this._stopPoll();
      });
      sock.connect(this.rcPort, '127.0.0.1');
    });
  }

  _waitForRc(maxMs = 8000) {
    const deadline = Date.now() + maxMs;
    return new Promise((resolve, reject) => {
      const tryConnect = async () => {
        if (Date.now() > deadline) return reject(new Error('RC TCP not available'));
        try {
          await this._connectRc();
          resolve();
        } catch (err) {
          setTimeout(tryConnect, 300);
        }
      };
      tryConnect();
    });
  }

  _buildStartArgs() {
    const settings = normalizePlaybackSettings(this.settings);
    this.settings = settings;
    const output = resolveOutputSize(settings, this.display);
    const bounds = this.display && this.display.bounds || { x: 0, y: 0, width: output.width, height: output.height };
    const fullscreen = settings.outputMode === 'fullscreen';
    const embeddedOutput = Boolean(this.drawableHwnd);
    const x = fullscreen ? bounds.x : bounds.x + Math.max(0, Math.round((bounds.width - output.width) / 2));
    const y = fullscreen ? bounds.y : bounds.y + Math.max(0, Math.round((bounds.height - output.height) / 2));
    const ratio = aspectRatio(output.width, output.height);
    const args = [
      '--intf', settings.hideVlcUi ? 'dummy' : 'qt',
      '--extraintf', 'rc',
      `--rc-host=127.0.0.1:${this.rcPort}`,
      '--video-x', String(x),
      '--video-y', String(y),
      '--width', String(output.width),
      '--height', String(output.height),
      embeddedOutput ? '--no-fullscreen' : (fullscreen ? '--fullscreen' : '--no-fullscreen'),
      '--no-video-title-show',
      '--volume', String(Math.round((settings.volumePercent / 100) * VLC_VOLUME_AT_100_PERCENT)),
      '--loop'
    ];
    if (embeddedOutput) args.push(`--drawable-hwnd=${this.drawableHwnd}`);
    if (settings.hideVlcUi) {
      args.push('--no-qt-fs-controller', '--no-video-deco');
    } else {
      args.push('--no-qt-error-dialogs', '--qt-continue=0', '--no-qt-recentplay');
    }
    if (settings.scaling === 'fill') args.push('--autoscale', '--crop', ratio);
    else if (settings.scaling === 'stretch') args.push('--autoscale', '--aspect-ratio', ratio);
    else args.push('--autoscale');
    return args;
  }

  _buildSpawnOptions(vlcDir) {
    return {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Idle output is owned by Electron. During scheduled native fullscreen
      // playback this suppresses VLC's console/interface while its video
      // output remains visible.
      windowsHide: this.settings.hideVlcUi,
      cwd: vlcDir,
      env: process.env
    };
  }

  _isOwnedProcessAlive() {
    if (!this.proc || !this.proc.pid) return false;
    try {
      process.kill(this.proc.pid, 0);
      return true;
    } catch (_) {
      return false;
    }
  }

  start() {
    if (this._startPromise) return this._startPromise;
    this._startPromise = this._startWithRecovery()
      .finally(() => { this._startPromise = null; });
    return this._startPromise;
  }

  async _startWithRecovery() {
    if (this._isOwnedProcessAlive()) {
      try {
        await this._waitForRc(this.existingRcTimeoutMs);
        return;
      } catch (error) {
        this.emit('vlc-log', `[recovery] owned VLC process has no RC endpoint; replacing it (${error.message})`);
        await this._stopForOutputChange();
      }
    } else if (this.proc) {
      this._resetVlc();
      this._setState('idle');
    }

    try {
      await this._spawnVlc();
    } catch (error) {
      await this._stopForOutputChange();
      this._setState('error');
      throw error;
    }
  }

  _spawnVlc() {
    return new Promise((resolve, reject) => {
      const args = this._buildStartArgs();

      const vlcDir = path.dirname(this.vlcPath);
      this.emit('vlc-log', `--- start attempt at ${new Date().toISOString()} ---`);

      try {
        this.proc = spawn(this.vlcPath, args, this._buildSpawnOptions(vlcDir));
        this._startedDisplayId = this.display && String(this.display.id);
      } catch (err) {
        this._setState('error');
        return reject(err);
      }

      const startedProc = this.proc;
      const stderrLines = [];
      startedProc.stdout.on('data', (buf) => {
        const text = buf.toString('utf8');
        this.emit('vlc-stdout', text.trim());
        this._parseRc(text);
      });
      startedProc.stderr.on('data', (buf) => {
        const text = buf.toString('utf8');
        stderrLines.push(text.trim());
        if (stderrLines.length > 50) stderrLines.shift();
        this.emit('vlc-stderr', text.trim());
      });
      startedProc.on('error', (err) => {
        if (this.proc !== startedProc) return;
        this._setState('error');
        this.emit('error', err);
      });
      startedProc.on('exit', (code) => {
        // A process intentionally closed for idle mode may report its exit
        // after a replacement VLC process has already started.
        if (this.proc !== startedProc) return;
        this.emit('exit', code);
        if (code !== 0 && code != null) {
          const tail = stderrLines.slice(-15).join('\n');
          this.emit('error', new Error('VLC exited code=' + code + (tail ? '\n' + tail : '')));
          this._resetVlc();
          this._setState('error');
        } else {
          this._resetVlc();
          this._setState('idle');
        }
      });

      this._waitForRc().then(resolve).catch(reject);
    });
  }

  _startPoll() {
    if (this._pollHandle) clearInterval(this._pollHandle);
    this._pollPlayback();
    this._pollHandle = setInterval(() => this._pollPlayback(), this.pollIntervalMs);
    if (this._pollHandle.unref) this._pollHandle.unref();
  }

  _pollPlayback() {
    this.send('status');
    if (this.idleMode || this._metricsBlockedUntilInput || this._confirmedInputIndex < 0) {
      this._pendingMetricResponses = [];
      return;
    }
    this._pendingMetricResponses = ['positionSeconds', 'lengthSeconds'];
    this.send('get_time');
    this.send('get_length');
  }

  _stopPoll() {
    if (this._pollHandle) { clearInterval(this._pollHandle); this._pollHandle = null; }
  }

  refreshAudioDevices(timeoutMs = 600) {
    if (!this.ready) return Promise.resolve(this.getAudioStatus());
    if (this._audioDeviceCapture) {
      clearTimeout(this._audioDeviceCapture.timer);
      this._audioDeviceCapture.resolve(this.getAudioStatus());
      this._audioDeviceCapture = null;
    }
    return new Promise(resolve => {
      const capture = { devices: [], currentDeviceId: null, resolve, timer: null };
      capture.timer = setTimeout(() => {
        if (this._audioDeviceCapture !== capture) return;
        this._audioDeviceCapture = null;
        if (capture.devices.length) {
          this.audioDevices = capture.devices.map(({ id, name }) => ({ id, name }));
          this.currentAudioDeviceId = capture.currentDeviceId;
        }
        this.emit('audio-change', this.getAudioStatus());
        resolve(this.getAudioStatus());
      }, Math.max(200, Number(timeoutMs) || 600));
      this._audioDeviceCapture = capture;
      if (!this.send('adev')) {
        clearTimeout(capture.timer);
        this._audioDeviceCapture = null;
        resolve(this.getAudioStatus());
      }
    });
  }

  setAudioDevice(deviceId) {
    const normalized = normalizePlaybackSettings({
      ...this.settings,
      audioDeviceId: deviceId
    });
    this.settings = normalized;
    this.currentAudioDeviceId = normalized.audioDeviceId;
    if (this.ready && normalized.audioDeviceId) this.send(`adev ${normalized.audioDeviceId}`);
    this.emit('audio-change', this.getAudioStatus());
    return this.getAudioStatus();
  }

  setVolumePercent(value) {
    const normalized = normalizePlaybackSettings({
      ...this.settings,
      volumePercent: value
    });
    this.settings = normalized;
    return this.applyVolumePercent(normalized.volumePercent);
  }

  applyVolumePercent(value) {
    const numeric = Number(value);
    this.volumePercent = Number.isFinite(numeric)
      ? Math.max(0, Math.min(100, Math.round(numeric)))
      : 100;
    if (this.ready) {
      this.send(`volume ${Math.round((this.volumePercent / 100) * VLC_VOLUME_AT_100_PERCENT)}`);
    }
    this.emit('audio-change', this.getAudioStatus());
    return this.getAudioStatus();
  }

  applyAudioSettings() {
    if (this.settings.audioDeviceId) this.setAudioDevice(this.settings.audioDeviceId);
    this.setVolumePercent(this.settings.volumePercent);
    const refreshTimer = setTimeout(() => {
      this.refreshAudioDevices().catch(() => {});
    }, 500);
    if (refreshTimer.unref) refreshTimer.unref();
  }

  replacePlaylist(filePaths, options = {}) {
    const operation = () => this._replacePlaylist(filePaths, options);
    const pending = this._playlistOperation.then(operation, operation);
    this._playlistOperation = pending.catch(() => {});
    return pending;
  }

  async _replacePlaylist(filePaths, options = {}) {
    if (!Array.isArray(filePaths)) filePaths = [];
    const hadActiveInput = Boolean(
      this.playback.currentPath ||
      this._confirmedInputIndex >= 0 ||
      this.state === 'playing' ||
      this.state === 'paused'
    );
    const nextIdleMode = Boolean(options.idle);
    this.idleMode = nextIdleMode;

    const targetDisplay = nextIdleMode
      ? (this.idleDisplay || this.playbackDisplay || this.display)
      : (this.playbackDisplay || this.display);
    const targetDisplayId = targetDisplay && String(targetDisplay.id);
    const outputDisplayChanged = Boolean(
      this.proc && this._startedDisplayId != null &&
      targetDisplayId != null && this._startedDisplayId !== targetDisplayId
    );

    if (targetDisplay) this.display = targetDisplay;
    this._beginInputTransition(filePaths);
    const shouldLoop = options.loop !== false;

    const useTransition = this.transitionDuration > 0;
    let transitionStarted = false;
    let transitionEnded = false;
    try {
      if (useTransition && this.onTransitionStart) {
        // Mark the cover active before invoking the UI hook so a partial UI
        // failure still runs the cleanup in finally.
        transitionStarted = true;
        // The output window and its black cover must be fully stacked before
        // VLC is allowed to decode the first frame of the next input.
        await Promise.resolve(this.onTransitionStart());
        await sleep(this.transitionDuration);
      }

      if (outputDisplayChanged) await this._stopForOutputChange();

      if (!this.ready) await this.start();
      // VLC old-RC "clear" only clears the playlist; it does not reliably close
      // the decoder that is currently playing. Always stop and wait for VLC's
      // acknowledgement before loading the replacement so time/length replies
      // from the previous film cannot bleed into the next one. Stop works for
      // both playing and paused inputs, so no toggle is needed here.
      if (hadActiveInput) {
        // Do not use the cached `idle` state as proof that this stop completed.
        // At a natural media boundary VLC is already reported idle while its old
        // input/decoder may still be releasing. Wait for a fresh RC response to
        // this stop command, then give the decoder a short quiescence window.
        const stopped = this._waitForStopAcknowledgement();
        this.send('stop');
        this.send('status');
        try {
          await stopped;
          await sleep(150);
        } catch (error) {
          // A missing old-RC acknowledgement must not allow stale decoder state
          // into the next film. Recreate VLC, matching the already-safe gap path.
          this.emit('vlc-log', `[transition] ${error.message}; restarting VLC before replacement`);
          await this._stopForOutputChange();
          await this.start();
        }
      }
      this.send('clear');
      await sleep(200);
      // RC "add" starts the newly added item immediately, so repeatedly using it
      // makes the last playlist item win. Enqueue everything first, then issue one
      // play command so VLC starts from the first item in the requested order.
      for (const p of filePaths) {
        const mrl = this._toMrl(p);
        this.send('enqueue ' + mrl);
        await sleep(100);
      }
      this.send(`loop ${shouldLoop ? 'on' : 'off'}`);
      const firstInputConfirmation = filePaths.length && !this.idleMode
        ? this._waitForPlaylistIndex(0)
        : null;
      const firstPlayingConfirmation = filePaths.length && !this.idleMode
        ? this._waitForFreshPlaybackState('playing')
        : null;
      // Set a scheduled item volume before decoding starts so the first audio
      // frame cannot leak at the previous film/operator volume. Reapply it
      // after the normal audio settings because VLC may initialize the output
      // device only once playback has started.
      if (filePaths.length && Object.prototype.hasOwnProperty.call(options, 'volumePercent')) {
        this.applyVolumePercent(options.volumePercent);
      }
      if (filePaths.length) this.send('play');
      await sleep(300);
      if (filePaths.length) {
        this.applyAudioSettings();
        if (Object.prototype.hasOwnProperty.call(options, 'volumePercent')) {
          this.applyVolumePercent(options.volumePercent);
        }
      }
      this.send('status');
      await Promise.all([firstInputConfirmation, firstPlayingConfirmation].filter(Boolean));
      const startIndex = Math.max(0, Math.floor(Number(options.startIndex) || 0));
      const startPositionSeconds = Math.max(0, Math.floor(Number(options.startPositionSeconds) || 0));
      let preparedAtOffset = false;
      if (filePaths.length && !this.idleMode && (startIndex > 0 || startPositionSeconds > 0)) {
        await this.preparePlaylistAt(startIndex, startPositionSeconds);
        preparedAtOffset = true;
      } else if (filePaths.length) {
        this._setState(this.idleMode ? 'idle' : 'playing');
      }

      if (useTransition && this.onTransitionEnd) {
        await sleep(this.transitionDuration);
        await Promise.resolve(this.onTransitionEnd());
        transitionEnded = true;
      }
      if (preparedAtOffset) await this.resumePreparedPlayback();
    } catch (error) {
      // Never strand the decoder paused behind the black transition cover.
      // A plain play command is an idempotent recovery action for old-RC even
      // when its cached state no longer matches the actual VLC state.
      if (filePaths.length && this.ready && !this.idleMode) {
        try {
          const recovered = this._waitForFreshPlaybackState('playing');
          this.send('play');
          this.send('status');
          await recovered;
        } catch (recoveryError) {
          this.emit('vlc-log', `[transition] playback recovery failed: ${recoveryError.message}`);
        }
      }
      throw error;
    } finally {
      if (transitionStarted && !transitionEnded && this.onTransitionEnd) {
        try {
          await Promise.resolve(this.onTransitionEnd());
        } catch (overlayError) {
          this.emit('vlc-log', `[transition] overlay cleanup failed: ${overlayError.message}`);
        }
      }
    }
  }

  async clear() {
    this.currentPlaylist = [];
    this.idleMode = false;
    this._pendingMetricResponses = [];
    this._metricsBlockedUntilInput = true;
    this._confirmedInputIndex = -1;
    this._resetPlaybackProgress();
    this.send('stop');
    await sleep(100);
    this.send('clear');
    await sleep(100);
    this._setState('idle');
    this.send('status');
  }

  _beginInputTransition(filePaths) {
    const files = Array.isArray(filePaths) ? filePaths.slice() : [];
    this.currentPlaylist = files;
    this._pendingMetricResponses = [];
    this._metricsBlockedUntilInput = files.length > 0 && !this.idleMode;
    this._confirmedInputIndex = -1;
    this._resetPlaybackProgress(files[0] || null, files.length ? 0 : -1);
  }

  async pause() {
    const actualState = await this._queryPlaybackState();
    if (actualState === 'paused') return this.getPlaybackStatus();
    const paused = this._waitForFreshPlaybackState('paused');
    this.send('pause');
    this.send('status');
    await paused;
    return this.getPlaybackStatus();
  }

  async play() {
    const playing = this._waitForFreshPlaybackState('playing');
    this.send('play');
    this.send('status');
    await playing;
    return this.getPlaybackStatus();
  }

  async resume() {
    const actualState = await this._queryPlaybackState();
    if (actualState === 'playing') return this.getPlaybackStatus();
    // VLC old RC pause is a toggle. Use it only after a fresh response has
    // confirmed that the decoder is really paused.
    const playing = this._waitForFreshPlaybackState('playing');
    if (actualState === 'paused') {
      this.send('pause');
    } else {
      this.send('play');
    }
    this.send('status');
    await playing;
    return this.getPlaybackStatus();
  }

  async seekTo(positionSeconds) {
    if (!this.ready) throw new Error('VLC RC is not ready');
    const length = Math.max(0, Math.floor(Number(this.playback.lengthSeconds) || 0));
    if (length <= 0) throw new Error('Current media duration is not available');
    const target = Math.max(0, Math.min(
      length - 1,
      Math.floor(Number(positionSeconds) || 0)
    ));
    this.send(`seek ${target}`);
    await sleep(120);
    this.playback.positionSeconds = target;
    this._emitPlaybackProgress();
    this._pollPlayback();
    return this.getPlaybackStatus();
  }

  async seekRelative(deltaSeconds) {
    const current = Math.max(0, Number(this.playback.positionSeconds) || 0);
    return this.seekTo(current + Number(deltaSeconds || 0));
  }

  async resumePlaylistAt(index, positionSeconds = 0) {
    if (!this.ready) throw new Error('VLC RC is not ready');
    if (!this.currentPlaylist.length) throw new Error('Cannot resume an empty playlist');
    const targetIndex = Math.max(0, Math.min(
      this.currentPlaylist.length - 1,
      Math.floor(Number(index) || 0)
    ));
    const targetPosition = Math.max(0, Math.floor(Number(positionSeconds) || 0));

    // The bundled VLC 3 old-RC interface addresses playlist items from 1,
    // while the player keeps zero-based array indexes internally. Do not send
    // goto when VLC already confirmed the requested input. In particular,
    // goto 1 reloads a one-item playlist asynchronously and can reset a seek
    // that was issued immediately afterwards.
    const inputConfirmation = this._waitForPlaylistIndex(targetIndex);
    const awaitingNaturalFirstInput = this._confirmedInputIndex < 0 && targetIndex === 0;
    if (this._confirmedInputIndex !== targetIndex && !awaitingNaturalFirstInput) {
      this.send(`goto ${targetIndex + 1}`);
    }
    await inputConfirmation;
    // Give the newly confirmed input a short moment to become seekable.
    await sleep(100);
    if (targetPosition > 0) this.send(`seek ${targetPosition}`);
    await sleep(200);

    this.playback.positionSeconds = targetPosition;
    this._emitPlaybackProgress();
    this._setState('playing');
    this._pollPlayback();
    return this.getPlaybackStatus();
  }

  async preparePlaylistAt(index, positionSeconds = 0) {
    if (!this.ready) throw new Error('VLC RC is not ready');
    if (!this.currentPlaylist.length) throw new Error('Cannot prepare an empty playlist');
    const targetIndex = Math.max(0, Math.min(
      this.currentPlaylist.length - 1,
      Math.floor(Number(index) || 0)
    ));
    const targetPosition = Math.max(0, Math.floor(Number(positionSeconds) || 0));

    const inputConfirmation = this._waitForPlaylistIndex(targetIndex);
    const awaitingNaturalFirstInput = this._confirmedInputIndex < 0 && targetIndex === 0;
    if (this._confirmedInputIndex !== targetIndex && !awaitingNaturalFirstInput) {
      this.send(`goto ${targetIndex + 1}`);
    }
    await inputConfirmation;

    const positioned = this._waitForPlaybackPosition(targetIndex, targetPosition);
    this.send(`seek ${targetPosition}`);
    await sleep(120);
    this._pollPlayback();
    await positioned;

    // Seeking old-RC while paused is unreliable. Confirm the requested frame
    // while the decoder is running, then freeze that confirmed frame.
    const paused = this._waitForFreshPlaybackState('paused');
    this.send('pause');
    this.send('status');
    await paused;
    this.playback.positionSeconds = targetPosition;
    this._emitPlaybackProgress();
    return this.getPlaybackStatus();
  }

  async resumePreparedPlayback() {
    if (!this.ready) throw new Error('VLC RC is not ready');
    if (this.state !== 'paused') throw new Error('VLC prepared playback is not paused');
    const playing = this._waitForFreshPlaybackState('playing');
    // VLC old-RC pause is a toggle; a second pause resumes the prepared frame.
    this.send('pause');
    this.send('status');
    await playing;
    this._setState('playing');
    return this.getPlaybackStatus();
  }

  async playIdle() {
    // Electron owns the dedicated idle video window. VLC is fully stopped so
    // no Qt/console/logo window can leak onto either monitor while idle.
    this.idleMode = true;
    this.currentPlaylist = [];
    this._pendingMetricResponses = [];
    this._confirmedInputIndex = -1;
    this._resetPlaybackProgress();
    if (this.onTransitionStart) await Promise.resolve(this.onTransitionStart());
    await this._stopForOutputChange();
    this._setState('idle');
  }

  isPlaying() { return this.state === 'playing'; }

  simulateCrashForRecoveryTest() {
    if (!this.proc || typeof this.proc.kill !== 'function') {
      throw new Error('VLC process is not running');
    }
    const pid = Number(this.proc.pid) || null;
    const killed = this.proc.kill();
    if (killed === false) throw new Error('Windows refused to terminate the VLC process');
    this.emit('vlc-log', `[test] simulated VLC crash${pid ? ` pid=${pid}` : ''}`);
    return { pid };
  }

  async _stopForOutputChange() {
    this._stopPoll();
    this.send('quit');
    const previousProc = this.proc;
    this.proc = null;
    this.ready = false;
    this._startedDisplayId = null;
    if (this.rc && !this.rc.destroyed) this.rc.destroy();
    this.rc = null;
    if (previousProc) {
      try { previousProc.kill(); } catch (_) {}
    }
    await sleep(250);
  }

  async quit() {
    this._stopPoll();
    this.send('quit');
    await sleep(200);
    if (this.rc && !this.rc.destroyed) { this.rc.destroy(); this.rc = null; }
    if (this.proc) { try { this.proc.kill(); } catch (_) {} }
    this._resetVlc();
    this._setState('idle');
  }
}

module.exports = { VlcController, parseAudioDeviceLine };
