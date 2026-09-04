'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { LdgGateway, parseLdgHeader, unwrapAssetKey } = require('../ldg.cjs');

const ASSET_ID = '12345678-1234-4234-8234-1234567890ab';
const DEVICE_ID = '87654321-4321-4432-8432-ba0987654321';
const PLAYER_TOKEN = 'test-player-token-with-enough-random-material';

function uuidBytes(uuid) {
  return Buffer.from(uuid.replaceAll('-', ''), 'hex');
}

function makeFixture(filePath, plaintext, key, chunkSize = 1024 * 1024, revision = 1) {
  const core = Buffer.alloc(80);
  core.write('LDG1', 0, 'ascii');
  core[4] = 1;
  core[5] = 1;
  core.writeUInt32BE(chunkSize, 8);
  core.writeBigUInt64BE(BigInt(plaintext.length), 12);
  const noncePrefix = crypto.randomBytes(8);
  noncePrefix.copy(core, 20);
  uuidBytes(ASSET_ID).copy(core, 28);
  core.writeUInt32BE(revision, 44);
  crypto.createHash('sha256').update(plaintext).digest().copy(core, 48);
  const header = Buffer.concat([core, crypto.createHash('sha256').update(core).digest(), Buffer.alloc(16)]);
  const records = [header];
  for (let index = 0; index * chunkSize < plaintext.length; index++) {
    const plain = plaintext.subarray(index * chunkSize, Math.min(plaintext.length, (index + 1) * chunkSize));
    const nonce = Buffer.alloc(12);
    noncePrefix.copy(nonce);
    nonce.writeUInt32BE(index, 8);
    const suffix = Buffer.alloc(8);
    suffix.writeUInt32BE(index, 0);
    suffix.writeUInt32BE(plain.length, 4);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
    cipher.setAAD(Buffer.concat([core, suffix]));
    records.push(cipher.update(plain), cipher.final(), cipher.getAuthTag());
  }
  fs.writeFileSync(filePath, Buffer.concat(records));
}

function makeAsset(filePath, plaintext, key, revision = 1) {
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const deviceKey = crypto.hkdfSync('sha256', Buffer.from(PLAYER_TOKEN), Buffer.from(DEVICE_ID), Buffer.from('ldg-device-kek-v1'), 32);
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deviceKey, nonce, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(`ldg-license-v1|${DEVICE_ID}|${ASSET_ID}|${revision}|${expiresAt}`));
  const wrapped = Buffer.concat([cipher.update(key), cipher.final()]);
  return {
    id: ASSET_ID,
    revision,
    filename: 'protected-film.ldg',
    encryptionFormat: 'ldg-v1',
    encryption: {
      format: 'ldg-v1',
      headerSize: 128,
      chunkSize: 1024 * 1024,
      plaintextSize: plaintext.length,
      plaintextSha256: crypto.createHash('sha256').update(plaintext).digest('hex'),
      originalMimeType: 'video/mp4',
      encryptionRevision: revision,
      license: {
        algorithm: 'A256GCM',
        wrappedKey: wrapped.toString('base64'),
        nonce: nonce.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        expiresAt
      }
    },
    localPath: filePath
  };
}

test('LDG header and device-bound license are authenticated', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ldg-header-'));
  const filePath = path.join(directory, 'film.ldg');
  const plaintext = Buffer.from('cinema payload '.repeat(90000));
  const key = crypto.randomBytes(32);
  try {
    makeFixture(filePath, plaintext, key);
    const asset = makeAsset(filePath, plaintext, key);
    const header = parseLdgHeader(filePath);
    assert.equal(header.assetId, ASSET_ID);
    assert.equal(header.plaintextSize, plaintext.length);
    assert.equal(header.revision, 1);
    assert.deepEqual(unwrapAssetKey(asset, PLAYER_TOKEN, DEVICE_ID).key, key);
    assert.throws(() => unwrapAssetKey(asset, 'token-from-another-player', DEVICE_ID));
    assert.equal(fs.readFileSync(filePath).includes(plaintext.subarray(0, 64)), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('local LDG gateway decrypts byte ranges without writing plaintext to disk', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ldg-gateway-'));
  const filePath = path.join(directory, 'film.ldg');
  const plaintext = crypto.randomBytes(1024 * 1024 + 8192);
  const key = crypto.randomBytes(32);
  const gateway = new LdgGateway({ playerToken: PLAYER_TOKEN, deviceId: DEVICE_ID });
  try {
    makeFixture(filePath, plaintext, key);
    const url = await gateway.register(makeAsset(filePath, plaintext, key), filePath);
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/ldg\/v1\/[A-Za-z0-9_-]+$/);
    const start = 1024 * 1024 - 120;
    const end = start + 500;
    const response = await fetch(url, { headers: { Range: `bytes=${start}-${end}` } });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-range'), `bytes ${start}-${end}/${plaintext.length}`);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), plaintext.subarray(start, end + 1));
    assert.deepEqual(fs.readdirSync(directory), ['film.ldg']);
  } finally {
    await gateway.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('LDG gateway shutdown terminates active local sockets', async () => {
  const gateway = new LdgGateway({ playerToken: PLAYER_TOKEN, deviceId: DEVICE_ID });
  await gateway.start();
  const socket = net.connect(gateway.port, '127.0.0.1');
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });

  const socketClosed = new Promise(resolve => socket.once('close', resolve));
  await gateway.close();
  await socketClosed;

  assert.equal(gateway.server, null);
  assert.equal(gateway.port, 0);
  assert.equal(gateway.connections.size, 0);
  assert.equal(socket.destroyed, true);
});
