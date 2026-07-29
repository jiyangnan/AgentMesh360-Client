'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { AgentMeshCoreClient, CoreRequestError } = require('../src/auth/core-client');

test('login posts credentials without adding an authorization header', async () => {
  let request;
  const client = new AgentMeshCoreClient({
    baseUrl: 'https://core.example',
    fetchImpl: async (url, options) => {
      request = { url, options };
      return response(200, { access_token: 'access-token', refresh_token: 'refresh-token' });
    },
  });

  const result = await client.login('user@example.com', 'secret');
  assert.equal(result.access_token, 'access-token');
  assert.equal(request.url, 'https://core.example/v1/auth/login');
  assert.deepEqual(JSON.parse(request.options.body), { email: 'user@example.com', password: 'secret' });
  assert.equal(request.options.headers.Authorization, undefined);
});

test('bootstrap sends the access token only through Authorization', async () => {
  let request;
  const client = new AgentMeshCoreClient({
    baseUrl: 'https://core.example/',
    fetchImpl: async (url, options) => {
      request = { url, options };
      return response(200, { schema_version: 1, access: { can_enter_client: true } });
    },
  });

  await client.bootstrap('private-access-token');
  assert.equal(request.url, 'https://core.example/v1/account/client-bootstrap');
  assert.equal(request.options.headers.Authorization, 'Bearer private-access-token');
  assert.equal(request.options.body, undefined);
});

test('desktop OAuth builds a trusted start URL and exchanges only the one-time code', async () => {
  let request;
  const client = new AgentMeshCoreClient({
    baseUrl: 'https://core.example',
    fetchImpl: async (url, options) => {
      request = { url, options };
      return response(200, {
        access_token: 'oauth-access-token',
        refresh_token: 'oauth-refresh-token',
      });
    },
  });
  const start = new URL(client.oauthStartUrl('google', {
    redirectUri: 'http://127.0.0.1:43123/oauth/callback/desktop_callback_123456',
    state: 's'.repeat(43),
    codeChallenge: 'c'.repeat(43),
  }));
  assert.equal(start.origin, 'https://core.example');
  assert.equal(start.pathname, '/v1/auth/oauth/google/start');
  assert.equal(start.searchParams.get('client'), 'desktop');
  assert.equal(start.searchParams.get('state'), 's'.repeat(43));

  await client.exchangeDesktopOAuth({
    code: 'one-time-code',
    codeVerifier: 'v'.repeat(43),
    redirectUri: 'http://127.0.0.1:43123/oauth/callback/desktop_callback_123456',
  });
  assert.equal(request.url, 'https://core.example/v1/auth/oauth/desktop/exchange');
  assert.deepEqual(JSON.parse(request.options.body), {
    code: 'one-time-code',
    code_verifier: 'v'.repeat(43),
    redirect_uri: 'http://127.0.0.1:43123/oauth/callback/desktop_callback_123456',
  });
  assert.equal(request.options.headers.Authorization, undefined);
});

test('HTTP authentication failures map to stable, token-free errors', async () => {
  const client = new AgentMeshCoreClient({
    fetchImpl: async () => response(401, { detail: 'private-access-token was rejected' }),
  });

  await assert.rejects(
    client.refresh('private-refresh-token'),
    (error) => error instanceof CoreRequestError
      && error.code === 'session_expired'
      && !error.message.includes('private'),
  );
});

test('server details are not reflected into desktop error messages', async () => {
  const client = new AgentMeshCoreClient({
    fetchImpl: async () => response(500, { detail: 'private-refresh-token leaked by upstream' }),
  });

  await assert.rejects(
    client.bootstrap('private-access-token'),
    (error) => error.code === 'http_500' && !error.message.includes('private'),
  );
});

function response(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  };
}
