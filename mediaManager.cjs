'use strict';

const { EventEmitter } = require('events');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');

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

function requestDownload(url, destination, expectedSize, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const partialSize = fileExists(destination) ? fs.statSync(destination).size : 0;
    const headers = partialSize > 0 ? { Range: `bytes=${partialSize}-` } : {};
    const transport = url.startsWith('https:') ? https : http;
    const request = transport.get(url, { headers }, response => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        response.resume();
        if (!response.headers.location || redirectsLeft <= 0) {
          reject(new Error('Media download exceeded redirect limit'));
          return;
        }
        const redirectUrl = new URL(response.headers.location, url).toString();
        requestDownload(redirectUrl, destination, expectedSize, redirectsLeft - 1)
          .then(resolve, reject);
        return;
      }

      if (![200, 206].includes(response.statusCode)) {
        response.resume();
        reject(new Error(`Media download failed with HTTP ${response.statusCode}`));
        return;
      }

      const shouldAppend = response.statusCode === 206 && partialSize > 0;
      const output = fs.createWriteStream(destination, { flags: shouldAppend ? 'a' : 'w' });
      response.pipe(output);
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

  async prepareAsset(asset) {
    const target = this.getAssetPath(asset);
    if (await this.isReady(asset)) {
      this.emit('ready', { asset, path: target, cached: true });
      return target;
    }

    const partial = `${target}.part`;
    if (fileExists(partial)) {
      const partialSize = fs.statSync(partial).size;
      if (partialSize === asset.size) {
        const partialDigest = await hashFile(partial);
        if (partialDigest === asset.sha256) {
          if (fileExists(target)) fs.unlinkSync(target);
          fs.renameSync(partial, target);
          this.emit('ready', { asset, path: target, cached: false });
          return target;
        }
        fs.unlinkSync(partial);
      } else if (partialSize > asset.size) {
        fs.unlinkSync(partial);
      }
    }

    this.emit('download-start', { asset, path: target });
    await requestDownload(asset.downloadUrl, partial, asset.size);
    const digest = await hashFile(partial);
    if (digest !== asset.sha256) {
      fs.unlinkSync(partial);
      throw new Error(`Checksum mismatch for asset ${asset.id}`);
    }
    if (fileExists(target)) fs.unlinkSync(target);
    fs.renameSync(partial, target);
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

  async prepareSchedules(schedules, assets) {
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
          : (item.localPath || item.path || null);
        return { ...item, localPath, path: localPath };
      });
      return {
        ...schedule,
        playlist,
        files: playlist.map(item => ({ ...item }))
      };
    });
  }
}

module.exports = { MediaManager, hashFile };
