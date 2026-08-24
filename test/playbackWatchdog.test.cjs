'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { PlaybackWatchdog } = require('../playbackWatchdog.cjs');

test('watchdog recovers only after consecutive active-playback failures', async () => {
  let expected = false;
  let healthy = false;
  let recoveries = 0;
  const watchdog = new PlaybackWatchdog({
    failureThreshold: 2,
    isPlaybackExpected: () => expected,
    isHealthy: () => healthy,
    recover: async () => {
      recoveries += 1;
      healthy = true;
    }
  });

  await watchdog.check();
  assert.equal(recoveries, 0, 'idle VLC must not be restarted');

  expected = true;
  await watchdog.check();
  assert.equal(watchdog.getStatus().state, 'degraded');
  assert.equal(recoveries, 0);

  await watchdog.check();
  assert.equal(recoveries, 1);
  assert.equal(watchdog.getStatus().state, 'healthy');
  assert.equal(watchdog.getStatus().attempts, 0);
});

test('watchdog applies backoff and stops at the configured retry limit', async () => {
  let now = 1000;
  let recoveries = 0;
  const watchdog = new PlaybackWatchdog({
    failureThreshold: 1,
    maxAttempts: 3,
    backoffMs: [100, 200, 400],
    now: () => now,
    isPlaybackExpected: () => true,
    isHealthy: () => false,
    recover: async () => {
      recoveries += 1;
      throw new Error('simulated VLC failure');
    }
  });

  await watchdog.check();
  assert.equal(recoveries, 1);
  assert.equal(watchdog.getStatus().nextRetryAt, 1100);

  await watchdog.check();
  assert.equal(recoveries, 1, 'retry must wait for its backoff deadline');

  now = 1100;
  await watchdog.check();
  assert.equal(recoveries, 2);
  assert.equal(watchdog.getStatus().nextRetryAt, 1300);

  now = 1300;
  await watchdog.check();
  assert.equal(recoveries, 3);
  assert.equal(watchdog.getStatus().state, 'exhausted');

  now = 10000;
  await watchdog.check();
  assert.equal(recoveries, 3, 'exhausted watchdog must require a manual retry');
});

test('manual retry resets an exhausted watchdog', async () => {
  let healthy = false;
  const watchdog = new PlaybackWatchdog({
    failureThreshold: 1,
    maxAttempts: 1,
    isPlaybackExpected: () => true,
    isHealthy: () => healthy,
    recover: async () => { healthy = true; }
  });
  watchdog.attempts = 1;
  watchdog.state = 'exhausted';

  const result = await watchdog.recoverNow();
  assert.equal(result.state, 'healthy');
  assert.equal(watchdog.getStatus().attempts, 0);
});

test('manual retry is a no-op while Player is in standby', async () => {
  let recoveries = 0;
  const watchdog = new PlaybackWatchdog({
    isPlaybackExpected: () => false,
    isHealthy: () => true,
    recover: async () => { recoveries += 1; }
  });
  watchdog.attempts = 2;
  watchdog.state = 'exhausted';

  const result = await watchdog.recoverNow();

  assert.equal(result.state, 'idle');
  assert.equal(result.attempts, 0);
  assert.equal(recoveries, 0);
});
