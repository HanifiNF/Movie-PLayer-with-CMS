'use strict';

const { spawn } = require('child_process');
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
    this.httpHost = '127.0.0.1';
    this.httpPort = options.httpPort || CFG.VLC_HTTP_PORT || 8888;
    this.httpPass = options.httpPass || CFG.VLC_HTTP_PASSWORD || 'player';
    this.proc = null;
    this.ready = false;
    this.currentPlaylist = [];
    this.state = 'idle';
    this._pollHandle = null;
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

  async _api(cmd, params = {}) {
    const qs = new URLSearchParams({ command: cmd, ...params });
    const url = `http://${this.httpHost}:${this.httpPort}/requests/status.xml?${qs.toString()}`;
    const auth = Buffer.from(':' + this.httpPass).toString('base64');
    const r = await fetch(url, { headers: { Authorization: 'Basic ' + auth } });
    return await r.text();
  }

  async _status() {
    const url = `http://${this.httpHost}:${this.httpPort}/requests/status.xml`;
    const auth = Buffer.from(':' + this.httpPass).toString('base64');
    const r = await fetch(url, { headers: { Authorization: 'Basic ' + auth } });
    return await r.text();
  }

  async _refreshState() {
    try {
      const xml = await this._status();
      const m = /<state>([^<]+)<\/state>/.exec(xml);
      if (!m) return;
      const map = { playing: 'playing', paused: 'paused', stopped: 'idle' };
      this._setState(map[m[1]] || 'idle');
      return m[1];
    } catch (e) {
      return null;
    }
  }

  start() {
    if (this.proc) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const args = [
        '--intf', 'qt',
        '--extraintf', 'http',
        '--http-host', this.httpHost,
        '--http-port', String(this.httpPort),
        '--http-password', this.httpPass,
        '--fullscreen',
        '--no-video-title-show',
        '--loop',
        '--no-qt-error-dialogs'
      ];

      const vlcDir = path.dirname(this.vlcPath);
      const vlcPlugins = path.join(vlcDir, 'plugins');
      const env = process.env;

      this.emit('vlc-log', `--- start attempt at ${new Date().toISOString()} ---`);

      try {
        console.log("VLC Path:", this.vlcPath);
        console.log("Exists:", fs.existsSync(this.vlcPath));
        this.proc = spawn(this.vlcPath, args, {
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: false,
          cwd: vlcDir,
          env: env
        });
        console.log("PID:", this.proc.pid);
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
      });

      const probeHttp = async (attempt = 0) => {
        if (attempt > 15) {
          this._setState('error');
          const tail = stderrLines.slice(-15).join('\n');
          this.emit('vlc-log', `http probe failed after 15 attempts${tail ? '\n' + tail : ''}`);
          return reject(new Error('VLC HTTP interface not reachable' + (tail ? '\n' + tail : '')));
        }
        if (!this.proc) return reject(new Error('VLC exited during startup'));
        try {
          await this._status();
          this.ready = true;
          this.emit('ready');
          this._startPoll();
          resolve();
        } catch (_) {
          this.emit('vlc-log', `http probe attempt ${attempt + 1} failed`);
          await sleep(800);
          probeHttp(attempt + 1);
        }
      };
      setTimeout(() => probeHttp(0), 1000);
    });
  }

  _startPoll() {
    if (this._pollHandle) clearInterval(this._pollHandle);
    this._pollHandle = setInterval(() => { this._refreshState(); }, 2000);
    if (this._pollHandle.unref) this._pollHandle.unref();
  }

  _stopPoll() {
    if (this._pollHandle) { clearInterval(this._pollHandle); this._pollHandle = null; }
  }

  async replacePlaylist(filePaths) {
    if (!Array.isArray(filePaths)) filePaths = [];
    this.currentPlaylist = filePaths.slice();
    if (!this.ready) await this.start();
    try {
      await this._api('pl_empty');
      await sleep(150);
      for (const p of filePaths) {
        const mrl = this._toMrl(p);
        await this._api('in_play', { input: mrl });
        await sleep(80);
      }
      if (filePaths.length) {
        await this._api('pl_play');
      }
      await sleep(300);
      await this._refreshState();
    } catch (e) {
      this.emit('error', e);
    }
  }

  async clear() {
    this.currentPlaylist = [];
    try { await this._api('pl_empty'); } catch (_) {}
    this._setState('idle');
  }

  async pause() {
    try { await this._api('pl_pause'); } catch (_) {}
    await sleep(100);
    await this._refreshState();
  }

  async play() {
    try { await this._api('pl_play'); } catch (_) {}
    await sleep(100);
    await this._refreshState();
  }

  isPlaying() { return this.state === 'playing'; }

  async quit() {
    this._stopPoll();
    try { await this._api('pl_stop'); } catch (_) {}
    await sleep(100);
    if (this.proc) {
      try { this.proc.kill(); } catch (_) {}
    }
    this.proc = null;
    this.ready = false;
    this._setState('idle');
  }
}

module.exports = { VlcController };