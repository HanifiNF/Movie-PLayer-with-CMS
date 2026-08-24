'use strict';

function isPlaybackExpected(active) {
  return Boolean(active && Array.isArray(active.files) && active.files.length);
}

function isVlcPlaybackHealthy(vlc, active) {
  // VLC is intentionally stopped while no schedule is active. Standby is a
  // healthy Player state and must not trigger recovery.
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
