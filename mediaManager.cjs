'use strict';

const { EventEmitter } = require('events');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const { Transform } = require('stream');

function fileExists(filePath) {
  try {
    return fs.existsSync(filePath);
  } catch (_) {
    return false;
  }
}

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const input = fs.createReadStream(filePath);
    input.on('data', chunk => hash.update(chunk));
    input.on('error', reject);
    input.on('end', () => resolve(hash.digest('hex')));
  });
}

function downloadMetadataPath(destination) {
  return `${destination}.meta.json`;
}

function readDownloadMetadata(destination) {
  try {
    return JSON.parse(fs.readFileSync(downloadMetadataPath(destination), 'utf8'));
  } catch (_) {
    return {};
  }
}

function writeDownloadMetadata(destination, value) {
  fs.writeFileSync(downloadMetadataPath(destination), JSON.stringify(value));
}

function removeDownloadState(destination, removePartial = true) {
  if (removePartial && fileExists(destination)) fs.unlinkSync(destination);
  const metadataPath = downloadMetadataPath(destination);
  if (fileExists(metadataPath)) fs.unlinkSync(metadataPath);
}

function createRateLimitStream(bytesPerSecond) {
  const rate = Number(bytesPerSecond);
  if (!Number.isFinite(rate) || rate <= 0) return null;

  let transferredBytes = 0;
  const startedAt = Date.now();
  return new Transform({
    transform(chunk, _encoding, callback) {
      transferredBytes += chunk.length;
      const expectedElapsedMs = transferredBytes / rate * 1000;
      const delayMs = Math.max(0, expectedElapsedMs - (Date.now() - startedAt));
      setTimeout(() => callback(null, chunk), delayMs);
    }
  });
}

function requestDownload(url, destination, expectedSize, options = {}, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const partialSize = fileExists(destination) ? fs.statSync(destination).size : 0;
    const headers = { ...(options.headers || {}) };
    if (options.authOrigin && new URL(url).origin !== options.authOrigin) delete headers.Authorization;
    if (partialSize > 0) {
      headers.Range = `bytes=${partialSize}-`;
      const metadata = readDownloadMetadata(destination);
      if (metadata.etag) headers['If-Range'] = metadata.etag;
    }
    const transport = url.startsWith('https:') ? https : http;
    const request = transport.get(url, { headers }, response => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        response.resume();
        if (!response.headers.location || redirectsLeft <= 0) {
          reject(new Error('Media download exceeded redirect limit'));
          return;
        }
        const redirectUrl = new URL(response.headers.location, url).toString();
        requestDownload(redirectUrl, destination, expectedSize, options, redirectsLeft - 1)
          .then(resolve, reject);
        return;
      }

      const canResetRange = options.allowRangeReset !== false;
      const retryFromZero = message => {
        response.resume();
        if (!partialSize || !canResetRange) {
          reject(new Error(message));
          return;
        }
        removeDownloadState(destination);
        requestDownload(url, destination, expectedSize, { ...options, allowRangeReset: false }, redirectsLeft)
          .then(resolve, reject);
      };

      if (response.statusCode === 416) {
        retryFromZero('Media server rejected the saved download range');
        return;
      }
      if (![200, 206].includes(response.statusCode)) {
        response.resume();
        reject(new Error(`Media download failed with HTTP ${response.statusCode}`));
        return;
      }

      if (response.statusCode === 206) {
        const match = String(response.headers['content-range'] || '').match(/^bytes (\d+)-(\d+)\/(\d+|\*)$/i);
        const rangeStart = match ? Number(match[1]) : -1;
        const rangeEnd = match ? Number(match[2]) : -1;
        const rangeTotal = match && match[3] !== '*' ? Number(match[3]) : expectedSize;
        if (!match || rangeStart !== partialSize || rangeEnd < rangeStart || (expectedSize && rangeTotal !== expectedSize)) {
          retryFromZero('Media server returned an invalid Content-Range');
          return;
        }
      }

      if (response.headers.etag) writeDownloadMetadata(destination, { etag: String(response.headers.etag) });

      const shouldAppend = response.statusCode === 206 && partialSize > 0;
      const startingBytes = shouldAppend ? partialSize : 0;
      let receivedBytes = 0;
      const output = fs.createWriteStream(destination, { flags: shouldAppend ? 'a' : 'w' });
      if (typeof options.onProgress === 'function') {
        options.onProgress({ downloadedBytes: startingBytes, totalBytes: expectedSize || 0 });
        response.on('data', chunk => {
          receivedBytes += chunk.length;
          options.onProgress({ downloadedBytes: startingBytes + receivedBytes, totalBytes: expectedSize || 0 });
        });
      }
      const rateLimit = createRateLimitStream(options.limitBytesPerSecond);
      if (rateLimit) {
        rateLimit.on('error', reject);
        response.pipe(rateLimit).pipe(output);
      } else {
        response.pipe(output);
      }
      output.on('error', reject);
      response.on('error', reject);
      output.on('finish', () => {
        output.close(() => {
          const finalSize = fs.statSync(destination).size;
          if (expectedSize && finalSize !== expectedSize) {
            reject(new Error(`Media size mismatch: expected ${expectedSize}, received ${finalSize}`));
            return;
          }
          resolve();
        });
      });
    });
    request.setTimeout(30000, () => request.destroy(new Error('Media download timed out')));
    request.on('error', reject);
  });
}

