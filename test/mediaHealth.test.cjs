'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { MediaHealthMonitor, inspectBasicFile } = require('../mediaHealth.cjs');

test('basic media inspection distinguishes ready, missing, and empty files', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wir-health-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ready = path.join(root, 'ready.mp4');
  const empty = path.join(root, 'empty.mp4');
  fs.writeFileSync(ready, 'video');
  fs.writeFileSync(empty, '');

  assert.equal(inspectBasicFile(ready).status, 'ready');
  assert.equal(inspectBasicFile(empty).status, 'corrupt');
  assert.equal(inspectBasicFile(path.join(root, 'missing.mp4')).status, 'missing');
});

test('health scan verifies managed checksums and reports aggregate counts', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wir-health-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const localPath = path.join(root, 'local.mp4');
  const managedPath = path.join(root, 'asset.mp4');
  fs.writeFileSync(localPath, 'local');
  fs.writeFileSync(managedPath, 'wrong');

  const monitor = new MediaHealthMonitor({
    storagePath: root,
    lowSpaceBytes: Number.MAX_SAFE_INTEGER
  });
  const snapshot = await monitor.scan([{
    files: [
      { title: 'Local', path: localPath },
      { title: 'Managed', assetId: 'asset-1', path: managedPath },
      { title: 'Missing', path: path.join(root, 'missing.mp4') }
    ]
  }], [{
    id: 'asset-1',
    size: 5,
    sha256: crypto.createHash('sha256').update('right').digest('hex')
  }]);

  assert.deepEqual(snapshot.counts, { ready: 1, missing: 1, corrupt: 1, unreadable: 0 });
  assert.equal(snapshot.disk.lowSpace, true);
  assert.equal(snapshot.state, 'warning');
});

test('isReady notices a local file deleted after the last scan', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wir-health-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'film.mp4');
  fs.writeFileSync(filePath, 'film');
  const monitor = new MediaHealthMonitor({ storagePath: root });
  const file = { path: filePath };
  await monitor.scan([{ files: [file] }], []);
  assert.equal(monitor.isReady(file), true);
  fs.unlinkSync(filePath);
  assert.equal(monitor.isReady(file), false);
});
