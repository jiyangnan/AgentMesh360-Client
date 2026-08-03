'use strict';

const { CoreRequestError } = require('./auth/core-client');

const DEFAULT_REVALIDATE_INTERVAL_MS = 5 * 60 * 1000;
const USABLE_RESIDENT_STATES = new Set([
  'resident',
  'working',
  'needs_input',
  'dormant',
]);

class IdentityController {
  constructor({
    core,
    tokenStore,
    host,
    oauth = null,
    setIntervalImpl = setInterval,
    clearIntervalImpl = clearInterval,
    revalidateIntervalMs = DEFAULT_REVALIDATE_INTERVAL_MS,
  }) {
    this.core = core;
    this.tokenStore = tokenStore;
    this.host = host;
    this.oauth = oauth;
    this.setIntervalImpl = setIntervalImpl;
    this.clearIntervalImpl = clearIntervalImpl;
    this.revalidateIntervalMs = revalidateIntervalMs;
    this.accessToken = null;
    this.listeners = new Set();
    this.timer = null;
    this.activeOperation = null;
    this.hostReconnectPromise = null;
    this.shuttingDown = false;
    this.validationRevision = 0;
    this.state = Object.freeze({ phase: 'starting' });
    this.handleHostExit = (error) => {
      if (!['ready', 'checking'].includes(this.state.phase)) return;
      this.accessToken = null;
      this.#publishUnavailable(error, true, 'host_exited');
    };
    this.handleHostReconnect = () => {
      this.#recoverHostAccessAfterReconnect().catch(() => {});
    };
    this.host.on?.('exit', this.handleHostExit);
    this.host.on?.('reconnected', this.handleHostReconnect);
  }

  getState() {
    return this.state;
  }

