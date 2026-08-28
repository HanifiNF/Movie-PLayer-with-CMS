'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  listWindowsAudioOutputs,
  normalizeWindowsAudioEndpoints
} = require('../windowsAudioDevices.cjs');

test('normalizeWindowsAudioEndpoints keeps render endpoints, removes duplicates, and sorts names', () => {
  const devices = normalizeWindowsAudioEndpoints([
    { id: 'SWD\\MMDEVAPI\\{0.0.0.00000000}.{BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB}', name: 'Speakers' },
    { id: '{0.0.1.00000000}.{CCCCCCCC-CCCC-CCCC-CCCC-CCCCCCCCCCCC}', name: 'Microphone' },
    { id: '{0.0.0.00000000}.{AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA}', name: ' Headphones\r\n' },
    { id: '{0.0.0.00000000}.{bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb}', name: 'Duplicate' }
  ]);

  assert.deepEqual(devices, [
    {
      id: '{0.0.0.00000000}.{AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA}',
      name: 'Headphones',
      source: 'windows'
    },
    {
      id: '{0.0.0.00000000}.{BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB}',
      name: 'Speakers',
      source: 'windows'
    }
  ]);
});

test('listWindowsAudioOutputs invokes hidden PowerShell and parses a single endpoint object', async () => {
  let invocation = null;
  const execFile = (file, args, options, callback) => {
    invocation = { file, args, options };
    callback(null, JSON.stringify({
      id: '{0.0.0.00000000}.{AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA}',
      name: 'Speakers (Test)'
    }), '');
  };

  const devices = await listWindowsAudioOutputs({ execFile, windowsRoot: 'C:\\Windows', timeoutMs: 1234 });

  assert.equal(devices.length, 1);
  assert.equal(devices[0].name, 'Speakers (Test)');
  assert.match(invocation.file, /powershell\.exe$/i);
  assert.equal(invocation.options.windowsHide, true);
  assert.equal(invocation.options.timeout, 1234);
  assert.ok(invocation.args.includes('-NonInteractive'));
});

test('listWindowsAudioOutputs returns an empty list for empty PowerShell output', async () => {
  const devices = await listWindowsAudioOutputs({
    execFile: (_file, _args, _options, callback) => callback(null, '', '')
  });
  assert.deepEqual(devices, []);
});
