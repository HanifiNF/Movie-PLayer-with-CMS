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

module.exports = { choosePlaybackDisplay };
