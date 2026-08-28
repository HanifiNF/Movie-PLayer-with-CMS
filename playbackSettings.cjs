'use strict';

const DEFAULT_PLAYBACK_SETTINGS = Object.freeze({
  displayId: null,
  idleDisplayId: null,
  outputMode: 'fullscreen',
  resolution: 'native',
  customWidth: 1920,
  customHeight: 1080,
  scaling: 'fit',
  audioDeviceId: null,
  volumePercent: 100,
  hideVlcUi: true
});

function boundedInteger(value, fallback, minimum, maximum) {
  const number = Math.round(Number(value));
  return Number.isFinite(number) && number >= minimum && number <= maximum
    ? number
    : fallback;
}

function normalizePlaybackSettings(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const outputMode = ['fullscreen', 'windowed'].includes(source.outputMode)
    ? source.outputMode
    : DEFAULT_PLAYBACK_SETTINGS.outputMode;
  const resolution = ['native', '1080p', '720p', 'custom'].includes(source.resolution)
    ? source.resolution
    : DEFAULT_PLAYBACK_SETTINGS.resolution;
  const scaling = ['fit', 'fill', 'stretch'].includes(source.scaling)
    ? source.scaling
    : DEFAULT_PLAYBACK_SETTINGS.scaling;
  const displayId = source.displayId == null || source.displayId === '' || source.displayId === 'auto'
    ? null
    : String(source.displayId);
  const idleDisplayId = source.idleDisplayId == null || source.idleDisplayId === '' || source.idleDisplayId === 'same'
    ? null
    : String(source.idleDisplayId);
  const audioDeviceId = source.audioDeviceId == null || source.audioDeviceId === '' || source.audioDeviceId === 'default'
    ? null
    : String(source.audioDeviceId).replace(/[\r\n\0]/g, '').slice(0, 1024) || null;

  return {
    displayId,
    idleDisplayId,
    outputMode,
    resolution,
    customWidth: boundedInteger(source.customWidth, 1920, 320, 7680),
    customHeight: boundedInteger(source.customHeight, 1080, 240, 4320),
    scaling,
    audioDeviceId,
    volumePercent: boundedInteger(source.volumePercent, 100, 0, 100),
    hideVlcUi: source.hideVlcUi !== false
  };
}

function resolveOutputSize(settings, display) {
  const normalized = normalizePlaybackSettings(settings);
  if (normalized.resolution === '1080p') return { width: 1920, height: 1080 };
  if (normalized.resolution === '720p') return { width: 1280, height: 720 };
  if (normalized.resolution === 'custom') {
    return { width: normalized.customWidth, height: normalized.customHeight };
  }
  const bounds = display && display.bounds || {};
  return {
    width: boundedInteger(bounds.width, 1920, 320, 7680),
    height: boundedInteger(bounds.height, 1080, 240, 4320)
  };
}

module.exports = {
  DEFAULT_PLAYBACK_SETTINGS,
  normalizePlaybackSettings,
  resolveOutputSize
};
