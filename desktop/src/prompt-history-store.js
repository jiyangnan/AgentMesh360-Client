'use strict';

const crypto = require('node:crypto');
const path = require('node:path');

const {
  authorityScope,
} = require('./workspace-authority-store');

const PROMPT_HISTORY_METHOD = 'x.ai/prompt_history';
const DEFAULT_RESULT_LIMIT = 20;
const MAX_RESULT_LIMIT = 50;
const MAX_HOST_PROMPTS = 1_000;
const MAX_CACHED_PROMPTS = 200;
const MAX_PROMPT_CHARS = 20_000;
const MAX_TOTAL_HOST_CHARS = 1_000_000;
const MAX_QUERY_CHARS = 200;
const MAX_PREVIEW_CHARS = 160;
const CONTROL_CHAR_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u;
const STRICT_CONTROL_CHAR_PATTERN = /[\u0000-\u001F\u007F-\u009F]/u;

/**
 * Main-process-only history projection. Private cwd/session authority is bound
 * separately from Renderer queries and injected into the Grok extension call.
 */
class PromptHistoryStore {
  constructor({ requestHistory } = {}) {
    if (typeof requestHistory !== 'function') throw new Error('Prompt History 缺少 Host 读取器');
    this.requestHistory = requestHistory;
    this.sessions = new Map();
  }

  /**
   * Trusted Main/Controller-only binding. privateSessionId must come from the
   * authenticated Session authority, never from Renderer IPC.
   */
  bindSession({
    accountId,
    agentId,
    sessionKey,
    privateCwd,
    privateSessionId,
  }) {
    const scope = authorityScope(accountId, agentId);
    const publicSessionKey = validateSessionKey(sessionKey, '会话引用');
    const cwd = validatePrivateCwd(privateCwd);
    const privateId = validateSessionKey(privateSessionId, '私有会话标识');
    const key = historyScopeKey(scope, publicSessionKey);
    const current = this.sessions.get(key);
    if (
      current
      && current.privateCwd === cwd
      && current.privateSessionId === privateId
    ) {
      return;
    }
    this.sessions.set(key, {
      scope,
      accountId,
      agentId,
      sessionKey: publicSessionKey,
      privateCwd: cwd,
      privateSessionId: privateId,
      generation: crypto.randomUUID(),
      nextRequestRevision: 0,
      appliedRequestRevision: 0,
      entries: [],
    });
  }

  unbindSession({ accountId, agentId, sessionKey }) {
    const scope = authorityScope(accountId, agentId);
    this.sessions.delete(historyScopeKey(scope, validateSessionKey(sessionKey, '会话引用')));
  }

  async search({
    accountId,
    agentId,
    sessionKey,
    query = '',
    limit = DEFAULT_RESULT_LIMIT,
  }) {
    const scope = authorityScope(accountId, agentId);
    const publicSessionKey = validateSessionKey(sessionKey, '会话引用');
    const key = historyScopeKey(scope, publicSessionKey);
    const state = this.sessions.get(key);
    if (!state) throw new Error('Prompt History 会话尚未建立');
    const generation = state.generation;
    const normalizedQuery = normalizeQuery(query);
    const resultLimit = boundedLimit(limit);
    const requestRevision = state.nextRequestRevision + 1;
    state.nextRequestRevision = requestRevision;

    this.#assertStillBound(key, state, generation);
    const response = await this.requestHistory({
      method: PROMPT_HISTORY_METHOD,
      params: {
        cwd: state.privateCwd,
        filter_session_id: state.privateSessionId,
      },
    }).catch(() => {
      // Host errors may echo private cwd/session parameters. Never bridge the
      // raw error string to Renderer.
      throw new Error('暂时无法读取 Prompt History');
    });
    const projected = projectHostHistory(response, scope, publicSessionKey);

    // Re-check the trusted Session binding after the asynchronous Host call.
    // Prompt history belongs to the Agent's private main-session workspace;
    // it must not depend on whether the user has separately authorized an @
    // file folder.
    this.#assertStillBound(key, state, generation);

    if (requestRevision >= state.appliedRequestRevision) {
      state.entries = projected;
      state.appliedRequestRevision = requestRevision;
    }
    return filterPublicHistory(state.entries, normalizedQuery, resultLimit);
  }

  select({ accountId, agentId, sessionKey, historyId }) {
    const scope = authorityScope(accountId, agentId);
    const publicSessionKey = validateSessionKey(sessionKey, '会话引用');
    const state = this.sessions.get(historyScopeKey(scope, publicSessionKey));
    if (!state) throw new Error('Prompt History 会话尚未建立');
    if (typeof historyId !== 'string' || !/^history-[0-9a-f]{32}$/.test(historyId)) {
      throw new Error('Prompt History 记录无效');
    }
    const entry = state.entries.find((candidate) => candidate.historyId === historyId);
    if (!entry) throw new Error('Prompt History 记录不存在');
    // Deliberately return editable text only. There is no send/sendNow action in
    // this API; the Renderer must place it back into the Composer for review.
    return { text: entry.text };
  }

