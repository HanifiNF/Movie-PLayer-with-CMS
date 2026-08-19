'use strict';

function normalizeRevision(value) {
  const revision = Number(value);
  return Number.isSafeInteger(revision) && revision >= 0 ? revision : null;
}

function revisionSyncAction(options = {}) {
  if (options.initialSyncNeeded || options.pendingRemovalRetry) return 'assets';
  if (options.assetRevision !== null && options.assetRevision !== options.appliedAssetRevision) return 'assets';
  if (options.scheduleRevision !== null && options.scheduleRevision !== options.appliedScheduleRevision) return 'schedules';
  return null;
}

module.exports = { normalizeRevision, revisionSyncAction };
