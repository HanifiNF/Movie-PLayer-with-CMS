'use strict';

function resolveResumeTarget(checkpoint, activeSchedule) {
  const files = activeSchedule && Array.isArray(activeSchedule.files)
    ? activeSchedule.files
    : [];
  if (!checkpoint || !activeSchedule) return null;
  if (checkpoint.scheduleId !== activeSchedule.scheduleId) return null;
  if (checkpoint.occurrenceStart !== activeSchedule.startTime) return null;
  if (!Number.isInteger(checkpoint.currentIndex) || checkpoint.currentIndex < 0) return null;
  if (checkpoint.currentIndex >= files.length) return null;

  const rawPosition = Math.max(0, Math.floor(Number(checkpoint.positionSeconds) || 0));
  const length = Math.max(0, Math.floor(Number(checkpoint.lengthSeconds) || 0));
  const positionSeconds = length > 1 ? Math.min(rawPosition, length - 1) : rawPosition;
  if (checkpoint.currentIndex === 0 && positionSeconds <= 1) return null;

  return {
    currentIndex: checkpoint.currentIndex,
    positionSeconds,
    file: files[checkpoint.currentIndex]
  };
}

module.exports = { resolveResumeTarget };
