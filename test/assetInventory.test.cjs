'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { buildAssetInventory } = require('../assetInventory.cjs');

test('builds a safe CMS snapshot without exposing absolute local paths', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wir-inventory-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'Campaign'));
  fs.writeFileSync(path.join(root, 'Campaign', 'Film A.mp4'), 'video');

  const inventory = await buildAssetInventory({
    mediaLibraryDir: root,
    mediaProbe: { async probe() { return { durationMs: 125000, source: 'test' }; } },
    cachedAssets: [],
    mediaManager: null
  });

  assert.equal(inventory.assets.length, 1);
  assert.match(inventory.assets[0].media_key, /^local:[a-f0-9]{64}$/);
  assert.equal(inventory.assets[0].relative_path, 'Campaign/Film A.mp4');
  assert.equal(inventory.assets[0].duration_ms, 125000);
  assert.equal(inventory.assets[0].status, 'ready');
  assert.equal(JSON.stringify(inventory.assets).includes(root), false);
});

test('includes missing managed assets so the CMS can report their health', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wir-inventory-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const inventory = await buildAssetInventory({
    mediaLibraryDir: root,
    mediaProbe: { async probe() { throw new Error('must not probe missing media'); } },
    cachedAssets: [{
      id: 'asset-123', filename: 'Managed Film.mp4', size: 100,
      durationMs: 60000, sha256: 'a'.repeat(64)
    }],
    mediaManager: { getAssetPath() { return path.join(root, 'not-downloaded.mp4'); } }
  });

  assert.equal(inventory.assets.length, 1);
  assert.equal(inventory.assets[0].media_key, 'managed:asset-123');
  assert.equal(inventory.assets[0].status, 'missing');
  assert.equal(inventory.assets[0].sha256, 'a'.repeat(64));
});
