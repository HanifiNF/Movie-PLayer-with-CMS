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
    this.onTransitionStart = options.onTransitionStart || null;
    this.onTransitionEnd = options.onTransitionEnd || null;
    this._pollHandle = null;
    this._buffer = '';
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
      let x = 0, y = 0, w = 1920, h = 1080;
      if (this.display) {
        x = this.display.bounds.x;
        y = this.display.bounds.y;
        w = this.display.bounds.width;
        h = this.display.bounds.height;
      }

      const args = [
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
        '--no-qt-error-dialogs'
      ];

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
    this._pollHandle = setInterval(() => { this.send('status'); }, 2000);
    if (this._pollHandle.unref) this._pollHandle.unref();
  }

  _stopPoll() {
    if (this._pollHandle) { clearInterval(this._pollHandle); this._pollHandle = null; }
  }

  async replacePlaylist(filePaths, options = {}) {
    if (!Array.isArray(filePaths)) filePaths = [];
    this.currentPlaylist = filePaths.slice();
    this.idleMode = !!options.idle;

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
    for (const p of filePaths) {
      const mrl = this._toMrl(p);
      this.send('add ' + mrl);
      await sleep(100);
    }
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
