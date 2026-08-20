'use strict';

function choosePlaybackDisplay(displays, primaryDisplay, preferredDisplayId = null) {
  const available = Array.isArray(displays) ? displays.filter(Boolean) : [];
  if (!available.length) {
    return { display: null, hasDedicatedDisplay: false, hasSecondaryDisplay: false };
  }

  const primaryId = primaryDisplay && primaryDisplay.id;
  const primary = available.find(display => display.id === primaryId)
    || primaryDisplay
    || available[0];
  const dedicated = available.find(display => display.id !== primary.id) || null;
  const preferred = preferredDisplayId == null
    ? null
    : available.find(display => String(display.id) === String(preferredDisplayId)) || null;
  const selected = preferred || dedicated || primary;

  return {
    display: selected,
    hasDedicatedDisplay: selected.id !== primary.id,
    hasSecondaryDisplay: Boolean(dedicated)
  };
}

function chooseIdleDisplay(displays, playbackDisplay, preferredDisplayId = null) {
  const available = Array.isArray(displays) ? displays.filter(Boolean) : [];
  if (!available.length) return { display: null, preferredAvailable: false };

  const fallback = available.find(display => (
    playbackDisplay && String(display.id) === String(playbackDisplay.id)
  )) || playbackDisplay || available[0];
  if (preferredDisplayId == null) {
    return { display: fallback, preferredAvailable: true };
  }

  const preferred = available.find(display => (
    String(display.id) === String(preferredDisplayId)
  )) || null;
  return {
    display: preferred || fallback,
    preferredAvailable: Boolean(preferred)
  };
}

module.exports = { choosePlaybackDisplay, chooseIdleDisplay };
