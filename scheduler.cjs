'use strict';

const { EventEmitter } = require('events');

const MS = { day: 86400000, second: 1000 };

function getZonedParts(date, offsetMinutes) {
  const shifted = new Date(date.getTime() + offsetMinutes * 60000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
    weekday: shifted.getUTCDay() || 7
  };
}

function buildDateAt(year, month, day, hour, minute, second, offsetMinutes) {
  return new Date(Date.UTC(year, month, day, hour, minute, second) - offsetMinutes * 60000);
}

function parseOffsetMinutes(iso) {
  if (/Z$/i.test(String(iso))) return 0;
  const match = /([+-])(\d{2}):?(\d{2})$/.exec(String(iso));
  if (!match) return -new Date(iso).getTimezoneOffset();
  const sign = match[1] === '-' ? -1 : 1;
  return sign * (parseInt(match[2], 10) * 60 + parseInt(match[3], 10));
}

function getDuration(sched, first) {
  if (!sched.endTime) return 0;
  const end = new Date(sched.endTime);
  if (Number.isNaN(end.getTime())) return 0;
  return Math.max(0, end.getTime() - first.getTime());
}

function occurrenceForDay(day, startParts, offset, duration, nowMs, firstMs, untilMs = null) {
  const start = buildDateAt(
    day.year,
    day.month,
    day.day,
    startParts.hour,
    startParts.minute,
    startParts.second,
    offset
  );
  const startMs = start.getTime();
  if (startMs < firstMs) return null;
  if (untilMs != null && startMs > untilMs) return null;
  if (startMs <= nowMs && duration > 0 && nowMs < startMs + duration) {
    return { start, duration, alreadyActive: true };
  }
  if (startMs > nowMs) return { start, duration, alreadyActive: false };
  return null;
}

/**
 * Returns the active occurrence at `now`, or the next future occurrence.
 * Recurrence uses the fixed UTC offset encoded in startTime, so the result is
 * independent from the Windows timezone configured on the player.
 */
function nextOccurrenceStart(sched, now = new Date()) {
  if (!sched || sched.enabled === false || !sched.startTime) return null;
  const first = new Date(sched.startTime);
  if (Number.isNaN(first.getTime())) return null;

  const duration = getDuration(sched, first);
  const recurrence = sched.recurrence;
  const nowMs = now.getTime();

  if (!recurrence || !recurrence.freq) {
    if (nowMs < first.getTime()) return { start: first, duration, alreadyActive: false };
    if (duration > 0 && nowMs < first.getTime() + duration) {
      return { start: first, duration, alreadyActive: true };
    }
    return null;
  }

  const offset = parseOffsetMinutes(sched.startTime);
  const untilMs = recurrence.until ? new Date(recurrence.until).getTime() : null;
  if (untilMs != null && Number.isNaN(untilMs)) return null;
  const startParts = getZonedParts(first, offset);
  const lookbackDays = Math.max(1, Math.ceil(duration / MS.day));
  const candidates = [];

  // Search backwards first so long-running occurrences are still recognized.
  for (let delta = -lookbackDays; delta <= 14; delta++) {
    const dayDate = new Date(nowMs + delta * MS.day);
    const day = getZonedParts(dayDate, offset);

    if (recurrence.freq === 'weekly') {
      const configuredDays = Array.isArray(recurrence.daysOfWeek) && recurrence.daysOfWeek.length
        ? recurrence.daysOfWeek
        : [startParts.weekday];
      if (!configuredDays.includes(day.weekday)) continue;
    } else if (recurrence.freq !== 'daily') {
      return null;
    }

    const occurrence = occurrenceForDay(
      day,
      startParts,
      offset,
      duration,
      nowMs,
      first.getTime(),
      untilMs
    );
    if (occurrence) candidates.push(occurrence);
  }

  const active = candidates
    .filter(item => item.alreadyActive)
    .sort((a, b) => b.start.getTime() - a.start.getTime())[0];
  if (active) return active;

  return candidates
    .filter(item => !item.alreadyActive)
    .sort((a, b) => a.start.getTime() - b.start.getTime())[0] || null;
}

function compareOccurrences(a, b) {
  const priorityA = Number.isFinite(Number(a.schedule.priority)) ? Number(a.schedule.priority) : 0;
  const priorityB = Number.isFinite(Number(b.schedule.priority)) ? Number(b.schedule.priority) : 0;
  if (priorityA !== priorityB) return priorityB - priorityA;

  const startDifference = b.start.getTime() - a.start.getTime();
  if (startDifference !== 0) return startDifference;

  return String(a.schedule.id).localeCompare(String(b.schedule.id));
}

