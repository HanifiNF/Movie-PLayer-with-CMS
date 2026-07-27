'use strict';

// Centralized configuration - edit values here, not in the login form.
module.exports = {
  // CMS server URL. Hardcoded; the login form no longer asks for it.
  SERVER_URL: 'http://localhost:3000',

  // VLC RC interface settings (used by vlcController.cjs).
  VLC_RC_PORT: 4212,

  // Test/bypass mode credentials injected when user clicks "Test Mode".
  // No real network call happens; the player runs offline with a mock schedule.
  TEST_DEVICE_ID: 'test-device-001',
  TEST_TOKEN: 'dev-test-token',
  TEST_USERNAME: 'tester',

  // Default video path used by "Add Schedule" in Test Mode.
  // Replace with an absolute local path that exists on this PC, e.g.
  //   'C:\\Users\\Public\\Videos\\sample.mp4'
  TEST_FILE: 'C:\\laragon\\www\\Netflix-clone\\storage\\app\\video\\9sbXNTj4uHvgIgIIt9Xptg8qpSBJTyjTYdoT7QwR.mp4',

  VLC_MONITOR: 2
};