'use strict';

const crypto = require('crypto');

function validPort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : null;
}

/**
 * Production installations retain the configured VLC port. Development
 * profiles that opt into PLAYER_USER_DATA receive a deterministic port derived
 * from their profile directory, allowing multiple Studio profiles on one PC
 * without sharing VLC's RC endpoint.
 */
function resolveVlcRcPort(basePort, userDataPath, overridePort, isolatedProfile = false) {
  const override = validPort(overridePort);
  if (override !== null) return override;

  const fallback = validPort(basePort) || 4212;
  if (!isolatedProfile || !String(userDataPath || '').trim()) return fallback;

  const digest = crypto.createHash('sha256')
    .update(String(userDataPath).trim().toLowerCase())
    .digest();
  return 20000 + (digest.readUInt32BE(0) % 20000);
}

module.exports = { resolveVlcRcPort };
