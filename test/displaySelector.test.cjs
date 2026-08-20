'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { choosePlaybackDisplay, chooseIdleDisplay } = require('../displaySelector.cjs');

test('one monitor uses the primary display without a dedicated idle screen', () => {
  const primary = { id: 10, label: 'Laptop' };
  const selection = choosePlaybackDisplay([primary], primary);

  assert.equal(selection.display, primary);
  assert.equal(selection.hasDedicatedDisplay, false);
  assert.equal(selection.hasSecondaryDisplay, false);
});

test('two monitors choose the non-primary display regardless of array order', () => {
  const primary = { id: 10, label: 'Laptop' };
  const external = { id: 20, label: 'Cinema output' };

  assert.equal(choosePlaybackDisplay([external, primary], primary).display, external);
  assert.equal(choosePlaybackDisplay([primary, external], primary).display, external);
  assert.equal(
    choosePlaybackDisplay([primary, external], primary).hasDedicatedDisplay,
    true
  );
  assert.equal(choosePlaybackDisplay([primary, external], primary).hasSecondaryDisplay, true);
});

test('manual selection may explicitly target the primary display', () => {
  const primary = { id: 10, label: 'Laptop' };
  const external = { id: 20, label: 'Cinema output' };
  const selection = choosePlaybackDisplay([primary, external], primary, '10');

  assert.equal(selection.display, primary);
  assert.equal(selection.hasDedicatedDisplay, false);
  assert.equal(selection.hasSecondaryDisplay, true);
});

test('idle output follows playback by default and may target another monitor', () => {
  const primary = { id: 10, label: 'Laptop' };
  const playback = { id: 20, label: 'Cinema output' };

  assert.equal(chooseIdleDisplay([primary, playback], playback).display, playback);
  assert.equal(chooseIdleDisplay([primary, playback], playback, '10').display, primary);
});

test('disconnected idle output falls back to playback output', () => {
  const primary = { id: 10, label: 'Laptop' };
  const playback = { id: 20, label: 'Cinema output' };
  const selection = chooseIdleDisplay([primary, playback], playback, '30');

  assert.equal(selection.display, playback);
  assert.equal(selection.preferredAvailable, false);
});
