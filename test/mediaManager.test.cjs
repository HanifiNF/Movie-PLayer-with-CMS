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
