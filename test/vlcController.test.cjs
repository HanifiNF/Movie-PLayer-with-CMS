'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { VlcController } = require('../vlcController.cjs');

test('replacePlaylist enqueues every item before starting the first one', async () => {
  const controller = new VlcController();
  const commands = [];
  controller.ready = true;
  controller.send = command => {
    commands.push(command);
    return true;
  };

  await controller.replacePlaylist([
    'C:\\media\\film A.mp4',
    'C:\\media\\film B.mp4'
  ], { loop: false });

  assert.deepEqual(commands, [
    'clear',
    'enqueue file:///C:/media/film%20A.mp4',
    'enqueue file:///C:/media/film%20B.mp4',
    'loop off',
    'play',
    'status'
  ]);
  assert.deepEqual(controller.currentPlaylist, [
    'C:\\media\\film A.mp4',
    'C:\\media\\film B.mp4'
  ]);
});

test('playback polling requests status, elapsed time, and media length', () => {
  const controller = new VlcController();
  const commands = [];
  controller.send = command => commands.push(command);

  controller._pollPlayback();

  assert.deepEqual(commands, ['status', 'get_time', 'get_length']);
  assert.deepEqual(controller._pendingMetricResponses, ['positionSeconds', 'lengthSeconds']);
  assert.equal(controller.pollIntervalMs, 1000);
});

test('RC responses identify the active playlist item and its progress', () => {
  const controller = new VlcController();
  controller.currentPlaylist = [
    'C:\\media\\film A.mp4',
    'C:\\media\\film B.mp4'
  ];
  controller._pendingMetricResponses = ['positionSeconds', 'lengthSeconds'];

  controller._parseRc([
    '( new input: file:///C:/media/film%20B.mp4 )',
    '42',
    '120',
    ''
  ].join('\n'));

  assert.deepEqual(controller.getPlaybackStatus(), {
    currentPath: 'C:\\media\\film B.mp4',
    currentIndex: 1,
    positionSeconds: 42,
    lengthSeconds: 120,
    updatedAt: controller.getPlaybackStatus().updatedAt
  });
  assert.ok(controller.getPlaybackStatus().updatedAt);
});
