'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { VlcController, parseAudioDeviceLine } = require('../vlcController.cjs');

test('VLC audio device responses are parsed without accepting unrelated RC lines', () => {
  assert.deepEqual(parseAudioDeviceLine('| device-id - Speakers (USB Audio) *'), {
    id: 'device-id',
    name: 'Speakers (USB Audio)',
    active: true
  });
  assert.equal(parseAudioDeviceLine('| another-id - HDMI Output').active, false);
  assert.equal(parseAudioDeviceLine('| state playing'), null);
  assert.equal(parseAudioDeviceLine('status change: ( audio volume: 256 )'), null);
});

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
    if (command === 'status') {
      setTimeout(() => {
        controller._setCurrentInput('file:///C:/media/film%20A.mp4');
        controller._parseRc('status change: ( play state: 3 )\n');
      }, 10);
    }
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
    'volume 256',
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
  let pauseCommands = 0;
  controller.ready = true;
  controller.send = command => {
    commands.push(command);
    if (command === 'status' && controller._confirmedInputIndex < 0) {
      setTimeout(() => {
        controller._setCurrentInput('file:///C:/media/film%20A.mp4');
        controller._parseRc('status change: ( play state: 3 )\n');
      }, 10);
    }
    if (command === 'goto 2') {
      setTimeout(() => controller._setCurrentInput('file:///C:/media/film%20B.mp4'), 10);
    }
    if (command === 'pause') {
      pauseCommands += 1;
      setTimeout(() => controller._parseRc(
        `status change: ( ${pauseCommands === 1 ? 'pause' : 'play'} state: 3 )\n`
      ), 10);
    }
    if (command === 'seek 42') {
      setTimeout(() => controller._parseRc('status change: ( time: 42s )\n'), 10);
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
    'volume 256',
    'status',
    'goto 2',
    'seek 42',
    'status',
    'get_time',
    'get_length',
    'pause',
    'status',
    'pause',
    'status'
  ]);
});

test('single-item scheduled playback waits for VLC input and seeks without reloading it', async () => {
  const controller = new VlcController();
  const commands = [];
  let pauseCommands = 0;
  controller.ready = true;
  controller.send = command => {
    commands.push(command);
    if (command === 'status') {
      setTimeout(() => {
        controller._setCurrentInput('http://127.0.0.1:62862/ldg/v1/film-b');
        controller._parseRc('status change: ( play state: 3 )\n');
      }, 10);
    }
    if (command === 'pause') {
      pauseCommands += 1;
      setTimeout(() => controller._parseRc(
        `status change: ( ${pauseCommands === 1 ? 'pause' : 'play'} state: 3 )\n`
      ), 10);
    }
    if (command === 'seek 60') {
      setTimeout(() => controller._parseRc('status change: ( time: 60s )\n'), 10);
    }
    return true;
  };

  await controller.replacePlaylist([
    'http://127.0.0.1:62862/ldg/v1/film-b'
  ], { loop: false, startPositionSeconds: 60 });

  assert.deepEqual(commands, [
    'clear',
    'enqueue http://127.0.0.1:62862/ldg/v1/film-b',
    'loop off',
    'play',
    'volume 256',
    'status',
    'seek 60',
    'status',
    'get_time',
    'get_length',
    'pause',
    'status',
    'pause',
    'status'
  ]);
  assert.equal(commands.includes('goto 1'), false);
  assert.equal(controller.getPlaybackStatus().positionSeconds, 60);
});

test('offset playback stays paused behind the cover until VLC confirms the target frame', async () => {
  const events = [];
  let controller;
  let pauseCommands = 0;
  controller = new VlcController({
    transitionDuration: 1,
    onTransitionStart: () => events.push('cover-start'),
    onTransitionEnd: () => events.push(`cover-end:${controller.state}`)
  });
  controller.ready = true;
  controller.send = command => {
    events.push(command);
    if (command === 'status' && controller._confirmedInputIndex < 0) {
      setTimeout(() => {
        controller._setCurrentInput('file:///C:/media/feature.mp4');
        controller._parseRc('status change: ( play state: 3 )\n');
      }, 5);
    }
    if (command === 'pause') {
      pauseCommands += 1;
      setTimeout(() => controller._parseRc(
        `status change: ( ${pauseCommands === 1 ? 'pause' : 'play'} state: 3 )\n`
      ), 5);
    }
    if (command === 'seek 60') {
      setTimeout(() => controller._parseRc('status change: ( time: 60s )\n'), 5);
    }
    return true;
  };

  await controller.replacePlaylist(['C:\\media\\feature.mp4'], {
    loop: false,
    startPositionSeconds: 60
  });

  const coverEnd = events.indexOf('cover-end:paused');
  const seek = events.indexOf('seek 60');
  const resume = events.lastIndexOf('pause');
  assert.ok(seek >= 0 && seek < coverEnd);
  assert.ok(coverEnd >= 0 && coverEnd < resume);
  assert.equal(controller.state, 'playing');
});

