'use strict';

const { EventEmitter } = require('events');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');
const { parseLdgHeader } = require('./ldg.cjs');

const DEFAULT_IDLE_DELAY_MS = 60 * 1000;
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function isLdgAsset(asset) {
  return Boolean(asset && (
    asset.encryptionFormat === 'ldg-v1' ||
    asset.encryption_format === 'ldg-v1' ||
    asset.encryption && asset.encryption.format === 'ldg-v1'
  ));
}

function fileIdentity(filePath) {
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw new Error('Path is not a file');
  return {
    path: path.resolve(filePath),
    size: Number(stat.size),
    mtimeMs: Math.trunc(Number(stat.mtimeMs)),
    ctimeMs: Math.trunc(Number(stat.ctimeMs))
  };
}

function assetRevision(asset) {
  return Number(asset && (
    asset.revision ??
    asset.encryptionRevision ??
    asset.encryption_revision ??
    (asset.encryption && asset.encryption.encryptionRevision)
  )) || 0;
}

function assetKey(asset) {
  return String(asset && asset.id || '');
}

function signatureFor(asset) {
  return {
    assetId: assetKey(asset),
    revision: assetRevision(asset),
    sha256: String(asset && asset.sha256 || '').toLowerCase(),
    size: Number(asset && asset.size) || 0
  };
}

function validateLdgAsset(asset, filePath) {
  const header = parseLdgHeader(filePath);
  const encryption = asset && asset.encryption || {};
  if (header.assetId.toLowerCase() !== assetKey(asset).toLowerCase()) {
    throw new Error('LDG asset identity does not match the manifest');
  }
  const expectedRevision = Number(encryption.encryptionRevision ?? assetRevision(asset));
  if (Number.isFinite(expectedRevision) && header.revision !== expectedRevision) {
    throw new Error('LDG encryption revision does not match the manifest');
  }
  if (encryption.plaintextSize != null && header.plaintextSize !== Number(encryption.plaintextSize)) {
    throw new Error('LDG plaintext size does not match the manifest');
  }
  if (encryption.plaintextSha256 && header.plaintextSha256 !== String(encryption.plaintextSha256).toLowerCase()) {
    throw new Error('LDG plaintext digest does not match the manifest');
  }
  return header;
}

function atomicWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2));
  fs.renameSync(temporary, filePath);
}

