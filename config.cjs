'use strict';

// Centralized configuration - edit values here, not in the login form.
module.exports = {
  // CMS server URL. Hardcoded; the login form no longer asks for it.
  SERVER_URL: 'http://localhost:3000',

  // Test/bypass mode credentials injected when user clicks "Test Mode".
  // No real network call happens; the player runs offline with a mock schedule.
  TEST_DEVICE_ID: 'test-device-001',
  TEST_TOKEN: 'dev-test-token',
  TEST_USERNAME: 'tester',

  // Media file to play when Test Mode injects a mock schedule.
  // Replace with an absolute local path that exists on this PC, e.g.
  //   'C:\\Users\\Public\\Videos\\sample.mp4'
  // or leave empty to just open VLC idle (black fullscreen).
  TEST_FILE: 'C:\\Users\\Hanifi Setiawan\\Videos\\wwm\\wwm 2025.11.16 - 09.48.44.04.DVR.mp4'
};