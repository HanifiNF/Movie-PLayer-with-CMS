'use strict';

const { EventEmitter } = require('events');

class CmsApiError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'CmsApiError';
    this.status = options.status || 0;
    this.code = options.code || 'cms_request_failed';
  }
}

function normalizeServerUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value || '').trim());
  } catch (_) {
    throw new CmsApiError('CMS Server URL is invalid.', { code: 'invalid_server_url' });
  }

  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new CmsApiError('CMS Server URL must use HTTP or HTTPS without embedded credentials.', {
      code: 'invalid_server_url'
    });
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString().replace(/\/+$/, '');
}

function parseSessionExpiry(value, now = Date.now()) {
  const fallback = now + 30 * 60 * 1000;
  if (typeof value !== 'string' || !value.trim()) return fallback;

  let timestamp = value.trim();
  // Compatibility with older CMS responses. Those values were generated in
  // UTC but omitted the offset, so interpreting them as PC-local time could
  // make a new session appear expired immediately.
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(timestamp)) {
    timestamp = timestamp.replace(' ', 'T') + 'Z';
  }

  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : fallback;
}

class CmsClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.serverURL = normalizeServerUrl(options.serverURL);
    this.fetch = options.fetch || globalThis.fetch;
    if (typeof this.fetch !== 'function') throw new Error('A fetch implementation is required');
    this.heartbeatIntervalMs = options.heartbeatIntervalMs || 10000;
    this.retryDelaysMs = options.retryDelaysMs || [2000, 5000, 10000, 15000, 30000];
    this.requestTimeoutMs = options.requestTimeoutMs || 8000;
    this.timer = null;
    this.heartbeatPromise = null;
    this.running = false;
    this.failureCount = 0;
    this.token = '';
    this.metadata = {};
    this.status = 'offline';
  }

  async register(payload) {
    return this.#request('/api/player/register', {
      method: 'POST',
      body: payload
    });
  }

  async operatorLogin(email, password) {
    return this.#request('/api/auth/login', {
      method: 'POST',
      body: { email, password }
    });
  }

  async operatorLogout(token) {
    return this.#request('/api/auth/logout', { method: 'POST', token, body: {} });
  }

  async availableDevices(operatorToken) {
    return this.#request('/api/operator/devices/available', {
      method: 'GET', token: operatorToken
    });
  }

  async authorizeDeviceControl(operatorToken, deviceId) {
    return this.#request(`/api/operator/devices/${encodeURIComponent(deviceId)}/control-access`, {
      method: 'POST', token: operatorToken, body: {}
    });
  }

  async claim(operatorToken, payload) {
    return this.#request('/api/player/claim', {
      method: 'POST', token: operatorToken, body: payload
    });
  }

  async syncAssets(token, payload) {
    return this.#request('/api/player/assets/sync', {
      method: 'POST', token, body: payload
    });
  }

  async assignedAssets(token) {
    const assets = await this.#request('/api/player/assets/assigned', { method: 'GET', token });
    return (Array.isArray(assets) ? assets : []).map(asset => ({
      id: String(asset.id || ''),
      filename: String(asset.filename || ''),
      downloadUrl: new URL(String(asset.download_url || ''), `${this.serverURL}/`).toString(),
      size: Number(asset.size),
      sha256: String(asset.sha256 || '').toLowerCase(),
      mimeType: String(asset.mime_type || 'application/octet-stream'),
      durationMs: Math.max(0, Number(asset.duration_ms) || 0),
      revision: Math.max(0, Number(asset.revision) || 0)
    }));
  }

  async pendingAssetRemovals(token) {
    const removals = await this.#request('/api/player/assets/removals', { method: 'GET', token });
    return (Array.isArray(removals) ? removals : []).map(asset => ({
      id: String(asset.id || ''), filename: String(asset.filename || '')
    })).filter(asset => asset.id && asset.filename);
  }

  async acknowledgeAssetRemoval(token, assetId) {
    return this.#request(`/api/player/assets/${encodeURIComponent(assetId)}/removed`, {
      method: 'POST', token, body: {}
    });
  }

  start(token, metadata = {}) {
    this.stop();
    this.running = true;
    this.token = token;
    this.metadata = { ...metadata };
    this.failureCount = 0;
    this.#setStatus('connecting');
    void this.#heartbeat().catch(() => {});
  }

  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async heartbeatNow() {
    if (!this.running) {
      throw new CmsApiError('CMS connection is not running.', { code: 'cms_not_running' });
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    return this.#heartbeat();
  }

  async #heartbeat() {
    if (!this.running) return;
    if (this.heartbeatPromise) return this.heartbeatPromise;
    this.heartbeatPromise = this.#performHeartbeat();
    try {
      return await this.heartbeatPromise;
    } finally {
      this.heartbeatPromise = null;
    }
  }

  async #performHeartbeat() {
    if (!this.running) return;
    try {
      const data = await this.#request('/api/player/heartbeat', {
        method: 'POST',
        token: this.token,
        body: this.metadata
      });
      this.failureCount = 0;
      this.#setStatus('online');
      this.emit('heartbeat', data);
      this.#schedule(this.heartbeatIntervalMs);
      return data;
    } catch (error) {
      if (!this.running) return;
      if (error instanceof CmsApiError && error.status === 401) {
        this.stop();
        this.#setStatus('authentication-error');
        this.emit('authentication-error', error);
        throw error;
      }

      const delayIndex = Math.min(this.failureCount, this.retryDelaysMs.length - 1);
      const retryDelay = this.retryDelaysMs[delayIndex];
      this.failureCount += 1;
      this.#setStatus('reconnecting');
      this.emit('connection-error', error);
      this.#schedule(retryDelay);
      throw error;
    }
  }

  #schedule(delay) {
    if (!this.running) return;
    this.timer = setTimeout(() => void this.#heartbeat().catch(() => {}), delay);
    if (this.timer.unref) this.timer.unref();
  }

  #setStatus(status) {
    if (this.status === status) return;
    this.status = status;
    this.emit('status', status);
  }

  async #request(endpoint, options) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    if (timeout.unref) timeout.unref();

    try {
      const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
      if (options.token) headers.Authorization = `Bearer ${options.token}`;
      const response = await this.fetch(this.serverURL + endpoint, {
        method: options.method,
        headers,
        body: options.method === 'GET' ? undefined : JSON.stringify(options.body || {}),
        signal: controller.signal
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const apiError = payload && payload.error || {};
        throw new CmsApiError(apiError.message || `CMS request failed (${response.status}).`, {
          status: response.status,
          code: apiError.code
        });
      }
      return payload.data || payload;
    } catch (error) {
      if (error && error.name === 'AbortError') {
        throw new CmsApiError('CMS request timed out.', { code: 'cms_timeout' });
      }
      if (error instanceof CmsApiError) throw error;
      throw new CmsApiError(`Cannot reach CMS: ${error.message || error}`, { code: 'cms_unreachable' });
    } finally {
      clearTimeout(timeout);
    }
  }
}

module.exports = { CmsClient, CmsApiError, normalizeServerUrl, parseSessionExpiry };
