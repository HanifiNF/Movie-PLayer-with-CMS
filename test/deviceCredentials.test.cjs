'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DeviceCredentials } = require('../deviceCredentials.cjs');

function createFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wir-player-credentials-'));
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: value => Buffer.from(`encrypted:${value}`, 'utf8'),
    decryptString: value => value.toString('utf8').replace(/^encrypted:/, '')
  };
  const store = new DeviceCredentials({
    configPath: path.join(directory, 'config.json'),
    installationPath: path.join(directory, 'installation.json'),
    safeStorage
  });
  return { directory, store };
}

test('install ID is stable and kept separately from pairing credentials', t => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.directory, { recursive: true, force: true }));

  const first = fixture.store.getInstallId();
  fixture.store.clear();
  const second = fixture.store.getInstallId();

  assert.match(first, /^[0-9a-f-]{36}$/);
  assert.equal(second, first);
});

test('token is encrypted at rest and restored for runtime use', t => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.directory, { recursive: true, force: true }));

  fixture.store.save({
    serverURL: 'http://localhost:8080',
    deviceId: 'device-1',
    token: 'plain-secret-token',
    bypass: false
  });

  const storedText = fs.readFileSync(path.join(fixture.directory, 'config.json'), 'utf8');
  assert.doesNotMatch(storedText, /plain-secret-token/);
  assert.doesNotMatch(storedText, /"token"/);
  assert.equal(fixture.store.load().token, 'plain-secret-token');
});

test('legacy plaintext token is migrated on first load', t => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.directory, { recursive: true, force: true }));
  const configPath = path.join(fixture.directory, 'config.json');
  fs.mkdirSync(fixture.directory, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({
    serverURL: 'http://localhost:8080',
    deviceId: 'legacy-device',
    token: 'legacy-token'
  }));

  const loaded = fixture.store.load();
  const migratedText = fs.readFileSync(configPath, 'utf8');

  assert.equal(loaded.token, 'legacy-token');
  assert.doesNotMatch(migratedText, /legacy-token/);
  assert.match(migratedText, /encryptedToken/);
});