function selectActiveOccurrence(schedules, now = new Date(), isFinished = () => false) {
  const active = [];
  for (const schedule of Array.isArray(schedules) ? schedules : []) {
    const occurrence = nextOccurrenceStart(schedule, now);
    if (!occurrence || !occurrence.alreadyActive) continue;
    if (isFinished(schedule.id, occurrence.start.getTime())) continue;
    active.push({ schedule, ...occurrence });
  }
  active.sort(compareOccurrences);
  return active[0] || null;
}

function buildTimelineSegments(files, loop = false) {
  const source = Array.isArray(files) ? files : [];
  const segments = [];
  source.forEach((file, index) => {
    const durationMs = Math.max(0, Number(file.durationMs) || 0);
    if (durationMs > 0) segments.push({ phase: 'media', itemIndex: index, durationMs, file });
    const gapAfterMs = Math.max(0, Number(file.gapAfterMs) || 0);
    if (gapAfterMs > 0 && (index < source.length - 1 || loop)) {
      segments.push({ phase: 'gap', itemIndex: index, durationMs: gapAfterMs, file });
    }
  });
  return segments;
}

function resolveTimelineTarget(files, occurrenceStart, now = new Date(), loop = false) {
  const startMs = occurrenceStart instanceof Date ? occurrenceStart.getTime() : new Date(occurrenceStart).getTime();
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(nowMs)) return null;

  const segments = buildTimelineSegments(files, loop);
  const totalMs = segments.reduce((sum, segment) => sum + segment.durationMs, 0);
  const elapsedMs = Math.max(0, nowMs - startMs);
  // Sub-second startup differences do not warrant a disruptive seek.
  if (!segments.length || totalMs <= 0) return null;
  if (!loop && elapsedMs >= totalMs) return null;

  let cursorMs = loop ? elapsedMs % totalMs : elapsedMs;
  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
    const segment = segments[segmentIndex];
    if (cursorMs < segment.durationMs) {
      const playbackOffsetMs = segment.phase === 'media'
        ? Math.max(0, Number(segment.file.startOffsetMs) || 0)
        : 0;
      return {
        phase: segment.phase,
        segmentIndex,
        currentIndex: segment.itemIndex,
        positionSeconds: Math.max(0, Math.floor((playbackOffsetMs + cursorMs) / 1000)),
        playbackOffsetMs,
        segmentElapsedMs: cursorMs,
        segmentRemainingMs: Math.max(0, segment.durationMs - cursorMs),
        elapsedMs,
        cycle: totalMs > 0 ? Math.floor(elapsedMs / totalMs) : 0
      };
    }
    cursorMs -= segment.durationMs;
  }
  return null;
}

class Scheduler extends EventEmitter {
  constructor(vlc, options = {}) {
    super();
    this.vlc = vlc;
    this.schedules = [];
    this.currentScheduleId = null;
    this.currentStart = null;
    this.currentDuration = null;
    this.currentOccurrenceKey = null;
    this.currentFiles = [];
    this.currentTimelineFiles = [];
    this.currentTimeline = null;
    this.currentTimelineSegmentKey = null;
    this.tickHandle = null;
    this._idlePlaying = false;
    this._reconciling = false;
    this.finishedOccurrences = new Map();
    this.manuallySkipped = new Set();
    this.tickMs = options.tickMs || MS.second;
    this.isMediaReady = options.isMediaReady || (() => true);
    this._startTick();
  }

  _startTick() {
    if (this.tickHandle) return;
    this.tickHandle = setInterval(() => {
      this._reconcile(new Date());
      this.emit('tick');
    }, this.tickMs);
    if (this.tickHandle.unref) this.tickHandle.unref();
  }

  _stopTick() {
    if (this.tickHandle) {
      clearInterval(this.tickHandle);
      this.tickHandle = null;
    }
  }

  _occurrenceKey(schedule, startMs) {
    const mediaFingerprint = (schedule.files || [])
      .map((file, index) => [
        file.assetId || '',
        file.mediaKey || '',
        file.localPath || file.path || '',
        Number.isFinite(Number(file.order)) ? Number(file.order) : index,
        Math.max(0, Number(file.durationMs) || 0),
        Math.max(0, Number(file.startOffsetMs) || 0),
        Math.max(0, Number(file.gapAfterMs) || 0)
      ].join(':'))
      .join('|');
    return `${schedule.id}:${startMs}:${Number(schedule.revision) || 0}:${schedule.loop !== false}:${mediaFingerprint}`;
  }

  _isFinished(scheduleId, startMs) {
    const set = this.finishedOccurrences.get(scheduleId);
    return Boolean(set && set.has(startMs));
  }

  _finishOccurrence(scheduleId, startMs, manual = false) {
    if (!this.finishedOccurrences.has(scheduleId)) {
      this.finishedOccurrences.set(scheduleId, new Set());
    }
    this.finishedOccurrences.get(scheduleId).add(startMs);
    if (manual) this.manuallySkipped.add(scheduleId);
  }

