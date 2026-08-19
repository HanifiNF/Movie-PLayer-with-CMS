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

test('resumes an interrupted download from the saved partial byte', async t => {
  const content = Buffer.from('0123456789-resumable-media-content');
  const sha256 = crypto.createHash('sha256').update(content).digest('hex');
  const etag = `"${sha256}"`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wir-player-resume-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  let receivedRange = '';
  let receivedIfRange = '';
  const manager = new MediaManager({ mediaDir: path.join(tempDir, 'media') });
  const asset = { id: 'resume-asset', filename: 'film.mp4', size: content.length, sha256 };
  const target = manager.getAssetPath(asset);
  const partialBytes = 11;
  fs.writeFileSync(`${target}.part`, content.subarray(0, partialBytes));
  fs.writeFileSync(`${target}.part.meta.json`, JSON.stringify({ etag }));
  const server = http.createServer((request, response) => {
    receivedRange = request.headers.range || '';
    receivedIfRange = request.headers['if-range'] || '';
    response.writeHead(206, {
      etag, 'content-length': content.length - partialBytes,
      'content-range': `bytes ${partialBytes}-${content.length - 1}/${content.length}`
    });
    response.end(content.subarray(partialBytes));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  asset.downloadUrl = `http://127.0.0.1:${server.address().port}/film.mp4`;

  const result = await manager.prepareAsset(asset);

  assert.equal(receivedRange, `bytes=${partialBytes}-`);
  assert.equal(receivedIfRange, etag);
  assert.deepEqual(fs.readFileSync(result), content);
  assert.equal(fs.existsSync(`${target}.part`), false);
  assert.equal(fs.existsSync(`${target}.part.meta.json`), false);
});

test('restarts safely when the server rejects a stale partial range', async t => {
  const content = Buffer.from('fresh-complete-media');
  const sha256 = crypto.createHash('sha256').update(content).digest('hex');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wir-player-range-reset-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const manager = new MediaManager({ mediaDir: path.join(tempDir, 'media') });
  const asset = { id: 'reset-asset', filename: 'film.mp4', size: content.length, sha256 };
  const target = manager.getAssetPath(asset);
  fs.writeFileSync(`${target}.part`, Buffer.from('stale'));
  fs.writeFileSync(`${target}.part.meta.json`, JSON.stringify({ etag: '"old"' }));
  const ranges = [];
  const server = http.createServer((request, response) => {
    ranges.push(request.headers.range || '');
    if (ranges.length === 1) {
      response.writeHead(416, { 'content-range': `bytes */${content.length}` });
      response.end();
      return;
    }
    response.writeHead(200, { etag: `"${sha256}"`, 'content-length': content.length });
    response.end(content);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  asset.downloadUrl = `http://127.0.0.1:${server.address().port}/film.mp4`;

  const result = await manager.prepareAsset(asset);

  assert.deepEqual(ranges, ['bytes=5-', '']);
  assert.deepEqual(fs.readFileSync(result), content);
});

test('can throttle downloads for reliable interruption testing', async t => {
  const content = Buffer.alloc(32 * 1024, 7);
  const sha256 = crypto.createHash('sha256').update(content).digest('hex');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wir-player-throttle-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-length': content.length });
    response.end(content);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const manager = new MediaManager({
    mediaDir: path.join(tempDir, 'media'),
    getDownloadOptions: () => ({ limitBytesPerSecond: 64 * 1024 })
  });
  const asset = {
    id: 'throttled-asset', filename: 'film.mp4', size: content.length, sha256,
    downloadUrl: `http://127.0.0.1:${server.address().port}/film.mp4`
  };
  let reportedLimit = null;
  manager.on('download-start', event => { reportedLimit = event.speedLimitKbps; });

  const startedAt = Date.now();
  const result = await manager.prepareAsset(asset);
  const elapsedMs = Date.now() - startedAt;

  assert.ok(elapsedMs >= 400, `expected a throttled download, completed in ${elapsedMs}ms`);
  assert.equal(reportedLimit, 64);
  assert.deepEqual(fs.readFileSync(result), content);
});

test('resolves a CMS schedule local media key without exposing its path to the CMS', async t => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wir-player-local-schedule-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const localPath = path.join(tempDir, 'local-film.mp4');
  fs.writeFileSync(localPath, 'local film');
  const manager = new MediaManager({ mediaDir: path.join(tempDir, 'managed') });
  const mediaKey = `local:${'b'.repeat(64)}`;

  const prepared = await manager.prepareSchedules([{
    id: 'local-schedule', playlist: [{ mediaKey, title: 'Local film' }]
  }], [], new Map([[mediaKey, localPath]]));

  assert.equal(prepared[0].playlist[0].path, localPath);
  assert.equal(prepared[0].playlist[0].mediaKey, mediaKey);
});

test('schedule-only sync does not start a second managed download', async t => {
  const content = Buffer.from('not downloaded by schedule sync');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wir-player-schedule-no-download-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  let requests = 0;
  const server = http.createServer((_request, response) => { requests++; response.end(content); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const manager = new MediaManager({ mediaDir: path.join(tempDir, 'managed') });
  const asset = {
    id: 'managed-not-ready', filename: 'film.mp4', size: content.length,
    sha256: crypto.createHash('sha256').update(content).digest('hex'),
    downloadUrl: `http://127.0.0.1:${server.address().port}/film.mp4`
  };

  const prepared = await manager.prepareSchedules([{
    id: 'schedule', playlist: [{ assetId: asset.id }]
  }], [asset], new Map(), { downloadMissing: false });

  assert.equal(prepared[0].playlist[0].path, null);
  assert.equal(requests, 0);
});

test('encrypted schedules keep the LDG path for health checks and use a gateway URL for VLC', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'media-manager-ldg-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const content = Buffer.from('LDG1');
  const asset = {
    id: 'encrypted-asset', filename: 'Film.ldg', displayFilename: 'Film.mp4',
    encryptionFormat: 'ldg-v1', size: content.length,
    sha256: crypto.createHash('sha256').update(content).digest('hex')
  };
  const manager = new MediaManager({
    mediaDir: directory,
    resolvePlaybackSource: async () => 'http://127.0.0.1:12345/ldg/v1/secret'
  });
  const filePath = manager.getAssetPath(asset);
  fs.writeFileSync(filePath, content);
  const schedules = await manager.prepareSchedules([{
    id: 'encrypted-schedule', playlist: [{ assetId: asset.id }]
  }], [asset], new Map(), { downloadMissing: false });
  assert.equal(schedules[0].files[0].localPath, filePath);
  assert.equal(schedules[0].files[0].playbackSource, 'http://127.0.0.1:12345/ldg/v1/secret');
});
