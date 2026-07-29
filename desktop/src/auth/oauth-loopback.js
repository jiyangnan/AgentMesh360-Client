'use strict';

const crypto = require('node:crypto');
const http = require('node:http');

const SUPPORTED_PROVIDERS = new Set(['google', 'github']);
const DEFAULT_TIMEOUT_MS = 3 * 60 * 1000;

class DesktopOAuthError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DesktopOAuthError';
    this.code = code;
  }
}

class DesktopOAuthBroker {
  constructor({
    core,
    allowedCoreOrigin,
    openExternal,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    createServer = http.createServer,
    randomBytes = crypto.randomBytes,
  }) {
    if (!core || typeof core.oauthStartUrl !== 'function') {
      throw new Error('OAuth Core client is required');
    }
    if (typeof openExternal !== 'function') {
      throw new Error('OAuth external browser opener is required');
    }
    this.core = core;
    this.allowedCoreOrigin = validateCoreOrigin(allowedCoreOrigin);
    this.openExternal = openExternal;
    this.timeoutMs = timeoutMs;
    this.createServer = createServer;
    this.randomBytes = randomBytes;
    this.activeLogin = null;
  }

  login(provider) {
    if (!SUPPORTED_PROVIDERS.has(provider)) {
      return Promise.reject(new DesktopOAuthError(
        'oauth_provider_unsupported',
        '当前客户端不支持此登录方式',
      ));
    }
    if (this.activeLogin) {
      return Promise.reject(new DesktopOAuthError(
        'oauth_busy',
        '已有一个登录窗口正在等待完成',
      ));
    }
    this.activeLogin = this.#run(provider).finally(() => {
      this.activeLogin = null;
    });
    return this.activeLogin;
  }

  async #run(provider) {
    const state = randomValue(this.randomBytes);
    const codeVerifier = randomValue(this.randomBytes);
    const codeChallenge = crypto
      .createHash('sha256')
      .update(codeVerifier, 'ascii')
      .digest('base64url');
    const callbackToken = randomValue(this.randomBytes);
    const receiver = await createLoopbackReceiver({
      callbackToken,
      expectedState: state,
      timeoutMs: this.timeoutMs,
      createServer: this.createServer,
    });
    try {
      const authorizationUrl = this.core.oauthStartUrl(provider, {
        redirectUri: receiver.redirectUri,
        state,
        codeChallenge,
      });
      validateAuthorizationUrl(
        authorizationUrl,
        this.allowedCoreOrigin,
        provider,
        {
          redirectUri: receiver.redirectUri,
          state,
          codeChallenge,
        },
      );
      try {
        await this.openExternal(authorizationUrl);
      } catch {
        throw new DesktopOAuthError(
          'oauth_open_failed',
          '无法打开系统浏览器，请稍后重试',
        );
      }
      const callback = await receiver.result;
      return await this.core.exchangeDesktopOAuth({
        code: callback.code,
        codeVerifier,
        redirectUri: receiver.redirectUri,
      });
    } finally {
      await receiver.close();
    }
  }
}