  subscribe(listener) {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  isRevalidationDue(now = Date.now()) {
    if (this.state.phase !== 'ready' || this.activeOperation) return false;
    const checkedAt = Date.parse(this.state.checkedAt || '');
    return !Number.isFinite(checkedAt) || now - checkedAt >= this.revalidateIntervalMs;
  }

  async start() {
    if (!this.timer) {
      this.timer = this.setIntervalImpl(() => {
        this.revalidate('periodic').catch(() => {});
      }, this.revalidateIntervalMs);
      this.timer?.unref?.();
    }
    let refreshToken;
    try {
      refreshToken = this.tokenStore.loadRefreshToken();
    } catch (error) {
      this.#publish({
        phase: 'unavailable',
        code: 'secure_store_error',
        message: error.message,
        canLogout: true,
      });
      return this.state;
    }
    if (!refreshToken) {
      await this.host.invalidate().catch(() => {});
      this.#publish({ phase: 'signed_out' });
      return this.state;
    }
    return this.#runValidation(refreshToken, 'startup');
  }

  login(email, password) {
    return this.#completeLogin(
      () => this.core.login(String(email || '').trim(), String(password || '')),
      '正在登录并验证订阅…',
      'login',
    );
  }

  loginWithOAuth(provider) {
    if (!this.oauth) {
      return Promise.reject(new Error('第三方登录服务尚未初始化'));
    }
    return this.#completeLogin(
      () => this.oauth.login(String(provider || '').toLowerCase()),
      '请在系统浏览器完成登录，客户端正在等待安全回调…',
      'oauth',
    );
  }

  revalidate(reason = 'manual') {
    if (this.activeOperation) return this.activeOperation;
    let refreshToken;
    try {
      refreshToken = this.tokenStore.loadRefreshToken();
    } catch (error) {
      this.#publishUnavailable(error, true, 'secure_store_error');
      return Promise.resolve(this.state);
    }
    if (!refreshToken) {
      this.#publish({ phase: 'signed_out' });
      return Promise.resolve(this.state);
    }
    return this.#runValidation(refreshToken, reason);
  }

  logout() {
    return this.#exclusive(async () => {
      this.tokenStore.clear();
      this.accessToken = null;
      await this.host.invalidate().catch(() => {});
      this.#publish({ phase: 'signed_out' });
      return this.state;
    });
  }

  activateAgent(agentId) {
    const anotherAgentIsActivating = Boolean(
      this.activeOperation
      && this.state.phase === 'ready'
      && this.state.activatingAgentId
      && this.state.activatingAgentId !== agentId,
    );
    const requestedAgentIsAlreadyResident = this.state.agents?.some((agent) => (
      agent.agentId === agentId
      && agent.desiredState === 'running'
      && USABLE_RESIDENT_STATES.has(agent.runtimeState)
    )) === true;
    if (anotherAgentIsActivating && requestedAgentIsAlreadyResident) {
      return Promise.resolve(this.state);
    }
    return this.#exclusive(async () => {
      if (this.state.phase !== 'ready' || !this.accessToken) {
        throw new Error('当前账号尚未通过订阅验证');
      }
      this.#publish({ ...this.state, activatingAgentId: agentId, activationError: null });
      try {
        await this.host.activateAgent(agentId);
        const list = await this.host.listAgents();
        this.#publish({ ...this.state, agents: publicAgents(list.agents), activatingAgentId: null });
      } catch (error) {
        this.#publish({
          ...this.state,
          activatingAgentId: null,
          activationError: publicActivationError(error),
        });
      }
      return this.state;
    });
  }

  async shutdown() {
    this.shuttingDown = true;
    if (this.timer) this.clearIntervalImpl(this.timer);
    this.timer = null;
    this.accessToken = null;
    this.host.off?.('exit', this.handleHostExit);
    this.host.off?.('reconnected', this.handleHostReconnect);
    await this.hostReconnectPromise?.catch(() => {});
    await this.host.stop();
  }

  #recoverHostAccessAfterReconnect() {
    if (this.shuttingDown || this.hostReconnectPromise) {
      return this.hostReconnectPromise || Promise.resolve(this.state);
    }
    this.hostReconnectPromise = Promise.resolve()
      .then(async () => {
        const inFlight = this.activeOperation;
        if (inFlight) await inFlight.catch(() => {});
        if (
          this.shuttingDown
          || !['ready', 'checking', 'blocked', 'unavailable'].includes(this.state.phase)
        ) {
          return this.state;
        }
        return this.revalidate('host_reconnected');
      })
      .finally(() => {
        this.hostReconnectPromise = null;
      });
    return this.hostReconnectPromise;
  }

  #completeLogin(loadPair, message, reason) {
    return this.#exclusive(async () => {
      this.#publish({ phase: 'checking', message });
      let pair;
      try {
        pair = await loadPair();
        validateTokenPair(pair);
        this.tokenStore.saveRefreshToken(pair.refresh_token);
      } catch (error) {
        this.accessToken = null;
        await this.host.invalidate().catch(() => {});
        if (
          (
            error instanceof CoreRequestError
            && ['invalid_credentials', 'email_not_verified'].includes(error.code)
          )
          || String(error?.code || '').startsWith('oauth_')
        ) {
          this.#publish({
            phase: 'signed_out',
            error: error.message,
            code: error.code,
          });
          return this.state;
        }
        this.#publishUnavailable(error, true);
        return this.state;
      }
      return this.#validatePair(pair, reason);
    });
  }

  #runValidation(refreshToken, reason) {
    return this.#exclusive(async () => {
      const isBackgroundRevalidation = this.state.phase === 'ready';
      if (!isBackgroundRevalidation) {
        const preserve = this.state.phase === 'blocked' ? this.state : null;
        this.#publish({
          ...(preserve || {}),
          phase: 'checking',
          message: reason === 'startup' ? '正在恢复安全登录状态…' : '正在重新验证订阅…',
        });
      }
      let pair;
      try {
        pair = await this.core.refresh(refreshToken);
        validateTokenPair(pair);
        this.tokenStore.saveRefreshToken(pair.refresh_token);
      } catch (error) {
        this.accessToken = null;
        await this.host.invalidate().catch(() => {});
        if (error instanceof CoreRequestError && error.code === 'session_expired') {
          this.tokenStore.clear();
          this.#publish({ phase: 'signed_out', error: '登录已过期，请重新登录', code: error.code });
          return this.state;
        }
        this.#publishUnavailable(error, true);
        return this.state;
      }
      return this.#validatePair(pair, reason);
    });
  }

  async #validatePair(pair, reason) {
    this.accessToken = pair.access_token;
    let coreBootstrap;
    try {
      coreBootstrap = await this.core.bootstrap(this.accessToken);
      validateCoreBootstrap(coreBootstrap);
    } catch (error) {
      this.accessToken = null;
      await this.host.invalidate().catch(() => {});
      if (error instanceof CoreRequestError && error.code === 'session_expired') {
        this.tokenStore.clear();
        this.#publish({ phase: 'signed_out', error: '登录已过期，请重新登录', code: error.code });
        return this.state;
      }
      this.#publishUnavailable(error, true);
      return this.state;
    }

    const normalized = normalizeBootstrap(coreBootstrap);
    if (!normalized.access.canEnterClient) {
      await this.host.bootstrap(this.accessToken).catch(() => this.host.invalidate().catch(() => {}));
      this.#publish({
        phase: 'blocked',
        account: normalized.account,
        subscription: normalized.subscription,
        credits: normalized.credits,
        access: normalized.access,
        checkedAt: new Date().toISOString(),
      });
      return this.state;
    }

    try {
      const hostBootstrap = await this.host.bootstrap(this.accessToken);
      if (
        hostBootstrap?.schemaVersion !== 1
        || hostBootstrap?.access?.canEnterClient !== true
        || hostBootstrap?.account?.id !== normalized.account.id
      ) {
        throw new Error('订阅验证结果不一致');
      }
      const list = await this.host.listAgents();
      this.#publish({
        phase: 'ready',
        account: normalized.account,
        subscription: normalized.subscription,
        credits: normalized.credits,
        access: normalized.access,
        agents: publicAgents(list?.agents),
        checkedAt: new Date().toISOString(),
        revalidatedBy: reason,
        validationRevision: ++this.validationRevision,
      });
    } catch (error) {
      await this.host.invalidate().catch(() => {});
      this.#publishUnavailable(error, true, 'host_unavailable');
    }
    return this.state;
  }

  #exclusive(operation) {
    if (this.activeOperation) return this.activeOperation;
    this.activeOperation = Promise.resolve()
      .then(operation)
      .finally(() => {
        this.activeOperation = null;
      });
    return this.activeOperation;
  }

  #publishUnavailable(error, canLogout, code) {
    this.#publish({
      phase: 'unavailable',
      code: code || error?.code || 'verification_unavailable',
      message: error?.message || '暂时无法验证 AgentMesh360 订阅',
      canLogout,
    });
  }

  #publish(next) {
    this.state = deepFreeze(stripSecrets(next));
    for (const listener of this.listeners) listener(this.state);
  }
}

