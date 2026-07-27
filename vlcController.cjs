'use strict';

const { spawn } = require('child_process');
const net = require('net');
const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('events');
const CFG = require('./config.cjs');

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
    this.rcHost = '127.0.0.1';
    this.rcPort = options.rcPort || CFG.VLC_RC_PORT || 4212;
    this.proc = null;
    this.rc = null;
    this.ready = false;
    this.currentPlaylist = [];
    this.state = 'idle';
    this._pollHandle = null;
    this._buffer = '';
    this.display = options.display || null;
  }

  _setState(next) {
    if (this.state === next) return;
    this.state = next;
    this.emit('state-change', next);
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
    if (!this.rc || !this.rc.writable) return false;
    const line = cmd.endsWith('\n') ? cmd : cmd + '\n';
    return this.rc.write(line);
  }

  _parseRc(chunk) {
    this._buffer += chunk;
    const lines = this._buffer.split(/\r?\n/);
    this._buffer = lines.pop() || '';
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      if (t.indexOf('state:') === 0) {
        const v = t.split(':')[1].trim();
        const map = { playing: 'playing', paused: 'paused', stopped: 'idle' };
        this._setState(map[v] || 'idle');
      }
    }
  }

  start() {
    if (this.proc) return Promise.resolve();
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
        '--rc-host', `${this.rcHost}:${this.rcPort}`,
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
      this.proc.stderr.on('data', (buf) => {
        const text = buf.toString('utf8');
        stderrLines.push(text.trim());
        if (stderrLines.length > 50) stderrLines.shift();
        this.emit('vlc-stderr', text.trim());
      });
      this.proc.stdout.on('data', (buf) => {
        this.emit('vlc-stdout', buf.toString('utf8'));
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
          this._setState('error');
        } else {
          this._setState('idle');
        }
        this.proc = null;
        this.ready = false;
        this.rc = null;
      });

      const connectRc = (attempt = 0) => {
        if (attempt > 15) {
          this._setState('error');
          const tail = stderrLines.slice(-15).join('\n');
          this.emit('vlc-log', `rc probe failed after 15 attempts${tail ? '\n' + tail : ''}`);
          return reject(new Error('VLC RC interface not reachable' + (tail ? '\n' + tail : '')));
        }
        if (!this.proc) return reject(new Error('VLC exited during startup'));
        const sock = net.connect(this.rcPort, this.rcHost);
        let opened = false;
        sock.on('connect', () => {
          opened = true;
          this.rc = sock;
          this.ready = true;
          this.emit('ready');
          this.emit('vlc-log', `[VLC ready] RC connected at ${new Date().toISOString()}`);
          sock.on('data', (buf) => {
            const text = buf.toString('utf8');
            this.emit('rc-data', text);
            this._parseRc(text);
          });
          this._startPoll();
          resolve();
        });
        sock.on('error', () => {
          if (!opened && attempt < 15) {
            this.emit('vlc-log', `rc probe attempt ${attempt + 1} failed`);
            setTimeout(() => connectRc(attempt + 1), 800);
          }
        });
        sock.on('close', () => { this.rc = null; this.ready = false; });
      };
      setTimeout(() => connectRc(0), 1000);
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

  async replacePlaylist(filePaths) {
    if (!Array.isArray(filePaths)) filePaths = [];
    this.currentPlaylist = filePaths.slice();
    if (!this.ready) await this.start();
    this.send('clear');
    await sleep(200);
    for (const p of filePaths) {
      const mrl = this._toMrl(p);
      this.send('add ' + mrl);
      await sleep(100);
    }
    if (filePaths.length) this.send('goto 0');
    await sleep(300);
    this.send('status');
  }

  async clear() {
    this.currentPlaylist = [];
    this.send('clear');
    this._setState('idle');
  }

  async pause() {
    this.send('pause');
    await sleep(100);
    this.send('status');
  }

  async play() {
    this.send('play');
    await sleep(100);
    this.send('status');
  }

  isPlaying() { return this.state === 'playing'; }

  async quit() {
    this._stopPoll();
    this.send('quit');
    await sleep(100);
    if (this.rc) {
      try { this.rc.destroy(); } catch (_) {}
      this.rc = null;
    }
    if (this.proc) {
      try { this.proc.kill(); } catch (_) {}
    }
    this.proc = null;
    this.ready = false;
    this._setState('idle');
  }
}

module.exports = { VlcController };