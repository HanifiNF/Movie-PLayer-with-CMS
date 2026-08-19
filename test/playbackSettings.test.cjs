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
    outputMode: 'floating',
    resolution: 'custom',
    customWidth: 20,
    customHeight: 9000,
    scaling: 'unknown',
    hideVlcUi: false
  }), {
    displayId: '22',
    outputMode: 'fullscreen',
    resolution: 'custom',
    customWidth: 1920,
    customHeight: 1080,
    scaling: 'fit',
    hideVlcUi: false
  });
});

test('output size resolves native, preset, and custom resolutions', () => {
  const display = { bounds: { width: 2560, height: 1440 } };
  assert.deepEqual(resolveOutputSize({ resolution: 'native' }, display), { width: 2560, height: 1440 });
  assert.deepEqual(resolveOutputSize({ resolution: '720p' }, display), { width: 1280, height: 720 });
  assert.deepEqual(resolveOutputSize({ resolution: 'custom', customWidth: 1600, customHeight: 900 }, display), { width: 1600, height: 900 });
});
