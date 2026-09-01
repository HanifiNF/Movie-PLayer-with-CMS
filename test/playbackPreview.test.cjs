'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  resolvePreviewState,
  selectDisplaySource,
  shouldCapturePreview
} = require('../playbackPreview.cjs');

test('preview requires a dedicated output and an actively rendered film', () => {
  assert.equal(resolvePreviewState({ hasDedicatedDisplay: false, now: {}, vlcState: 'playing' }).status, 'unavailable');
  assert.equal(resolvePreviewState({ hasDedicatedDisplay: true, now: null, vlcState: 'idle' }).status, 'waiting');
  assert.equal(resolvePreviewState({ hasDedicatedDisplay: true, now: { phase: 'gap' }, vlcState: 'idle' }).status, 'gap');
  assert.equal(resolvePreviewState({ hasDedicatedDisplay: true, now: { phase: 'film' }, vlcState: 'playing' }).status, 'live');
  assert.equal(resolvePreviewState({ hasDedicatedDisplay: true, now: { phase: 'film' }, vlcState: 'paused' }).status, 'paused');
  assert.equal(resolvePreviewState({ hasDedicatedDisplay: true, now: { phase: 'film' }, vlcState: 'error' }).status, 'error');
  assert.equal(shouldCapturePreview('live'), true);
  assert.equal(shouldCapturePreview('paused'), true);
  assert.equal(shouldCapturePreview('waiting'), false);
});

test('display source selection uses the stable Electron display id', () => {
  const sources = [
    { id: 'screen:1:0', display_id: '101' },
    { id: 'screen:2:0', display_id: '202' }
  ];
  assert.equal(selectDisplaySource(sources, 202), sources[1]);
  assert.equal(selectDisplaySource(sources, 'missing'), null);
  assert.equal(selectDisplaySource([], 202), null);
});
