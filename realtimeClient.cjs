'use strict';

const { EventEmitter } = require('events');
const { io: defaultIo } = require('socket.io-client');
const { normalizeServerUrl } = require('./cmsClient.cjs');

function normalizeRealtimeHint(payload) {
  if (!payload || typeof payload !== 'object') throw new Error('Realtime message is missing.');
  if (payload.schema !== 'player-realtime.v1') throw new Error('Unsupported realtime message schema.');
  const deviceId = String(payload.deviceId || '').trim();
  if (!deviceId) throw new Error('Realtime message has no Studio ID.');
  return {
    schema: payload.schema,
    eventId: payload.eventId === null || payload.eventId === undefined ? null : Math.max(0, Number(payload.eventId) || 0),
    deviceId,
    assetRevision: Math.max(0, Number(payload.assetRevision) || 0),
    scheduleRevision: Math.max(0, Number(payload.scheduleRevision) || 0),
    reason: String(payload.reason || 'revision.changed'),
    occurredAt: String(payload.occurredAt || new Date().toISOString())
  };
}

class RealtimeClient extends EventEmitter {
  constructor({ ioFactory = defaultIo } = {}) {
    super();
    this.ioFactory = ioFactory;
    this.socket = null;
    this.options = null;
  }

  start({ url, token, deviceId }) {
    this.stop();
    const normalizedUrl = normalizeServerUrl(url);
    if (!token || !deviceId) throw new Error('Realtime credentials are incomplete.');
    this.options = { url: normalizedUrl, token: String(token), deviceId: String(deviceId) };
    this.emit('status', { status: 'connecting', connected: false, url: normalizedUrl, lastError: null });
    const socket = this.ioFactory(`${normalizedUrl}/player`, {
      auth: { token: String(token), deviceId: String(deviceId) },
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 2000,
      reconnectionDelayMax: 15000,
      timeout: 10000
    });
    this.socket = socket;
    socket.on('connect', () => this.emit('status', {
      status: 'connected', connected: true, url: normalizedUrl,
      lastConnectedAt: new Date().toISOString(), lastError: null
    }));
    socket.on('disconnect', reason => this.emit('status', {
      status: reason === 'io server disconnect' ? 'fallback' : 'reconnecting',
      connected: false, url: normalizedUrl, lastError: String(reason || 'disconnected')
    }));
    socket.on('connect_error', error => this.emit('connect-error', error));
    socket.on('sync:initial', payload => this.#emitHint(payload));
    socket.on('sync:hint', payload => this.#emitHint(payload));
    socket.on('device:revoked', payload => this.emit('revoked', payload || {}));
    socket.on('session:replaced', payload => this.emit('session-replaced', payload || {}));
    return socket;
  }

  stop() {
    if (!this.socket) return;
    try { this.socket.removeAllListeners(); } catch (_) {}
    try { this.socket.disconnect(); } catch (_) {}
    this.socket = null;
  }

  reconnect() {
    if (this.socket && !this.socket.connected) this.socket.connect();
  }

  reportApplied({ eventId = null, assetRevision = 0, scheduleRevision = 0, ok = true, error = null } = {}) {
    if (!this.socket || !this.socket.connected) return false;
    this.socket.emit('sync:applied', {
      eventId, assetRevision: Math.max(0, Number(assetRevision) || 0),
      scheduleRevision: Math.max(0, Number(scheduleRevision) || 0),
      ok: Boolean(ok), error: error ? String(error) : null,
      appliedAt: new Date().toISOString()
    });
    return true;
  }

  #emitHint(payload) {
    try {
      this.emit('hint', normalizeRealtimeHint(payload));
    } catch (error) {
      this.emit('message-error', error);
    }
  }
}

module.exports = { RealtimeClient, normalizeRealtimeHint };
