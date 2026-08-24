'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  isPlaybackAlertStatus,
  isPlaybackExpected,
  isVlcPlaybackHealthy,
  resolvePlaybackTelemetry
} = require('../playbackState.cjs');

test('idle Player is healthy even though VLC is intentionally stopped', () => {
  const vlc = { ready: false, state: 'idle', idleMode: true };
  assert.equal(isPlaybackExpected(null), false);
  assert.equal(isVlcPlaybackHealthy(vlc, null), true);
});

test('active playback requires a ready playing or paused VLC', () => {
  const active = { files: [{ path: 'film.ldg' }] };
  assert.equal(isVlcPlaybackHealthy({ ready: false, state: 'idle', idleMode: false }, active), false);
  assert.equal(isVlcPlaybackHealthy({ ready: true, state: 'playing', idleMode: false }, active), true);
  assert.equal(isVlcPlaybackHealthy({ ready: true, state: 'paused', idleMode: false }, active), true);
});

test('idle telemetry ignores a stale VLC error status', () => {
  assert.deepEqual(
    resolvePlaybackTelemetry(null, 'idle', 'vlc-error'),
    { state: 'idle', error: '' }
  );
});

test('active telemetry preserves real playback errors', () => {
  const active = { files: [{ path: 'film.ldg' }] };
  assert.deepEqual(
    resolvePlaybackTelemetry(active, 'idle', 'vlc-error'),
    { state: 'error', error: 'VLC playback is unavailable.' }
  );
  assert.equal(isPlaybackAlertStatus('vlc-recovering'), true);
});
