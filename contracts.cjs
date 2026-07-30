'use strict';

const path = require('path');

class ContractError extends Error {
  constructor(message, details = []) {
    super(message);
    this.name = 'ContractError';
    this.details = details;
  }
}

function asNonEmptyString(value, field, errors) {
  const result = typeof value === 'string' ? value.trim() : '';
  if (!result) errors.push(`${field} is required`);
  return result;
}

function asIsoDate(value, field, errors) {
  const result = asNonEmptyString(value, field, errors);
  if (result && Number.isNaN(new Date(result).getTime())) {
    errors.push(`${field} must be a valid ISO 8601 date`);
  }
  if (result && !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(result)) {
    errors.push(`${field} must include a timezone offset`);
  }
  return result;
}

function normalizeRecurrence(value, errors) {
  if (value == null || value.freq == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    errors.push('recurrence must be an object or null');
    return null;
  }

  const freq = String(value.freq || '').toLowerCase();
  if (!['daily', 'weekly'].includes(freq)) {
    errors.push('recurrence.freq must be daily or weekly');
    return null;
  }

  let daysOfWeek = [];
  if (freq === 'weekly') {
    daysOfWeek = [...new Set(
      (Array.isArray(value.daysOfWeek) ? value.daysOfWeek : [])
        .map(Number)
        .filter(day => Number.isInteger(day) && day >= 1 && day <= 7)
    )].sort((a, b) => a - b);
    if (!daysOfWeek.length) {
      errors.push('recurrence.daysOfWeek must contain values from 1 (Mon) to 7 (Sun)');
    }
  }

  return { freq, daysOfWeek };
}

function normalizePlaylistItem(value, index, errors) {
  const item = value && typeof value === 'object' ? value : {};
  const assetId = typeof item.assetId === 'string' ? item.assetId.trim() : '';
  const localPath = typeof item.localPath === 'string'
    ? item.localPath.trim()
    : (typeof item.path === 'string' ? item.path.trim() : '');

  if (!assetId && !localPath) {
    errors.push(`playlist[${index}] requires assetId or localPath`);
  }

  return {
    assetId: assetId || null,
    localPath: localPath || null,
    path: localPath || null,
    title: typeof item.title === 'string' && item.title.trim()
      ? item.title.trim()
      : (localPath ? path.basename(localPath) : assetId),
    order: Number.isFinite(Number(item.order)) ? Number(item.order) : index
  };
}

function normalizeSchedule(value) {
  const schedule = value && typeof value === 'object' ? value : {};
  const errors = [];
  const id = asNonEmptyString(schedule.id || schedule.scheduleId, 'id', errors);
  const startTime = asIsoDate(schedule.startTime || schedule.startAt, 'startTime', errors);
  const endTime = asIsoDate(schedule.endTime || schedule.endAt, 'endTime', errors);

  if (startTime && endTime && new Date(endTime).getTime() <= new Date(startTime).getTime()) {
    errors.push('endTime must be later than startTime');
  }

  const sourcePlaylist = Array.isArray(schedule.playlist)
    ? schedule.playlist
    : (Array.isArray(schedule.files) ? schedule.files : []);
  if (!sourcePlaylist.length) errors.push('playlist must contain at least one media item');
  const playlist = sourcePlaylist
    .map((item, index) => normalizePlaylistItem(item, index, errors))
    .sort((a, b) => a.order - b.order);

  const recurrence = normalizeRecurrence(schedule.recurrence, errors);
  if (errors.length) {
    throw new ContractError(`Invalid schedule ${id || '(unknown)'}`, errors);
  }

  return {
    id,
    title: typeof schedule.title === 'string' && schedule.title.trim()
      ? schedule.title.trim()
      : id,
    revision: Math.max(0, Number(schedule.revision) || 0),
    priority: Number.isFinite(Number(schedule.priority)) ? Number(schedule.priority) : 0,
    // Keep the original offset because it defines the schedule's wall-clock
    // timezone for recurring occurrences.
    startTime,
    endTime,
    recurrence,
    enabled: schedule.enabled !== false,
    loop: schedule.loop !== false,
    playlist,
    // Preserve the old property until every CMS/player deployment uses playlist.
    files: playlist.map(item => ({
      assetId: item.assetId,
      localPath: item.localPath,
      path: item.localPath,
      title: item.title,
      order: item.order
    }))
  };
}

function normalizeAsset(value) {
  const asset = value && typeof value === 'object' ? value : {};
  const errors = [];
  const id = asNonEmptyString(asset.id || asset.assetId, 'asset.id', errors);
  const downloadUrl = asNonEmptyString(asset.downloadUrl, `asset ${id}.downloadUrl`, errors);
  const sha256 = asNonEmptyString(asset.sha256, `asset ${id}.sha256`, errors).toLowerCase();
  const size = Number(asset.size);

  if (downloadUrl && !/^https?:\/\//i.test(downloadUrl)) {
    errors.push(`asset ${id}.downloadUrl must use http or https`);
  }
  if (sha256 && !/^[a-f0-9]{64}$/.test(sha256)) {
    errors.push(`asset ${id}.sha256 must be a 64-character SHA-256 hex digest`);
  }
  if (!Number.isSafeInteger(size) || size <= 0) {
    errors.push(`asset ${id}.size must be a positive integer`);
  }
  if (errors.length) throw new ContractError(`Invalid asset ${id || '(unknown)'}`, errors);

  return {
    id,
    filename: typeof asset.filename === 'string' && asset.filename.trim()
      ? path.basename(asset.filename.trim())
      : `${id}.bin`,
    downloadUrl,
    sha256,
    size,
    mimeType: typeof asset.mimeType === 'string' ? asset.mimeType : 'application/octet-stream',
    durationMs: Math.max(0, Number(asset.durationMs) || 0),
    revision: Math.max(0, Number(asset.revision) || 0)
  };
}

function normalizeSyncPayload(payload) {
  const envelope = Array.isArray(payload)
    ? { schedules: payload }
    : (payload && (payload.id || payload.scheduleId)
        ? { schedules: [payload] }
        : (payload || {}));
  const scheduleErrors = [];
  const assetErrors = [];
  const schedules = [];
  const assets = [];

  for (const value of Array.isArray(envelope.schedules) ? envelope.schedules : []) {
    try {
      schedules.push(normalizeSchedule(value));
    } catch (error) {
      scheduleErrors.push(...(error.details || [error.message]));
    }
  }
  for (const value of Array.isArray(envelope.assets) ? envelope.assets : []) {
    try {
      assets.push(normalizeAsset(value));
    } catch (error) {
      assetErrors.push(...(error.details || [error.message]));
    }
  }

  if (scheduleErrors.length || assetErrors.length) {
    throw new ContractError('Invalid CMS sync payload', [...scheduleErrors, ...assetErrors]);
  }

  return {
    revision: Math.max(0, Number(envelope.revision) || 0),
    schedules,
    assets
  };
}

module.exports = {
  ContractError,
  normalizeAsset,
  normalizeSchedule,
  normalizeSyncPayload
};
