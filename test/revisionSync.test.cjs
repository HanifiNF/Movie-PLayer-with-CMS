'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { normalizeRevision, revisionSyncAction } = require('../revisionSync.cjs');

test('revision normalization accepts only non-negative safe integers', () => {
  assert.equal(normalizeRevision('3'), 3);
  assert.equal(normalizeRevision(-1), null);
  assert.equal(normalizeRevision('invalid'), null);
});

test('asset revision and deferred removal trigger full distribution sync', () => {
  assert.equal(revisionSyncAction({
    initialSyncNeeded: false, pendingRemovalRetry: false,
    assetRevision: 2, appliedAssetRevision: 1,
    scheduleRevision: 4, appliedScheduleRevision: 4
  }), 'assets');
  assert.equal(revisionSyncAction({
    initialSyncNeeded: false, pendingRemovalRetry: true,
    assetRevision: 2, appliedAssetRevision: 2,
    scheduleRevision: 4, appliedScheduleRevision: 4
  }), 'assets');
});

test('schedule-only revision avoids a full asset distribution sync', () => {
  assert.equal(revisionSyncAction({
    initialSyncNeeded: false, pendingRemovalRetry: false,
    assetRevision: 2, appliedAssetRevision: 2,
    scheduleRevision: 5, appliedScheduleRevision: 4
  }), 'schedules');
  assert.equal(revisionSyncAction({
    initialSyncNeeded: false, pendingRemovalRetry: false,
    assetRevision: 2, appliedAssetRevision: 2,
    scheduleRevision: 4, appliedScheduleRevision: 4
  }), null);
});
