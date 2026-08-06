'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { MediaManager } = require('../mediaManager.cjs');

test('downloads an asset, verifies SHA-256, and resolves it to a local path', async t => {
  const content = Buffer.from('verified media content');
  const sha256 = crypto.createHash('sha256').update(content).digest('hex');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wir-player-test-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  let requestCount = 0;
  const server = http.createServer((_request, response) => {
    requestCount++;
    response.writeHead(200, {
      'content-type': 'video/mp4',
      'content-length': content.length
    });
    response.end(content);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());

  const address = server.address();
  const manager = new MediaManager({ mediaDir: path.join(tempDir, 'media') });
  const prepared = await manager.prepareSchedules([{
    id: 'schedule-1',
    playlist: [{ assetId: 'asset-1' }],
    files: []
  }], [{
    id: 'asset-1',
    filename: 'promo.mp4',
    downloadUrl: `http://127.0.0.1:${address.port}/promo.mp4`,
    size: content.length,
    sha256
  }]);

  assert.equal(fs.readFileSync(prepared[0].files[0].path, 'utf8'), content.toString());
  assert.equal(await manager.isReady({
    id: 'asset-1',
    filename: 'promo.mp4',
    size: content.length,
    sha256
  }), true);

  const target = prepared[0].files[0].path;
  fs.renameSync(target, `${target}.part`);
  await manager.prepareSchedules([{
    id: 'schedule-1',
    playlist: [{ assetId: 'asset-1' }]
  }], [{
    id: 'asset-1',
    filename: 'promo.mp4',
    downloadUrl: `http://127.0.0.1:${address.port}/promo.mp4`,
    size: content.length,
    sha256
  }]);
  assert.equal(requestCount, 1, 'a complete verified .part file should not be downloaded again');
});

test('pre-downloads assigned assets with device authorization', async t => {
  const content = Buffer.from('private assigned film');
  const sha256 = crypto.createHash('sha256').update(content).digest('hex');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wir-player-auth-test-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  let authorization = '';
  const server = http.createServer((request, response) => {
    authorization = request.headers.authorization || '';
    response.writeHead(200, { 'content-length': content.length });
    response.end(content);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  const manager = new MediaManager({
    mediaDir: path.join(tempDir, 'media'),
    getDownloadOptions: () => ({ headers: { Authorization: 'Bearer device-token' }, authOrigin: origin })
  });
  const progress = [];
  let verifying = false;
  manager.on('download-progress', event => progress.push(event));
  manager.on('verifying', () => { verifying = true; });

  const result = await manager.prepareAssets([{
    id: 'assigned-asset', filename: 'film.mp4', downloadUrl: `${origin}/film.mp4`,
    size: content.length, sha256
  }]);

  assert.equal(authorization, 'Bearer device-token');
  assert.ok(progress.length > 0);
  assert.equal(progress.at(-1).downloadedBytes, content.length);
  assert.equal(progress.at(-1).totalBytes, content.length);
  assert.equal(verifying, true);
  assert.equal(result.ready.length, 1);
  assert.deepEqual(result.failed, []);
  assert.equal(fs.readFileSync(result.ready[0].localPath, 'utf8'), content.toString());
});
