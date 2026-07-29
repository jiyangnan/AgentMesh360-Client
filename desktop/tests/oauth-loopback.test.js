'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DesktopOAuthBroker,
  DesktopOAuthError,
  validateAuthorizationUrl,
} = require('../src/auth/oauth-loopback');

function startUrl(provider, request) {
  const url = new URL(`https://core.example/v1/auth/oauth/${provider}/start`);
  url.searchParams.set('client', 'desktop');
  url.searchParams.set('redirect_uri', request.redirectUri);
  url.searchParams.set('state', request.state);
  url.searchParams.set('code_challenge', request.codeChallenge);
  return url.toString();
}

test('system-browser OAuth returns a PKCE-bound token pair without exposing tokens to the callback', async () => {
  let authorization;
  let exchange;
  const core = {
    oauthStartUrl(provider, request) {
      authorization = { provider, ...request };
      return startUrl(provider, request);
    },
    async exchangeDesktopOAuth(request) {
      exchange = request;
      return {
        access_token: 'desktop-access-token',
        refresh_token: 'desktop-refresh-token',
      };
    },
  };
  const broker = new DesktopOAuthBroker({
    core,
    allowedCoreOrigin: 'https://core.example',
    openExternal: async (url) => {
      assert.equal(new URL(url).origin, 'https://core.example');
      setImmediate(async () => {
        const callback = new URL(authorization.redirectUri);
        callback.searchParams.set('code', 'o'.repeat(43));
        callback.searchParams.set('state', authorization.state);
        const response = await fetch(callback);
        assert.equal(response.status, 200);
        assert.equal((await response.text()).includes('desktop-access-token'), false);
      });
    },
  });

  const pair = await broker.login('google');

  assert.equal(pair.refresh_token, 'desktop-refresh-token');
  assert.equal(authorization.provider, 'google');
  assert.match(authorization.redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback\//);
  assert.match(authorization.state, /^[A-Za-z0-9_-]{43}$/);
  assert.match(authorization.codeChallenge, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(exchange.code, 'o'.repeat(43));
  assert.equal(exchange.redirectUri, authorization.redirectUri);
  assert.match(exchange.codeVerifier, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(exchange.codeVerifier, authorization.codeChallenge);
});

test('callback state mismatch fails closed without exchanging the code', async () => {
  let authorization;
  let exchanges = 0;
  const core = {
    oauthStartUrl(provider, request) {
      authorization = request;
      return startUrl(provider, request);
    },
    async exchangeDesktopOAuth() {
      exchanges += 1;
      return {};
    },
  };
  const broker = new DesktopOAuthBroker({
    core,
    allowedCoreOrigin: 'https://core.example',
    openExternal: async () => {
      setImmediate(async () => {
        const callback = new URL(authorization.redirectUri);
        callback.searchParams.set('code', 'stolen-code');
        callback.searchParams.set('state', 'wrong-state');
        await fetch(callback);
      });
    },
  });

  await assert.rejects(
    broker.login('github'),
    (error) => error instanceof DesktopOAuthError
      && error.code === 'oauth_state_mismatch',
  );
  assert.equal(exchanges, 0);
});

test('provider cancellation returns a stable token-free error', async () => {
  let authorization;
  const broker = new DesktopOAuthBroker({
    core: {
      oauthStartUrl(provider, request) {
        authorization = request;
        return startUrl(provider, request);
      },
      async exchangeDesktopOAuth() {
        throw new Error('must not exchange');
      },
    },
    allowedCoreOrigin: 'https://core.example',
    openExternal: async () => {
      setImmediate(async () => {
        const callback = new URL(authorization.redirectUri);
        callback.searchParams.set('error', 'oauth_cancelled');
        callback.searchParams.set('state', authorization.state);
        await fetch(callback);
      });
    },
  });

  await assert.rejects(
    broker.login('google'),
    (error) => error instanceof DesktopOAuthError
      && error.code === 'oauth_cancelled'
      && !error.message.includes('token'),
  );
});

test('only Google and GitHub may start external OAuth', async () => {
  const broker = new DesktopOAuthBroker({
    core: { oauthStartUrl() {} },
    allowedCoreOrigin: 'https://core.example',
    openExternal: async () => {},
  });
  await assert.rejects(
    broker.login('unknown'),
    (error) => error instanceof DesktopOAuthError
      && error.code === 'oauth_provider_unsupported',
  );
});

test('authorization URL validation rejects a rewritten state before opening the browser', () => {
  const request = {
    redirectUri: 'http://127.0.0.1:43123/oauth/callback/desktop_callback_123456',
    state: 's'.repeat(43),
    codeChallenge: 'c'.repeat(43),
  };
  const rewritten = new URL(startUrl('google', request));
  rewritten.searchParams.set('state', 'x'.repeat(43));

  assert.throws(
    () => validateAuthorizationUrl(
      rewritten.toString(),
      'https://core.example',
      'google',
      request,
    ),
    (error) => error instanceof DesktopOAuthError
      && error.code === 'oauth_authorization_url_invalid',
  );
});

test('OAuth timeout closes the loopback attempt with a stable error', async () => {
  const broker = new DesktopOAuthBroker({
    core: {
      oauthStartUrl(provider, request) {
        return startUrl(provider, request);
      },
      async exchangeDesktopOAuth() {
        throw new Error('must not exchange');
      },
    },
    allowedCoreOrigin: 'https://core.example',
    openExternal: async () => {},
    timeoutMs: 10,
  });

  await assert.rejects(
    broker.login('google'),
    (error) => error instanceof DesktopOAuthError
      && error.code === 'oauth_timeout',
  );
});

test('a second OAuth attempt is rejected while the first browser flow is active', async () => {
  let authorization;
  const broker = new DesktopOAuthBroker({
    core: {
      oauthStartUrl(provider, request) {
        authorization = request;
        return startUrl(provider, request);
      },
      async exchangeDesktopOAuth() {
        throw new Error('must not exchange');
      },
    },
    allowedCoreOrigin: 'https://core.example',
    openExternal: async () => {},
  });

  const first = broker.login('google');
  const firstRejected = assert.rejects(
    first,
    (error) => error.code === 'oauth_cancelled',
  );
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(
    broker.login('github'),
    (error) => error instanceof DesktopOAuthError
      && error.code === 'oauth_busy',
  );
  const callback = new URL(authorization.redirectUri);
  callback.searchParams.set('error', 'oauth_cancelled');
  callback.searchParams.set('state', authorization.state);
  await fetch(callback);
  await firstRejected;
});
