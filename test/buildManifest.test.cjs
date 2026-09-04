'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

test('every local CommonJS runtime dependency is included in the packaged build', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const included = new Set(packageJson.build && packageJson.build.files || []);
  const runtimeFiles = fs.readdirSync(root).filter(name => name.endsWith('.cjs'));
  const required = new Set();
  const pattern = /require\(['"]\.\/([^'"]+)['"]\)/g;

  for (const filename of runtimeFiles) {
    const source = fs.readFileSync(path.join(root, filename), 'utf8');
    for (const match of source.matchAll(pattern)) required.add(match[1]);
  }

  const missing = [...required].filter(filename => !included.has(filename)).sort();
  assert.deepEqual(missing, [], `Packaged build is missing: ${missing.join(', ')}`);
});

test('packaged build includes the idle video at the runtime location', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const resources = packageJson.build && packageJson.build.extraResources || [];
  assert.ok(
    resources.some(item => item.from === 'assets/idle-black.mp4' && item.to === 'idle/idle-black.mp4'),
    'Idle video extraResource mapping is missing'
  );
  assert.equal(fs.existsSync(path.join(root, 'assets', 'idle-black.mp4')), true, 'Idle video source is missing');
});

test('packaged VLC excludes its location-sensitive plugin cache', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const resources = packageJson.build && packageJson.build.extraResources || [];
  const vlcResource = resources.find(item => item.from === 'vlc-portable' && item.to === 'vlc');

  assert.ok(vlcResource, 'VLC extraResource mapping is missing');
  assert.ok(vlcResource.filter.includes('!plugins/plugins.dat'));
});
