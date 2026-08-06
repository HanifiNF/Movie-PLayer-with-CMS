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
  if (samePath(target, options.activePath)) {
    return { status: 'deferred', assetId: options.asset.id, path: target, reason: 'currently-playing' };
  }

  const removed = [];
  for (const candidate of [target, `${target}.part`]) {
    if (!fs.existsSync(candidate)) continue;
    const stat = fs.lstatSync(candidate);
    if (!stat.isFile()) throw new Error(`Managed media cleanup refused a non-file path: ${candidate}`);
    fs.unlinkSync(candidate);
    removed.push(candidate);
  }
  return { status: 'removed', assetId: options.asset.id, path: target, removed };
}

module.exports = { removeManagedAsset, samePath };