class MediaManager extends EventEmitter {
  constructor(options = {}) {
    super();
    if (!options.mediaDir) throw new Error('MediaManager requires mediaDir');
    this.mediaDir = options.mediaDir;
    this.concurrency = Math.max(1, Number(options.concurrency) || 2);
    this.getDownloadOptions = typeof options.getDownloadOptions === 'function'
      ? options.getDownloadOptions
      : () => ({});
    fs.mkdirSync(this.mediaDir, { recursive: true });
  }

  getAssetPath(asset) {
    const extension = path.extname(asset.filename || '').slice(0, 16);
    const safeId = String(asset.id).replace(/[^a-zA-Z0-9._-]/g, '_');
    return path.join(this.mediaDir, `${safeId}${extension}`);
  }

  async isReady(asset) {
    const target = this.getAssetPath(asset);
    if (!fileExists(target)) return false;
    const stat = fs.statSync(target);
    if (stat.size !== asset.size) return false;
    return (await hashFile(target)) === asset.sha256;
  }

  async prepareAsset(asset, allowIntegrityRetry = true) {
    const target = this.getAssetPath(asset);
    const partial = `${target}.part`;
    if (await this.isReady(asset)) {
      removeDownloadState(partial);
      this.emit('ready', { asset, path: target, cached: true });
      return target;
    }

    if (fileExists(partial)) {
      const partialSize = fs.statSync(partial).size;
      if (partialSize === asset.size) {
        const partialDigest = await hashFile(partial);
        if (partialDigest === asset.sha256) {
          if (fileExists(target)) fs.unlinkSync(target);
          fs.renameSync(partial, target);
          removeDownloadState(partial, false);
          this.emit('ready', { asset, path: target, cached: false });
          return target;
        }
        removeDownloadState(partial);
      } else if (partialSize > asset.size) {
        removeDownloadState(partial);
      }
    }

    const downloadOptions = this.getDownloadOptions(asset);
    this.emit('download-start', {
      asset,
      path: target,
      speedLimitKbps: Number(downloadOptions.limitBytesPerSecond) > 0
        ? Number(downloadOptions.limitBytesPerSecond) / 1024
        : null
    });
    await requestDownload(asset.downloadUrl, partial, asset.size, {
      ...downloadOptions,
      onProgress: progress => this.emit('download-progress', { asset, ...progress })
    });
    this.emit('verifying', { asset, path: partial });
    const digest = await hashFile(partial);
    if (digest !== asset.sha256) {
      removeDownloadState(partial);
      if (allowIntegrityRetry) {
        this.emit('download-retry', { asset, reason: 'checksum-mismatch' });
        return this.prepareAsset(asset, false);
      }
      throw new Error(`Checksum mismatch for asset ${asset.id}`);
    }
    if (fileExists(target)) fs.unlinkSync(target);
    fs.renameSync(partial, target);
    removeDownloadState(partial, false);
    this.emit('ready', { asset, path: target, cached: false });
    return target;
  }

  async _mapWithConcurrency(values, worker) {
    const result = new Map();
    let cursor = 0;
    const runners = Array.from(
      { length: Math.min(this.concurrency, values.length) },
      async () => {
        while (cursor < values.length) {
          const index = cursor++;
          const value = values[index];
          result.set(value.id, await worker(value));
        }
      }
    );
    await Promise.all(runners);
    return result;
  }

  async prepareSchedules(schedules, assets, localMediaPaths = new Map(), options = {}) {
    const assetById = new Map((assets || []).map(asset => [asset.id, asset]));
    const requiredIds = new Set();

    for (const schedule of schedules || []) {
      for (const item of schedule.playlist || schedule.files || []) {
        if (item.assetId) requiredIds.add(item.assetId);
      }
    }

    const requiredAssets = [...requiredIds].map(id => {
      const asset = assetById.get(id);
      if (!asset) throw new Error(`Schedule references unknown asset ${id}`);
      return asset;
    });
    const localPaths = await this._mapWithConcurrency(
      requiredAssets,
      async asset => {
        try {
          if (options.downloadMissing === false) {
            return await this.isReady(asset) ? this.getAssetPath(asset) : null;
          }
          return await this.prepareAsset(asset);
        } catch (error) {
          this.emit('download-error', { asset, error });
          return null;
        }
      }
    );

    return (schedules || []).map(schedule => {
      const playlist = (schedule.playlist || schedule.files || []).map(item => {
        const localPath = item.assetId
          ? (localPaths.get(item.assetId) || null)
          : (item.mediaKey
              ? (localMediaPaths.get(item.mediaKey) || null)
              : (item.localPath || item.path || null));
        return { ...item, localPath, path: localPath };
      });
      return {
        ...schedule,
        playlist,
        files: playlist.map(item => ({ ...item }))
      };
    });
  }

  async prepareAssets(assets) {
    const failed = [];
    const paths = await this._mapWithConcurrency(assets || [], async asset => {
      try {
        return await this.prepareAsset(asset);
      } catch (error) {
        failed.push({ assetId: asset.id, error: error.message || String(error) });
        this.emit('download-error', { asset, error });
        return null;
      }
    });
    return {
      ready: [...paths.entries()].filter(([, value]) => value !== null).map(([assetId, localPath]) => ({ assetId, localPath })),
      failed
    };
  }
}

module.exports = { MediaManager, hashFile, requestDownload };
