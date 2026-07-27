'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { CoreRequestError } = require('../src/auth/core-client');
const { IdentityController } = require('../src/identity-controller');

test('startup without a stored refresh token stays signed out and does not start product agents', async () => {
  const fixture = makeFixture({ storedRefreshToken: null });
  const state = await fixture.controller.start();

  assert.equal(state.phase, 'signed_out');
  assert.equal(fixture.host.calls.invalidate, 1);
  assert.equal(fixture.host.calls.bootstrap, 0);
  assert.equal(fixture.host.calls.listAgents, 0);
});

test('valid zero-credit subscription reaches ready only after Core and Host agree', async () => {
  const fixture = makeFixture({ storedRefreshToken: 'old-refresh-token' });
  const state = await fixture.controller.start();

  assert.equal(state.phase, 'ready');
  assert.equal(state.credits.balance, 0);
  assert.equal(state.agents[0].agentId, 'job-agent');
  assert.equal(fixture.tokenStore.saved, 'rotated-refresh-token');
  assert.equal(fixture.host.calls.bootstrap, 1);
  assert.equal(fixture.host.calls.listAgents, 1);
  assert.equal(JSON.stringify(state).includes('access-token'), false);
  assert.equal(JSON.stringify(state).includes('refresh-token'), false);
  assert.equal(Object.hasOwn(state.agents[0], 'workspaceDir'), false);
  assert.equal(Object.hasOwn(state.agents[0], 'mainSessionId'), false);
  assert.equal(Object.hasOwn(state.agents[0], 'lastError'), false);
});

test('invalid subscription exposes only the blocked identity state and preserves local sessions', async () => {
  const fixture = makeFixture({
    storedRefreshToken: 'old-refresh-token',
    coreBootstrap: bootstrap({ canEnter: false, status: 'expired', reason: 'subscription_expired' }),
    hostBootstrap: hostBootstrap({ canEnter: false, status: 'expired', reason: 'subscription_expired' }),
  });
  const state = await fixture.controller.start();

  assert.equal(state.phase, 'blocked');
  assert.equal(state.access.reason, 'subscription_expired');
  assert.equal(fixture.host.calls.bootstrap, 1);
  assert.equal(fixture.host.calls.listAgents, 0);
  assert.equal(fixture.host.calls.stop, 0);
  assert.equal(fixture.tokenStore.cleared, 0);
  assert.equal(Object.hasOwn(state, 'agents'), false);
});

test('expired refresh token clears secure identity and requires a new login', async () => {
  const fixture = makeFixture({
    storedRefreshToken: 'expired-refresh-token',
    refreshError: new CoreRequestError('session_expired', '登录状态已失效，请重新登录', 401),
  });
  const state = await fixture.controller.start();

  assert.equal(state.phase, 'signed_out');
  assert.equal(state.code, 'session_expired');
  assert.equal(fixture.tokenStore.cleared, 1);
  assert.equal(fixture.host.calls.invalidate, 1);
});

test('valid Core access fails closed when the local Host cannot verify it', async () => {
  const fixture = makeFixture({
    storedRefreshToken: 'old-refresh-token',
    hostError: new Error('host missing'),
  });
  const state = await fixture.controller.start();

  assert.equal(state.phase, 'unavailable');
  assert.equal(state.code, 'host_unavailable');
  assert.equal(fixture.host.calls.invalidate, 1);
  assert.equal(Object.hasOwn(state, 'agents'), false);
});

test('login persists only the refresh token and activation is available only from ready', async () => {
  const fixture = makeFixture({ storedRefreshToken: null });
  const state = await fixture.controller.login('user@example.com', 'password');

  assert.equal(state.phase, 'ready');
  assert.equal(fixture.tokenStore.saved, 'login-refresh-token');
  const activated = await fixture.controller.activateAgent('job-agent');
  assert.equal(activated.agents[0].runtimeState, 'resident');
  assert.equal(fixture.host.calls.activateAgent, 1);
});

test('Agent activation failures never project raw Host errors into Renderer state', async () => {
  const fixture = makeFixture({ storedRefreshToken: 'old-refresh-token' });
  await fixture.controller.start();
  fixture.host.activateAgent = async () => {
    fixture.host.calls.activateAgent += 1;
    throw Object.assign(new Error('failed at /private/account with sk-private'), {
      code: 'host_request_failed',
    });
  };

  const state = await fixture.controller.activateAgent('job-agent');

  assert.equal(state.activationError, 'Agent 激活失败，请稍后重试');
  assert.equal(JSON.stringify(state).includes('/private/account'), false);
  assert.equal(JSON.stringify(state).includes('sk-private'), false);
});

test('an unexpected Host exit immediately closes an already-open Agent workspace', async () => {
  const fixture = makeFixture({ storedRefreshToken: 'old-refresh-token' });
  await fixture.controller.start();
  assert.equal(fixture.controller.getState().phase, 'ready');

  fixture.host.emit('exit', new Error('host crashed'));

  assert.equal(fixture.controller.getState().phase, 'unavailable');
  assert.equal(fixture.controller.getState().code, 'host_exited');
  assert.equal(Object.hasOwn(fixture.controller.getState(), 'agents'), false);
});

