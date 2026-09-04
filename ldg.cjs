'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');

const HEADER_SIZE = 128;
const HEADER_CORE_SIZE = 80;
const TAG_SIZE = 16;

function uuidFromBytes(buffer) {
  const hex = buffer.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function parseLdgHeader(filePath) {
  const descriptor = fs.openSync(filePath, 'r');
  try {
    const header = Buffer.alloc(HEADER_SIZE);
    const read = fs.readSync(descriptor, header, 0, HEADER_SIZE, 0);
    if (read !== HEADER_SIZE) throw new Error('LDG header is incomplete');
    if (header.subarray(0, 4).toString('ascii') !== 'LDG1') throw new Error('LDG magic header is invalid');
    if (header[4] !== 1 || header[5] !== 1) throw new Error('Unsupported LDG version or cipher');
    const core = header.subarray(0, HEADER_CORE_SIZE);
    const expectedHeaderHash = crypto.createHash('sha256').update(core).digest();
    if (!crypto.timingSafeEqual(expectedHeaderHash, header.subarray(80, 112))) {
      throw new Error('LDG header integrity check failed');
    }
    const chunkSize = header.readUInt32BE(8);
    const plaintextSize = Number(header.readBigUInt64BE(12));
    const revision = header.readUInt32BE(44);
    if (!Number.isSafeInteger(plaintextSize) || plaintextSize <= 0) throw new Error('LDG plaintext size is invalid');
    if (chunkSize < 1024 * 1024 || chunkSize > 16 * 1024 * 1024) throw new Error('LDG chunk size is invalid');
    const chunks = Math.ceil(plaintextSize / chunkSize);
    const expectedFileSize = HEADER_SIZE + plaintextSize + chunks * TAG_SIZE;
    const actualFileSize = fs.fstatSync(descriptor).size;
    if (actualFileSize !== expectedFileSize) {
      throw new Error(`LDG size mismatch: expected ${expectedFileSize}, found ${actualFileSize}`);
    }
    return {
      core: Buffer.from(core),
      chunkSize,
      plaintextSize,
      noncePrefix: Buffer.from(header.subarray(20, 28)),
      assetId: uuidFromBytes(header.subarray(28, 44)),
      revision,
      plaintextSha256: header.subarray(48, 80).toString('hex'),
      chunks,
      expectedFileSize
    };
  } finally {
    fs.closeSync(descriptor);
  }
}

function decodeBase64(value, expectedLength, field) {
  const result = Buffer.from(String(value || ''), 'base64');
  if (result.length !== expectedLength) throw new Error(`LDG ${field} is invalid`);
  return result;
}

function unwrapAssetKey(asset, playerToken, deviceId, now = Date.now()) {
  const encryption = asset && asset.encryption;
  const license = encryption && encryption.license;
  if (!encryption || encryption.format !== 'ldg-v1' || !license) throw new Error('LDG license is missing');
  const expiresAt = Date.parse(String(license.expiresAt || ''));
  if (!Number.isFinite(expiresAt) || expiresAt <= now) throw new Error('LDG license has expired');
  const deviceKey = crypto.hkdfSync(
    'sha256', Buffer.from(String(playerToken), 'utf8'), Buffer.from(String(deviceId), 'utf8'),
    Buffer.from('ldg-device-kek-v1', 'utf8'), 32
  );
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm', deviceKey, decodeBase64(license.nonce, 12, 'license nonce'),
    { authTagLength: TAG_SIZE }
  );
  const aad = `ldg-license-v1|${deviceId}|${asset.id}|${asset.revision}|${license.expiresAt}`;
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(decodeBase64(license.tag, TAG_SIZE, 'license tag'));
  const key = Buffer.concat([
    decipher.update(Buffer.from(String(license.wrappedKey || ''), 'base64')),
    decipher.final()
  ]);
  if (key.length !== 32) throw new Error('LDG unwrapped key length is invalid');
  return { key, expiresAt };
}