async function createLoopbackReceiver({
  callbackToken,
  expectedState,
  timeoutMs,
  createServer,
}) {
  const expectedPath = `/oauth/callback/${callbackToken}`;
  let settle;
  let fail;
  let settled = false;
  let timer = null;
  const result = new Promise((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  const finish = (fn, value) => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    fn(value);
  };
  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url || '/', 'http://127.0.0.1');
    if (request.method !== 'GET' || requestUrl.pathname !== expectedPath) {
      writeCallbackResponse(response, 404, '登录回调地址无效。');
      return;
    }
    const returnedState = requestUrl.searchParams.get('state') || '';
    if (!safeEqual(returnedState, expectedState)) {
      writeCallbackResponse(response, 400, '登录校验失败，请返回客户端重试。');
      finish(
        fail,
        new DesktopOAuthError(
          'oauth_state_mismatch',
          '登录回调校验失败，请重新登录',
        ),
      );
      return;
    }
    const providerError = requestUrl.searchParams.get('error');
    if (providerError) {
      writeCallbackResponse(response, 200, '登录已取消，可以关闭此页面。');
      finish(
        fail,
        new DesktopOAuthError(
          providerError === 'oauth_cancelled'
            ? 'oauth_cancelled'
            : 'oauth_failed',
          providerError === 'oauth_cancelled'
            ? '登录已取消'
            : '第三方登录失败，请重试',
        ),
      );
      return;
    }
    const code = requestUrl.searchParams.get('code') || '';
    if (!/^[A-Za-z0-9_-]{32,160}$/.test(code)) {
      writeCallbackResponse(response, 400, '登录授权码无效，请返回客户端重试。');
      finish(
        fail,
        new DesktopOAuthError(
          'oauth_invalid_code',
          '登录授权码无效，请重新登录',
        ),
      );
      return;
    }
    writeCallbackResponse(response, 200, '登录完成，可以关闭此页面并返回 AgentMesh360。');
    finish(settle, { code });
  });
  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(0, '127.0.0.1');
  }).catch((error) => {
    throw new DesktopOAuthError(
      'oauth_loopback_unavailable',
      error?.code === 'EADDRINUSE'
        ? '登录回调端口被占用，请重试'
        : '无法建立本机登录回调，请检查系统网络权限',
    );
  });
  server.on('error', (error) => {
    finish(
      fail,
      new DesktopOAuthError(
        'oauth_loopback_unavailable',
        error?.code === 'EADDRINUSE'
          ? '登录回调端口被占用，请重试'
          : '无法建立本机登录回调，请检查系统网络权限',
      ),
    );
  });
  const address = server.address();
  const redirectUri = `http://127.0.0.1:${address.port}${expectedPath}`;
  timer = setTimeout(() => {
    finish(
      fail,
      new DesktopOAuthError(
        'oauth_timeout',
        '登录等待超时，请重新发起',
      ),
    );
  }, timeoutMs);
  timer.unref?.();
  return {
    redirectUri,
    result,
    close: () => closeServer(server),
  };
}

function writeCallbackResponse(response, statusCode, message) {
  response.writeHead(statusCode, {
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
    'Content-Type': 'text/html; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(
    '<!doctype html><meta charset="utf-8">'
    + '<style>body{font:16px system-ui;margin:48px;color:#172033}</style>'
    + `<p>${escapeHtml(message)}</p>`,
  );
}

function closeServer(server) {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve) => server.close(() => resolve()));
}

function randomValue(randomBytes) {
  return randomBytes(32).toString('base64url');
}

function safeEqual(left, right) {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function validateCoreOrigin(value) {
  const parsed = new URL(String(value || ''));
  const isSecure = parsed.protocol === 'https:';
  const isLocalDevelopment = parsed.protocol === 'http:'
    && ['127.0.0.1', '::1'].includes(parsed.hostname);
  if ((!isSecure && !isLocalDevelopment) || parsed.origin !== parsed.toString().replace(/\/$/, '')) {
    throw new Error('OAuth Core origin is invalid');
  }
  return parsed.origin;
}

function validateAuthorizationUrl(
  value,
  allowedOrigin,
  provider,
  { redirectUri, state, codeChallenge } = {},
) {
  const parsed = new URL(value);
  if (
    parsed.origin !== allowedOrigin
    || parsed.pathname !== `/v1/auth/oauth/${provider}/start`
    || parsed.searchParams.get('client') !== 'desktop'
    || parsed.searchParams.get('redirect_uri') !== redirectUri
    || parsed.searchParams.get('state') !== state
    || parsed.searchParams.get('code_challenge') !== codeChallenge
  ) {
    throw new DesktopOAuthError(
      'oauth_authorization_url_invalid',
      '登录服务返回了不受信任的授权地址',
    );
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
  })[character]);
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  DesktopOAuthBroker,
  DesktopOAuthError,
  createLoopbackReceiver,
  validateAuthorizationUrl,
};
