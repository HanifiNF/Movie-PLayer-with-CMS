'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  ContractError,
  normalizeSchedule,
  normalizeSyncPayload
} = require('../contracts.cjs');

test('legacy files[].path schedules remain compatible', () => {
  const result = normalizeSchedule({
    id: 'legacy-1',
    startTime: '2026-08-01T10:00:00+07:00',
    endTime: '2026-08-01T11:00:00+07:00',
    files: [{ path: 'D:\\media\\promo.mp4' }]
  });
  assert.equal(result.files[0].path, 'D:\\media\\promo.mp4');
  assert.equal(result.startTime, '2026-08-01T10:00:00+07:00');
  assert.equal(result.enabled, true);
});

test('disabled state is preserved by schedule normalization', () => {
  const result = normalizeSchedule({
    id: 'disabled-1',
    enabled: false,
    startTime: '2026-08-01T10:00:00+07:00',
    endTime: '2026-08-01T11:00:00+07:00',
    files: [{ path: 'D:\\media\\promo.mp4' }]
  });
  assert.equal(result.enabled, false);
});

test('canonical payload accepts asset references and catalog metadata', () => {
  const payload = normalizeSyncPayload({
    revision: 7,
    schedules: [{
      id: 'schedule-1',
      startAt: '2026-08-01T10:00:00+07:00',
      endAt: '2026-08-01T11:00:00+07:00',
      priority: 10,
      playlist: [{ assetId: 'asset-1', order: 0 }]
    }],
    assets: [{
      id: 'asset-1',
      filename: 'promo.mp4',
      downloadUrl: 'https://example.test/promo.mp4',
      size: 12,
      sha256: 'a'.repeat(64)
    }]
  });
  assert.equal(payload.revision, 7);
  assert.equal(payload.schedules[0].playlist[0].assetId, 'asset-1');
  assert.equal(payload.assets[0].sha256.length, 64);
});

test('invalid payload is rejected before reaching the scheduler', () => {
  assert.throws(() => normalizeSyncPayload({
    schedules: [{
      id: 'broken',
      startAt: '2026-08-01T10:00:00',
      endAt: '2026-08-01T09:00:00+07:00',
      playlist: []
    }]
  }), ContractError);
});
