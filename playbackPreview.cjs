'use strict';

const PREVIEW_WIDTH = 480;
const PREVIEW_HEIGHT = 270;
const PREVIEW_INTERVAL_MS = 1000;

function resolvePreviewState({ hasDedicatedDisplay, now, vlcState, idleMode }) {
  if (!hasDedicatedDisplay) {
    return { status: 'unavailable', label: 'Unavailable', message: 'Connect or select a dedicated film output monitor.' };
  }
  if (!now) return { status: 'waiting', label: 'Waiting', message: 'Preview starts with the next active schedule.' };
  if (now.phase === 'gap') return { status: 'gap', label: 'Film gap', message: 'Waiting for the next film in this schedule.' };
  if (idleMode) return { status: 'waiting', label: 'Waiting', message: 'VLC is preparing the scheduled film output.' };
  if (vlcState === 'paused') return { status: 'paused', label: 'Paused', message: 'The film output is paused.' };
  if (vlcState === 'playing') return { status: 'live', label: 'Live', message: 'Low-resolution view of the film output monitor.' };
  if (vlcState === 'error') return { status: 'error', label: 'VLC error', message: 'Preview is unavailable while VLC recovers.' };
  return { status: 'waiting', label: 'Waiting', message: 'Film output has not started yet.' };
}

function selectDisplaySource(sources, displayId) {
  const expected = displayId == null ? '' : String(displayId);
  if (!expected) return null;
  return (Array.isArray(sources) ? sources : []).find(source => String(source && source.display_id || '') === expected) || null;
}

function shouldCapturePreview(status) {
  return status === 'live' || status === 'paused';
}

module.exports = {
  PREVIEW_WIDTH,
  PREVIEW_HEIGHT,
  PREVIEW_INTERVAL_MS,
  resolvePreviewState,
  selectDisplaySource,
  shouldCapturePreview
};