function parseRange(header, size) {
  if (!header) return { start: 0, end: size - 1, partial: false };
  if (String(header).includes(',')) return null;
  const match = String(header).match(/^bytes=(\d*)-(\d*)$/i);
  if (!match || (!match[1] && !match[2])) return null;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    return { start: Math.max(0, size - suffix), end: size - 1, partial: true };
  }
  const start = Number(match[1]);
  const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) return null;
  return { start, end, partial: true };
}

async function readExactly(handle, buffer, position) {
  let offset = 0;
  while (offset < buffer.length) {
    const result = await handle.read(buffer, offset, buffer.length - offset, position + offset);
    if (!result.bytesRead) throw new Error('Encrypted LDG chunk ended unexpectedly');
    offset += result.bytesRead;
  }
}

async function decryptChunk(handle, header, key, index) {
  const plainLength = Math.min(header.chunkSize, header.plaintextSize - index * header.chunkSize);
  const recordOffset = HEADER_SIZE + index * (header.chunkSize + TAG_SIZE);
  const record = Buffer.allocUnsafe(plainLength + TAG_SIZE);
  await readExactly(handle, record, recordOffset);
  const nonce = Buffer.alloc(12);
  header.noncePrefix.copy(nonce, 0);
  nonce.writeUInt32BE(index, 8);
  const aadSuffix = Buffer.alloc(8);
  aadSuffix.writeUInt32BE(index, 0);
  aadSuffix.writeUInt32BE(plainLength, 4);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_SIZE });
  decipher.setAAD(Buffer.concat([header.core, aadSuffix]));
  decipher.setAuthTag(record.subarray(plainLength));
  return Buffer.concat([decipher.update(record.subarray(0, plainLength)), decipher.final()]);
}

function waitForDrain(stream) {
  return new Promise((resolve, reject) => {
    stream.once('drain', resolve);
    stream.once('error', reject);
  });
}

class LdgGateway {
  constructor(options = {}) {
    if (!options.playerToken || !options.deviceId) throw new Error('LdgGateway requires playerToken and deviceId');
    this.playerToken = options.playerToken;
    this.deviceId = options.deviceId;
    this.server = null;
    this.startPromise = null;
    this.port = 0;
    this.records = new Map();
    this.assetTokens = new Map();
    this.connections = new Set();
  }

