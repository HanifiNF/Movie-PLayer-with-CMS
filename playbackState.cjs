'use strict';

function isPlaybackExpected(active) {
  return Boolean(active && active.phase !== 'gap' && Array.isArray(active.files) && active.files.length);
}

function isVlcPlaybackHealthy(vlc, active) {
  // Standby remains healthy whether VLC is still warming or already warm and
  // empty; neither condition should trigger playback recovery.
  if (!isPlaybackExpected(active)) return true;
  return Boolean(
    vlc &&
    vlc.ready &&
    vlc.state !== 'error' &&
    !vlc.idleMode &&
    (vlc.state === 'playing' || vlc.state === 'paused')
  );
}

function resolvePlaybackTelemetry(active, vlcState, runtimeStatus) {
  if (!isPlaybackExpected(active)) {
    return { state: 'idle', error: '' };
  }
  if (runtimeStatus === 'vlc-error' || vlcState === 'error') {
    return { state: 'error', error: 'VLC playback is unavailable.' };
  }
  if (vlcState === 'paused') return { state: 'paused', error: '' };
  if (vlcState === 'playing') return { state: 'playing', error: '' };
  return { state: 'idle', error: '' };
}

function isPlaybackAlertStatus(status) {
  return status === 'vlc-error' || status === 'vlc-recovering';
}

module.exports = {
  isPlaybackAlertStatus,
  isPlaybackExpected,
  isVlcPlaybackHealthy,
  resolvePlaybackTelemetry
};
