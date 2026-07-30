'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function readBoxHeader(fd, offset, limit) {
  if (offset + 8 > limit) return null;
  const header = Buffer.alloc(16);
  const bytesRead = fs.readSync(fd, header, 0, 16, offset);
  if (bytesRead < 8) return null;
  let size = header.readUInt32BE(0);
  const type = header.toString('ascii', 4, 8);
  let headerSize = 8;
  if (size === 1) {
    if (bytesRead < 16) return null;
    const largeSize = header.readBigUInt64BE(8);
    if (largeSize > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    size = Number(largeSize);
    headerSize = 16;
  } else if (size === 0) {
    size = limit - offset;
  }
  if (size < headerSize || offset + size > limit) return null;
  return { type, size, headerSize, start: offset, end: offset + size };
}

function findChildBox(fd, start, end, expectedType) {
  let offset = start;
  while (offset + 8 <= end) {
    const box = readBoxHeader(fd, offset, end);
    if (!box) return null;
    if (box.type === expectedType) return box;
    offset = box.end;
  }
  return null;
}

function probeMp4Duration(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (!['.mp4', '.m4v', '.mov'].includes(extension)) return null;
  const fd = fs.openSync(filePath, 'r');
  try {
    const fileSize = fs.fstatSync(fd).size;
    const moov = findChildBox(fd, 0, fileSize, 'moov');
    if (!moov) return null;
    const mvhd = findChildBox(fd, moov.start + moov.headerSize, moov.end, 'mvhd');
    if (!mvhd) return null;

    const payload = Buffer.alloc(40);
    const payloadStart = mvhd.start + mvhd.headerSize;
    const bytesRead = fs.readSync(fd, payload, 0, payload.length, payloadStart);
    if (bytesRead < 20) return null;

    const version = payload.readUInt8(0);
    let timescale;
    let duration;
    if (version === 1) {
      if (bytesRead < 32) return null;
      timescale = payload.readUInt32BE(20);
      const durationBig = payload.readBigUInt64BE(24);
      if (durationBig > BigInt(Number.MAX_SAFE_INTEGER)) return null;
      duration = Number(durationBig);
    } else {
      timescale = payload.readUInt32BE(12);
      duration = payload.readUInt32BE(16);
    }
    if (!timescale || !duration) return null;
    return Math.round((duration / timescale) * 1000);
  } finally {
    fs.closeSync(fd);
  }
}

function runFfprobe(executable, filePath) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath
    ], { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
    child.on('error', reject);
    child.on('exit', code => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `ffprobe exited ${code}`));
        return;
      }
      const seconds = Number.parseFloat(stdout.trim());
      if (!Number.isFinite(seconds) || seconds <= 0) {
        reject(new Error('ffprobe returned an invalid duration'));
        return;
      }
      resolve(Math.round(seconds * 1000));
    });
  });
}

function ffprobeCandidates() {
  const resourcesPath = process.resourcesPath || '';
  return [
    process.env.FFPROBE_PATH,
    resourcesPath && path.join(resourcesPath, 'ffmpeg', 'ffprobe.exe'),
    path.join(__dirname, 'ffmpeg-portable', 'ffprobe.exe'),
    'ffprobe'
  ].filter(Boolean);
}

class MediaProbe {
  constructor(options = {}) {
    if (!options.cachePath) throw new Error('MediaProbe requires cachePath');
    this.cachePath = options.cachePath;
    this.cache = readJson(this.cachePath, { entries: {} });
  }

  async probe(filePath, hintedDurationMs = 0) {
    const absolutePath = path.resolve(filePath);
    if (Number(hintedDurationMs) > 0) {
      return { durationMs: Number(hintedDurationMs), source: 'asset-metadata' };
    }

    const stat = fs.statSync(absolutePath);
    if (!stat.isFile()) throw new Error('Selected media is not a file');

    const key = absolutePath.toLowerCase();
    const cached = this.cache.entries && this.cache.entries[key];
    if (
      cached &&
      cached.size === stat.size &&
      cached.mtimeMs === stat.mtimeMs &&
      Number(cached.durationMs) > 0
    ) {
      return { durationMs: cached.durationMs, source: 'cache' };
    }

    let durationMs = probeMp4Duration(absolutePath);
    let source = durationMs ? 'mp4-metadata' : null;
    const errors = [];
    if (!durationMs) {
      for (const executable of ffprobeCandidates()) {
        if (path.isAbsolute(executable) && !fs.existsSync(executable)) continue;
        try {
          durationMs = await runFfprobe(executable, absolutePath);
          source = 'ffprobe';
          break;
        } catch (error) {
          errors.push(error.message);
        }
      }
    }
    if (!durationMs) {
      throw new Error(`Could not detect media duration${errors.length ? `: ${errors.at(-1)}` : ''}`);
    }

    if (!this.cache.entries) this.cache.entries = {};
    this.cache.entries[key] = {
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      durationMs,
      updatedAt: new Date().toISOString()
    };
    writeJson(this.cachePath, this.cache);
    return { durationMs, source };
  }
}

module.exports = {
  MediaProbe,
  probeMp4Duration,
  runFfprobe
};
