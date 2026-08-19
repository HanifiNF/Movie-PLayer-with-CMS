'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  Scheduler,
  nextOccurrenceStart,
  selectActiveOccurrence
} = require('../scheduler.cjs');

function schedule(overrides = {}) {
  return {
    id: 'daily',
    title: 'Daily schedule',
    startTime: '2025-01-01T10:00:00+07:00',
    endTime: '2025-01-01T11:00:00+07:00',
    recurrence: { freq: 'daily', daysOfWeek: [] },
    priority: 0,
    files: [{ path: 'C:\\media\\video.mp4' }],
    ...overrides
  };
}

test('daily recurrence advances to the current date instead of one day after its anchor', () => {
  const occurrence = nextOccurrenceStart(
    schedule(),
    new Date('2026-07-30T02:00:00.000Z')
  );
  assert.equal(occurrence.start.toISOString(), '2026-07-30T03:00:00.000Z');
  assert.equal(occurrence.alreadyActive, false);
});

test('daily recurrence recognizes the occurrence currently in progress', () => {
  const occurrence = nextOccurrenceStart(
    schedule(),
    new Date('2026-07-30T03:30:00.000Z')
  );
  assert.equal(occurrence.start.toISOString(), '2026-07-30T03:00:00.000Z');
  assert.equal(occurrence.alreadyActive, true);
});

test('weekly recurrence recognizes an active configured weekday', () => {
  const occurrence = nextOccurrenceStart(
    schedule({
      id: 'weekly',
      recurrence: { freq: 'weekly', daysOfWeek: [4] }
    }),
    new Date('2026-07-30T03:30:00.000Z')
  );
  assert.equal(occurrence.start.toISOString(), '2026-07-30T03:00:00.000Z');
  assert.equal(occurrence.alreadyActive, true);
});

test('daily recurrence stops after its inclusive end date', () => {
  const recurring = schedule({
    startTime: '2026-08-01T10:00:00+07:00',
    endTime: '2026-08-01T11:00:00+07:00',
    recurrence: { freq: 'daily', daysOfWeek: [], until: '2026-08-03T23:59:59+07:00' }
  });
  assert.equal(nextOccurrenceStart(recurring, new Date('2026-08-04T00:00:00+07:00')), null);
  const last = nextOccurrenceStart(recurring, new Date('2026-08-03T09:00:00+07:00'));
  assert.equal(last.start.toISOString(), '2026-08-03T03:00:00.000Z');
});

test('one-shot schedules expire after their end time', () => {
  const occurrence = nextOccurrenceStart(
    schedule({
      recurrence: null,
      startTime: '2026-07-30T10:00:00+07:00',
      endTime: '2026-07-30T11:00:00+07:00'
    }),
    new Date('2026-07-30T05:00:00.000Z')
  );
  assert.equal(occurrence, null);
});

test('disabled schedules never produce an occurrence', () => {
  const occurrence = nextOccurrenceStart(
    schedule({ enabled: false }),
    new Date('2026-07-30T03:30:00.000Z')
  );
  assert.equal(occurrence, null);
});

test('overlap resolution selects priority, then latest start time', () => {
  const now = new Date('2026-07-30T03:45:00.000Z');
  const winner = selectActiveOccurrence([
    schedule({ id: 'normal', priority: 0 }),
    schedule({
      id: 'emergency',
      priority: 100,
      startTime: '2025-01-01T10:30:00+07:00',
      endTime: '2025-01-01T11:30:00+07:00'
    })
  ], now);
  assert.equal(winner.schedule.id, 'emergency');
});

test('scheduler sends every playlist item to VLC in order', () => {
  let received = null;
  const vlc = {
    replacePlaylist(files, options) {
      received = { files, options };
    },
    playIdle() {},
    clear() {}
  };
  const scheduler = new Scheduler(vlc);
  const active = schedule({
    id: 'playlist',
    loop: false,
    files: [
      { path: 'C:\\media\\opening.mp4' },
      { localPath: 'C:\\media\\feature.mp4' },
      { path: 'C:\\media\\closing.mp4' }
    ]
  });

  scheduler.schedules = [active];
  scheduler._activate(active, new Date(active.startTime), 3600000);
  scheduler.clear();

  assert.deepEqual(received, {
    files: [
      'C:\\media\\opening.mp4',
      'C:\\media\\feature.mp4',
      'C:\\media\\closing.mp4'
    ],
    options: { loop: false }
  });
});

test('scheduler skips unavailable media and exposes the actual playback playlist', () => {
  let received = null;
  let unavailable = null;
  const vlc = {
    replacePlaylist(files) { received = files; },
    playIdle() {},
    clear() {}
  };
  const scheduler = new Scheduler(vlc, {
    isMediaReady: file => !file.path.includes('missing')
  });
  scheduler.on('media-unavailable', event => { unavailable = event.files; });
  const active = schedule({
    id: 'health-filter',
    files: [
      { title: 'Ready', path: 'C:\\media\\ready.mp4' },
      { title: 'Missing', path: 'C:\\media\\missing.mp4' }
    ]
  });

  scheduler.schedules = [active];
  scheduler._activate(active, new Date(active.startTime), 3600000);

  assert.deepEqual(received, ['C:\\media\\ready.mp4']);
  assert.deepEqual(scheduler.getNow().files.map(file => file.title), ['Ready']);
  assert.deepEqual(unavailable.map(file => file.title), ['Missing']);
  scheduler.clear();
});
