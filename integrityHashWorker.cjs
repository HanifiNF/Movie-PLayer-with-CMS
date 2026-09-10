'use strict';

const crypto = require('crypto');
const fs = require('fs');
const { parentPort, workerData } = require('worker_threads');

const filePath = workerData && workerData.filePath;
const hash = crypto.createHash('sha256');
const input = fs.createReadStream(filePath, { highWaterMark: 4 * 1024 * 1024 });
let processedBytes = 0;
let lastReportedAt = 0;

input.on('data', chunk => {
  hash.update(chunk);
  processedBytes += chunk.length;
  const now = Date.now();
  if (now - lastReportedAt >= 250) {
    lastReportedAt = now;
    parentPort.postMessage({ type: 'progress', processedBytes });
  }
});

input.on('error', error => {
  parentPort.postMessage({ type: 'error', error: error.message || String(error) });
});

input.on('end', () => {
  parentPort.postMessage({
    type: 'complete',
    processedBytes,
    digest: hash.digest('hex')
  });
});