function validateTokenPair(pair) {
  if (
    typeof pair?.access_token !== 'string'
    || typeof pair?.refresh_token !== 'string'
    || pair.access_token.length < 8
    || pair.refresh_token.length < 8
  ) {
    throw new Error('AgentMesh360 登录服务返回了无效令牌');
  }
}

function validateCoreBootstrap(bootstrap) {
  if (bootstrap?.schema_version !== 1 || typeof bootstrap?.access?.can_enter_client !== 'boolean') {
    throw new Error('AgentMesh360 订阅服务返回了不受支持的协议');
  }
}

function normalizeBootstrap(value) {
  return {
    account: {
      id: value.account.id,
      email: value.account.email,
      accountId: value.account.account_id,
      displayName: value.account.display_name || null,
      avatarUrl: value.account.avatar_url || null,
    },
    subscription: {
      status: value.subscription.status,
      source: value.subscription.source,
      plan: value.subscription.plan || null,
      periodStart: value.subscription.period_start || null,
      periodEnd: value.subscription.period_end || null,
      autoRenews: Boolean(value.subscription.auto_renews),
    },
    credits: {
      balance: Number(value.credits.balance || 0),
      source: value.credits.source,
      expiresAt: value.credits.expires_at || null,
    },
    access: {
      canEnterClient: value.access.can_enter_client,
      reason: value.access.reason,
    },
  };
}

function stripSecrets(value) {
  const clone = JSON.parse(JSON.stringify(value));
  const secretKeys = new Set([
    'accesstoken',
    'access_token',
    'refreshtoken',
    'refresh_token',
    'password',
    'authorization',
    'apikey',
    'api_key',
  ]);
  const visit = (current) => {
    if (!current || typeof current !== 'object') return;
    for (const key of Object.keys(current)) {
      if (secretKeys.has(key.toLowerCase())) {
        delete current[key];
      } else {
        visit(current[key]);
      }
    }
  };
  visit(clone);
  return clone;
}

function publicAgents(agents) {
  if (!Array.isArray(agents)) return [];
  return agents.map((agent) => ({
    agentId: String(agent.agentId || ''),
    displayName: String(agent.displayName || ''),
    description: String(agent.description || ''),
    version: String(agent.version || ''),
    desiredState: String(agent.desiredState || 'stopped'),
    runtimeState: String(agent.runtimeState || 'available'),
  }));
}

function publicActivationError(error) {
  const code = String(error?.code || '');
  if (code.includes('auth') || code.includes('subscription') || code.includes('access')) {
    return '订阅验证已失效，请重新检查后再试';
  }
  return 'Agent 激活失败，请稍后重试';
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

module.exports = {
  IdentityController,
  DEFAULT_REVALIDATE_INTERVAL_MS,
  normalizeBootstrap,
  publicActivationError,
  publicAgents,
  stripSecrets,
  validateCoreBootstrap,
  validateTokenPair,
};
