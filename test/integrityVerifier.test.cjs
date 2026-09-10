'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { IntegrityVerifier, runHashWorker } = require('../integrityVerifier.cjs');

const ASSET_ID = '12345678-1234-4234-8234-1234567890ab';

function uuidBytes(uuid) {
  return Buffer.from(uuid.replaceAll('-', ''), 'hex');
}

function createLdgFixture(filePath, plaintext, revision = 1) {
  const chunkSize = 1024 * 1024;
  const core = Buffer.alloc(80);
  core.write('LDG1', 0, 'ascii');
  core[4] = 1;
  core[5] = 1;
  core.writeUInt32BE(chunkSize, 8);
  core.writeBigUInt64BE(BigInt(plaintext.length), 12);
  crypto.randomBytes(8).copy(core, 20);
  uuidBytes(ASSET_ID).copy(core, 28);
  core.writeUInt32BE(revision, 44);
  const plaintextSha256 = crypto.createHash('sha256').update(plaintext).digest();
  plaintextSha256.copy(core, 48);
  const header = Buffer.concat([
    core,
    crypto.createHash('sha256').update(core).digest(),
    Buffer.alloc(16)
  ]);
  const tags = Buffer.alloc(Math.ceil(plaintext.length / chunkSize) * 16);
  const content = Buffer.concat([header, plaintext, tags]);
  fs.writeFileSync(filePath, content);
  return { content, plaintextSha256: plaintextSha256.toString('hex') };
}

function ldgAsset(content, plaintextSize, plaintextSha256) {
  return {
    id: ASSET_ID,
    revision: 1,
    filename: 'film.ldg',
    encryptionFormat: 'ldg-v1',
    size: content.length,
    sha256: crypto.createHash('sha256').update(content).digest('hex'),
    encryption: {
      format: 'ldg-v1',
      encryptionRevision: 1,
      plaintextSize,
      plaintextSha256
    }
  };
}

test('an existing LDG is immediately playable provisionally and queues background verification', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'integrity-ldg-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'film.ldg');
  const plaintext = Buffer.from('encrypted payload placeholder');
  const fixture = createLdgFixture(filePath, plaintext);
  const verifier = new IntegrityVerifier({
    cachePath: path.join(root, 'integrity.json'),
    idleDelayMs: 60 * 60 * 1000,
    isIdle: () => true
  });
  t.after(() => verifier.close());

  const result = verifier.inspect(ldgAsset(fixture.content, plaintext.length, fixture.plaintextSha256), filePath);

  assert.equal(result.ready, true);
  assert.equal(result.status, 'queued');
  assert.equal(verifier.getSnapshot().jobs.length, 1);
});

test('a persistent verification receipt skips hashing until file identity changes', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'integrity-receipt-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'film.ldg');
  const plaintext = Buffer.from('receipt payload');
  const fixture = createLdgFixture(filePath, plaintext);
  const asset = ldgAsset(fixture.content, plaintext.length, fixture.plaintextSha256);
  const cachePath = path.join(root, 'integrity.json');
  const verifier = new IntegrityVerifier({ cachePath, idleDelayMs: 60 * 60 * 1000 });
  verifier.recordVerified(asset, filePath, asset.sha256);
  await verifier.close();

  const restored = new IntegrityVerifier({ cachePath, idleDelayMs: 60 * 60 * 1000 });
  t.after(() => restored.close());
  assert.equal(restored.inspect(asset, filePath, { queue: false }).status, 'verified');

  const future = new Date(Date.now() + 2000);
  fs.utimesSync(filePath, future, future);
  const changed = restored.inspect(asset, filePath, { queue: false });
  assert.equal(changed.ready, true);
  assert.equal(changed.status, 'provisional');
});

test('the hash worker reports a digest without blocking the caller thread', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'integrity-worker-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'large.bin');
  const content = crypto.randomBytes(5 * 1024 * 1024);
  fs.writeFileSync(filePath, content);
  const progress = [];

  const task = runHashWorker(filePath, bytes => progress.push(bytes));
  const result = await task.promise;

  assert.equal(result.digest, crypto.createHash('sha256').update(content).digest('hex'));
  assert.equal(result.processedBytes, content.length);
  assert.ok(progress.length > 0);
});

test('non-LDG media remains unavailable until its queued full verification succeeds', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'integrity-plain-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'film.mp4');
  const content = crypto.randomBytes(2 * 1024 * 1024);
  fs.writeFileSync(filePath, content);
  const asset = {
    id: 'plain-asset', filename: 'film.mp4', size: content.length,
    sha256: crypto.createHash('sha256').update(content).digest('hex')
  };
  const verifier = new IntegrityVerifier({
    cachePath: path.join(root, 'integrity.json'), idleDelayMs: 0, isIdle: () => true
  });
  t.after(() => verifier.close());
  const verified = new Promise(resolve => verifier.once('verified', resolve));

  const initial = verifier.inspect(asset, filePath);
  assert.equal(initial.ready, false);
  assert.match(initial.status, /queued|verifying/);
  await verified;

  const result = verifier.inspect(asset, filePath, { queue: false });
  assert.equal(result.ready, true);
  assert.equal(result.status, 'verified');
});

test('background verification is interrupted for playback and restarts after idle', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'integrity-pause-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'film.mp4');
  const content = crypto.randomBytes(8 * 1024 * 1024);
  fs.writeFileSync(filePath, content);
  const asset = {
    id: 'paused-asset', filename: 'film.mp4', size: content.length,
    sha256: crypto.createHash('sha256').update(content).digest('hex')
  };
  let idle = true;
  let interrupted = false;
  const verifier = new IntegrityVerifier({
    cachePath: path.join(root, 'integrity.json'), idleDelayMs: 0, isIdle: () => idle
  });
  t.after(() => verifier.close());
  verifier.on('update', snapshot => {
    const job = snapshot.jobs.find(item => item.assetId === asset.id);
    if (!interrupted && job && job.status === 'verifying') {
      interrupted = true;
      idle = false;
      verifier.suspendForPlayback();
      setTimeout(() => {
        idle = true;
        verifier.resumeAfterIdle();
      }, 20);
    }
  });
  const verified = new Promise(resolve => verifier.once('verified', resolve));

  verifier.inspect(asset, filePath);
  await verified;

  assert.equal(interrupted, true);
  assert.equal(verifier.inspect(asset, filePath, { queue: false }).status, 'verified');
});