  _nextUnfinishedOccurrence(schedule, now = new Date()) {
    let cursor = new Date(now);
    for (let attempt = 0; attempt < 370; attempt++) {
      const occurrence = nextOccurrenceStart(schedule, cursor);
      if (!occurrence) return null;
      const startMs = occurrence.start.getTime();
      if (!this._isFinished(schedule.id, startMs)) return occurrence;
      cursor = new Date(startMs + Math.max(occurrence.duration, 0) + 1);
    }
    return null;
  }

  update(schedules) {
    this.schedules = Array.isArray(schedules) ? schedules.slice() : [];
    const validIds = new Set(this.schedules.map(schedule => schedule.id));
    for (const id of this.finishedOccurrences.keys()) {
      if (!validIds.has(id)) this.finishedOccurrences.delete(id);
    }
    for (const id of this.manuallySkipped) {
      if (!validIds.has(id)) this.manuallySkipped.delete(id);
    }
    this._reconcile(new Date());
  }

  _reconcile(now) {
    if (this._reconciling) return;
    this._reconciling = true;
    try {
      const active = selectActiveOccurrence(
        this.schedules,
        now,
        (scheduleId, startMs) => this._isFinished(scheduleId, startMs)
      );

      if (!active) {
        if (this.currentScheduleId) {
          const previous = this.schedules.find(item => item.id === this.currentScheduleId);
          if (previous) this.emit('expire', { schedule: previous });
        }
        this._setCurrent(null, null, null);
        if (!this._idlePlaying) {
          this._idlePlaying = true;
          Promise.resolve(this.vlc.playIdle()).catch(error => this.emit('error', error));
          this.emit('idle');
        }
        return;
      }

      const nextKey = this._occurrenceKey(active.schedule, active.start.getTime());
      if (this.currentOccurrenceKey === nextKey) {
        this._syncTimeline({ ...active.schedule, files: this.currentTimelineFiles }, active.start, now);
        return;
      }

      const previous = this.schedules.find(item => item.id === this.currentScheduleId);
      if (previous) this.emit('finish', { schedule: previous });
      this._activate(active.schedule, active.start, active.duration, now);
    } finally {
      this._reconciling = false;
    }
  }

  _activate(schedule, startAt, duration, now = startAt) {
    this._idlePlaying = false;
    this._setCurrent(
      schedule.id,
      startAt,
      duration,
      this._occurrenceKey(schedule, startAt.getTime())
    );
    const scheduledFiles = schedule.files || [];
    const readyFiles = scheduledFiles.filter(file => {
      try { return this.isMediaReady(file); } catch (_) { return false; }
    });
    const unavailableFiles = scheduledFiles.filter(file => !readyFiles.includes(file));
    this.currentFiles = readyFiles;
    if (unavailableFiles.length) {
      this.emit('media-unavailable', { schedule, files: unavailableFiles });
    }
    const playableItems = readyFiles
      .map(file => ({ file, source: file.playbackSource || file.localPath || file.path }))
      .filter(item => Boolean(item.source));
    const playableFiles = playableItems.map(item => item.file);
    this.currentTimelineFiles = playableFiles;
    this.currentFiles = playableFiles;

    if (playableFiles.length) {
      this._syncTimeline({ ...schedule, files: playableFiles }, startAt, now, true);
    } else {
      Promise.resolve(this.vlc.playIdle()).catch(error => this.emit('error', error));
      this.emit('error', new Error(`Schedule ${schedule.id} has no ready media files`));
    }
    this.emit('activate', { schedule, start: startAt, duration });
  }

  _syncTimeline(schedule, startAt, now, force = false) {
    const files = schedule.files || [];
    const target = resolveTimelineTarget(files, startAt, now, schedule.loop !== false);
    if (!target) {
      // Legacy locally-authored schedules may not contain duration metadata.
      // Preserve their original VLC playlist behavior; CMS schedules always
      // carry durations and therefore use the segment timeline below.
      if (force && files.length) {
        const sources = files.map(file => file.playbackSource || file.localPath || file.path).filter(Boolean);
        if (sources.length) Promise.resolve(this.vlc.replacePlaylist(sources, { loop: schedule.loop !== false })).catch(error => this.emit('error', error));
      }
      return;
    }
    const segmentKey = `${this.currentOccurrenceKey}:${target.cycle}:${target.segmentIndex}:${target.phase}`;
    this.currentTimeline = target;
    if (!force && this.currentTimelineSegmentKey === segmentKey) return;
    this.currentTimelineSegmentKey = segmentKey;

    if (target.phase === 'gap') {
      this.currentFiles = [];
      Promise.resolve(this.vlc.playIdle()).catch(error => this.emit('error', error));
      this.emit('gap', { schedule, ...target });
      return;
    }

    const file = files[target.currentIndex];
    const source = file && (file.playbackSource || file.localPath || file.path);
    if (!source) return;
    this.currentFiles = [file];
    Promise.resolve(this.vlc.replacePlaylist([source], {
      loop: false,
      startPositionSeconds: target.positionSeconds
    })).catch(error => this.emit('error', error));
    this.emit('media', { schedule, file, ...target });
  }

