'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { scanBeforeRemoteDistribution } = require('../assetRefresh.cjs');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('returns the local scan without waiting for upload or remote download', async () => {
  const upload = deferred();
  const download = deferred();
  const inventory = { assets: [{ media_key: 'local:film' }], displayItems: [{ title: 'Film A' }] };
  let displayed = null;
  let distributionStarted = false;

  const result = await scanBeforeRemoteDistribution({
    collectInventory: async () => inventory,
    onInventory: value => { displayed = value; },
    uploadInventory: () => upload.promise,
    synchronizeDistribution: () => {
      distributionStarted = true;
      return download.promise;
    }
  });

  assert.equal(result.inventory, inventory);
  assert.equal(displayed, inventory);
  assert.equal(distributionStarted, false, 'distribution remains in the background behind inventory upload');

  upload.resolve({ reported: 1 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(distributionStarted, true);

  let backgroundFinished = false;
  void result.background.then(() => { backgroundFinished = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(backgroundFinished, false, 'an active download must not hold the scan result');

  download.resolve({ downloads: { failed: [] } });
  const background = await result.background;
  assert.deepEqual(background.errors, []);
});

test('still starts distribution when the immediate inventory upload fails', async () => {
  const errors = [];
  let distributionStarted = false;
  const result = await scanBeforeRemoteDistribution({
    collectInventory: async () => ({ assets: [], displayItems: [] }),
    uploadInventory: async () => { throw new Error('CMS unavailable'); },
    synchronizeDistribution: async () => {
      distributionStarted = true;
      return { downloads: { failed: [] } };
    },
    onBackgroundError: (error, phase) => errors.push({ phase, message: error.message })
  });

  const background = await result.background;
  assert.equal(distributionStarted, true);
  assert.deepEqual(errors, [{ phase: 'inventory-upload', message: 'CMS unavailable' }]);
  assert.deepEqual(background.errors, [{ phase: 'inventory-upload', error: 'CMS unavailable' }]);
});