test('fresh state confirmation does not accept a matching cached paused state', async () => {
  const controller = new VlcController({ resumeInputTimeoutMs: 250 });
  controller._setState('paused');
  let resolved = false;
  const confirmation = controller._waitForFreshPlaybackState('paused').then(() => { resolved = true; });

  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(resolved, false);
  controller._parseRc("Type 'pause' to continue.\n");
  await confirmation;
  assert.equal(resolved, true);
});

test('failed offset preparation resumes VLC and always removes the transition cover', async () => {
  const events = [];
  let playCommands = 0;
  const controller = new VlcController({
    transitionDuration: 1,
    resumeInputTimeoutMs: 600,
    onTransitionStart: () => events.push('cover-start'),
    onTransitionEnd: () => events.push('cover-end')
  });
  controller.ready = true;
  controller.send = command => {
    events.push(command);
    if (command === 'play') playCommands += 1;
    if (command === 'status' && controller._confirmedInputIndex < 0) {
      setTimeout(() => {
        controller._setCurrentInput('file:///C:/media/feature.mp4');
        controller._parseRc('status change: ( play state: 3 )\n');
      }, 5);
    } else if (command === 'status' && playCommands >= 2) {
      setTimeout(() => controller._parseRc('status change: ( play state: 3 )\n'), 5);
    }
    // Deliberately never acknowledge seek 60.
    return true;
  };

  await assert.rejects(
    controller.replacePlaylist(['C:\\media\\feature.mp4'], {
      loop: false,
      startPositionSeconds: 60
    }),
    /did not confirm playback position/
  );

  assert.equal(playCommands, 2);
  assert.equal(controller.state, 'playing');
  assert.deepEqual(events.filter(event => event.startsWith('cover-')), ['cover-start', 'cover-end']);
});

test('playlist replacement waits for the black transition cover before decoding', async () => {
  const events = [];
  const controller = new VlcController({
    transitionDuration: 1,
    onTransitionStart: async () => {
      events.push('cover-start');
      await new Promise(resolve => setTimeout(resolve, 10));
      events.push('cover-ready');
    },
    onTransitionEnd: async () => {
      events.push('cover-end');
    }
  });
  controller.ready = true;
  controller.send = command => {
    events.push(command);
    if (command === 'status') {
      setTimeout(() => {
        controller._setCurrentInput('file:///C:/media/film.mp4');
        controller._parseRc('status change: ( play state: 3 )\n');
      }, 10);
    }
    return true;
  };

  await controller.replacePlaylist(['C:\\media\\film.mp4'], { loop: false });

  assert.ok(events.indexOf('cover-ready') < events.indexOf('clear'));
  assert.ok(events.indexOf('cover-end') > events.indexOf('play'));
});

test('replacing a naturally ended input confirms a fresh stop before starting the next film', async () => {
  const controller = new VlcController({ replacementStopTimeoutMs: 250 });
  const commands = [];
  controller.ready = true;
  controller.currentPlaylist = ['C:\\media\\film A.mp4'];
  controller._setCurrentInput('file:///C:/media/film%20A.mp4');
  // This is the no-gap boundary: VLC already reported idle, but still owns
  // the previous decoder and its 19/25 second metrics.
  controller._setState('idle');
  controller.playback.positionSeconds = 19;
  controller.playback.lengthSeconds = 25;
  controller.send = command => {
    commands.push(command);
    if (command === 'stop') {
      setTimeout(() => controller._parseRc('( stop state: 0 )\n'), 10);
    }
    if (command === 'status' && commands.includes('play')) {
      setTimeout(() => {
        controller._setCurrentInput('file:///C:/media/film%20B.mp4');
        controller._parseRc('status change: ( play state: 3 )\n');
      }, 10);
    }
    return true;
  };

  await controller.replacePlaylist(['C:\\media\\film B.mp4'], { loop: false });

  assert.ok(commands.indexOf('stop') < commands.indexOf('clear'));
  assert.ok(commands.indexOf('clear') < commands.indexOf('enqueue file:///C:/media/film%20B.mp4'));
  assert.ok(commands.indexOf('enqueue file:///C:/media/film%20B.mp4') < commands.indexOf('play'));
  assert.equal(controller.getPlaybackStatus().currentPath, 'C:\\media\\film B.mp4');
  assert.equal(controller.getPlaybackStatus().positionSeconds, 0);
  assert.equal(controller.getPlaybackStatus().lengthSeconds, 0);
});

