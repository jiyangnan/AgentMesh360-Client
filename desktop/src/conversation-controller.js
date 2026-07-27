'use strict';

const path = require('node:path');

const AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,98}[a-z0-9]$/;
const MAX_PROMPT_CHARS = 16_000;
const MAX_CHUNK_CHARS = 32_000;
const MAX_PUBLIC_MESSAGES = 200;
const MAX_PUBLIC_TRANSCRIPT_CHARS = 200_000;
const SESSION_UPDATE_METHODS = new Set([
  'session/update',
  'x.ai/session/update',
  '_x.ai/session/update',
]);
const SAFE_STOP_REASONS = new Set([
  'end_turn',
  'max_tokens',
  'max_turn_requests',
  'refusal',
  'cancelled',
]);

class AgentConversationController {
  constructor({ identity, host, activateAgent }) {
    this.identity = identity;
    this.host = host;
    this.activateAgent = activateAgent;
    this.listeners = new Set();
    this.authority = null;
    this.accountId = null;
    this.messages = [];
    this.messageCounter = 0;
    this.transcriptTruncated = false;
    this.openPromise = null;
    this.openAgentId = null;
    this.snapshot = Object.freeze({ phase: 'idle' });
    this.handleIdentity = (state) => this.#handleIdentity(state);
    this.handleNotification = (message) => this.#handleNotification(message);
    this.handleReconnect = () => this.#handleReconnect();
    this.unsubscribeIdentity = this.identity.subscribe(this.handleIdentity);
    this.host.on?.('notification', this.handleNotification);
    this.host.on?.('reconnected', this.handleReconnect);
  }

  getSnapshot() {
    return this.snapshot;
  }

  subscribe(listener) {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => this.listeners.delete(listener);
  }

