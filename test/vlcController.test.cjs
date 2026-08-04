'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { VlcController } = require('../vlcController.cjs');

test('VLC startup disables Qt resume prompts and recent-play history', () => {
  const controller = new VlcController();
  const args = controller._buildStartArgs();

  assert.ok(args.includes('--qt-continue=0'));
  assert.ok(args.includes('--no-qt-recentplay'));
  assert.ok(args.includes('--no-qt-error-dialogs'));
});

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

test('resumePlaylistAt converts to VLC 3 one-based item and waits before seeking', async () => {
  const controller = new VlcController();
  const commands = [];
  controller.ready = true;
  controller.currentPlaylist = [
    'C:\\media\\film A.mp4',
    'C:\\media\\film B.mp4'
  ];
  controller.send = command => {
    commands.push(command);
    if (command === 'goto 2') {
      setTimeout(() => {
        controller._setCurrentInput('file:///C:/media/film%20B.mp4');
      }, 10);
    }
  };

  const playback = await controller.resumePlaylistAt(1, 42);

  assert.deepEqual(commands, [
    'goto 2',
    'seek 42',
    'status',
    'get_time',
    'get_length'
  ]);
  assert.equal(playback.currentIndex, 1);
  assert.equal(playback.currentPath, 'C:\\media\\film B.mp4');
  assert.equal(playback.positionSeconds, 42);
});

test('resumePlaylistAt never seeks when VLC does not confirm the target item', async () => {
  const controller = new VlcController({ resumeInputTimeoutMs: 250 });
  const commands = [];
  controller.ready = true;
  controller.currentPlaylist = [
    'C:\\media\\film A.mp4',
    'C:\\media\\film B.mp4'
  ];
  controller._setCurrentInput('file:///C:/media/film%20A.mp4');
  controller.send = command => commands.push(command);

  await assert.rejects(
    controller.resumePlaylistAt(1, 42),
    /did not confirm playlist item 2/
  );
  assert.deepEqual(commands, ['goto 2']);
});

test('relative and absolute seek clamp positions to the current media', async () => {
  const controller = new VlcController();
  const commands = [];
  controller.ready = true;
  controller.playback.positionSeconds = 42;
  controller.playback.lengthSeconds = 60;
  controller.send = command => commands.push(command);

  await controller.seekRelative(10);
  await controller.seekRelative(-100);
  await controller.seekTo(999);

  assert.deepEqual(commands, [
    'seek 52', 'status', 'get_time', 'get_length',
    'seek 0', 'status', 'get_time', 'get_length',
    'seek 59', 'status', 'get_time', 'get_length'
  ]);
  assert.equal(controller.getPlaybackStatus().positionSeconds, 59);
});
