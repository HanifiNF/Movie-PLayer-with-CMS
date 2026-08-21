'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { VlcController } = require('../vlcController.cjs');

test('VLC startup defaults to a production-safe hidden fullscreen interface', () => {
  const controller = new VlcController();
  const args = controller._buildStartArgs();

  assert.equal(args[args.indexOf('--intf') + 1], 'dummy');
  assert.ok(args.includes('--fullscreen'));
  assert.ok(!args.includes('--video-on-top'));
  assert.ok(args.includes('--no-qt-fs-controller'));
  assert.ok(args.includes('--no-video-deco'));
  assert.ok(!args.includes('--no-embedded-video'));
  assert.ok(!args.includes('--qt-continue=0'));
});

test('scheduled kiosk playback hides VLC console and interface windows', () => {
  const controller = new VlcController({ settings: { hideVlcUi: true } });
  const options = controller._buildSpawnOptions('C:\\player\\vlc-portable');

  assert.equal(options.windowsHide, true);
  assert.equal(options.cwd, 'C:\\player\\vlc-portable');
});

test('scheduled fullscreen output preserves the selected monitor origin and resolution', () => {
  const controller = new VlcController({
    display: { id: 20, bounds: { x: 1920, y: 0, width: 2560, height: 1440 } },
    settings: { outputMode: 'fullscreen', resolution: '720p', hideVlcUi: true }
  });
  const args = controller._buildStartArgs();

  assert.equal(args[args.indexOf('--video-x') + 1], '1920');
  assert.equal(args[args.indexOf('--video-y') + 1], '0');
  assert.equal(args[args.indexOf('--width') + 1], '1280');
  assert.equal(args[args.indexOf('--height') + 1], '720');
});

test('embedded film output renders into the Electron HWND without VLC fullscreen', () => {
  const controller = new VlcController({
    drawableHwnd: '987654321',
    display: { id: 20, bounds: { x: 1920, y: 0, width: 1920, height: 1080 } },
    settings: { outputMode: 'fullscreen', hideVlcUi: true }
  });
  const args = controller._buildStartArgs();

  assert.ok(args.includes('--no-fullscreen'));
  assert.ok(args.includes('--drawable-hwnd=987654321'));
  assert.ok(!args.includes('--fullscreen'));
});

test('debug window mode restores Qt UI and applies custom output geometry', () => {
  const controller = new VlcController({
    display: { bounds: { x: 1920, y: 0, width: 1920, height: 1080 } },
    settings: {
      hideVlcUi: false,
      outputMode: 'windowed',
      resolution: 'custom',
      customWidth: 1280,
      customHeight: 720,
      scaling: 'stretch'
    }
  });
  const args = controller._buildStartArgs();

  assert.equal(args[args.indexOf('--intf') + 1], 'qt');
  assert.equal(args[args.indexOf('--video-x') + 1], '2240');
  assert.equal(args[args.indexOf('--video-y') + 1], '180');
  assert.equal(args[args.indexOf('--width') + 1], '1280');
  assert.equal(args[args.indexOf('--height') + 1], '720');
  assert.ok(args.includes('--no-fullscreen'));
  assert.equal(args[args.indexOf('--aspect-ratio') + 1], '16:9');
  assert.ok(args.includes('--qt-continue=0'));
});

test('VLC preserves the localhost LDG gateway URL instead of converting it to a file MRL', () => {
  const controller = new VlcController();
  const url = 'http://127.0.0.1:43210/ldg/v1/secret-token';
  assert.equal(controller._toMrl(url), url);
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

test('replacePlaylist seeks to the requested late-join playlist position', async () => {
  const controller = new VlcController();
  const commands = [];
  controller.ready = true;
  controller.send = command => {
    commands.push(command);
    if (command === 'goto 2') {
      setTimeout(() => controller._setCurrentInput('file:///C:/media/film%20B.mp4'), 10);
    }
    return true;
  };

  await controller.replacePlaylist([
    'C:\\media\\film A.mp4',
    'C:\\media\\film B.mp4'
  ], { loop: false, startIndex: 1, startPositionSeconds: 42 });

  assert.deepEqual(commands, [
    'clear',
    'enqueue file:///C:/media/film%20A.mp4',
    'enqueue file:///C:/media/film%20B.mp4',
    'loop off',
    'play',
    'status',
    'goto 2',
    'seek 42',
    'status',
    'get_time',
    'get_length'
  ]);
});

test('start replaces an owned VLC process whose RC endpoint never becomes ready', async () => {
  const controller = new VlcController({ existingRcTimeoutMs: 250 });
  let stopped = 0;
  let spawned = 0;
  controller.proc = { pid: 4321 };
  controller._isOwnedProcessAlive = () => true;
  controller._waitForRc = async () => { throw new Error('RC TCP not available'); };
  controller._stopForOutputChange = async () => {
    stopped += 1;
    controller.proc = null;
    controller.ready = false;
  };
  controller._spawnVlc = async () => { spawned += 1; };

  await controller.start();

  assert.equal(stopped, 1);
  assert.equal(spawned, 1);
  assert.equal(controller._startPromise, null);
});

test('idle mode hands output to Electron and fully stops VLC', async () => {
  const transitions = [];
  const commands = [];
  const controller = new VlcController({
    onTransitionStart: () => transitions.push('show')
  });
  controller.ready = true;
  let killed = false;
  controller.proc = { kill: () => { killed = true; } };
  controller.currentPlaylist = ['C:\\media\\finished.mp4'];
  controller.send = command => {
    commands.push(command);
    return true;
  };

  await controller.playIdle();

  assert.equal(controller.idleMode, true);
  assert.equal(controller.state, 'idle');
  assert.equal(controller.proc, null);
  assert.equal(controller.ready, false);
  assert.equal(killed, true);
  assert.deepEqual(controller.currentPlaylist, []);
  assert.deepEqual(commands, ['quit']);
  assert.deepEqual(controller.getPlaybackStatus(), {
    currentPath: null,
    currentIndex: -1,
    positionSeconds: 0,
    lengthSeconds: 0,
    updatedAt: controller.getPlaybackStatus().updatedAt
  });
  assert.deepEqual(transitions, ['show']);
});

test('recovery test terminates only the controller-owned VLC process', () => {
  const controller = new VlcController();
  let kills = 0;
  controller.proc = { pid: 4321, kill: () => { kills += 1; return true; } };

  assert.deepEqual(controller.simulateCrashForRecoveryTest(), { pid: 4321 });
  assert.equal(kills, 1);
});

test('recovery test refuses to run without a controller-owned VLC process', () => {
  const controller = new VlcController();
  assert.throws(
    () => controller.simulateCrashForRecoveryTest(),
    /VLC process is not running/
  );
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

test('idle polling checks VLC state without reporting black-video progress', () => {
  const controller = new VlcController();
  const commands = [];
  controller.idleMode = true;
  controller.send = command => commands.push(command);

  controller._pollPlayback();

  assert.deepEqual(commands, ['status']);
  assert.deepEqual(controller._pendingMetricResponses, []);
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
