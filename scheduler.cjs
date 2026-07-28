'use strict';

const { EventEmitter } = require('events');

const MS = { day: 86400000, hour: 3600000, minute: 60000, second: 1000 };

function getZonedParts(date, offsetMinutes) {
  const t = new Date(date.getTime() + offsetMinutes * 60000);
  return {
    year: t.getUTCFullYear(),
    month: t.getUTCMonth(),
    day: t.getUTCDate(),
    hour: t.getUTCHours(),
    minute: t.getUTCMinutes(),
    second: t.getUTCSeconds(),
    weekday: t.getUTCDay()
  };
}

function buildDateAt(year, month, day, hour, minute, second, offsetMinutes) {
  const utcMs = Date.UTC(year, month, day, hour, minute, second);
  return new Date(utcMs - offsetMinutes * 60000);
}

function parseOffsetMinutes(iso) {
  const m = /([+-])(\d{2}):?(\d{2})$/.exec(iso);
  if (!m) return 0;
  const sign = m[1] === '-' ? -1 : 1;
  return sign * (parseInt(m[2], 10) * 60 + parseInt(m[3], 10));
}

function nextOccurrenceStart(sched, now = new Date()) {
  const startIso = sched.startTime;
  const rec = sched.recurrence;
  if (!startIso) return null;
  const offset = parseOffsetMinutes(startIso);
  const first = new Date(startIso);
  if (isNaN(first.getTime())) return null;
  const p = getZonedParts(first, offset);
  const duration = (() => {
    if (!sched.endTime) return 0;
    const e = new Date(sched.endTime);
    return isNaN(e.getTime()) ? 0 : (e.getTime() - first.getTime());
  })();
  if (!rec || !rec.freq) {
    if (now.getTime() < first.getTime()) return { start: first, duration };
    if (duration > 0 && now.getTime() < first.getTime() + duration) {
      return { start: first, duration, alreadyActive: true };
    }
    return null;
  }
  if (rec.freq === 'daily') {
    let candidate = buildDateAt(p.year, p.month, p.day, p.hour, p.minute, p.second, offset);
    if (candidate.getTime() <= now.getTime()) {
      candidate = new Date(candidate.getTime() + MS.day);
    }
    return { start: candidate, duration };
  }
  if (rec.freq === 'weekly') {
    const days = Array.isArray(rec.daysOfWeek) && rec.daysOfWeek.length
      ? rec.daysOfWeek.slice().sort((a, b) => a - b)
      : [((p.weekday || 0) || 7)];
    for (let i = 0; i < 14; i++) {
      const base = new Date(now.getTime() + i * MS.day);
      const parts = getZonedParts(base, offset);
      if (!days.includes(parts.weekday || 0) && !days.includes(((parts.weekday || 0) || 7))) continue;
      const cand = buildDateAt(parts.year, parts.month, parts.day, p.hour, p.minute, p.second, offset);
      if (cand.getTime() > now.getTime()) return { start: cand, duration };
    }
    return null;
  }
  return null;
}

class Scheduler extends EventEmitter {
  constructor(vlc) {
    super();
    this.vlc = vlc;
    this.schedules = [];
    this.timers = new Map();
    this.currentScheduleId = null;
    this.currentStart = null;
    this.currentDuration = null;
    this.tickHandle = null;
    this._idlePlaying = false;
    this.finishedOccurrences = new Map();
    this.manuallySkipped = new Set();
    this._startTick();
  }

  _startTick() {
    if (this.tickHandle) return;
    this.tickHandle = setInterval(() => this.emit('tick'), 1000);
    if (this.tickHandle.unref) this.tickHandle.unref();
  }

  _stopTick() {
    if (this.tickHandle) { clearInterval(this.tickHandle); this.tickHandle = null; }
  }

  _isFinished(scheduleId, startMs) {
    const set = this.finishedOccurrences.get(scheduleId);
    return !!set && set.has(startMs);
  }

  _finishOccurrence(scheduleId, startMs, manual = false) {
    if (!this.finishedOccurrences.has(scheduleId)) {
      this.finishedOccurrences.set(scheduleId, new Set());
    }
    this.finishedOccurrences.get(scheduleId).add(startMs);
    if (manual) this.manuallySkipped.add(scheduleId);
  }

  _nextUnfinishedOccurrence(sched, now = new Date()) {
    for (let i = 0; i < 366; i++) {
      const base = new Date(now.getTime() + i * MS.day);
      const occ = nextOccurrenceStart(sched, base);
      if (!occ) return null;
      if (!this._isFinished(sched.id, occ.start.getTime())) return occ;
    }
    return null;
  }

