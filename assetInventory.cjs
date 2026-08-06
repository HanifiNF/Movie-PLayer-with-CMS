'use strict';

const fs = require('fs');
const path = require('path');
const { listManagedAssets, scanMediaLibrary } = require('./mediaLibrary.cjs');

function inventoryStatus(item) {
  if ((item.status === 'available' || item.status === 'downloaded') && Number(item.size) > 0) return 'ready';
  if (item.status === 'invalid' || Number(item.size) === 0) return 'corrupt';
  if (item.status === 'missing') return 'missing';
  return 'unreadable';
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), Math.max(1, items.length)) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

async function buildAssetInventory(options = {}) {
  if (!options.mediaLibraryDir) throw new Error('mediaLibraryDir is required');
  if (!options.mediaProbe) throw new Error('mediaProbe is required');
  const mediaLibraryDir = path.resolve(options.mediaLibraryDir);
  fs.mkdirSync(mediaLibraryDir, { recursive: true });

  const localItems = scanMediaLibrary(mediaLibraryDir);
  const managedItems = options.mediaManager
    ? listManagedAssets(options.cachedAssets || [], asset => options.mediaManager.getAssetPath(asset))
    : [];
  const displayItems = [...localItems, ...managedItems].sort((left, right) => (
    left.title.localeCompare(right.title, undefined, { sensitivity: 'base' }) ||
    left.sourceLabel.localeCompare(right.sourceLabel) ||
    left.relativePath.localeCompare(right.relativePath)
  ));

  const assets = await mapWithConcurrency(displayItems, options.probeConcurrency || 2, async item => {
    const status = inventoryStatus(item);
    let durationMs = Math.max(0, Number(item.durationMs) || 0);
    let durationError = '';
    if (status === 'ready' && durationMs === 0) {
      try {
        const result = await options.mediaProbe.probe(item.path);
        durationMs = Math.max(0, Number(result.durationMs) || 0);
      } catch (error) {
        durationError = error.message || String(error);
      }
    }
    item.durationMs = durationMs;
    item.durationError = durationError;
    item.healthStatus = status;

    return {
      media_key: item.mediaKey,
      source: item.source === 'managed' ? 'managed' : 'local',
      title: String(item.title || item.filename || 'Untitled'),
      filename: String(item.filename || path.basename(item.path || 'media')),
      relative_path: String(item.relativePath || item.filename || '').replace(/\\/g, '/'),
      size_bytes: Math.max(0, Number(item.size) || 0),
      duration_ms: durationMs,
      sha256: item.sha256 || null,
      status,
      modified_at: item.modifiedAt || null
    };
  });

  return {
    directory: mediaLibraryDir,
    scannedAt: new Date().toISOString(),
    displayItems,
    assets
  };
}

module.exports = { buildAssetInventory, inventoryStatus, mapWithConcurrency };
