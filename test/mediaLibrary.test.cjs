'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { listManagedAssets, scanMediaLibrary } = require('../mediaLibrary.cjs');

test('scans supported films recursively and ignores unrelated files', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wir-library-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'Campaign A'));
  fs.writeFileSync(path.join(root, 'Film A.mp4'), 'a');
  fs.writeFileSync(path.join(root, 'Campaign A', 'Film B.mkv'), 'b');
  fs.writeFileSync(path.join(root, 'notes.txt'), 'not media');

  const items = scanMediaLibrary(root);
  assert.deepEqual(items.map(item => item.title), ['Film A', 'Film B']);
  assert.equal(items[1].relativePath, path.join('Campaign A', 'Film B.mkv'));
  assert.match(items[0].id, /^local-[a-f0-9]{40}$/);
  assert.match(items[0].mediaKey, /^local:[a-f0-9]{64}$/);
});

test('uses relative path identity so duplicate titles remain selectable', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wir-library-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'One'));
  fs.mkdirSync(path.join(root, 'Two'));
  fs.writeFileSync(path.join(root, 'One', 'Promo.mp4'), 'one');
  fs.writeFileSync(path.join(root, 'Two', 'Promo.mp4'), 'two');

  const items = scanMediaLibrary(root);
  assert.equal(items.length, 2);
  assert.equal(items[0].title, 'Promo');
  assert.equal(items[1].title, 'Promo');
  assert.notEqual(items[0].id, items[1].id);
});

test('lists managed downloads with reusable asset identity and readiness', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wir-managed-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const downloadedPath = path.join(root, 'asset-1.mp4');
  fs.writeFileSync(downloadedPath, 'ready');

  const items = listManagedAssets([{
    id: 'asset-1',
    filename: 'Reusable Film.mp4',
    size: 5
  }, {
    id: 'asset-2',
    filename: 'Missing Film.mp4',
    size: 12
  }], asset => path.join(root, `${asset.id}.mp4`));

  assert.equal(items[0].id, 'asset:asset-1');
  assert.equal(items[0].mediaKey, 'managed:asset-1');
  assert.equal(items[0].sourceLabel, 'Downloaded');
  assert.equal(items[0].status, 'downloaded');
  assert.equal(items[1].status, 'missing');
});