  reactivate(scheduleId) {
    this.finishedOccurrences.delete(scheduleId);
    this.manuallySkipped.delete(scheduleId);
    const schedule = this.schedules.find(s => s.id === scheduleId);
    if (!schedule) return;
    const occ = this._nextUnfinishedOccurrence(schedule, new Date());
    if (!occ) return;
    if (this.currentScheduleId && this.currentScheduleId !== scheduleId) {
      const prevEndTimer = this.timers.get('end:' + this.currentScheduleId);
      if (prevEndTimer) { clearTimeout(prevEndTimer); this.timers.delete('end:' + this.currentScheduleId); }
      const prevStart = this.currentStart ? this.currentStart.getTime() : null;
      if (prevStart) this._finishOccurrence(this.currentScheduleId, prevStart, false);
      const prevSched = this.schedules.find(x => x.id === this.currentScheduleId);
      if (prevSched) this.emit('finish', { schedule: prevSched });
    }
    this._setCurrent(null, null, null);
    this._activate(schedule, occ.start, occ.duration);
  }

  getSkipped() {
    const result = [];
    for (const id of this.manuallySkipped) {
      const s = this.schedules.find(x => x.id === id);
      if (!s) continue;
      result.push({
        scheduleId: s.id,
        title: s.title || s.id,
        startTime: s.startTime,
        endTime: s.endTime,
        files: s.files || []
      });
    }
    return result;
  }

  update(schedules) {
    this.clearTimers();
    this.schedules = Array.isArray(schedules) ? schedules.slice() : [];
    const now = new Date();
    let activeNow = null;
    for (const s of this.schedules) {
      const occ = this._nextUnfinishedOccurrence(s, now);
      if (!occ) continue;
      if (occ.alreadyActive) {
        if (!activeNow || occ.start.getTime() > activeNow.start.getTime()) {
          activeNow = { schedule: s, start: occ.start, duration: occ.duration };
        }
      } else {
        this._arm(s, occ.start, occ.duration);
      }
    }
    if (activeNow) {
      this._activate(activeNow.schedule, activeNow.start, activeNow.duration);
    } else {
      this._setCurrent(null, null, null);
      if (!this._idlePlaying) {
        this._idlePlaying = true;
        this.vlc.playIdle().catch(err => this.emit('error', err));
      }
      this.emit('idle');
    }
  }

  getNow() {
    if (!this.currentScheduleId) return null;
    const s = this.schedules.find(x => x.id === this.currentScheduleId);
    if (!s) return null;
    const endMs = this.currentStart && this.currentDuration
      ? this.currentStart.getTime() + this.currentDuration
      : null;
    return {
      scheduleId: s.id,
      title: s.title || s.id,
      files: s.files || [],
      startTime: this.currentStart ? this.currentStart.toISOString() : null,
      endMs,
      loop: !!s.loop
    };
  }

  getUpcoming(n = 6) {
    const now = new Date();
    const items = [];
    for (const s of this.schedules) {
      if (s.id === this.currentScheduleId) continue;
      const occ = this._nextUnfinishedOccurrence(s, now);
      if (!occ || occ.alreadyActive) continue;
      items.push({
        scheduleId: s.id,
        title: s.title || s.id,
        startMs: occ.start.getTime(),
        freqLabel: describeRecurrence(s)
      });
    }
    items.sort((a, b) => a.startMs - b.startMs);
    return items.slice(0, n);
  }

  skip() {
    if (!this.currentScheduleId) return;
    const id = this.currentScheduleId;
    const startAt = this.currentStart;
    const duration = this.currentDuration;
    const startTimer = this.timers.get('start:' + id);
    if (startTimer) { clearTimeout(startTimer); this.timers.delete('start:' + id); }
    const endTimer = this.timers.get('end:' + id);
    if (endTimer) { clearTimeout(endTimer); this.timers.delete('end:' + id); }
    if (startAt) {
      this._finishOccurrence(id, startAt.getTime(), true);
    }
    this._setCurrent(null, null, null);
    this.emit('expire', { schedule: this.schedules.find(x => x.id === id) });
    const now = new Date();
    let nextActive = null;
    for (const s of this.schedules) {
      if (s.id === id) continue;
      const occ = this._nextUnfinishedOccurrence(s, now);
      if (!occ) continue;
      if (occ.alreadyActive) {
        if (!nextActive || occ.start.getTime() > nextActive.start.getTime()) {
          nextActive = { schedule: s, start: occ.start, duration: occ.duration };
        }
      }
    }
    if (nextActive) {
      this._activate(nextActive.schedule, nextActive.start, nextActive.duration);
    } else {
      this._idlePlaying = true;
      this.vlc.playIdle();
      this.emit('idle');
    }
    if (startAt && duration) {
      const skippedSched = this.schedules.find(x => x.id === id);
      if (skippedSched) this._scheduleNext(skippedSched, startAt, duration);
    }
  }

