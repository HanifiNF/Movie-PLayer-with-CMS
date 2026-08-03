'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const net = require('net');
const { EventEmitter } = require('events');
const CFG = require('./config.cjs');
const { ensureIdleVideo } = require('./assets/ensureIdleVideo.cjs');

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
    this.onTransitionStart = options.onTransitionStart || null;
    this.onTransitionEnd = options.onTransitionEnd || null;
    this._pollHandle = null;
    this._buffer = '';
    this._pendingMetricResponses = [];
    this.playback = {
      currentPath: null,
      currentIndex: -1,
      positionSeconds: 0,
      lengthSeconds: 0,
      updatedAt: null
    };
    this.display = options.display || null;
  }

  _setState(next) {
    if (this.state === next) return;
    this.state = next;
    this.emit('state-change', next);
  }

  _resetVlc() {
    this._stopPoll();
    this.ready = false;
    this.proc = null;
    if (this.rc && !this.rc.destroyed) { this.rc.destroy(); this.rc = null; }
    this.currentPlaylist = [];
    this.idleMode = false;
    this._pendingMetricResponses = [];
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

  _emitPlaybackProgress() {
    this.playback.updatedAt = new Date().toISOString();
    this.emit('playback-progress', this.getPlaybackStatus());
  }

  _setCurrentInput(mrl) {
    const normalizedMrl = String(mrl || '').trim();
    const index = this.currentPlaylist.findIndex(file => (
      this._toMrl(file).toLowerCase() === normalizedMrl.toLowerCase()
    ));
    const currentPath = index >= 0 ? this.currentPlaylist[index] : normalizedMrl;
    if (index !== this.playback.currentIndex || currentPath !== this.playback.currentPath) {
      this._resetPlaybackProgress(currentPath, index);
    }
  }

  _waitForPlaylistIndex(targetIndex, timeoutMs = this.resumeInputTimeoutMs) {
    if (this.playback.currentIndex === targetIndex) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const onProgress = playback => {
        if (playback.currentIndex !== targetIndex) return;
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

  _toMrl(p) {
    let s = String(p);
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
        this._setState(map[raw] || 'idle');
        continue;
      }
      // VLC TCP RC numeric status-change notifications.
      const l = t.toLowerCase();
      if (l.includes('play state:')) this._setState('playing');
      else if (l.includes('pause state:')) this._setState('paused');
      else if (l.includes('stop state:')) this._setState('idle');
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
    let x = 0, y = 0, w = 1920, h = 1080;
    if (this.display) {
      x = this.display.bounds.x;
      y = this.display.bounds.y;
      w = this.display.bounds.width;
      h = this.display.bounds.height;
    }
    return [
      '--intf', 'qt',
      '--extraintf', 'rc',
      `--rc-host=127.0.0.1:${this.rcPort}`,
      '--video-x', String(x),
      '--video-y', String(y),
      '--width', String(w),
      '--height', String(h),
      '--fullscreen',
      '--no-video-title-show',
      '--loop',
      '--no-qt-error-dialogs',
      '--qt-continue=0',
      '--no-qt-recentplay'
    ];
  }

  start() {
    if (this.proc) {
      try {
        process.kill(this.proc.pid, 0);
        return this._waitForRc();
      } catch (_) {
        this._resetVlc();
        this._setState('idle');
      }
    }
    return new Promise((resolve, reject) => {
      const args = this._buildStartArgs();

      const vlcDir = path.dirname(this.vlcPath);
      const env = process.env;

      this.emit('vlc-log', `--- start attempt at ${new Date().toISOString()} ---`);

      try {
        this.proc = spawn(this.vlcPath, args, {
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: false,
          cwd: vlcDir,
          env: env
        });
      } catch (err) {
        this._setState('error');
        return reject(err);
      }

      const stderrLines = [];
      this.proc.stdout.on('data', (buf) => {
        const text = buf.toString('utf8');
        this.emit('vlc-stdout', text.trim());
        this._parseRc(text);
      });
      this.proc.stderr.on('data', (buf) => {
        const text = buf.toString('utf8');
        stderrLines.push(text.trim());
        if (stderrLines.length > 50) stderrLines.shift();
        this.emit('vlc-stderr', text.trim());
      });
      this.proc.on('error', (err) => {
        this._setState('error');
        this.emit('error', err);
      });
      this.proc.on('exit', (code) => {
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
    this._pendingMetricResponses = ['positionSeconds', 'lengthSeconds'];
    this.send('get_time');
    this.send('get_length');
  }

  _stopPoll() {
    if (this._pollHandle) { clearInterval(this._pollHandle); this._pollHandle = null; }
  }

  async replacePlaylist(filePaths, options = {}) {
    if (!Array.isArray(filePaths)) filePaths = [];
    this.currentPlaylist = filePaths.slice();
    this._resetPlaybackProgress(filePaths[0] || null, filePaths.length ? 0 : -1);
    this.idleMode = !!options.idle;
    const shouldLoop = options.loop !== false;

    const useTransition = this.transitionDuration > 0;
    if (useTransition && this.onTransitionStart) {
      this.onTransitionStart();
      await sleep(this.transitionDuration);
    }

    if (!this.ready) await this.start();
    // If the player is paused, the old RC "play" command means resume and the
    // prompt mode may ignore the new item. Unpause first, then stop, so the
    // subsequent clear/add/play actually switches to the new content.
    if (this.state === 'paused') {
      this.send('pause');
      await sleep(100);
      this.send('stop');
      await sleep(200);
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
    if (filePaths.length) this.send('play');
    await sleep(300);
    this.send('status');
    if (filePaths.length) this._setState('playing');

    if (useTransition && this.onTransitionEnd) {
      await sleep(this.transitionDuration);
      this.onTransitionEnd();
    }
  }

  async clear() {
    this.currentPlaylist = [];
    this.idleMode = false;
    this._pendingMetricResponses = [];
    this._resetPlaybackProgress();
    this.send('stop');
    await sleep(100);
    this.send('clear');
    await sleep(100);
    this._setState('idle');
    this.send('status');
  }

  async pause() {
    this.send('pause');
    await sleep(100);
    this._setState('paused');
    this.send('status');
  }

  async play() {
    this.send('play');
    await sleep(100);
    this._setState('playing');
    this.send('status');
  }

  async resume() {
    // VLC old RC pause is a toggle. When paused, send pause again to resume.
    if (this.state === 'paused') {
      this.send('pause');
    } else {
      this.send('play');
    }
    await sleep(100);
    this._setState('playing');
    this.send('status');
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
    // while the player keeps zero-based array indexes internally.
    const inputConfirmation = this._waitForPlaylistIndex(targetIndex);
    this.send(`goto ${targetIndex + 1}`);
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

  async playIdle() {
    try {
      let outputDir;
      try {
        const { app } = require('electron');
        outputDir = app.getPath('userData');
      } catch (_) {
        outputDir = require('os').tmpdir();
      }
      const idlePath = await ensureIdleVideo({ outputDir, text: 'No Active Schedule', fontSize: 72 });
      await this.replacePlaylist([idlePath], { idle: true });
    } catch (e) {
      this.idleMode = false;
      this.emit('vlc-log', `[playIdle] failed: ${e.message}; falling back to clear()`);
      await this.clear();
    }
  }

  isPlaying() { return this.state === 'playing'; }

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

module.exports = { VlcController };