  reactivate(scheduleId) {
    this.finishedOccurrences.delete(scheduleId);
    this.manuallySkipped.delete(scheduleId);
    this._setCurrent(null, null, null);
    this._reconcile(new Date());
  }

  skip() {
    if (!this.currentScheduleId || !this.currentStart) return;
    const scheduleId = this.currentScheduleId;
    this._finishOccurrence(scheduleId, this.currentStart.getTime(), true);
    const schedule = this.schedules.find(item => item.id === scheduleId);
    this._setCurrent(null, null, null);
    if (schedule) this.emit('expire', { schedule });
    this._reconcile(new Date());
  }

  getNow() {
    if (!this.currentScheduleId) return null;
    const schedule = this.schedules.find(item => item.id === this.currentScheduleId);
    if (!schedule) return null;
    return {
      scheduleId: schedule.id,
      title: schedule.title || schedule.id,
      files: this.currentFiles.slice(),
      phase: this.currentTimeline?.phase || 'media',
      itemIndex: this.currentTimeline?.currentIndex ?? 0,
      gapRemainingMs: this.currentTimeline?.phase === 'gap' ? this.currentTimeline.segmentRemainingMs : 0,
      nextTitle: this.currentTimeline?.phase === 'gap'
        ? (this.currentTimelineFiles[this.currentTimeline.currentIndex + 1]?.title || (schedule.loop !== false ? this.currentTimelineFiles[0]?.title : null))
        : null,
      playlistSize: this.currentTimelineFiles.length,
      startTime: this.currentStart ? this.currentStart.toISOString() : null,
      endMs: this.currentStart && this.currentDuration
        ? this.currentStart.getTime() + this.currentDuration
        : null,
      priority: Number(schedule.priority) || 0,
      loop: schedule.loop !== false
    };
  }

  getUpcoming(limit = 6) {
    const now = new Date();
    const items = [];
    for (const schedule of this.schedules) {
      const occurrence = this._nextUnfinishedOccurrence(schedule, now);
      if (!occurrence || occurrence.alreadyActive) continue;
      items.push({
        scheduleId: schedule.id,
        title: schedule.title || schedule.id,
        startMs: occurrence.start.getTime(),
        priority: Number(schedule.priority) || 0,
        freqLabel: describeRecurrence(schedule)
      });
    }
    items.sort((a, b) => a.startMs - b.startMs || b.priority - a.priority);
    return items.slice(0, limit);
  }

  getSkipped() {
    const result = [];
    for (const id of this.manuallySkipped) {
      const schedule = this.schedules.find(item => item.id === id);
      if (!schedule) continue;
      result.push({
        scheduleId: schedule.id,
        title: schedule.title || schedule.id,
        startTime: schedule.startTime,
        endTime: schedule.endTime,
        files: schedule.files || []
      });
    }
    return result;
  }

  _setCurrent(id, start, duration, occurrenceKey = null) {
    this.currentScheduleId = id;
    this.currentStart = start;
    this.currentDuration = duration;
    this.currentOccurrenceKey = id && start ? occurrenceKey : null;
    if (!id) {
      this.currentFiles = [];
      this.currentTimelineFiles = [];
      this.currentTimeline = null;
      this.currentTimelineSegmentKey = null;
    }
  }

  clearTimers() {
    // Kept for compatibility with older callers. Scheduling is reconciled on a
    // short interval instead of relying on long-lived setTimeout instances.
  }

  clear() {
    this._stopTick();
    this._setCurrent(null, null, null);
    this.schedules = [];
    this._idlePlaying = false;
  }

  recover(schedules) {
    this._setCurrent(null, null, null);
    this._idlePlaying = false;
    this.update(schedules || []);
    this._startTick();
  }
}

function describeRecurrence(schedule) {
  if (!schedule.recurrence || !schedule.recurrence.freq) return 'one-shot';
  if (schedule.recurrence.freq === 'daily') return 'daily';
  if (schedule.recurrence.freq === 'weekly') {
    const names = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const days = Array.isArray(schedule.recurrence.daysOfWeek)
      ? schedule.recurrence.daysOfWeek
      : [];
    return `weekly ${days.map(day => names[day - 1]).filter(Boolean).join(',')}`;
  }
  return schedule.recurrence.freq;
}

module.exports = {
  Scheduler,
  buildTimelineSegments,
  compareOccurrences,
  nextOccurrenceStart,
  resolveTimelineTarget,
  selectActiveOccurrence
};
