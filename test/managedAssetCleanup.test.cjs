'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { removeManagedAsset } = require('../managedAssetCleanup.cjs');

test('managed cleanup deletes only the final file and its partial file', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wir-cleanup-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const mediaManager = { getAssetPath: asset => path.join(directory, `${asset.id}.mp4`) };
  const asset = { id: 'asset-1', filename: 'Film.mp4' };
  const target = mediaManager.getAssetPath(asset);
  fs.writeFileSync(target, 'film');
  fs.writeFileSync(`${target}.part`, 'partial');
  fs.writeFileSync(`${target}.part.meta.json`, '{"etag":"test"}');

  const result = removeManagedAsset({ asset, mediaManager, activePath: '' });

  assert.equal(result.status, 'removed');
  assert.equal(fs.existsSync(target), false);
  assert.equal(fs.existsSync(`${target}.part`), false);
  assert.equal(fs.existsSync(`${target}.part.meta.json`), false);
});

test('managed cleanup defers deletion while VLC is using the exact file', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wir-cleanup-active-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const mediaManager = { getAssetPath: asset => path.join(directory, `${asset.id}.mp4`) };
  const asset = { id: 'asset-2', filename: 'Film.mp4' };
  const target = mediaManager.getAssetPath(asset);
  fs.writeFileSync(target, 'film');

  const result = removeManagedAsset({ asset, mediaManager, activePath: target });

  assert.equal(result.status, 'deferred');
  assert.equal(fs.existsSync(target), true);
});

test('managed cleanup removes the empty film folder but keeps the Media Folder', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wir-cleanup-nested-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filmDirectory = path.join(directory, 'Film Title--12345678');
  fs.mkdirSync(filmDirectory);
  const target = path.join(filmDirectory, '12345678-1234-4234-8234-1234567890ab-r1.ldg');
  fs.writeFileSync(target, 'film');
  const mediaManager = { mediaDir: directory, getAssetPath: () => target };

  const result = removeManagedAsset({ asset: { id: 'asset-nested' }, mediaManager, activePath: '' });

  assert.equal(result.status, 'removed');
  assert.equal(fs.existsSync(filmDirectory), false);
  assert.equal(fs.existsSync(directory), true);
});
