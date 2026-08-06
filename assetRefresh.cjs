'use strict';

function errorMessage(error) {
  return error && error.message ? error.message : String(error);
}

async function scanBeforeRemoteDistribution(options = {}) {
  if (typeof options.collectInventory !== 'function') {
    throw new Error('collectInventory is required');
  }

  const inventory = await options.collectInventory();
  if (typeof options.onInventory === 'function') options.onInventory(inventory);

  const background = (async () => {
    const errors = [];
    if (typeof options.uploadInventory === 'function') {
      try {
        await options.uploadInventory(inventory);
      } catch (error) {
        errors.push({ phase: 'inventory-upload', error: errorMessage(error) });
        if (typeof options.onBackgroundError === 'function') {
          options.onBackgroundError(error, 'inventory-upload');
        }
      }
    }

    let distribution = null;
    if (typeof options.synchronizeDistribution === 'function') {
      try {
        distribution = await options.synchronizeDistribution();
      } catch (error) {
        errors.push({ phase: 'remote-distribution', error: errorMessage(error) });
        if (typeof options.onBackgroundError === 'function') {
          options.onBackgroundError(error, 'remote-distribution');
        }
      }
    }
    return { distribution, errors };
  })();

  return { inventory, background };
}

module.exports = { scanBeforeRemoteDistribution };
