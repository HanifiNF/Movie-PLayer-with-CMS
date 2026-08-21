'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { resolveVlcRcPort } = require('../runtimeIsolation.cjs');

test('production profile retains the configured VLC RC port', () => {
  assert.equal(resolveVlcRcPort(4212, 'C:\\Users\\Public\\Player', null, false), 4212);
});

test('development user-data profiles receive stable isolated VLC RC ports', () => {
  const studioOne = resolveVlcRcPort(4212, 'C:\\Temp\\studio-one', null, true);
  const studioOneAgain = resolveVlcRcPort(4212, 'C:\\Temp\\studio-one', null, true);
  const studioTwo = resolveVlcRcPort(4212, 'C:\\Temp\\studio-two', null, true);

  assert.equal(studioOne, studioOneAgain);
  assert.notEqual(studioOne, studioTwo);
  assert.ok(studioOne >= 20000 && studioOne < 40000);
  assert.ok(studioTwo >= 20000 && studioTwo < 40000);
});

test('explicit VLC RC port override has highest priority', () => {
  assert.equal(resolveVlcRcPort(4212, 'C:\\Temp\\studio-one', '24567', true), 24567);
});