function runHashWorker(filePath, onProgress = () => {}) {
  const bundledWorkerPath = path.join(__dirname, 'integrityHashWorker.cjs');
  const unpackedWorkerPath = bundledWorkerPath.replace(
    `${path.sep}app.asar${path.sep}`,
    `${path.sep}app.asar.unpacked${path.sep}`
  );
  const workerPath = unpackedWorkerPath !== bundledWorkerPath && fs.existsSync(unpackedWorkerPath)
    ? unpackedWorkerPath
    : bundledWorkerPath;
  const worker = new Worker(workerPath, { workerData: { filePath } });
  let settled = false;
  const promise = new Promise((resolve, reject) => {
    worker.on('message', message => {
      if (!message || settled) return;
      if (message.type === 'progress') {
        try { onProgress(Number(message.processedBytes) || 0); } catch (_) {}
      }
      if (message.type === 'complete') {
        settled = true;
        resolve({ digest: message.digest, processedBytes: Number(message.processedBytes) || 0 });
      }
      if (message.type === 'error') {
        settled = true;
        reject(new Error(message.error || 'Integrity worker failed'));
      }
    });
    worker.on('error', error => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    worker.on('exit', code => {
      if (settled) return;
      settled = true;
      const error = new Error(code === 0 ? 'Integrity worker ended before returning a digest' : `Integrity worker exited with code ${code}`);
      error.code = 'INTEGRITY_WORKER_ABORTED';
      reject(error);
    });
  });
  return { worker, promise };
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

class IntegrityVerifier extends EventEmitter {
  constructor(options = {}) {
    super();
    if (!options.cachePath) throw new Error('IntegrityVerifier requires cachePath');
    this.cachePath = path.resolve(options.cachePath);
    this.idleDelayMs = Math.max(0, Number(options.idleDelayMs ?? DEFAULT_IDLE_DELAY_MS));
    this.maxAgeMs = Math.max(0, Number(options.maxAgeMs ?? DEFAULT_MAX_AGE_MS));
    this.isIdle = typeof options.isIdle === 'function' ? options.isIdle : () => true;
    this.canVerifyNow = typeof options.canVerifyNow === 'function' ? options.canVerifyNow : this.isIdle;
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
    this.entries = new Map();
    this.jobs = new Map();
    this.queueOrder = [];
    this.current = null;
    this.directWorker = null;
    this.directPending = 0;
    this.directTail = Promise.resolve();
    this.timer = null;
    this.closed = false;
    this.load();
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.cachePath, 'utf8'));
      for (const entry of Array.isArray(parsed.entries) ? parsed.entries : []) {
        if (entry && entry.assetId) this.entries.set(String(entry.assetId), entry);
      }
    } catch (_) {}
  }

  persist() {
    atomicWriteJson(this.cachePath, {
      version: 1,
      updatedAt: new Date(this.now()).toISOString(),
      entries: [...this.entries.values()]
    });
  }

  receiptMatches(entry, asset, identity, ldgHeaderSha256 = null) {
    const signature = signatureFor(asset);
    return Boolean(entry && identity &&
      entry.assetId === signature.assetId &&
      Number(entry.revision) === signature.revision &&
      String(entry.sha256 || '').toLowerCase() === signature.sha256 &&
      Number(entry.size) === signature.size &&
      path.resolve(entry.path) === identity.path &&
      Number(entry.fileSize) === identity.size &&
      Number(entry.mtimeMs) === identity.mtimeMs &&
      Number(entry.ctimeMs) === identity.ctimeMs &&
      (!isLdgAsset(asset) || String(entry.ldgHeaderSha256 || '') === String(ldgHeaderSha256 || '')));
  }

  inspect(asset, filePath, options = {}) {
    const key = assetKey(asset);
    let identity;
    try {
      identity = fileIdentity(filePath);
    } catch (error) {
      return { ready: false, status: error && error.code === 'ENOENT' ? 'missing' : 'unreadable', reason: error.message || String(error) };
    }
    if (identity.size !== Number(asset && asset.size)) {
      return { ready: false, status: 'corrupt', reason: `Size mismatch: expected ${asset && asset.size}, found ${identity.size}`, identity };
    }

    let ldgHeaderSha256 = null;
    if (isLdgAsset(asset)) {
      try {
        const header = validateLdgAsset(asset, filePath);
        ldgHeaderSha256 = crypto.createHash('sha256').update(header.core).digest('hex');
      } catch (error) {
        return { ready: false, status: 'corrupt', reason: error.message || String(error), identity };
      }
    }

    const entry = this.entries.get(key);
    const matching = this.receiptMatches(entry, asset, identity, ldgHeaderSha256);
    if (matching && entry.status === 'corrupt') {
      if (options.force && options.queue !== false) {
        this.queue(asset, filePath, { force: true });
        const pending = this.jobs.get(key);
        return {
          ready: false,
          status: pending ? pending.status : 'queued',
          reason: pending ? pending.reason : 'Queued for full integrity recheck',
          identity,
          progress: pending ? this.publicJob(pending) : null
        };
      }
      return { ready: false, status: 'corrupt', reason: entry.reason || 'SHA-256 checksum mismatch', identity };
    }

    let job = this.jobs.get(key);
    if (matching && entry.status === 'verified') {
      const verifiedAt = Date.parse(entry.verifiedAt || '');
      const stale = !Number.isFinite(verifiedAt) || this.now() - verifiedAt >= this.maxAgeMs;
      if ((stale || options.force) && options.queue !== false) this.queue(asset, filePath, { force: Boolean(options.force) });
      job = this.jobs.get(key);
      return {
        ready: true,
        status: job ? job.status : 'verified',
        reason: job ? job.reason : '',
        identity,
        verifiedAt: entry.verifiedAt,
        progress: job ? this.publicJob(job) : null
      };
    }

    if (!isLdgAsset(asset)) {
      if (options.queue !== false) this.queue(asset, filePath, { force: Boolean(options.force) });
      const pending = this.jobs.get(key);
      return {
        ready: false,
        status: pending ? pending.status : 'queued',
        reason: pending ? pending.reason : 'Full integrity verification is required before playback',
        identity,
        progress: pending ? this.publicJob(pending) : null
      };
    }

    if (options.queue !== false) this.queue(asset, filePath, { force: Boolean(options.force) });
    const pending = this.jobs.get(key);
    return {
      ready: true,
      status: pending ? pending.status : 'provisional',
      reason: pending ? pending.reason : 'LDG header and size valid; full verification is pending',
      identity,
      progress: pending ? this.publicJob(pending) : null
    };
  }

  publicJob(job) {
    const elapsedSeconds = Math.max(0.001, (this.now() - job.startedAt) / 1000);
    const speedBytesPerSecond = job.status === 'verifying' ? Math.round(job.processedBytes / elapsedSeconds) : 0;
    const remainingBytes = Math.max(0, job.totalBytes - job.processedBytes);
    return {
      status: job.status,
      processedBytes: job.processedBytes,
      totalBytes: job.totalBytes,
      percent: job.totalBytes > 0 ? Math.min(100, Math.round(job.processedBytes / job.totalBytes * 100)) : 0,
      speedBytesPerSecond,
      etaSeconds: speedBytesPerSecond > 0 ? Math.ceil(remainingBytes / speedBytesPerSecond) : null
    };
  }

  queue(asset, filePath, options = {}) {
    const key = assetKey(asset);
    if (!key || this.closed) return null;
    const existing = this.jobs.get(key);
    if (existing) {
      const oldSignature = signatureFor(existing.asset);
      const nextSignature = signatureFor(asset);
      const sameFile = path.resolve(existing.filePath) === path.resolve(filePath);
      const sameManifest = oldSignature.revision === nextSignature.revision &&
        oldSignature.sha256 === nextSignature.sha256 && oldSignature.size === nextSignature.size;
      if (sameFile && sameManifest) {
        if (options.force) existing.force = true;
        return this.publicJob(existing);
      }
      existing.cancelled = true;
      this.queueOrder = this.queueOrder.filter(item => item !== key);
      if (this.current && this.current.key === key) this.abortCurrent(false);
      this.jobs.delete(key);
    }
    let identity;
    try { identity = fileIdentity(filePath); } catch (_) { return null; }
    const job = {
      key, asset: { ...asset }, filePath: identity.path, totalBytes: identity.size,
      processedBytes: 0, startedAt: 0, status: this.isIdle() ? 'queued' : 'waiting',
      reason: this.isIdle() ? 'Queued for background verification' : 'Waiting for Player idle',
      force: Boolean(options.force), attempts: 0
    };
    this.jobs.set(key, job);
    this.queueOrder.push(key);
    this.emitUpdate();
    this.schedulePump();
    return this.publicJob(job);
  }

  recordVerified(asset, filePath, digest = null) {
    const identity = fileIdentity(filePath);
    const signature = signatureFor(asset);
    const actualDigest = String(digest || signature.sha256).toLowerCase();
    if (!signature.sha256 || actualDigest !== signature.sha256) throw new Error(`Checksum mismatch for asset ${signature.assetId}`);
    let ldgHeaderSha256 = null;
    if (isLdgAsset(asset)) {
      const header = validateLdgAsset(asset, filePath);
      ldgHeaderSha256 = crypto.createHash('sha256').update(header.core).digest('hex');
    }
    this.entries.set(signature.assetId, {
      ...signature,
      path: identity.path,
      fileSize: identity.size,
      mtimeMs: identity.mtimeMs,
      ctimeMs: identity.ctimeMs,
      ldgHeaderSha256,
      status: 'verified',
      reason: '',
      verifiedAt: new Date(this.now()).toISOString()
    });
    this.persist();
    this.emitUpdate();
  }

  recordCorrupt(asset, filePath, reason) {
    const identity = fileIdentity(filePath);
    const signature = signatureFor(asset);
    this.entries.set(signature.assetId, {
      ...signature,
      path: identity.path,
      fileSize: identity.size,
      mtimeMs: identity.mtimeMs,
      ctimeMs: identity.ctimeMs,
      status: 'corrupt',
      reason: reason || 'SHA-256 checksum mismatch',
      verifiedAt: new Date(this.now()).toISOString()
    });
    this.persist();
    this.emitUpdate();
  }

  remove(assetId) {
    const key = String(assetId || '');
    this.entries.delete(key);
    const index = this.queueOrder.indexOf(key);
    if (index >= 0) this.queueOrder.splice(index, 1);
    const job = this.jobs.get(key);
    if (job) job.cancelled = true;
    if (this.current && this.current.key === key) this.abortCurrent(false);
    this.jobs.delete(key);
    this.persist();
    this.emitUpdate();
  }

  async verifyPath(filePath, onProgress = () => {}) {
    this.directPending += 1;
    this.abortCurrent(true);
    const operation = this.directTail.then(async () => {
      while (!this.closed) {
        while (!this.closed && (this.current || !this.canVerifyNow())) await delay(this.current ? 50 : 1000);
        if (this.closed) throw new Error('Integrity verifier is closed');
        const task = runHashWorker(filePath, onProgress);
        this.directWorker = task.worker;
        try {
          return await task.promise;
        } catch (error) {
          if (!this.closed && error && error.code === 'INTEGRITY_WORKER_ABORTED') continue;
          throw error;
        } finally {
          if (this.directWorker === task.worker) this.directWorker = null;
        }
      }
      throw new Error('Integrity verifier is closed');
    });
    this.directTail = operation.catch(() => {}).finally(() => {
      this.directPending = Math.max(0, this.directPending - 1);
      this.schedulePump(0);
    });
    return operation;
  }

  schedulePump(delay = this.idleDelayMs) {
    if (this.closed || this.current || this.directPending || this.timer || !this.queueOrder.length) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.pump();
    }, Math.max(0, delay));
    if (this.timer.unref) this.timer.unref();
  }

  async pump() {
    if (this.closed || this.current || this.directPending || !this.queueOrder.length) return;
    if (!this.isIdle()) {
      for (const job of this.jobs.values()) {
        if (job.status !== 'verifying') {
          job.status = 'waiting';
          job.reason = 'Waiting for Player idle';
        }
      }
      this.emitUpdate();
      this.schedulePump(5000);
      return;
    }
    const key = this.queueOrder.shift();
    const job = this.jobs.get(key);
    if (!job) {
      this.schedulePump(0);
      return;
    }
    job.status = 'verifying';
    job.reason = 'Calculating SHA-256 in background';
    job.startedAt = this.now();
    job.processedBytes = 0;
    job.attempts += 1;
    const task = runHashWorker(job.filePath, processedBytes => {
      job.processedBytes = processedBytes;
      this.emitUpdate();
    });
    this.current = { key, worker: task.worker };
    this.emitUpdate();
    try {
      const result = await task.promise;
      if (job.cancelled || this.jobs.get(key) !== job) return;
      if (String(result.digest).toLowerCase() === String(job.asset.sha256 || '').toLowerCase()) {
        this.recordVerified(job.asset, job.filePath, result.digest);
        this.emit('verified', { asset: job.asset, path: job.filePath, durationMs: this.now() - job.startedAt });
      } else {
        this.recordCorrupt(job.asset, job.filePath, 'SHA-256 checksum mismatch');
        this.emit('corrupt', { asset: job.asset, path: job.filePath, reason: 'SHA-256 checksum mismatch' });
      }
      this.jobs.delete(key);
    } catch (error) {
      if (!this.closed && this.jobs.get(key) === job && error && error.code === 'INTEGRITY_WORKER_ABORTED') {
        job.status = 'waiting';
        job.reason = 'Waiting for Player idle';
        job.processedBytes = 0;
        if (!this.queueOrder.includes(key)) this.queueOrder.unshift(key);
      } else if (!this.closed) {
        job.reason = error.message || String(error);
        job.processedBytes = 0;
        if (job.attempts >= 3) {
          this.jobs.delete(key);
        } else {
          job.status = 'queued';
          this.queueOrder.push(key);
        }
        this.emit('verification-error', { asset: job.asset, path: job.filePath, error });
      }
    } finally {
      if (this.current && this.current.key === key) this.current = null;
      this.emitUpdate();
      this.schedulePump(this.isIdle() ? 1000 : 5000);
    }
  }

  abortCurrent(requeue = true) {
    if (!this.current) return;
    const { key, worker } = this.current;
    const job = this.jobs.get(key);
    if (job && requeue && !this.queueOrder.includes(key)) {
      job.status = 'waiting';
      job.reason = 'Waiting for Player idle';
      job.processedBytes = 0;
      this.queueOrder.unshift(key);
    }
    void worker.terminate();
  }

  suspendForPlayback() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.abortCurrent(true);
    if (this.directWorker) void this.directWorker.terminate();
    for (const job of this.jobs.values()) {
      if (job.status !== 'verifying') {
        job.status = 'waiting';
        job.reason = 'Waiting for Player idle';
      }
    }
    this.emitUpdate();
  }

  resumeAfterIdle() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const job of this.jobs.values()) {
      if (job.status === 'waiting') {
        job.status = 'queued';
        job.reason = 'Queued for background verification';
      }
    }
    this.emitUpdate();
    this.schedulePump();
  }

  emitUpdate() {
    this.emit('update', this.getSnapshot());
  }

  getSnapshot() {
    return {
      queued: this.queueOrder.length,
      active: this.current ? this.current.key : null,
      jobs: [...this.jobs.values()].map(job => ({
        assetId: job.key,
        path: job.filePath,
        reason: job.reason,
        ...this.publicJob(job)
      }))
    };
  }

  async close() {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.current) {
      const worker = this.current.worker;
      this.current = null;
      await worker.terminate();
    }
    if (this.directWorker) {
      const worker = this.directWorker;
      this.directWorker = null;
      await worker.terminate();
    }
  }
}

module.exports = {
  DEFAULT_IDLE_DELAY_MS,
  DEFAULT_MAX_AGE_MS,
  IntegrityVerifier,
  fileIdentity,
  isLdgAsset,
  runHashWorker,
  validateLdgAsset
};