  async open(agentId) {
    validateAgentId(agentId);
    if (this.openPromise) {
      if (this.openAgentId === agentId) return this.openPromise;
      throw new Error('另一个 Agent 对话正在打开');
    }
    this.openAgentId = agentId;
    this.openPromise = this.#open(agentId).finally(() => {
      this.openPromise = null;
      this.openAgentId = null;
    });
    return this.openPromise;
  }

  async send(value) {
    const text = validatePrompt(value);
    const authority = this.authority;
    if (!authority) {
      const message = this.snapshot.phase === 'error'
        ? '请重新打开 Agent 对话'
        : '尚未打开 Agent 对话';
      throw new Error(message);
    }
    this.#requireReadyAccount(authority.accountId);
    if (this.snapshot.streaming) throw new Error('上一条消息仍在处理中');

    this.#publish({
      ...this.#conversationBase(authority),
      phase: 'sending',
      streaming: true,
      error: null,
      stopReason: null,
    });
    try {
      const response = await this.host.promptSession({
        sessionId: authority.sessionId,
        text,
      });
      if (this.authority !== authority) return this.snapshot;
      this.#publish({
        ...this.#conversationBase(authority),
        phase: 'ready',
        streaming: false,
        error: null,
        stopReason: safeStopReason(response?.stopReason),
      });
    } catch (error) {
      if (this.authority !== authority) return this.snapshot;
      if (error?.code === 'host_timeout') {
        this.authority = null;
        this.#publish({
          ...this.#conversationBase(authority),
          phase: 'error',
          streaming: false,
          error: 'Agent 响应超时，请重新打开对话以恢复最新状态。',
          stopReason: null,
        });
        return this.snapshot;
      }
      this.#publish({
        ...this.#conversationBase(authority),
        phase: 'ready',
        streaming: false,
        error: safeConversationError(error, '发送失败，请稍后重试。'),
        stopReason: null,
      });
    }
    return this.snapshot;
  }

  close() {
    this.#reset();
    return this.snapshot;
  }

  dispose() {
    this.unsubscribeIdentity?.();
    this.host.off?.('notification', this.handleNotification);
    this.host.off?.('reconnected', this.handleReconnect);
    this.listeners.clear();
    this.authority = null;
  }

  async #open(agentId) {
    const state = this.#requireReadyAccount();
    const publicAgent = state.agents?.find((agent) => agent.agentId === agentId);
    if (!publicAgent) throw new Error('当前账号没有此 Agent');
    this.authority = null;
    this.messages = [];
    this.messageCounter = 0;
    this.transcriptTruncated = false;
    this.#publish({
      phase: 'loading',
      agentId,
      displayName: publicAgent.displayName || agentId,
      messages: [],
      streaming: false,
      transcriptTruncated: false,
      error: null,
    });

    try {
      const activationState = await this.activateAgent(agentId);
      if (
        activationState?.phase !== 'ready'
        || activationState?.activationError
        || activationState?.account?.id !== state.account.id
      ) {
        throw new Error('Agent 激活失败');
      }
      this.#requireReadyAccount(state.account.id);
      const list = await this.host.listAgents();
      const hostAgent = list?.agents?.find((agent) => agent.agentId === agentId);
      const sessionId = validatePrivateSessionId(hostAgent?.mainSessionId);
      const cwd = validatePrivateWorkspace(hostAgent?.workspaceDir);
      const authority = Object.freeze({
        accountId: state.account.id,
        agentId,
        displayName: publicAgent.displayName || agentId,
        sessionId,
        cwd,
      });
      this.authority = authority;
      await this.host.loadSession({ sessionId, cwd });
      if (this.authority !== authority) return this.snapshot;
      this.#requireReadyAccount(authority.accountId);
      this.#publish({
        ...this.#conversationBase(authority),
        phase: 'ready',
        streaming: false,
        error: null,
        stopReason: null,
      });
    } catch (error) {
      this.authority = null;
      this.#publish({
        phase: 'error',
        agentId,
        displayName: publicAgent.displayName || agentId,
        messages: this.#publicMessages(),
        streaming: false,
        transcriptTruncated: this.transcriptTruncated,
        error: safeConversationError(error, '暂时无法打开此 Agent 的主对话。'),
      });
    }
    return this.snapshot;
  }

  #handleIdentity(state) {
    if (state?.phase === 'ready') {
      const nextAccountId = state.account?.id ?? null;
      if (this.accountId !== null && this.accountId !== nextAccountId) this.#reset();
      this.accountId = nextAccountId;
      return;
    }
    if (['signed_out', 'blocked', 'unavailable'].includes(state?.phase)) {
      this.accountId = null;
      this.#reset();
    }
  }

  #handleReconnect() {
    const previous = this.authority;
    if (!previous) return;
    this.authority = null;
    this.#publish({
      phase: 'error',
      agentId: previous.agentId,
      displayName: previous.displayName,
      messages: this.#publicMessages(),
      streaming: false,
      transcriptTruncated: this.transcriptTruncated,
      error: '后台连接已恢复，请重新打开对话以继续。',
    });
  }

  #handleNotification(message) {
    const authority = this.authority;
    if (
      !authority
      || !SESSION_UPDATE_METHODS.has(message?.method)
      || message?.params?.sessionId !== authority.sessionId
    ) {
      return;
    }
    const update = message.params.update;
    const role = update?.sessionUpdate === 'user_message_chunk'
      ? 'user'
      : update?.sessionUpdate === 'agent_message_chunk'
        ? 'assistant'
        : null;
    const text = role && update?.content?.type === 'text'
      ? String(update.content.text || '').slice(0, MAX_CHUNK_CHARS)
      : '';
    if (!role || !text) return;
    this.#appendMessage(role, text);
    this.#publish({
      ...this.#conversationBase(authority),
      phase: this.snapshot.streaming ? 'sending' : this.snapshot.phase,
      streaming: this.snapshot.streaming === true,
      error: null,
      stopReason: null,
    });
  }

  #appendMessage(role, text) {
    const previous = this.messages.at(-1);
    if (previous?.role === role) {
      previous.text = `${previous.text}${text}`.slice(-MAX_PUBLIC_TRANSCRIPT_CHARS);
    } else {
      this.messageCounter += 1;
      this.messages.push({
        id: `message-${this.messageCounter}`,
        role,
        text,
      });
    }
    while (this.messages.length > MAX_PUBLIC_MESSAGES) {
      this.messages.shift();
      this.transcriptTruncated = true;
    }
    let total = this.messages.reduce((sum, message) => sum + message.text.length, 0);
    while (total > MAX_PUBLIC_TRANSCRIPT_CHARS && this.messages.length > 1) {
      total -= this.messages.shift().text.length;
      this.transcriptTruncated = true;
    }
    if (total > MAX_PUBLIC_TRANSCRIPT_CHARS && this.messages.length === 1) {
      this.messages[0].text = this.messages[0].text.slice(-MAX_PUBLIC_TRANSCRIPT_CHARS);
      this.transcriptTruncated = true;
    }
  }

  #conversationBase(authority) {
    return {
      agentId: authority.agentId,
      displayName: authority.displayName,
      messages: this.#publicMessages(),
      transcriptTruncated: this.transcriptTruncated,
    };
  }

  #publicMessages() {
    return this.messages.map((message) => ({ ...message }));
  }

  #requireReadyAccount(expectedAccountId = null) {
    const state = this.identity.getState();
    if (
      state?.phase !== 'ready'
      || state?.access?.canEnterClient !== true
      || state?.account?.id === undefined
      || (expectedAccountId !== null && state.account.id !== expectedAccountId)
    ) {
      throw new Error('当前账号尚未通过订阅验证');
    }
    return state;
  }

  #reset() {
    this.authority = null;
    this.messages = [];
    this.messageCounter = 0;
    this.transcriptTruncated = false;
    this.#publish({ phase: 'idle' });
  }

  #publish(value) {
    this.snapshot = deepFreeze(JSON.parse(JSON.stringify(value)));
    for (const listener of this.listeners) listener(this.snapshot);
  }
}

function validateAgentId(value) {
  if (typeof value !== 'string' || !AGENT_ID_PATTERN.test(value)) {
    throw new Error('Agent ID 无效');
  }
  return value;
}

function validatePrompt(value) {
  const text = String(value || '').trim();
  if (!text) throw new Error('请输入消息');
  if (text.length > MAX_PROMPT_CHARS) throw new Error('消息过长');
  return text;
}

function validatePrivateSessionId(value) {
  if (typeof value !== 'string' || value.length < 8 || value.length > 200) {
    throw new Error('Main Session 无效');
  }
  return value;
}

function validatePrivateWorkspace(value) {
  if (typeof value !== 'string' || value.length > 4096 || !path.isAbsolute(value)) {
    throw new Error('Agent Workspace 无效');
  }
  return value;
}

function safeStopReason(value) {
  return SAFE_STOP_REASONS.has(value) ? value : null;
}

function safeConversationError(error, fallback) {
  const code = String(error?.code || '');
  if (code.includes('auth') || code.includes('subscription') || code.includes('access')) {
    return '订阅验证已失效，请重新检查后再试。';
  }
  return fallback;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

module.exports = {
  AgentConversationController,
  MAX_PROMPT_CHARS,
  safeConversationError,
  validateAgentId,
  validatePrompt,
};
