'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('events');
const { RealtimeClient, normalizeRealtimeHint } = require('../realtimeClient.cjs');

class FakeSocket extends EventEmitter {
  constructor() { super(); this.connected = false; this.sent = []; }
  connect() { this.connected = true; }
  disconnect() { this.connected = false; }
  emit(name, ...args) {
    if (name === 'sync:applied') this.sent.push(args[0]);
    return super.emit(name, ...args);
  }
}

test('normalizes the revision-only gateway contract', () => {
  assert.deepEqual(normalizeRealtimeHint({
    schema: 'player-realtime.v1', eventId: 12, deviceId: 'studio-1',
    assetRevision: 4, scheduleRevision: 8, reason: 'schedule.changed', occurredAt: '2026-08-24T00:00:00Z'
  }), {
    schema: 'player-realtime.v1', eventId: 12, deviceId: 'studio-1',
    assetRevision: 4, scheduleRevision: 8, reason: 'schedule.changed', occurredAt: '2026-08-24T00:00:00Z'
  });
  assert.throws(() => normalizeRealtimeHint({ schema: 'legacy', deviceId: 'studio-1' }), /Unsupported/);
});

test('authenticates with token and Studio ID and forwards gateway events', () => {
  const socket = new FakeSocket();
  let target = null;
  let options = null;
  const client = new RealtimeClient({ ioFactory: (url, config) => { target = url; options = config; return socket; } });
  const hints = [];
  client.on('hint', hint => hints.push(hint));
  client.start({ url: 'http://localhost:3001/', token: 'x'.repeat(64), deviceId: 'studio-1' });
  assert.equal(target, 'http://localhost:3001/player');
  assert.deepEqual(options.auth, { token: 'x'.repeat(64), deviceId: 'studio-1' });

  socket.emit('sync:hint', {
    schema: 'player-realtime.v1', eventId: 3, deviceId: 'studio-1',
    assetRevision: 2, scheduleRevision: 5
  });
  assert.equal(hints[0].scheduleRevision, 5);

  socket.connected = true;
  assert.equal(client.reportApplied({ eventId: 3, assetRevision: 2, scheduleRevision: 5 }), true);
  assert.equal(socket.sent[0].eventId, 3);
  assert.equal(socket.sent[0].scheduleRevision, 5);
});

test('surfaces revoke and replacement events without treating them as schedule payloads', () => {
  const socket = new FakeSocket();
  const client = new RealtimeClient({ ioFactory: () => socket });
  let revoked = 0;
  let replaced = 0;
  client.on('revoked', () => { revoked += 1; });
  client.on('session-replaced', () => { replaced += 1; });
  client.start({ url: 'https://realtime.example.com', token: 'x'.repeat(64), deviceId: 'studio-1' });
  socket.emit('device:revoked', {});
  socket.emit('session:replaced', {});
  assert.equal(revoked, 1);
  assert.equal(replaced, 1);
});
