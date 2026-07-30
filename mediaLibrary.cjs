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
        title: path.basename(entry.name, extension),
        filename: entry.name,
        relativePath,
        path: absolutePath,
        size: stat.size,
        modifiedAt: stat.mtime.toISOString()
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

module.exports = { MEDIA_EXTENSIONS, makeLocalMediaId, scanMediaLibrary };
