'use strict';

const DEFAULT_CORE_URL = 'https://api.agentmesh360.com';

class CoreRequestError extends Error {
  constructor(code, message, status = 0) {
    super(message);
    this.name = 'CoreRequestError';
    this.code = code;
    this.status = status;
  }
}

class AgentMeshCoreClient {
  constructor({ baseUrl = process.env.AGENTMESH360_CORE_URL || DEFAULT_CORE_URL, fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
    if (typeof fetchImpl !== 'function') throw new Error('fetch implementation is required');
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  login(email, password) {
    return this.#request('/v1/auth/login', {
      method: 'POST',
      body: { email, password },
      errorContext: 'login',
    });
  }

  oauthStartUrl(provider, { redirectUri, state, codeChallenge }) {
    if (!['google', 'github'].includes(provider)) {
      throw new CoreRequestError(
        'oauth_provider_unsupported',
        '当前客户端不支持此登录方式',
      );
    }
    const url = new URL(`${this.baseUrl}/v1/auth/oauth/${provider}/start`);
    url.searchParams.set('client', 'desktop');
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', codeChallenge);
    return url.toString();
  }

  exchangeDesktopOAuth({ code, codeVerifier, redirectUri }) {
    return this.#request('/v1/auth/oauth/desktop/exchange', {
      method: 'POST',
      body: {
        code,
        code_verifier: codeVerifier,
        redirect_uri: redirectUri,
      },
      errorContext: 'oauth_exchange',
    });
  }

  refresh(refreshToken) {
    return this.#request('/v1/auth/refresh', {
      method: 'POST',
      body: { refresh_token: refreshToken },
      errorContext: 'refresh',
    });
  }

  bootstrap(accessToken) {
    return this.#request('/v1/account/client-bootstrap', {
      method: 'GET',
      accessToken,
      errorContext: 'bootstrap',
    });
  }

  async #request(path, { method, body, accessToken, errorContext }) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers = { Accept: 'application/json' };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const payload = await safeJson(response);
      if (!response.ok) throw mapHttpError(response.status, payload, errorContext);
      if (!payload || typeof payload !== 'object') {
        throw new CoreRequestError('invalid_response', 'AgentMesh360 服务返回了无效响应');
      }
      return payload;
    } catch (error) {
      if (error instanceof CoreRequestError) throw error;
      if (error?.name === 'AbortError') {
        throw new CoreRequestError('timeout', '连接 AgentMesh360 服务超时');
      }
      throw new CoreRequestError('network_unavailable', '暂时无法连接 AgentMesh360 服务');
    } finally {
      clearTimeout(timeout);
    }
  }
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function mapHttpError(status, payload, context) {
  if (context === 'login' && status === 401) {
    return new CoreRequestError('invalid_credentials', '邮箱或密码不正确', status);
  }
  if (context === 'login' && status === 403) {
    return new CoreRequestError('email_not_verified', '请先通过邮件完成账号验证', status);
  }
  if ((context === 'refresh' || context === 'bootstrap') && status === 401) {
    return new CoreRequestError('session_expired', '登录状态已失效，请重新登录', status);
  }
  if (context === 'oauth_exchange' && [400, 401].includes(status)) {
    return new CoreRequestError(
      'oauth_exchange_failed',
      '第三方登录凭据已失效，请重新登录',
      status,
    );
  }
  return new CoreRequestError(
    `http_${status}`,
    `AgentMesh360 服务请求失败（${status}）`,
    status,
  );
}

module.exports = {
  AgentMeshCoreClient,
  CoreRequestError,
  DEFAULT_CORE_URL,
};
