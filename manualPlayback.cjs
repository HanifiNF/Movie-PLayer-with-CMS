'use strict';

const { EventEmitter } = require('events');

function manualPlaybackAvailability(activeSchedule, watchdogStatus = {}) {
  if (!activeSchedule) return { allowed: true, reason: 'standby' };
  if (activeSchedule.phase === 'gap') {
    return { allowed: false, reason: 'film-gap', error: 'Manual playback is unavailable during a scheduled film gap.' };
  }
  const watchdogState = String(watchdogStatus.state || 'idle');
  if (['degraded', 'recovering', 'waiting'].includes(watchdogState)) {
    return { allowed: false, reason: 'recovering', error: 'VLC recovery is still in progress. Wait until recovery succeeds or is exhausted.' };
  }
  if (watchdogState === 'exhausted') return { allowed: true, reason: 'recovery-exhausted' };
  if (!Array.isArray(activeSchedule.files) || activeSchedule.files.length === 0) {
    return { allowed: true, reason: 'no-playable-media' };
  }
  return { allowed: false, reason: 'schedule-active', error: 'A healthy schedule is active. Manual playback cannot override it.' };
}

function normalizeManualRange(payload, durationMs) {
  const durationSeconds = Math.floor(Math.max(0, Number(durationMs) || 0) / 1000);
  if (durationSeconds <= 0) throw new Error('The asset duration is unavailable. Refresh Assets and try again.');
  const startSeconds = Math.floor(Number(payload && payload.startSeconds));
  const rawEnd = payload && payload.endSeconds;
  const endSeconds = rawEnd === '' || rawEnd == null ? durationSeconds : Math.floor(Number(rawEnd));
  if (!Number.isFinite(startSeconds) || startSeconds < 0) throw new Error('Start film at must be zero or greater.');
  if (!Number.isFinite(endSeconds) || endSeconds <= startSeconds) throw new Error('End film at must be after Start film at.');
  if (startSeconds >= durationSeconds) throw new Error('Start film at must be before the end of the asset.');
  if (endSeconds > durationSeconds) throw new Error('End film at cannot exceed the asset duration.');
  return { startSeconds, endSeconds, durationSeconds };
}

class ManualPlaybackSession extends EventEmitter {
  constructor(options = {}) {
    super();
    this.stopPlayback = options.stopPlayback || (async () => {});
    this.session = null;
    this.stopPromise = null;
  }

  getStatus() {
    return this.session ? { ...this.session } : { active: false };
  }

  begin(details) {
    this.session = {
      active: true,
      mediaId: String(details.mediaId),
      title: String(details.title || 'Untitled media'),
      startSeconds: Number(details.startSeconds),
      endSeconds: Number(details.endSeconds),
      durationSeconds: Number(details.durationSeconds),
      startedAt: new Date().toISOString(),
      reason: String(details.reason || 'standby')
    };
    this.emit('change', this.getStatus());
    return this.getStatus();
  }

  handleProgress(playback) {
    if (!this.session || this.stopPromise) return;
    const position = Number(playback && playback.positionSeconds);
    if (Number.isFinite(position) && position >= this.session.endSeconds) {
      void this.stop('end-position-reached');
    }
  }

  preempt(reason = 'schedule-started') {
    if (!this.session) return false;
    this.session = null;
    this.emit('change', { active: false, stoppedReason: reason });
    return true;
  }

  stop(reason = 'operator-stop') {
    if (!this.session) return Promise.resolve({ active: false });
    if (this.stopPromise) return this.stopPromise;
    this.session = null;
    this.emit('change', { active: false, stoppedReason: reason });
    this.stopPromise = Promise.resolve()
      .then(() => this.stopPlayback(reason))
      .then(() => ({ active: false, stoppedReason: reason }))
      .finally(() => { this.stopPromise = null; });
    return this.stopPromise;
  }
}

module.exports = { ManualPlaybackSession, manualPlaybackAvailability, normalizeManualRange };