test('playlist replacement restarts VLC when stop acknowledgement is missing', async () => {
  const controller = new VlcController({ replacementStopTimeoutMs: 250 });
  const commands = [];
  let restarts = 0;
  controller.ready = true;
  controller.currentPlaylist = ['C:\\media\\film A.mp4'];
  controller._setCurrentInput('file:///C:/media/film%20A.mp4');
  controller.send = command => {
    commands.push(command);
    if (command === 'status' && commands.includes('play')) {
      setTimeout(() => {
        controller._setCurrentInput('file:///C:/media/film%20B.mp4');
        controller._parseRc('status change: ( play state: 3 )\n');
      }, 10);
    }
    return true;
  };
  controller._stopForOutputChange = async () => {
    restarts += 1;
    controller.ready = false;
  };
  controller.start = async () => {
    controller.ready = true;
  };

  await controller.replacePlaylist(['C:\\media\\film B.mp4'], { loop: false });

  assert.equal(restarts, 1);
  assert.ok(commands.indexOf('stop') < commands.indexOf('clear'));
  assert.equal(controller.getPlaybackStatus().currentPath, 'C:\\media\\film B.mp4');
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
  controller.currentPlaylist = ['C:\\media\\film A.mp4'];
  controller._setCurrentInput('file:///C:/media/film%20A.mp4');
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
  controller._parseRc('( new input: file:///C:/media/film%20B.mp4 )\n');
  controller._pendingMetricResponses = ['positionSeconds', 'lengthSeconds'];
  controller._parseRc('42\n120\n');

  assert.deepEqual(controller.getPlaybackStatus(), {
    currentPath: 'C:\\media\\film B.mp4',
    currentIndex: 1,
    positionSeconds: 42,
    lengthSeconds: 120,
    updatedAt: controller.getPlaybackStatus().updatedAt
  });
  assert.ok(controller.getPlaybackStatus().updatedAt);
});

test('repeated status for the same input preserves pending time and length metrics', () => {
  const controller = new VlcController();
  controller.currentPlaylist = ['C:\\media\\film B.mp4'];
  controller._setCurrentInput('file:///C:/media/film%20B.mp4');
  controller._pendingMetricResponses = ['positionSeconds', 'lengthSeconds'];

  controller._parseRc([
    '( new input: file:///C:/media/film%20B.mp4 )',
    '68',
    '132',
    ''
  ].join('\n'));

  assert.equal(controller.getPlaybackStatus().currentIndex, 0);
  assert.equal(controller.getPlaybackStatus().positionSeconds, 68);
  assert.equal(controller.getPlaybackStatus().lengthSeconds, 132);
  assert.deepEqual(controller._pendingMetricResponses, []);
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

test('resumePlaylistAt does not reload an input VLC already confirmed', async () => {
  const controller = new VlcController();
  const commands = [];
  controller.ready = true;
  controller.currentPlaylist = ['C:\\media\\film B.mp4'];
  controller._setCurrentInput('file:///C:/media/film%20B.mp4');
  controller.send = command => commands.push(command);

  await controller.resumePlaylistAt(0, 60);

  assert.deepEqual(commands, [
    'seek 60',
    'status',
    'get_time',
    'get_length'
  ]);
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
  controller.currentPlaylist = ['C:\\media\\film A.mp4'];
  controller._setCurrentInput('file:///C:/media/film%20A.mp4');
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

test('late metrics from the previous film cannot overwrite a replacement input', () => {
  const controller = new VlcController();
  const commands = [];
  controller.currentPlaylist = ['C:\\media\\film A.mp4'];
  controller._setCurrentInput('file:///C:/media/film%20A.mp4');
  controller.playback.positionSeconds = 19;
  controller.playback.lengthSeconds = 25;
  controller._pendingMetricResponses = ['positionSeconds', 'lengthSeconds'];

  controller._beginInputTransition(['C:\\media\\film B.mp4']);
  controller._parseRc('19\n25\n');

  assert.deepEqual(controller.getPlaybackStatus(), {
    currentPath: 'C:\\media\\film B.mp4',
    currentIndex: 0,
    positionSeconds: 0,
    lengthSeconds: 0,
    updatedAt: controller.getPlaybackStatus().updatedAt
  });
  assert.equal(controller._metricsBlockedUntilInput, true);
  controller.send = command => commands.push(command);
  controller._pollPlayback();
  assert.deepEqual(commands, ['status']);

  controller._parseRc('( new input: file:///C:/media/film%20B.mp4 )\n');
  controller._pollPlayback();
  controller._parseRc('3\n120\n');
  assert.equal(controller.getPlaybackStatus().positionSeconds, 3);
  assert.equal(controller.getPlaybackStatus().lengthSeconds, 120);
  assert.deepEqual(commands, ['status', 'status', 'get_time', 'get_length']);
});