  clear() {
    this.clearTimers();
    this._setCurrent(null, null, null);
    this.schedules = [];
  }

  recover(schedules) {
    this.clearTimers();
    this._setCurrent(null, null, null);
    this._idlePlaying = false;
    this.update(schedules || []);
  }

  clearTimers() {
    for (const t of this.timers.values()) {
      clearTimeout(t);
    }
    this.timers.clear();
  }

  _setCurrent(id, start, duration) {
    this.currentScheduleId = id;
    this.currentStart = start;
    this.currentDuration = duration;
  }

  _arm(schedule, startAt, duration) {
    const id = schedule.id;
    const delay = startAt.getTime() - Date.now();
    if (delay <= 0) {
      this._activate(schedule, startAt, duration);
      return;
    }
    const startTimer = setTimeout(() => this._activate(schedule, startAt, duration), delay);
    this.timers.set('start:' + id, startTimer);
  }

  _activate(schedule, startAt, duration) {
    if (this._activatingId === schedule.id) return;
    if (this._isFinished(schedule.id, startAt.getTime())) return;
    const alreadyActive = this.currentScheduleId === schedule.id;
    if (this.currentScheduleId && this.currentScheduleId !== schedule.id) {
      const prevEndTimer = this.timers.get('end:' + this.currentScheduleId);
      if (prevEndTimer) { clearTimeout(prevEndTimer); this.timers.delete('end:' + this.currentScheduleId); }
      const prevStart = this.currentStart ? this.currentStart.getTime() : null;
      if (prevStart) this._finishOccurrence(this.currentScheduleId, prevStart, false);
      const prevSched = this.schedules.find(x => x.id === this.currentScheduleId);
      if (prevSched) this.emit('finish', { schedule: prevSched });
    }
    this._activatingId = schedule.id;
    this._idlePlaying = false;
    this._setCurrent(schedule.id, startAt, duration);
    if (!alreadyActive) {
      const files = (schedule.files || []).map(f => f.path).filter(Boolean);
      if (files.length) {
        this.vlc.replacePlaylist(files).catch(err => this.emit('error', err));
      } else {
        this.vlc.clear();
      }
      this.emit('activate', { schedule, start: startAt, duration });
    }
    if (duration && duration > 0) {
      const delay = Math.max(0, startAt.getTime() + duration - Date.now());
      const endTimer = setTimeout(() => this._expire(schedule, startAt, duration), delay);
      this.timers.set('end:' + schedule.id, endTimer);
    }
    this._scheduleNext(schedule, startAt, duration);
    this._activatingId = null;
  }

  _expire(schedule, startAt, duration) {
    if (this.currentScheduleId === schedule.id) {
      this._finishOccurrence(schedule.id, startAt.getTime(), false);
      this._idlePlaying = true;
      this.vlc.playIdle();
      this._setCurrent(null, null, null);
      this.emit('expire', { schedule });
    }
    this.timers.delete('end:' + schedule.id);
  }

  _scheduleNext(schedule, startAt, duration) {
    if (!schedule.recurrence || !schedule.recurrence.freq) return;
    const next = this._nextUnfinishedOccurrence(schedule, new Date(startAt.getTime() + (duration || 0) + 1000));
    if (!next) return;
    this._arm(schedule, next.start, next.duration);
  }
}

function describeRecurrence(s) {
  if (!s.recurrence || !s.recurrence.freq) return 'one-shot';
  if (s.recurrence.freq === 'daily') return 'daily';
  if (s.recurrence.freq === 'weekly') {
    const names = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
    const days = Array.isArray(s.recurrence.daysOfWeek) ? s.recurrence.daysOfWeek : [];
    return 'weekly ' + days.map(d => names[(d - 1) % 7]).join(',');
  }
  return s.recurrence.freq;
}

module.exports = { Scheduler, nextOccurrenceStart };
