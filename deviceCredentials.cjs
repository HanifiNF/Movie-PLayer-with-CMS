'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

class DeviceCredentials {
  constructor(options = {}) {
    if (!options.configPath || !options.installationPath || !options.safeStorage) {
      throw new Error('configPath, installationPath, and safeStorage are required');
    }
    this.configPath = options.configPath;
    this.installationPath = options.installationPath;
    this.safeStorage = options.safeStorage;
  }

  getInstallId() {
    const existing = this.#readJson(this.installationPath, null);
    if (existing && typeof existing.installId === 'string' && existing.installId.length >= 8) {
      return existing.installId;
    }

    const installId = randomUUID();
    this.#writeJson(this.installationPath, { installId, createdAt: new Date().toISOString() });
    return installId;
  }

  load() {
    const stored = this.#readJson(this.configPath, null);
    if (!stored) return null;

    if (stored.encryptedToken) {
      if (!this.safeStorage.isEncryptionAvailable()) {
        throw new Error('Secure credential storage is unavailable on this computer');
      }
      const token = this.safeStorage.decryptString(Buffer.from(stored.encryptedToken, 'base64'));
      return { ...stored, token, encryptedToken: undefined };
    }

    // Migrate configurations created by Player 1.1.0, which stored the token
    // as plain JSON. The next write removes the legacy value.
    if (typeof stored.token === 'string' && stored.token) {
      const migrated = { ...stored };
      this.save(migrated);
      return migrated;
    }

    return null;
  }

  save(config) {
    if (!config || typeof config.token !== 'string' || !config.token) {
      throw new Error('A player token is required');
    }
    if (!this.safeStorage.isEncryptionAvailable()) {
      throw new Error('Secure credential storage is unavailable on this computer');
    }

    const encryptedToken = this.safeStorage.encryptString(config.token).toString('base64');
    const persisted = { ...config, encryptedToken };
    delete persisted.token;
    delete persisted.bypass;
    this.#writeJson(this.configPath, persisted);
  }

  clear() {
    try {
      if (fs.existsSync(this.configPath)) fs.unlinkSync(this.configPath);
    } catch (error) {
      throw new Error(`Unable to clear player credentials: ${error.message}`);
    }
  }

  #readJson(file, fallback) {
    try {
      if (!fs.existsSync(file)) return fallback;
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (_) {
      return fallback;
    }
  }

  #writeJson(file, data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporaryPath = `${file}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(temporaryPath, file);
  }
}

module.exports = { DeviceCredentials };
