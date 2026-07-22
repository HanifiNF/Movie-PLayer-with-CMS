'use strict';

const { spawn } = require('child_process');
const net = require('net');
const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('events');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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

class VlcController extends EventEmitter {
  constructor(options = {}) {
    super();
    this.vlcPath = options.vlcPath || resolveVlcPath();
    this.rcHost = '127.0.0.1';
    this.rcPort = options.rcPort || 4212;
    this.proc = null;
    this.rc = null;
    this.ready = false;
    this.currentPlaylist = [];
    this.state = 'idle';
    this._buffer = '';
    this.on('rc-data', (chunk) => this._parseRc(chunk));
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
        const next = map[v] || 'idle';
        this._setState(next);
      }
    }
  }

  _setState(next) {
    if (this.state === next) return;
    this.state = next;
    this.emit('state-change', next);
  }

  start() {
    if (this.proc) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const args = [
        '--intf', 'rc',
        '--rc-host', `${this.rcHost}:${this.rcPort}`,
        '--fullscreen',
        '--no-video-title-show',
        '--loop'
      ];

      const vlcDir = path.dirname(this.vlcPath);
      const vlcPlugins = path.join(vlcDir, 'plugins');
      const env = Object.assign({}, process.env, {
        VLC_PLUGIN_PATH: vlcPlugins,
        VLC_PLUGIN_DATA_PATH: vlcDir,
        PATH: vlcDir + ';' + (process.env.PATH || '')
      });

      try {
        this.proc = spawn(this.vlcPath, args, {
          detached: false,
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
      const maxStderr = 50;
      this.proc.stderr.on('data', (buf) => {
        const text = buf.toString('utf8');
        stderrLines.push(text.trim());
        if (stderrLines.length > maxStderr) stderrLines.shift();
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
        }
        this.proc = null;
        this.ready = false;
        this.rc = null;
        this._setState('idle');
      });

      const connectRc = (attempt = 0) => {
        if (attempt > 15) {
          this._setState('error');
          const tail = stderrLines.slice(-15).join('\n');
          return reject(new Error('VLC RC interface not reachable' + (tail ? '\n' + tail : '')));
        }
        const sock = net.connect(this.rcPort, this.rcHost);
        let opened = false;
        sock.on('connect', () => {
          opened = true;
          this.rc = sock;
          this.ready = true;
          this.emit('ready');
          this._setState(this.currentPlaylist.length ? 'playing' : 'idle');
          resolve();
        });
        sock.on('error', () => {
          if (!opened && attempt < 15) {
            setTimeout(() => connectRc(attempt + 1), 800);
          }
        });
        sock.on('close', () => { this.rc = null; this.ready = false; });
        sock.on('data', (buf) => this.emit('rc-data', buf.toString('utf8')));
      };
      setTimeout(() => connectRc(0), 800);
    });
  }

  send(cmd) {
    if (!this.rc || !this.rc.writable) return false;
    const line = cmd.endsWith('\n') ? cmd : cmd + '\n';
    return this.rc.write(line);
  }

  async replacePlaylist(filePaths) {
    if (!Array.isArray(filePaths)) filePaths = [];
    this.currentPlaylist = filePaths.slice();
    if (!this.ready) await this.start();
    this.send('clear');
    await sleep(200);
    for (const p of filePaths) {
      this.send('add ' + this._toVlcUri(p));
      await sleep(100);
    }
    if (filePaths.length) {
      this.send('goto 0');
      await sleep(300);
      this.send('status');
    }
    this.send('fullscreen on');
    this._setState(filePaths.length ? 'playing' : 'idle');
  }

  enqueue(filePath) {
    this.send('enqueue ' + this._toVlcUri(filePath));
  }

  clear() {
    this.currentPlaylist = [];
    this.send('clear');
    this._setState('idle');
  }

  _toVlcUri(p) {
    let s = String(p);
    s = s.replace(/\\/g, '/');
    s = s.replace(/%/g, '%25').replace(/#/g, '%23').replace(/\?/g, '%3F').replace(/ /g, '%20');
    if (/^[A-Za-z]:/.test(s)) s = 'file:///' + s;
    else if (!/^file:/.test(s)) s = 'file://' + s;
    return s;
  }

  pause() {
    this.send('pause');
    if (this.state === 'playing') this._setState('paused');
  }
  play() {
    this.send('play');
    if (this.state === 'paused') this._setState('playing');
  }
  isPlaying() { return this.state === 'playing'; }

  quit() {
    try { this.send('quit'); } catch (_) {}
    if (this.proc) {
      try { this.proc.kill(); } catch (_) {}
    }
    if (this.rc) {
      try { this.rc.destroy(); } catch (_) {}
      this.rc = null;
    }
    this.proc = null;
    this.ready = false;
    this._setState('idle');
  }

  _quote(p) {
    return '"' + String(p).replace(/"/g, '\\"') + '"';
  }
}

module.exports = { VlcController };
