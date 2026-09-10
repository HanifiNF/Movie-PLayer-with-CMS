'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_LOW_SPACE_BYTES = 5 * 1024 * 1024 * 1024;

function inspectBasicFile(filePath) {
  if (!filePath) return { status: 'missing', reason: 'No local path is available' };
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return { status: 'unreadable', reason: 'Path is not a file' };
    if (stat.size <= 0) return { status: 'corrupt', reason: 'File is empty', size: stat.size };
    const descriptor = fs.openSync(filePath, 'r');
    fs.closeSync(descriptor);
    return { status: 'ready', reason: '', size: stat.size };
  } catch (error) {
    if (error && error.code === 'ENOENT') return { status: 'missing', reason: 'File was not found' };
    return { status: 'unreadable', reason: error.message || String(error) };
  }
}

function getDiskStatus(storagePath, lowSpaceBytes = DEFAULT_LOW_SPACE_BYTES) {
  try {
    const stats = fs.statfsSync(storagePath);
    const freeBytes = Number(stats.bavail) * Number(stats.bsize);
    const totalBytes = Number(stats.blocks) * Number(stats.bsize);
    return {
      freeBytes,
      totalBytes,
      lowSpace: freeBytes < lowSpaceBytes,
      thresholdBytes: lowSpaceBytes
    };
  } catch (error) {
    return {
      freeBytes: null,
      totalBytes: null,
      lowSpace: false,
      thresholdBytes: lowSpaceBytes,
      error: error.message || String(error)
    };
  }
}

class MediaHealthMonitor {
  constructor(options = {}) {
    if (!options.storagePath) throw new Error('MediaHealthMonitor requires storagePath');
    this.storagePath = path.resolve(options.storagePath);
    this.lowSpaceBytes = Math.max(0, Number(options.lowSpaceBytes) || DEFAULT_LOW_SPACE_BYTES);
    this.readinessProvider = typeof options.readinessProvider === 'function'
      ? options.readinessProvider
      : null;
    this.byPath = new Map();
    this.snapshot = {
      state: 'idle',
      checkedAt: null,
      counts: { ready: 0, missing: 0, corrupt: 0, unreadable: 0 },
      verificationCounts: { verified: 0, provisional: 0, queued: 0, waiting: 0, verifying: 0 },
      items: [],
      disk: getDiskStatus(this.storagePath, this.lowSpaceBytes)
    };
  }

  async scan(schedules, assets, options = {}) {
    const assetById = new Map((assets || []).map(asset => [asset.id, asset]));
    const unique = new Map();
    for (const schedule of schedules || []) {
      for (const file of schedule.files || schedule.playlist || []) {
        const filePath = file.healthPath || file.localPath || file.path || null;
        const key = file.assetId ? `asset:${file.assetId}` : `path:${String(filePath || '').toLowerCase()}`;
        if (!unique.has(key)) unique.set(key, { ...file, filePath });
      }
    }

    const items = [];
    for (const [id, file] of unique) {
      const basic = inspectBasicFile(file.filePath);
      let status = basic.status;
      let reason = basic.reason;
      let playable = status === 'ready';
      let progress = null;
      const asset = file.assetId ? assetById.get(file.assetId) : null;
      if (status === 'ready' && asset) {
        if (basic.size !== Number(asset.size)) {
          status = 'corrupt';
          reason = `Size mismatch: expected ${asset.size}, found ${basic.size}`;
          playable = false;
        } else if (this.readinessProvider) {
          const readiness = this.readinessProvider(asset, file.filePath, {
            queue: options.queueVerification !== false,
            force: Boolean(options.forceVerification)
          });
          status = readiness.status;
          reason = readiness.reason || '';
          playable = Boolean(readiness.ready);
          progress = readiness.progress || null;
        } else {
          status = 'ready';
          playable = true;
        }
      }
      items.push({
        id,
        assetId: file.assetId || null,
        title: file.title || (file.filePath ? path.basename(file.filePath) : file.assetId) || id,
        path: file.filePath,
        status,
        reason,
        playable,
        progress,
        size: basic.size || 0,
        source: file.assetId ? 'managed' : 'local'
      });
    }

    const counts = { ready: 0, missing: 0, corrupt: 0, unreadable: 0 };
    const verificationCounts = { verified: 0, provisional: 0, queued: 0, waiting: 0, verifying: 0 };
    this.byPath.clear();
    for (const item of items) {
      if (item.playable) counts.ready += 1;
      else if (Object.hasOwn(counts, item.status)) counts[item.status] += 1;
      if (Object.hasOwn(verificationCounts, item.status)) verificationCounts[item.status] += 1;
      if (item.path) this.byPath.set(path.resolve(item.path).toLowerCase(), item);
    }
    const disk = getDiskStatus(this.storagePath, this.lowSpaceBytes);
    const hasMediaErrors = counts.missing + counts.corrupt + counts.unreadable > 0;
    const verificationWork = verificationCounts.queued + verificationCounts.waiting + verificationCounts.verifying;
    this.snapshot = {
      state: hasMediaErrors || disk.lowSpace
        ? 'warning'
        : (verificationWork > 0 ? (verificationCounts.verifying ? 'verifying' : 'waiting') : 'healthy'),
      checkedAt: new Date().toISOString(),
      counts,
      verificationCounts,
      items,
      disk
    };
    return this.getSnapshot();
  }

  isReady(file) {
    const filePath = file && (file.localPath || file.path);
    const basic = inspectBasicFile(filePath);
    if (basic.status !== 'ready') return false;
    const known = this.byPath.get(path.resolve(filePath).toLowerCase());
    return !known || known.playable !== false;
  }

  getSnapshot() {
    return {
      ...this.snapshot,
      counts: { ...this.snapshot.counts },
      verificationCounts: { ...(this.snapshot.verificationCounts || {}) },
      items: this.snapshot.items.map(item => ({ ...item })),
      disk: { ...this.snapshot.disk }
    };
  }
}

module.exports = {
  DEFAULT_LOW_SPACE_BYTES,
  MediaHealthMonitor,
  getDiskStatus,
  inspectBasicFile
};
