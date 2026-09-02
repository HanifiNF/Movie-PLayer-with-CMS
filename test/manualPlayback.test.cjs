'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ManualPlaybackSession,
  manualPlaybackAvailability,
  normalizeManualRange
} = require('../manualPlayback.cjs');

test('manual playback is allowed only in standby or terminal schedule failure', () => {
  assert.equal(manualPlaybackAvailability(null).allowed, true);
  assert.equal(manualPlaybackAvailability({ phase: 'media', files: [] }).reason, 'no-playable-media');
  assert.equal(manualPlaybackAvailability({ phase: 'media', files: [{}] }, { state: 'exhausted' }).allowed, true);
  assert.equal(manualPlaybackAvailability({ phase: 'gap', files: [] }, { state: 'exhausted' }).allowed, false);
  assert.equal(manualPlaybackAvailability({ phase: 'media', files: [{}] }, { state: 'recovering' }).allowed, false);
  assert.equal(manualPlaybackAvailability({ phase: 'media', files: [{}] }, { state: 'healthy' }).allowed, false);
});

test('manual playback range is bounded by the probed duration', () => {
  assert.deepEqual(normalizeManualRange({ startSeconds: 60, endSeconds: 120 }, 180000), {
    startSeconds: 60, endSeconds: 120, durationSeconds: 180
  });
  assert.deepEqual(normalizeManualRange({ startSeconds: 0, endSeconds: '' }, 180000).endSeconds, 180);
  assert.throws(() => normalizeManualRange({ startSeconds: 60, endSeconds: 60 }, 180000), /must be after/);
  assert.throws(() => normalizeManualRange({ startSeconds: 0, endSeconds: 181 }, 180000), /cannot exceed/);
});

test('manual session stops once playback reaches its configured end position', async () => {
  const reasons = [];
  const session = new ManualPlaybackSession({ stopPlayback: async reason => reasons.push(reason) });
  session.begin({ mediaId: 'one', title: 'Film', startSeconds: 10, endSeconds: 20, durationSeconds: 30 });
  session.handleProgress({ positionSeconds: 19 });
  assert.equal(session.getStatus().active, true);
  session.handleProgress({ positionSeconds: 20 });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(reasons, ['end-position-reached']);
  assert.equal(session.getStatus().active, false);
});
