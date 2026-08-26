'use strict';

const fs = require('fs');
const path = require('path');

function samePath(left, right) {
  if (!left || !right) return false;
  const normalize = value => path.resolve(String(value)).replace(/[\\/]+$/, '').toLowerCase();
  return normalize(left) === normalize(right);
}

function removeManagedAsset(options = {}) {
  if (!options.asset || !options.mediaManager) throw new Error('asset and mediaManager are required');
  const target = options.mediaManager.getAssetPath(options.asset);
  if (samePath(target, options.activePath) || String(options.activeAssetId || '') === String(options.asset.id || '')) {
    return { status: 'deferred', assetId: options.asset.id, path: target, reason: 'currently-playing' };
  }

  const removed = [];
  for (const candidate of [target, `${target}.part`, `${target}.part.meta.json`]) {
    if (!fs.existsSync(candidate)) continue;
    const stat = fs.lstatSync(candidate);
    if (!stat.isFile()) throw new Error(`Managed media cleanup refused a non-file path: ${candidate}`);
    fs.unlinkSync(candidate);
    removed.push(candidate);
  }
  removeEmptyParents(path.dirname(target), options.mediaManager.mediaDir);
  return { status: 'removed', assetId: options.asset.id, path: target, removed };
}

function removeEmptyParents(startDirectory, mediaDirectory) {
  if (!mediaDirectory) return;
  const root = path.resolve(mediaDirectory);
  let current = path.resolve(startDirectory);
  while (current !== root && current.startsWith(`${root}${path.sep}`)) {
    if (!fs.existsSync(current) || fs.readdirSync(current).length > 0) return;
    fs.rmdirSync(current);
    current = path.dirname(current);
  }
}

module.exports = { removeManagedAsset, removeEmptyParents, samePath };
