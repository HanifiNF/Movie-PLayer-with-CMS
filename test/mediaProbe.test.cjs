'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { MediaProbe, probeMp4Duration } = require('../mediaProbe.cjs');

function mp4Box(type, payload) {
  const box = Buffer.alloc(8 + payload.length);
  box.writeUInt32BE(box.length, 0);
  box.write(type, 4, 4, 'ascii');
  payload.copy(box, 8);
  return box;
}

function makeMinimalMp4(durationSeconds) {
  const movieHeader = Buffer.alloc(100);
  movieHeader.writeUInt8(0, 0);
  movieHeader.writeUInt32BE(1000, 12);
  movieHeader.writeUInt32BE(durationSeconds * 1000, 16);
  return Buffer.concat([
    mp4Box('ftyp', Buffer.from('isom0000')),
    mp4Box('moov', mp4Box('mvhd', movieHeader))
  ]);
}

test('reads duration from MP4 movie metadata without ffprobe', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wir-probe-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const mediaPath = path.join(root, 'film.mp4');
  fs.writeFileSync(mediaPath, makeMinimalMp4(3725));

  assert.equal(probeMp4Duration(mediaPath), 3725000);
});

test('caches detected duration by file size and modified time', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wir-probe-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const mediaPath = path.join(root, 'film.mp4');
  fs.writeFileSync(mediaPath, makeMinimalMp4(90));
  const probe = new MediaProbe({ cachePath: path.join(root, 'duration-cache.json') });

  const first = await probe.probe(mediaPath);
  const second = await probe.probe(mediaPath);
  assert.equal(first.durationMs, 90000);
  assert.equal(second.durationMs, 90000);
  assert.equal(second.source, 'cache');
});

test('uses trusted asset duration metadata without opening the media file', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wir-probe-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const probe = new MediaProbe({ cachePath: path.join(root, 'duration-cache.json') });

  const result = await probe.probe(path.join(root, 'not-downloaded.mp4'), 123456);
  assert.deepEqual(result, { durationMs: 123456, source: 'asset-metadata' });
});