  clearAccount(accountId) {
    const account = String(accountId ?? '');
    for (const [key, state] of this.sessions) {
      if (String(state.accountId) === account) this.sessions.delete(key);
    }
  }

  clearAll() {
    this.sessions.clear();
  }

  dispose() {
    this.clearAll();
  }

  #assertStillBound(key, state, generation) {
    const current = this.sessions.get(key);
    if (current !== state || current.generation !== generation) {
      throw new Error('Prompt History 会话授权已变化');
    }
  }
}

function projectHostHistory(value, scope, sessionKey) {
  if (!isPlainObject(value) || !Array.isArray(value.prompts) || value.prompts.length > MAX_HOST_PROMPTS) {
    throw new Error('Host 返回的 Prompt History 无效');
  }
  const seen = new Set();
  const entries = [];
  let totalChars = 0;
  for (const raw of value.prompts) {
    if (typeof raw !== 'string') throw new Error('Host 返回的 Prompt History 无效');
    // Bound UTF-16 code units before Array.from() allocates a code-point array.
    if (raw.length > MAX_PROMPT_CHARS * 2) {
      throw new Error('Host 返回的 Prompt History 超出安全范围');
    }
    const chars = Array.from(raw);
    totalChars += chars.length;
    if (chars.length > MAX_PROMPT_CHARS || totalChars > MAX_TOTAL_HOST_CHARS || CONTROL_CHAR_PATTERN.test(raw)) {
      throw new Error('Host 返回的 Prompt History 超出安全范围');
    }
    const text = normalizePromptText(raw);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    entries.push({
      historyId: historyId(scope, sessionKey, text),
      text,
      preview: previewText(text),
      searchable: normalizeSearchText(text),
    });
    if (entries.length >= MAX_CACHED_PROMPTS) break;
  }
  return entries;
}

function filterPublicHistory(entries, normalizedQuery, limit) {
  return entries
    .filter((entry) => !normalizedQuery || entry.searchable.includes(normalizedQuery))
    .slice(0, limit)
    .map((entry) => ({
      historyId: entry.historyId,
      preview: entry.preview,
    }));
}

function normalizePromptText(value) {
  return value.replace(/\r\n?/g, '\n').trim().normalize('NFC');
}

function previewText(value) {
  const compact = value.replace(/\s+/gu, ' ').trim();
  const chars = Array.from(compact);
  return chars.length <= MAX_PREVIEW_CHARS
    ? compact
    : `${chars.slice(0, MAX_PREVIEW_CHARS - 1).join('')}…`;
}

function normalizeQuery(value) {
  if (
    typeof value !== 'string'
    || Array.from(value).length > MAX_QUERY_CHARS
    || STRICT_CONTROL_CHAR_PATTERN.test(value)
  ) {
    throw new Error('Prompt History 搜索内容无效');
  }
  return normalizeSearchText(value.trim());
}

function normalizeSearchText(value) {
  return String(value).normalize('NFKC').toLocaleLowerCase('zh-CN');
}

function validateSessionKey(value, label) {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > 512
    || STRICT_CONTROL_CHAR_PATTERN.test(value)
  ) {
    throw new Error(`${label}无效`);
  }
  return value;
}

function validatePrivateCwd(value) {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > 4_096
    || !path.isAbsolute(value)
    || STRICT_CONTROL_CHAR_PATTERN.test(value)
  ) {
    throw new Error('Prompt History 私有工作区无效');
  }
  return value;
}

function boundedLimit(value) {
  if (value === undefined || value === null) return DEFAULT_RESULT_LIMIT;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_RESULT_LIMIT) {
    throw new Error('Prompt History 返回数量无效');
  }
  return value;
}

function historyScopeKey(scope, sessionKey) {
  return `${scope}\u0000${sessionKey}`;
}

function historyId(scope, sessionKey, text) {
  return `history-${crypto
    .createHash('sha256')
    .update(scope)
    .update('\u0000')
    .update(sessionKey)
    .update('\u0000')
    .update(text)
    .digest('hex')
    .slice(0, 32)}`;
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

module.exports = {
  MAX_CACHED_PROMPTS,
  MAX_RESULT_LIMIT,
  PROMPT_HISTORY_METHOD,
  PromptHistoryStore,
  projectHostHistory,
};
