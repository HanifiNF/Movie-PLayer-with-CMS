'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MEDIA_EXTENSIONS = new Set([
  '.mp4', '.mkv', '.avi', '.mov', '.webm', '.m4v', '.mpg', '.mpeg', '.ts'
]);

function makeLocalMediaId(relativePath) {
  return `local-${crypto
    .createHash('sha1')
    .update(relativePath.replace(/\\/g, '/').toLowerCase())
    .digest('hex')}`;
}

function makeLocalMediaKey(relativePath) {
  return `local:${crypto
    .createHash('sha256')
    .update(relativePath.replace(/\\/g, '/').toLowerCase())
    .digest('hex')}`;
}

function scanMediaLibrary(rootDir, options = {}) {
  const maxDepth = Math.max(0, Number(options.maxDepth) || 5);
  const root = path.resolve(rootDir);
  if (!fs.existsSync(root)) return [];

  const items = [];
  function visit(directory, depth) {
    if (depth > maxDepth) return;
    const entries = fs.readdirSync(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolutePath, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const extension = path.extname(entry.name).toLowerCase();
      if (!MEDIA_EXTENSIONS.has(extension)) continue;

      const relativePath = path.relative(root, absolutePath);
      const stat = fs.statSync(absolutePath);
      items.push({
        id: makeLocalMediaId(relativePath),
        mediaKey: makeLocalMediaKey(relativePath),
        source: 'library',
        sourceLabel: 'Media Folder',
        title: path.basename(entry.name, extension),
        filename: entry.name,
        relativePath,
        path: absolutePath,
        size: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        status: 'available'
      });
    }
  }

  visit(root, 0);
  items.sort((a, b) => (
    a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }) ||
    a.relativePath.localeCompare(b.relativePath)
  ));
  return items;
}

function listManagedAssets(assets, getAssetPath) {
  return (Array.isArray(assets) ? assets : []).map(asset => {
    const localPath = getAssetPath(asset);
    let status = 'missing';
    try {
      if (fs.existsSync(localPath)) {
        status = fs.statSync(localPath).size === asset.size ? 'downloaded' : 'invalid';
      }
    } catch (_) {
      status = 'invalid';
    }
    const extension = path.extname(asset.displayFilename || asset.filename || '');
    return {
      id: `asset:${asset.id}`,
      mediaKey: `managed:${asset.id}`,
      source: 'managed',
      sourceLabel: 'Downloaded',
      assetId: asset.id,
      title: path.basename(asset.displayFilename || asset.filename || asset.id, extension),
      filename: asset.displayFilename || asset.filename || asset.id,
      relativePath: asset.filename || asset.id,
      path: localPath,
      size: asset.size,
      durationMs: Number(asset.durationMs) || 0,
      sha256: asset.sha256 || null,
      modifiedAt: null,
      status
    };
  });
}

module.exports = {
  MEDIA_EXTENSIONS,
  listManagedAssets,
  makeLocalMediaId,
  makeLocalMediaKey,
  scanMediaLibrary
};