test('Leader reconnect refreshes identity once and bootstraps the replacement Host', async () => {
  const fixture = makeFixture({ storedRefreshToken: 'old-refresh-token' });
  await fixture.controller.start();
  fixture.core.tokenPair = {
    access_token: 'reconnected-access-token',
    refresh_token: 'reconnected-refresh-token',
  };

  fixture.host.emit('reconnected');
  fixture.host.emit('reconnected');
  fixture.host.emit('reconnected');
  await waitFor(() => fixture.controller.getState().revalidatedBy === 'host_reconnected');

  assert.equal(fixture.controller.getState().phase, 'ready');
  assert.equal(fixture.core.refreshCalls, 2);
  assert.equal(fixture.host.calls.bootstrap, 2);
  assert.deepEqual(fixture.host.bootstrapTokens, [
    'rotated-access-token',
    'reconnected-access-token',
  ]);
  assert.equal(fixture.tokenStore.saved, 'reconnected-refresh-token');
});

test('Leader reconnect fails closed when Core cannot refresh identity', async () => {
  const fixture = makeFixture({ storedRefreshToken: 'old-refresh-token' });
  await fixture.controller.start();
  fixture.core.refreshError = new Error('Core temporarily unavailable');

  fixture.host.emit('reconnected');
  await waitFor(() => fixture.controller.getState().phase === 'unavailable');

  assert.equal(fixture.host.calls.bootstrap, 1);
  assert.equal(fixture.host.calls.invalidate, 1);
  assert.equal(Object.hasOwn(fixture.controller.getState(), 'agents'), false);
  assert.equal(JSON.stringify(fixture.controller.getState()).includes('rotated-access-token'), false);
});

function makeFixture({
  storedRefreshToken,
  coreBootstrap = bootstrap({ canEnter: true }),
  hostBootstrap: hostBootstrapResult = hostBootstrap({ canEnter: true }),
  refreshError = null,
  hostError = null,
} = {}) {
  const tokenStore = {
    value: storedRefreshToken,
    saved: null,
    cleared: 0,
    loadRefreshToken() { return this.value; },
    saveRefreshToken(value) { this.value = value; this.saved = value; },
    clear() { this.value = null; this.cleared += 1; },
  };
  const core = {
    refreshCalls: 0,
    refreshError,
    tokenPair: {
      access_token: 'rotated-access-token',
      refresh_token: 'rotated-refresh-token',
    },
    async login() {
      return { access_token: 'login-access-token', refresh_token: 'login-refresh-token' };
    },
    async refresh() {
      this.refreshCalls += 1;
      if (this.refreshError) throw this.refreshError;
      return this.tokenPair;
    },
    async bootstrap() { return coreBootstrap; },
  };
  const host = Object.assign(new EventEmitter(), {
    calls: { bootstrap: 0, listAgents: 0, activateAgent: 0, invalidate: 0, stop: 0 },
    bootstrapTokens: [],
    async bootstrap(accessToken) {
      this.calls.bootstrap += 1;
      this.bootstrapTokens.push(accessToken);
      if (hostError) throw hostError;
      return hostBootstrapResult;
    },
    async listAgents() {
      this.calls.listAgents += 1;
      return { agents: [{
        agentId: 'job-agent',
        displayName: 'Job Agent',
        description: 'Career copilot',
        version: '0.1.0',
        runtimeState: 'available',
        desiredState: 'stopped',
        workspaceDir: '/private/user/workspace',
        mainSessionId: 'private-session-id',
        lastError: 'private-host-detail',
      }] };
    },
    async activateAgent() { this.calls.activateAgent += 1; },
    async invalidate() { this.calls.invalidate += 1; },
    async stop() { this.calls.stop += 1; },
  });
  const controller = new IdentityController({
    core,
    tokenStore,
    host,
    setIntervalImpl: () => ({ unref() {} }),
    clearIntervalImpl: () => {},
  });
  const originalList = host.listAgents.bind(host);
  host.listAgents = async () => {
    const result = await originalList();
    if (host.calls.activateAgent) {
      result.agents[0].runtimeState = 'resident';
      result.agents[0].desiredState = 'running';
    }
    return result;
  };
  return { controller, core, host, tokenStore };
}

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('等待异步状态更新超时');
}

function bootstrap({ canEnter, status = 'active', reason = 'subscription_active' }) {
  return {
    schema_version: 1,
    server_time: '2026-07-22T01:00:00Z',
    account: {
      id: 7,
      email: 'user@example.com',
      account_id: 11,
      display_name: 'Ferdinand',
      avatar_url: null,
    },
    subscription: {
      status,
      source: 'monthly_pass',
      plan: 'pro',
      period_start: '2026-07-01 00:00:00',
      period_end: '2026-08-01 00:00:00',
      auto_renews: true,
    },
    credits: { balance: 0, source: 'account', expires_at: null },
    access: { can_enter_client: canEnter, reason },
  };
}

function hostBootstrap({ canEnter, status = 'active', reason = 'subscription_active' }) {
  return {
    schemaVersion: 1,
    account: { id: 7, email: 'user@example.com', accountId: 11 },
    subscription: { status },
    credits: { balance: 0 },
    access: { canEnterClient: canEnter, reason },
  };
}
