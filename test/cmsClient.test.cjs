'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { CmsClient, CmsApiError, normalizeServerUrl, parseSessionExpiry } = require('../cmsClient.cjs');

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

test('parseSessionExpiry preserves timezone-aware timestamps', () => {
  assert.equal(
    parseSessionExpiry('2026-08-04T10:30:00+00:00'),
    Date.UTC(2026, 7, 4, 10, 30, 0)
  );
  assert.equal(
    parseSessionExpiry('2026-08-04T17:30:00+07:00'),
    Date.UTC(2026, 7, 4, 10, 30, 0)
  );
});

test('parseSessionExpiry treats legacy timezone-less CMS timestamps as UTC', () => {
  assert.equal(
    parseSessionExpiry('2026-08-04 10:30:00'),
    Date.UTC(2026, 7, 4, 10, 30, 0)
  );
  assert.equal(parseSessionExpiry('invalid', 1000), 30 * 60 * 1000 + 1000);
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

test('operator login, available devices, and claim use separate operator token', async () => {
  const requests = [];
  const client = new CmsClient({
    serverURL: 'http://localhost:8080',
    fetch: async (url, options) => {
      requests.push({ url, options });
      if (url.endsWith('/api/auth/login')) return response(200, { data: { token: 'operator-token', user: { role: 'operator' } } });
      if (url.endsWith('/api/operator/devices/available')) return response(200, { data: [{ id: 'device-1', name: 'Lobby' }] });
      return response(201, { data: { token: 'device-token', device_id: 'device-1' } });
    }
  });

  const auth = await client.operatorLogin('operator@example.com', 'password');
  const devices = await client.availableDevices(auth.token);
  const claim = await client.claim(auth.token, { device_id: devices[0].id, device_fingerprint: 'install-1' });

  assert.equal(claim.token, 'device-token');
  assert.equal(requests[1].options.headers.Authorization, 'Bearer operator-token');
  assert.equal(requests[1].options.body, undefined);
  assert.equal(requests[2].options.headers.Authorization, 'Bearer operator-token');
});

test('dashboard control authorization is scoped to a specific device', async () => {
  let request;
  const client = new CmsClient({
    serverURL: 'http://localhost:8080',
    fetch: async (url, options) => {
      request = { url, options };
      return response(200, { data: { authorized: true, device_id: 'device-1' } });
    }
  });

  const result = await client.authorizeDeviceControl('operator-token', 'device-1');

  assert.equal(result.authorized, true);
  assert.equal(request.url, 'http://localhost:8080/api/operator/devices/device-1/control-access');
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.headers.Authorization, 'Bearer operator-token');
});

test('heartbeat authenticates with Bearer token and reports online', async () => {
  let authorization;
  const client = new CmsClient({
    serverURL: 'http://localhost:8080',
    heartbeatIntervalMs: 60000,
    fetch: async (_url, options) => {
      authorization = options.headers.Authorization;
      return response(200, { data: {
        device_id: 'device-1', device_name: 'Player Jakarta', device_location: 'Jakarta',
        device_timezone: 'Asia/Jakarta', connection_status: 'online'
      } });
    }
  });

  const heartbeat = once(client, 'heartbeat');
  client.start('secret-token', { app_version: '1.1.0' });
  const [data] = await heartbeat;
  client.stop();

  assert.equal(authorization, 'Bearer secret-token');
  assert.equal(data.connection_status, 'online');
  assert.equal(data.device_name, 'Player Jakarta');
  assert.equal(data.device_location, 'Jakarta');
  assert.equal(client.status, 'online');
});

test('heartbeatNow performs an immediate authenticated refresh without waiting for timer', async () => {
  let requestCount = 0;
  const client = new CmsClient({
    serverURL: 'http://localhost:8080',
    heartbeatIntervalMs: 60000,
    fetch: async () => {
      requestCount += 1;
      return response(200, { data: { device_id: 'device-1', connection_status: 'online' } });
    }
  });

  const firstHeartbeat = once(client, 'heartbeat');
  client.start('device-token', { app_version: '1.1.0' });
  await firstHeartbeat;
  const refreshed = await client.heartbeatNow();

  assert.equal(requestCount, 2);
  assert.equal(refreshed.device_id, 'device-1');
  client.stop();
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