  async start() {
    if (this.server) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = new Promise((resolve, reject) => {
      const server = http.createServer((request, response) => {
        void this.#handle(request, response).catch(error => {
          if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
          response.end('Encrypted media playback failed');
          this.onError && this.onError(error);
        });
      });
      server.on('error', reject);
      server.on('connection', socket => {
        this.connections.add(socket);
        socket.once('close', () => this.connections.delete(socket));
      });
      server.listen(0, '127.0.0.1', () => {
        this.server = server;
        this.port = server.address().port;
        resolve();
      });
    }).finally(() => { this.startPromise = null; });
    return this.startPromise;
  }

  async register(asset, filePath) {
    if (!asset || !filePath || asset.encryptionFormat !== 'ldg-v1') return filePath;
    await this.start();
    const header = parseLdgHeader(filePath);
    if (header.assetId.toLowerCase() !== String(asset.id).toLowerCase()) throw new Error('LDG asset identity does not match the manifest');
    if (header.revision !== Number(asset.encryption.encryptionRevision || asset.revision)) {
      throw new Error('LDG encryption revision does not match the manifest');
    }
    if (header.plaintextSize !== Number(asset.encryption.plaintextSize)) throw new Error('LDG plaintext size does not match the manifest');
    if (header.plaintextSha256 !== asset.encryption.plaintextSha256) throw new Error('LDG plaintext digest does not match the manifest');
    const unwrapped = unwrapAssetKey(asset, this.playerToken, this.deviceId);
    const existingToken = this.assetTokens.get(String(asset.id));
    const existing = existingToken ? this.records.get(existingToken) : null;
    if (existing) {
      if (existing.key) existing.key.fill(0);
      existing.filePath = filePath;
      existing.mimeType = asset.encryption.originalMimeType || 'application/octet-stream';
      existing.header = header;
      existing.key = unwrapped.key;
      existing.expiresAt = unwrapped.expiresAt;
      return `http://127.0.0.1:${this.port}/ldg/v1/${existingToken}`;
    }
    const token = crypto.randomBytes(32).toString('base64url');
    this.records.set(token, {
      assetId: asset.id,
      filePath,
      mimeType: asset.encryption.originalMimeType || 'application/octet-stream',
      header,
      key: unwrapped.key,
      expiresAt: unwrapped.expiresAt
    });
    this.assetTokens.set(String(asset.id), token);
    return `http://127.0.0.1:${this.port}/ldg/v1/${token}`;
  }

  unregister(assetId) {
    const token = this.assetTokens.get(String(assetId));
    if (!token) return;
    const record = this.records.get(token);
    if (record && record.key) record.key.fill(0);
    this.records.delete(token);
    this.assetTokens.delete(String(assetId));
  }

  async #handle(request, response) {
    const remote = request.socket.remoteAddress || '';
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) {
      response.writeHead(403, { 'Cache-Control': 'no-store' });
      response.end();
      return;
    }
    const match = new URL(request.url, 'http://127.0.0.1').pathname.match(/^\/ldg\/v1\/([A-Za-z0-9_-]+)$/);
    const record = match ? this.records.get(match[1]) : null;
    if (!record || Date.now() >= record.expiresAt) {
      response.writeHead(404, { 'Cache-Control': 'no-store' });
      response.end();
      return;
    }
    if (!['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(405, { Allow: 'GET, HEAD', 'Cache-Control': 'no-store' });
      response.end();
      return;
    }
    const range = parseRange(request.headers.range, record.header.plaintextSize);
    if (!range) {
      response.writeHead(416, {
        'Accept-Ranges': 'bytes',
        'Content-Range': `bytes */${record.header.plaintextSize}`,
        'Cache-Control': 'no-store'
      });
      response.end();
      return;
    }
    const length = range.end - range.start + 1;
    const headers = {
      'Accept-Ranges': 'bytes',
      'Content-Type': record.mimeType,
      'Content-Length': String(length),
      'Cache-Control': 'no-store, private',
      'X-Content-Type-Options': 'nosniff'
    };
    if (range.partial) headers['Content-Range'] = `bytes ${range.start}-${range.end}/${record.header.plaintextSize}`;
    response.writeHead(range.partial ? 206 : 200, headers);
    if (request.method === 'HEAD') {
      response.end();
      return;
    }

    const firstChunk = Math.floor(range.start / record.header.chunkSize);
    const lastChunk = Math.floor(range.end / record.header.chunkSize);
    const handle = await fs.promises.open(record.filePath, 'r');
    try {
      for (let index = firstChunk; index <= lastChunk; index++) {
        let plain = await decryptChunk(handle, record.header, record.key, index);
        const chunkStart = index * record.header.chunkSize;
        const sliceStart = Math.max(0, range.start - chunkStart);
        const sliceEnd = Math.min(plain.length, range.end - chunkStart + 1);
        plain = plain.subarray(sliceStart, sliceEnd);
        if (plain.length && !response.write(plain)) await waitForDrain(response);
      }
      response.end();
    } finally {
      await handle.close();
    }
  }

  async close() {
    for (const record of this.records.values()) if (record.key) record.key.fill(0);
    this.records.clear();
    this.assetTokens.clear();
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    await new Promise(resolve => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve();
      };
      const timeout = setTimeout(finish, 1000);
      server.close(finish);
      for (const socket of this.connections) socket.destroy();
      this.connections.clear();
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    });
    this.port = 0;
  }
}

module.exports = {
  HEADER_SIZE,
  LdgGateway,
  decryptChunk,
  parseLdgHeader,
  parseRange,
  unwrapAssetKey
};
