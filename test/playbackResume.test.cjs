'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { resolveResumeTarget } = require('../playbackResume.cjs');

const active = {
  scheduleId: 'schedule-1',
  startTime: '2026-08-03T10:00:00.000Z',
  files: [
    { title: 'Film A', path: 'C:\\media\\a.mp4' },
    { title: 'Film B', path: 'C:\\media\\b.mp4' }
  ]
};

test('resume target preserves the active item and last known position', () => {
  const result = resolveResumeTarget({
    scheduleId: 'schedule-1',
    occurrenceStart: '2026-08-03T10:00:00.000Z',
    currentIndex: 1,
    positionSeconds: 42,
    lengthSeconds: 120
  }, active);

  assert.deepEqual(result, {
    currentIndex: 1,
    positionSeconds: 42,
    file: active.files[1]
  });
});

test('resume target rejects checkpoints from another occurrence', () => {
  const result = resolveResumeTarget({
    scheduleId: 'schedule-1',
    occurrenceStart: '2026-08-02T10:00:00.000Z',
    currentIndex: 1,
    positionSeconds: 42,
    lengthSeconds: 120
  }, active);
  assert.equal(result, null);
});

test('resume position is clamped before the end of the media', () => {
  const result = resolveResumeTarget({
    scheduleId: 'schedule-1',
    occurrenceStart: '2026-08-03T10:00:00.000Z',
    currentIndex: 0,
    positionSeconds: 150,
    lengthSeconds: 120
  }, active);
  assert.equal(result.positionSeconds, 119);
});
