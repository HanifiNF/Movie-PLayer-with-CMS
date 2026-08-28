'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  DEFAULT_PLAYBACK_SETTINGS,
  normalizePlaybackSettings,
  resolveOutputSize
} = require('../playbackSettings.cjs');

test('playback settings default to production-safe hidden fullscreen output', () => {
  assert.deepEqual(normalizePlaybackSettings({}), DEFAULT_PLAYBACK_SETTINGS);
});

test('playback settings reject unsupported values and bound custom sizes', () => {
  assert.deepEqual(normalizePlaybackSettings({
    displayId: 22,
    idleDisplayId: 33,
    outputMode: 'floating',
    resolution: 'custom',
    customWidth: 20,
    customHeight: 9000,
    scaling: 'unknown',
    audioDeviceId: 'speaker-id\nvolume 0',
    volumePercent: 250,
    hideVlcUi: false
  }), {
    displayId: '22',
    idleDisplayId: '33',
    outputMode: 'fullscreen',
    resolution: 'custom',
    customWidth: 1920,
    customHeight: 1080,
    scaling: 'fit',
    audioDeviceId: 'speaker-idvolume 0',
    volumePercent: 100,
    hideVlcUi: false
  });
});

test('audio settings support system default, a VLC device id, and safe volume bounds', () => {
  assert.equal(normalizePlaybackSettings({ audioDeviceId: 'default' }).audioDeviceId, null);
  assert.equal(normalizePlaybackSettings({ audioDeviceId: 'device-123' }).audioDeviceId, 'device-123');
  assert.equal(normalizePlaybackSettings({ volumePercent: 0 }).volumePercent, 0);
  assert.equal(normalizePlaybackSettings({ volumePercent: 75 }).volumePercent, 75);
});

test('idle monitor defaults to the scheduled film output monitor', () => {
  assert.equal(normalizePlaybackSettings({ idleDisplayId: 'same' }).idleDisplayId, null);
  assert.equal(normalizePlaybackSettings({ idleDisplayId: 44 }).idleDisplayId, '44');
});

test('output size resolves native, preset, and custom resolutions', () => {
  const display = { bounds: { width: 2560, height: 1440 } };
  assert.deepEqual(resolveOutputSize({ resolution: 'native' }, display), { width: 2560, height: 1440 });
  assert.deepEqual(resolveOutputSize({ resolution: '720p' }, display), { width: 1280, height: 720 });
  assert.deepEqual(resolveOutputSize({ resolution: 'custom', customWidth: 1600, customHeight: 900 }, display), { width: 1600, height: 900 });
});
