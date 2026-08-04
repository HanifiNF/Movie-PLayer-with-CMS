'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { CmsClient, CmsApiError, normalizeServerUrl } = require('../cmsClient.cjs');

function response(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return payload; }
  };
}

test('normalizeServerUrl accepts HTTP URLs and removes trailing slashes', () => {
  assert.equal(normalizeServerUrl(' http://localhost:8080/// '), 'http://localhost:8080');
  assert.throws(() => normalizeServerUrl('file:///tmp/cms'), CmsApiError);
  assert.throws(() => normalizeServerUrl('http://user:pass@localhost:8080'), CmsApiError);
});

test('register sends the enrollment payload to the CMS', async () => {
  let request;
  const client = new CmsClient({
    serverURL: 'http://localhost:8080',
    fetch: async (url, options) => {
      request = { url, options };
      return response(201, { data: { device_id: 'device-1', token: 'secret-token' } });
    }
  });

  const result = await client.register({ enrollment_code: 'ABCD-2345' });

  assert.equal(request.url, 'http://localhost:8080/api/player/register');
  assert.equal(request.options.method, 'POST');
  assert.deepEqual(JSON.parse(request.options.body), { enrollment_code: 'ABCD-2345' });
  assert.equal(result.token, 'secret-token');
});

test('heartbeat authenticates with Bearer token and reports online', async () => {
  let authorization;
  const client = new CmsClient({
    serverURL: 'http://localhost:8080',
    heartbeatIntervalMs: 60000,
    fetch: async (_url, options) => {
      authorization = options.headers.Authorization;
      return response(200, { data: { device_id: 'device-1', connection_status: 'online' } });
    }
  });

  const heartbeat = once(client, 'heartbeat');
  client.start('secret-token', { app_version: '1.1.0' });
  const [data] = await heartbeat;
  client.stop();

  assert.equal(authorization, 'Bearer secret-token');
  assert.equal(data.connection_status, 'online');
  assert.equal(client.status, 'online');
});

test('invalid player token stops heartbeat and exposes authentication error', async () => {
  const client = new CmsClient({
    serverURL: 'http://localhost:8080',
    fetch: async () => response(401, {
      error: { code: 'invalid_player_token', message: 'The player token is invalid.' }
    })
  });

  const authenticationError = once(client, 'authentication-error');
  client.start('revoked-token');
  const [error] = await authenticationError;

  assert.equal(error.code, 'invalid_player_token');
  assert.equal(client.status, 'authentication-error');
  assert.equal(client.running, false);
});
