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
      title: 'Catalog Promo',
      filename: 'promo.mp4',
      relativePath: 'Catalog-Promo--12345678/12345678-1234-4234-8234-1234567890ab-r1.ldg',
      downloadUrl: 'https://example.test/promo.mp4',
      size: 12,
      sha256: 'a'.repeat(64)
    }]
  });
  assert.equal(payload.revision, 7);
  assert.equal(payload.schedules[0].playlist[0].assetId, 'asset-1');
  assert.equal(payload.assets[0].sha256.length, 64);
  assert.equal(payload.assets[0].title, 'Catalog Promo');
  assert.equal(payload.assets[0].relativePath, 'Catalog-Promo--12345678/12345678-1234-4234-8234-1234567890ab-r1.ldg');
});

test('managed asset paths reject traversal and absolute paths', () => {
  for (const relativePath of ['../outside.ldg', 'Film/../../outside.ldg', 'C:\\outside.ldg', '/outside.ldg']) {
    assert.throws(() => normalizeSyncPayload({ assets: [{
      id: 'unsafe-asset', filename: 'film.ldg', relativePath,
      downloadUrl: 'https://example.test/film', size: 12, sha256: 'a'.repeat(64)
    }] }), ContractError);
  }
});

test('multi-item playlists preserve their explicit playback order', () => {
  const result = normalizeSchedule({
    id: 'playlist-1',
    startTime: '2026-08-01T10:00:00+07:00',
    endTime: '2026-08-01T12:00:00+07:00',
    playlist: [
      { path: 'D:\\media\\closing.mp4', title: 'Closing', order: 2 },
      { assetId: 'asset-opening', title: 'Opening', order: 0 },
      { path: 'D:\\media\\feature.mp4', title: 'Feature', order: 1 }
    ]
  });

  assert.deepEqual(
    result.playlist.map(item => item.title),
    ['Opening', 'Feature', 'Closing']
  );
  assert.deepEqual(
    result.files.map(item => item.order),
    [0, 1, 2]
  );
});

test('playlist film gap is normalized and old payloads default to zero', () => {
  const normalized = normalizeSchedule({
    id: 'gap-contract',
    startTime: '2026-08-01T10:00:00+07:00',
    endTime: '2026-08-01T11:00:00+07:00',
    playlist: [
    { mediaKey: 'local:first', durationMs: 60000, gapAfterMs: 10000 },
    { mediaKey: 'local:second', durationMs: 120000 }
    ]
  });
  assert.equal(normalized.playlist[0].gapAfterMs, 10000);
  assert.equal(normalized.playlist[1].gapAfterMs, 0);
  assert.equal(normalized.files[0].gapAfterMs, 10000);
  assert.equal(normalized.files[1].gapAfterMs, 0);
});

test('playlist film start offset is preserved and old payloads default to zero', () => {
  const normalized = normalizeSchedule({
    id: 'start-offset-contract',
    startTime: '2026-08-01T10:00:00+07:00',
    endTime: '2026-08-01T11:00:00+07:00',
    playlist: [
      { mediaKey: 'local:first', durationMs: 60000, startOffsetMs: 120000 },
      { mediaKey: 'local:second', durationMs: 120000 }
    ]
  });
  assert.equal(normalized.playlist[0].startOffsetMs, 120000);
  assert.equal(normalized.playlist[1].startOffsetMs, 0);
  assert.equal(normalized.files[0].startOffsetMs, 120000);
  assert.equal(normalized.files[1].startOffsetMs, 0);
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

test('CMS playlist items may reference local Player media by media key', () => {
  const payload = normalizeSyncPayload({ revision: 4, schedules: [{
    id: 'cms-schedule', title: 'Local playlist',
    startTime: '2026-08-12T10:00:00+07:00', endTime: '2026-08-12T10:01:00+07:00',
    playlist: [{ mediaKey: `local:${'a'.repeat(64)}`, title: 'Local film', durationMs: 60000 }]
  }] });
  assert.equal(payload.schedules[0].playlist[0].mediaKey, `local:${'a'.repeat(64)}`);
  assert.equal(payload.schedules[0].playlist[0].durationMs, 60000);
});

test('recurrence keeps an offset-aware inclusive end timestamp', () => {
  const result = normalizeSchedule({
    id: 'daily-until',
    startTime: '2026-08-18T10:00:00+07:00',
    endTime: '2026-08-18T11:00:00+07:00',
    recurrence: { freq: 'daily', daysOfWeek: [], until: '2026-08-31T23:59:59+07:00' },
    playlist: [{ mediaKey: `local:${'a'.repeat(64)}` }]
  });
  assert.equal(result.recurrence.until, '2026-08-31T23:59:59+07:00');
});
