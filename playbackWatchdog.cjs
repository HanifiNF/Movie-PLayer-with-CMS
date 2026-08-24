'use strict';

const { EventEmitter } = require('events');

class PlaybackWatchdog extends EventEmitter {
  constructor(options = {}) {
    super();
    this.isPlaybackExpected = options.isPlaybackExpected || (() => false);
    this.isHealthy = options.isHealthy || (() => true);
    this.recover = options.recover || (async () => {});
    this.intervalMs = Math.max(250, Number(options.intervalMs) || 3000);
    this.failureThreshold = Math.max(1, Number(options.failureThreshold) || 2);
    this.maxAttempts = Math.max(1, Number(options.maxAttempts) || 5);
    this.backoffMs = Array.isArray(options.backoffMs) && options.backoffMs.length
      ? options.backoffMs.map(value => Math.max(0, Number(value) || 0))
      : [0, 2000, 5000, 15000, 30000];
    this.now = options.now || (() => Date.now());
    this.timer = null;
    this.inFlight = null;
    this.state = 'idle';
    this.attempts = 0;
    this.consecutiveFailures = 0;
    this.nextRetryAt = null;
    this.lastError = null;
    this.lastRecoveredAt = null;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.check().catch(error => this.emit('internal-error', error));
    }, this.intervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  reset() {
    this.attempts = 0;
    this.consecutiveFailures = 0;
    this.nextRetryAt = null;
    this.lastError = null;
    this._setState('idle');
  }

  getStatus() {
    return {
      state: this.state,
      attempts: this.attempts,
      maxAttempts: this.maxAttempts,
      consecutiveFailures: this.consecutiveFailures,
      nextRetryAt: this.nextRetryAt,
      lastError: this.lastError,
      lastRecoveredAt: this.lastRecoveredAt
    };
  }

  async check() {
    if (this.inFlight) return this.inFlight;
    if (!this.isPlaybackExpected()) {
      if (this.state !== 'idle' || this.attempts || this.consecutiveFailures) this.reset();
      return this.getStatus();
    }

    if (this.isHealthy()) {
      const wasRecovering = this.attempts > 0 || ['degraded', 'waiting', 'recovering'].includes(this.state);
      this.attempts = 0;
      this.consecutiveFailures = 0;
      this.nextRetryAt = null;
      this.lastError = null;
      this._setState('healthy');
      if (wasRecovering) {
        this.lastRecoveredAt = new Date(this.now()).toISOString();
        this.emit('recovered', this.getStatus());
      }
      return this.getStatus();
    }

    this.consecutiveFailures += 1;
    if (this.consecutiveFailures < this.failureThreshold) {
      this._setState('degraded');
      return this.getStatus();
    }
    if (this.attempts >= this.maxAttempts) {
      this._setState('exhausted');
      return this.getStatus();
    }
    if (this.nextRetryAt && this.now() < this.nextRetryAt) {
      this._setState('waiting');
      return this.getStatus();
    }
    return this._attemptRecovery();
  }

  async recoverNow() {
    if (this.inFlight) return this.inFlight;
    if (!this.isPlaybackExpected()) {
      this.reset();
      return this.getStatus();
    }
    this.attempts = 0;
    this.consecutiveFailures = this.failureThreshold;
    this.nextRetryAt = null;
    return this._attemptRecovery();
  }

  _attemptRecovery() {
    this.attempts += 1;
    const attempt = this.attempts;
    this._setState('recovering');
    this.emit('attempt', { attempt, maxAttempts: this.maxAttempts });
    this.inFlight = Promise.resolve()
      .then(() => this.recover({ attempt, maxAttempts: this.maxAttempts }))
      .then(() => {
        if (!this.isHealthy()) throw new Error('Playback is still unhealthy after recovery');
        this.consecutiveFailures = 0;
        this.nextRetryAt = null;
        this.lastError = null;
        this.lastRecoveredAt = new Date(this.now()).toISOString();
        this._setState('healthy');
        this.emit('recovered', this.getStatus());
        this.attempts = 0;
        return this.getStatus();
      })
      .catch(error => {
        this.lastError = error && error.message ? error.message : String(error);
        if (this.attempts >= this.maxAttempts) {
          this.nextRetryAt = null;
          this._setState('exhausted');
          this.emit('exhausted', this.getStatus());
        } else {
          const delayIndex = Math.min(this.attempts - 1, this.backoffMs.length - 1);
          this.nextRetryAt = this.now() + this.backoffMs[delayIndex];
          this._setState('waiting');
          this.emit('failed-attempt', this.getStatus());
        }
        return this.getStatus();
      })
      .finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  _setState(next) {
    if (this.state === next) return;
    this.state = next;
    this.emit('state-change', this.getStatus());
  }
}

module.exports = { PlaybackWatchdog };
