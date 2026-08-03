'use strict';

const path = require('node:path');
const { randomUUID } = require('node:crypto');

const AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,98}[a-z0-9]$/;
const MAX_PROMPT_CHARS = 16_000;
const MAX_CHUNK_CHARS = 32_000;
const MAX_PUBLIC_MESSAGES = 200;
const MAX_PUBLIC_TRANSCRIPT_CHARS = 200_000;
const MAX_PUBLIC_ACTIVITIES = 50;
const MAX_PUBLIC_BACKGROUND_TASKS = 50;
const MAX_PUBLIC_PLAN_ENTRIES = 50;
const MAX_PLAN_CONTENT_CHARS = 300;
const MAX_PLAN_CONTENT_BYTES = 1_200;
const MAX_PUBLIC_ARTIFACTS = 100;
const MAX_PRIVATE_TOOL_CALL_ID_CHARS = 200;
const MAX_PRIVATE_TASK_ID_CHARS = 200;
const MAX_PERMISSION_TITLE_CHARS = 300;
const MAX_PERMISSION_OPTION_CHARS = 160;
const MAX_PERMISSION_OPTION_ID_CHARS = 200;
const SAFE_PERMISSION_OPTIONS = new Map([
  ['allow-once', Object.freeze({ kind: 'allow_once', decision: 'allow' })],
  ['reject-once', Object.freeze({ kind: 'reject_once', decision: 'reject' })],
]);
const SAFE_TOOL_KINDS = new Set([
  'read',
  'edit',
  'delete',
  'move',
  'search',
  'execute',
  'fetch',
]);
const SAFE_ACTIVITY_TOOL_KINDS = new Set([
  ...SAFE_TOOL_KINDS,
  'think',
  'switch_mode',
  'other',
]);
const SAFE_ACTIVITY_STATUSES = new Set([
  'pending',
  'in_progress',
  'completed',
  'failed',
]);
const TERMINAL_ACTIVITY_STATUSES = new Set(['completed', 'failed']);
const SAFE_BACKGROUND_KINDS = new Set(['command', 'monitor']);
const SAFE_BACKGROUND_STATUSES = new Set([
  'running',
  'completed',
  'failed',
  'stopped',
]);
const TERMINAL_BACKGROUND_STATUSES = new Set(['completed', 'failed', 'stopped']);
const BACKGROUND_STATUS_READY = 'ready';
const BACKGROUND_STATUS_UNAVAILABLE = 'unavailable';
const SAFE_PLAN_STATUSES = new Set([
  'pending',
  'in_progress',
  'completed',
  'cancelled',
]);
const PLAN_STATUS_READY = 'ready';
const PLAN_STATUS_UNAVAILABLE = 'unavailable';
const ARTIFACT_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const SAFE_ARTIFACT_KINDS = new Set([
  'document',
  'image',
  'audio',
  'video',
  'archive',
  'code',
  'data',
  'other',
]);
const ARTIFACT_STATUS_READY = 'ready';
const ARTIFACT_STATUS_UNAVAILABLE = 'unavailable';
const MAX_PUBLIC_PROJECT_STEPS = 20;
const PROJECT_STEP_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const SAFE_PROJECT_STATUSES = new Set([
  'active',
  'waiting_for_user',
  'blocked',
  'completed',
]);
const SAFE_PROJECT_STEP_STATUSES = new Set([
  'pending',
  'in_progress',
  'blocked',
  'completed',
]);
const PROJECT_STATUS_READY = 'ready';
const PROJECT_STATUS_UNAVAILABLE = 'unavailable';
const SESSION_UPDATE_METHODS = new Set([
  'session/update',
  'x.ai/session/update',
  '_x.ai/session/update',
]);
const SESSION_INTERJECTION_METHODS = new Set([
  'x.ai/session/interjection',
  '_x.ai/session/interjection',
]);
const SAFE_STOP_REASONS = new Set([
  'end_turn',
  'max_tokens',
  'max_turn_requests',
  'refusal',
  'cancelled',
]);

class AgentConversationController {
  constructor({ identity, host, activateAgent, attachmentStore = null }) {
    this.identity = identity;
    this.host = host;
    this.activateAgent = activateAgent;
    this.attachmentStore = attachmentStore || unavailableAttachmentStore();
    this.listeners = new Set();
    this.authority = null;
    this.accountId = null;
    this.messages = [];
    this.messageCounter = 0;
    this.seenInterjectionIds = new Set();
    this.runningSessionIds = new Set();
    this.transcriptTruncated = false;
    this.activities = [];
    this.activityByToolCallId = new Map();
    this.activityCounter = 0;
    this.backgroundTasks = [];
    this.backgroundTaskByPrivateId = new Map();
    this.backgroundTaskCounter = 0;
    this.backgroundStatus = BACKGROUND_STATUS_READY;
    this.planEntries = [];
    this.planStatus = PLAN_STATUS_READY;
    this.planRefreshGeneration = 0;
    this.planRefreshPromise = null;
    this.planRefreshQueued = false;
    this.artifacts = [];
    this.artifactStatus = ARTIFACT_STATUS_READY;
    this.project = null;
    this.projectStatus = PROJECT_STATUS_READY;
    this.openPromise = null;
    this.openAgentId = null;
    this.permissionInteraction = null;
    this.interactionCounter = 0;
    this.snapshot = Object.freeze({ phase: 'idle' });
    this.handleIdentity = (state) => this.#handleIdentity(state);
    this.handleNotification = (message) => this.#handleNotification(message);
    this.handleReconnect = () => this.#handleReconnect();
    this.handleHostExit = () => this.#handleHostExit();
    this.handlePermissionRequest = (request) => this.#handlePermissionRequest(request);
    this.handlePermissionResolved = (event) => this.#handlePermissionResolved(event);
    this.unsubscribeIdentity = this.identity.subscribe(this.handleIdentity);
    this.host.on?.('notification', this.handleNotification);
    this.host.on?.('reconnected', this.handleReconnect);
    this.host.on?.('exit', this.handleHostExit);
    this.host.on?.('permission-request', this.handlePermissionRequest);
    this.host.on?.('permission-resolved', this.handlePermissionResolved);
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
    const { text, attachmentIds } = validatePromptRequest(value);
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
      const prepared = await this.attachmentStore.preparePrompt({
        accountId: authority.accountId,
        agentId: authority.agentId,
        text,
        attachmentIds,
      });
      let response;
      this.runningSessionIds.add(authority.sessionId);
      try {
        response = await this.host.promptSession({
          sessionId: authority.sessionId,
          text,
          prompt: prepared.prompt,
        });
      } finally {
        this.runningSessionIds.delete(authority.sessionId);
      }
      if (this.authority !== authority) return this.snapshot;
      await this.attachmentStore.consume({
        accountId: authority.accountId,
        agentId: authority.agentId,
        attachmentIds: prepared.attachmentIds,
      }).catch(() => {});
      this.#cancelPermission();
      await this.#refreshBackgroundTasks(authority);
      if (this.authority !== authority) return this.snapshot;
      await this.#refreshSessionPlan(authority);
      if (this.authority !== authority) return this.snapshot;
      await this.#refreshArtifacts(authority);
      if (this.authority !== authority) return this.snapshot;
      await this.#refreshProjectState(authority);
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
      this.#cancelPermission();
      if (error?.code === 'host_timeout') {
        this.#clearActivities();
        this.#clearBackgroundTasks();
        this.#clearSessionPlan();
        this.#clearArtifacts();
        this.#clearProjectState();
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
        error: safeConversationError(
          error,
          attachmentIds.length
            ? '当前模型未能处理这条包含附件的消息。请确认模型支持相应内容，或更换模型后重试。'
            : '发送失败，请稍后重试。',
        ),
        stopReason: null,
      });
    }
    return this.snapshot;
  }

  async interject(value) {
    const text = validatePrompt(value);
    const authority = this.authority;
    if (!authority) {
      const message = this.snapshot.phase === 'error'
        ? '请重新打开 Agent 对话'
        : '尚未打开 Agent 对话';
      throw new Error(message);
    }
    this.#requireReadyAccount(authority.accountId);
    if (!this.runningSessionIds.has(authority.sessionId)) {
      throw new Error('Agent 当前没有正在执行的任务');
    }
    const response = await this.host.interjectSession({
      sessionId: authority.sessionId,
      text,
      interjectionId: randomUUID(),
    });
    if (response?.status !== 'queued') {
      throw new Error('Agent 没有接受这条补充要求');
    }
    return this.snapshot;
  }

  async stageAttachmentPaths(paths) {
    const authority = this.#requireAttachmentAuthority();
    await this.attachmentStore.stagePaths({
      accountId: authority.accountId,
      agentId: authority.agentId,
      paths,
    });
    return this.#publishDraftAttachments(authority);
  }

  async stageAttachmentBytes(items) {
    const authority = this.#requireAttachmentAuthority();
    await this.attachmentStore.stageBytes({
      accountId: authority.accountId,
      agentId: authority.agentId,
      items,
    });
    return this.#publishDraftAttachments(authority);
  }

  async stageAttachmentLink(url) {
    const authority = this.#requireAttachmentAuthority();
    this.attachmentStore.stageLink({
      accountId: authority.accountId,
      agentId: authority.agentId,
      url,
    });
    return this.#publishDraftAttachments(authority);
  }

  async discardAttachment(attachmentId) {
    const authority = this.#requireAttachmentAuthority();
    await this.attachmentStore.discard({
      accountId: authority.accountId,
      agentId: authority.agentId,
      attachmentId,
    });
    return this.#publishDraftAttachments(authority);
  }

  respondToPermission(interactionId, optionId = null) {
    const interaction = this.permissionInteraction;
    if (
      !interaction
      || interaction.public.interactionId !== interactionId
      || this.authority !== interaction.authority
    ) {
      throw new Error('权限请求已失效');
    }
    this.#requireReadyAccount(interaction.authority.accountId);
    const privateOptionId = optionId === null
      ? null
      : interaction.options.get(optionId);
    if (optionId !== null && !privateOptionId) throw new Error('权限选项无效');
    this.permissionInteraction = null;
    try {
      this.host.respondPermission(interaction.hostRequestId, privateOptionId);
    } catch {
      this.#publish({
        ...this.#conversationBase(interaction.authority),
        phase: this.snapshot.phase,
        streaming: this.snapshot.streaming === true,
        error: '权限请求已失效，请让 Agent 重新发起。',
        stopReason: null,
      });
      throw new Error('权限请求已失效');
    }
    this.#publish({
      ...this.#conversationBase(interaction.authority),
      phase: this.snapshot.phase,
      streaming: this.snapshot.streaming === true,
      error: null,
      stopReason: null,
    });
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
    this.host.off?.('exit', this.handleHostExit);
    this.host.off?.('permission-request', this.handlePermissionRequest);
    this.host.off?.('permission-resolved', this.handlePermissionResolved);
    this.listeners.clear();
    this.#cancelPermission();
    this.#clearActivities();
    this.#clearBackgroundTasks();
    this.#clearSessionPlan();
    this.#clearArtifacts();
    this.#clearProjectState();
    this.authority = null;
    this.runningSessionIds.clear();
  }

  async #open(agentId) {
    const state = this.#requireReadyAccount();
    const publicAgent = state.agents?.find((agent) => agent.agentId === agentId);
    if (!publicAgent) throw new Error('当前账号没有此 Agent');
    this.#cancelPermission();
    this.#clearActivities();
    this.#clearBackgroundTasks();
    this.#clearSessionPlan();
    this.#clearArtifacts();
    this.#clearProjectState();
    this.authority = null;
    this.messages = [];
    this.messageCounter = 0;
    this.seenInterjectionIds.clear();
    this.transcriptTruncated = false;
    this.#publish({
      phase: 'loading',
      agentId,
      displayName: publicAgent.displayName || agentId,
      messages: [],
      activities: [],
      backgroundTasks: [],
      backgroundStatus: BACKGROUND_STATUS_READY,
      planEntries: [],
      planStatus: PLAN_STATUS_READY,
      artifacts: [],
      artifactStatus: ARTIFACT_STATUS_READY,
      project: null,
      projectStatus: PROJECT_STATUS_READY,
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
      await this.#refreshBackgroundTasks(authority);
      if (this.authority !== authority) return this.snapshot;
      await this.#refreshSessionPlan(authority);
      if (this.authority !== authority) return this.snapshot;
      await this.#refreshArtifacts(authority);
      if (this.authority !== authority) return this.snapshot;
      await this.#refreshProjectState(authority);
      if (this.authority !== authority) return this.snapshot;
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
        activities: this.#publicActivities(),
        backgroundTasks: this.#publicBackgroundTasks(),
        backgroundStatus: this.backgroundStatus,
        planEntries: this.#publicSessionPlan(),
        planStatus: this.planStatus,
        artifacts: this.#publicArtifacts(),
        artifactStatus: this.artifactStatus,
        project: this.#publicProject(),
        projectStatus: this.projectStatus,
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
      if (this.accountId !== null && this.accountId !== nextAccountId) {
        this.attachmentStore.clearAccount(this.accountId).catch(() => {});
        this.#reset();
      }
      this.accountId = nextAccountId;
      return;
    }
    if (['signed_out', 'blocked', 'unavailable'].includes(state?.phase)) {
      if (this.accountId !== null) this.attachmentStore.clearAccount(this.accountId).catch(() => {});
      this.accountId = null;
      this.#reset();
    }
  }

  #handleReconnect() {
    const previous = this.authority;
    if (!previous) return;
    this.#cancelPermission();
    this.#clearActivities();
    this.#clearBackgroundTasks();
    this.#clearSessionPlan();
    this.#clearArtifacts();
    this.#clearProjectState();
    this.authority = null;
    this.#publish({
      phase: 'error',
      agentId: previous.agentId,
      displayName: previous.displayName,
      messages: this.#publicMessages(),
      activities: [],
      backgroundTasks: [],
      backgroundStatus: BACKGROUND_STATUS_READY,
      planEntries: [],
      planStatus: PLAN_STATUS_READY,
      artifacts: [],
      artifactStatus: ARTIFACT_STATUS_READY,
      project: null,
      projectStatus: PROJECT_STATUS_READY,
      streaming: false,
      transcriptTruncated: this.transcriptTruncated,
      error: '后台连接已恢复，请重新打开对话以继续。',
    });
  }

  #handleHostExit() {
    const previous = this.authority;
    if (!previous) return;
    this.#cancelPermission();
    this.#clearActivities();
    this.#clearBackgroundTasks();
    this.#clearSessionPlan();
    this.#clearArtifacts();
    this.#clearProjectState();
    this.authority = null;
    this.#publish({
      phase: 'error',
      agentId: previous.agentId,
      displayName: previous.displayName,
      messages: this.#publicMessages(),
      activities: [],
      backgroundTasks: [],
      backgroundStatus: BACKGROUND_STATUS_READY,
      planEntries: [],
      planStatus: PLAN_STATUS_READY,
      artifacts: [],
      artifactStatus: ARTIFACT_STATUS_READY,
      project: null,
      projectStatus: PROJECT_STATUS_READY,
      streaming: false,
      transcriptTruncated: this.transcriptTruncated,
      error: 'Agent Host 已断开，请重新打开对话以继续。',
    });
  }

  #handlePermissionRequest(request) {
    const authority = this.authority;
    if (
      !authority
      || request?.sessionId !== authority.sessionId
      || this.identity.getState()?.phase !== 'ready'
      || this.identity.getState()?.access?.canEnterClient !== true
    ) {
      this.#cancelHostPermission(request?.requestId);
      return;
    }
    if (this.permissionInteraction) {
      this.#cancelHostPermission(request?.requestId);
      return;
    }
    const projected = projectPermissionRequest(request, ++this.interactionCounter);
    if (!projected) {
      this.#cancelHostPermission(request?.requestId);
      return;
    }
    this.permissionInteraction = {
      authority,
      hostRequestId: request.requestId,
      public: projected.public,
      options: projected.options,
    };
    this.#publish({
      ...this.#conversationBase(authority),
      phase: this.snapshot.phase,
      streaming: this.snapshot.streaming === true,
      error: null,
      stopReason: null,
    });
  }

  #handlePermissionResolved(event) {
    const interaction = this.permissionInteraction;
    if (!interaction || interaction.hostRequestId !== event?.requestId) return;
    this.permissionInteraction = null;
    if (this.authority !== interaction.authority) return;
    this.#publish({
      ...this.#conversationBase(interaction.authority),
      phase: this.snapshot.phase,
      streaming: this.snapshot.streaming === true,
      error: event?.outcome === 'transport_closed'
        ? '权限请求已失效，请让 Agent 重新发起。'
        : event?.outcome === 'expired'
          ? '权限确认已超时，请让 Agent 重新发起。'
          : null,
      stopReason: null,
    });
  }

  #handleNotification(message) {
    const authority = this.authority;
    if (
      !authority
      || message?.params?.sessionId !== authority.sessionId
    ) {
      return;
    }
    if (SESSION_INTERJECTION_METHODS.has(message?.method)) {
      const interjectionId = typeof message?.params?.interjectionId === 'string'
        && message.params.interjectionId.length <= 100
        ? message.params.interjectionId
        : null;
      if (interjectionId && this.seenInterjectionIds.has(interjectionId)) return;
      const text = typeof message?.params?.text === 'string'
        ? message.params.text.trim().slice(0, MAX_PROMPT_CHARS)
        : '';
      if (!text) return;
      if (interjectionId) {
        this.seenInterjectionIds.add(interjectionId);
        while (this.seenInterjectionIds.size > MAX_PUBLIC_MESSAGES) {
          this.seenInterjectionIds.delete(this.seenInterjectionIds.values().next().value);
        }
      }
      this.#appendMessage('user', text, true);
      this.#publish({
        ...this.#conversationBase(authority),
        phase: this.snapshot.streaming ? 'sending' : this.snapshot.phase,
        streaming: this.snapshot.streaming === true,
        error: null,
        stopReason: null,
      });
      return;
    }
    const update = message.params.update;
    if (isHarnessBackgroundMethod(message?.method, update?.sessionUpdate)) {
      const changed = update.sessionUpdate === 'task_backgrounded'
        ? this.#recordBackgroundTask(
          update,
          message?.params?._meta?.isReplay === true,
        )
        : this.#recordBackgroundTaskCompletion(update);
      if (changed) this.#publishActivityState(authority);
      return;
    }
    if (!SESSION_UPDATE_METHODS.has(message?.method)) return;
    if (update?.sessionUpdate === 'plan') {
      if (message?.params?._meta?.isReplay !== true) {
        this.#scheduleSessionPlanRefresh(authority);
      }
      return;
    }
    if (update?.sessionUpdate === 'tool_call') {
      if (this.#recordToolCall(update)) this.#publishActivityState(authority);
      return;
    }
    if (update?.sessionUpdate === 'tool_call_update') {
      if (this.#recordToolCallUpdate(update)) this.#publishActivityState(authority);
      return;
    }
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

  #recordToolCall(update) {
    const toolCallId = safePrivateToolCallId(update?.toolCallId);
    const status = safeActivityStatus(update?.status, true);
    if (!toolCallId || !status) return false;
    const toolKind = safeActivityToolKind(update?.kind);
    const existing = this.activityByToolCallId.get(toolCallId);
    if (existing) {
      if (TERMINAL_ACTIVITY_STATUSES.has(existing.public.status)) return false;
      let changed = false;
      if (existing.public.toolKind !== toolKind) {
        existing.public.toolKind = toolKind;
        changed = true;
      }
      return this.#applyActivityStatus(existing, status) || changed;
    }
    this.activityCounter += 1;
    const activity = {
      toolCallId,
      public: {
        activityId: `activity-${this.activityCounter}`,
        toolKind,
        status,
      },
    };
    this.activities.push(activity);
    this.activityByToolCallId.set(toolCallId, activity);
    while (this.activities.length > MAX_PUBLIC_ACTIVITIES) {
      const removed = this.activities.shift();
      this.activityByToolCallId.delete(removed.toolCallId);
    }
    return true;
  }

  #recordToolCallUpdate(update) {
    const toolCallId = safePrivateToolCallId(update?.toolCallId);
    if (!toolCallId) return false;
    const activity = this.activityByToolCallId.get(toolCallId);
    if (!activity) return false;
    if (TERMINAL_ACTIVITY_STATUSES.has(activity.public.status)) return false;
    let changed = false;
    if (update.kind !== undefined && SAFE_ACTIVITY_TOOL_KINDS.has(update.kind)) {
      if (activity.public.toolKind !== update.kind) {
        activity.public.toolKind = update.kind;
        changed = true;
      }
    }
    if (update.status !== undefined) {
      const status = safeActivityStatus(update.status, false);
      if (status) changed = this.#applyActivityStatus(activity, status) || changed;
    }
    return changed;
  }

  #applyActivityStatus(activity, nextStatus) {
    const currentStatus = activity.public.status;
    if (currentStatus === nextStatus) return false;
    if (TERMINAL_ACTIVITY_STATUSES.has(currentStatus)) return false;
    activity.public.status = nextStatus;
    return true;
  }

  #publishActivityState(authority) {
    this.#publish({
      ...this.#conversationBase(authority),
      phase: this.snapshot.streaming ? 'sending' : this.snapshot.phase,
      streaming: this.snapshot.streaming === true,
      error: this.snapshot.error ?? null,
      stopReason: this.snapshot.stopReason ?? null,
    });
  }

  #recordBackgroundTask(update, restoredFromReplay = false) {
    const privateTaskId = safePrivateTaskId(update?.task_id);
    if (!privateTaskId) return false;
    const kind = update.monitor_description === undefined || update.monitor_description === null
      ? 'command'
      : 'monitor';
    const existing = this.backgroundTaskByPrivateId.get(privateTaskId);
    if (existing) {
      if (TERMINAL_BACKGROUND_STATUSES.has(existing.public.status)) return false;
      if (kind === 'monitor' && existing.public.kind !== 'monitor') {
        existing.public.kind = 'monitor';
        return true;
      }
      return false;
    }

    this.#appendBackgroundTask(privateTaskId, kind, 'running', restoredFromReplay);
    return true;
  }

  #recordBackgroundTaskCompletion(update) {
    const snapshot = update?.task_snapshot;
    if (!snapshot || typeof snapshot !== 'object') return false;
    const privateTaskId = safePrivateTaskId(snapshot.task_id);
    if (!privateTaskId) return false;
    const task = this.backgroundTaskByPrivateId.get(privateTaskId);
    if (!task || TERMINAL_BACKGROUND_STATUSES.has(task.public.status)) return false;
    const status = backgroundCompletionStatus(snapshot);
    if (!status) return false;
    if (snapshot.kind === 'monitor') task.public.kind = 'monitor';
    task.public.status = status;
    return true;
  }

  #appendMessage(role, text, forceNew = false) {
    const previous = this.messages.at(-1);
    if (!forceNew && previous?.role === role) {
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
      activities: this.#publicActivities(),
      backgroundTasks: this.#publicBackgroundTasks(),
      backgroundStatus: this.backgroundStatus,
      planEntries: this.#publicSessionPlan(),
      planStatus: this.planStatus,
      artifacts: this.#publicArtifacts(),
      artifactStatus: this.artifactStatus,
      project: this.#publicProject(),
      projectStatus: this.projectStatus,
      transcriptTruncated: this.transcriptTruncated,
      draftAttachments: this.#draftAttachments(authority),
      ...(this.permissionInteraction?.authority === authority
        ? { interaction: { ...this.permissionInteraction.public } }
        : {}),
    };
  }

  #draftAttachments(authority) {
    try {
      return this.attachmentStore.list({
        accountId: authority.accountId,
        agentId: authority.agentId,
      });
    } catch {
      return [];
    }
  }

  #requireAttachmentAuthority() {
    const authority = this.authority;
    if (!authority || !['ready', 'sending'].includes(this.snapshot.phase)) {
      throw new Error('请先打开 Agent 对话');
    }
    this.#requireReadyAccount(authority.accountId);
    if (this.snapshot.streaming) throw new Error('请等待当前回复完成后再添加附件');
    return authority;
  }

  #publishDraftAttachments(authority) {
    if (this.authority !== authority) return this.snapshot;
    this.#publish({
      ...this.#conversationBase(authority),
      phase: this.snapshot.phase,
      streaming: this.snapshot.streaming === true,
      error: null,
      stopReason: this.snapshot.stopReason ?? null,
    });
    return this.snapshot;
  }

  #publicMessages() {
    return this.messages.map((message) => ({ ...message }));
  }

  #publicActivities() {
    return this.activities.map((activity) => ({ ...activity.public }));
  }

  #publicBackgroundTasks() {
    return this.backgroundTasks.map((task) => ({ ...task.public }));
  }

  #publicSessionPlan() {
    return this.planEntries.map((entry) => ({ ...entry }));
  }

  async #refreshBackgroundTasks(authority) {
    let response;
    try {
      response = await this.host.listAgentBackgroundActivities(authority.agentId);
    } catch {
      if (this.authority !== authority) return;
      this.#clearBackgroundTasks();
      this.backgroundStatus = BACKGROUND_STATUS_UNAVAILABLE;
      return;
    }
    if (this.authority !== authority) return;
    try {
      this.#requireReadyAccount(authority.accountId);
    } catch (error) {
      this.#clearBackgroundTasks();
      throw error;
    }
    try {
      this.#reconcileBackgroundTasks(response);
      this.backgroundStatus = BACKGROUND_STATUS_READY;
    } catch {
      if (this.authority !== authority) return;
      this.#clearBackgroundTasks();
      this.backgroundStatus = BACKGROUND_STATUS_UNAVAILABLE;
    }
  }

  #reconcileBackgroundTasks(value) {
    if (
      !value
      || typeof value !== 'object'
      || !Array.isArray(value.activities)
      || value.activities.length > MAX_PUBLIC_BACKGROUND_TASKS
    ) {
      throw new Error('invalid Harness background activity projection');
    }
    const snapshots = new Map();
    for (const activity of value.activities) {
      const privateTaskId = safePrivateTaskId(activity?.taskId);
      if (
        !privateTaskId
        || snapshots.has(privateTaskId)
        || !SAFE_BACKGROUND_KINDS.has(activity?.kind)
        || !SAFE_BACKGROUND_STATUSES.has(activity?.status)
      ) {
        throw new Error('invalid Harness background activity');
      }
      snapshots.set(privateTaskId, {
        kind: activity.kind,
        status: activity.status,
      });
    }

    for (const task of this.backgroundTasks) {
      const authoritative = snapshots.get(task.privateTaskId);
      if (!authoritative) {
        if (task.restoredFromReplay && task.public.status === 'running') {
          task.public.status = 'stopped';
        }
        continue;
      }
      snapshots.delete(task.privateTaskId);
      if (TERMINAL_BACKGROUND_STATUSES.has(task.public.status)) continue;
      task.public.kind = authoritative.kind;
      task.public.status = authoritative.status;
      task.restoredFromReplay = false;
    }

    for (const [privateTaskId, activity] of snapshots) {
      this.#appendBackgroundTask(privateTaskId, activity.kind, activity.status, false);
    }
  }

  #appendBackgroundTask(privateTaskId, kind, status, restoredFromReplay) {
    this.backgroundTaskCounter += 1;
    const task = {
      privateTaskId,
      restoredFromReplay,
      public: {
        backgroundId: `background-${this.backgroundTaskCounter}`,
        kind,
        status,
      },
    };
    this.backgroundTasks.push(task);
    this.backgroundTaskByPrivateId.set(privateTaskId, task);
    while (this.backgroundTasks.length > MAX_PUBLIC_BACKGROUND_TASKS) {
      const terminalIndex = this.backgroundTasks.findIndex(({ public: value }) => (
        TERMINAL_BACKGROUND_STATUSES.has(value.status)
      ));
      const [removed] = this.backgroundTasks.splice(terminalIndex < 0 ? 0 : terminalIndex, 1);
      this.backgroundTaskByPrivateId.delete(removed.privateTaskId);
    }
    return task;
  }

  async #refreshSessionPlan(authority) {
    const generation = ++this.planRefreshGeneration;
    let response;
    try {
      response = await this.host.getAgentSessionPlan(authority.agentId);
    } catch {
      if (this.authority !== authority || generation !== this.planRefreshGeneration) return;
      this.planEntries = [];
      this.planStatus = PLAN_STATUS_UNAVAILABLE;
      return;
    }
    if (this.authority !== authority || generation !== this.planRefreshGeneration) return;
    try {
      this.#requireReadyAccount(authority.accountId);
    } catch (error) {
      this.#clearSessionPlan();
      throw error;
    }
    try {
      this.planEntries = projectSessionPlan(response);
      this.planStatus = PLAN_STATUS_READY;
    } catch {
      if (this.authority !== authority || generation !== this.planRefreshGeneration) return;
      this.planEntries = [];
      this.planStatus = PLAN_STATUS_UNAVAILABLE;
    }
  }

  #scheduleSessionPlanRefresh(authority) {
    if (this.authority !== authority) return;
    if (this.planRefreshPromise) {
      this.planRefreshQueued = true;
      return;
    }
    let refreshPromise;
    const refresh = async () => {
      do {
        this.planRefreshQueued = false;
        await this.#refreshSessionPlan(authority);
      } while (this.planRefreshQueued && this.authority === authority);
      if (this.authority === authority) this.#publishActivityState(authority);
    };
    refreshPromise = refresh()
      .catch(() => {})
      .finally(() => {
        if (this.planRefreshPromise === refreshPromise) this.planRefreshPromise = null;
      });
    this.planRefreshPromise = refreshPromise;
  }

  #publicArtifacts() {
    return this.artifacts.map((artifact) => ({ ...artifact }));
  }

  #publicProject() {
    if (!this.project) return null;
    return {
      ...this.project,
      steps: this.project.steps.map((step) => ({ ...step })),
    };
  }

  async #refreshArtifacts(authority) {
    let response;
    try {
      response = await this.host.listWorkspaceArtifacts(authority.agentId);
    } catch {
      if (this.authority !== authority) return;
      this.artifacts = [];
      this.artifactStatus = ARTIFACT_STATUS_UNAVAILABLE;
      return;
    }
    if (this.authority !== authority) return;
    try {
      this.#requireReadyAccount(authority.accountId);
    } catch (error) {
      this.#clearArtifacts();
      throw error;
    }
    try {
      this.artifacts = projectWorkspaceArtifacts(response);
      this.artifactStatus = ARTIFACT_STATUS_READY;
    } catch {
      if (this.authority !== authority) return;
      this.artifacts = [];
      this.artifactStatus = ARTIFACT_STATUS_UNAVAILABLE;
    }
  }

  async #refreshProjectState(authority) {
    let response;
    try {
      response = await this.host.getWorkspaceProjectState(authority.agentId);
    } catch {
      if (this.authority !== authority) return;
      this.project = null;
      this.projectStatus = PROJECT_STATUS_UNAVAILABLE;
      return;
    }
    if (this.authority !== authority) return;
    try {
      this.#requireReadyAccount(authority.accountId);
    } catch (error) {
      this.#clearProjectState();
      throw error;
    }
    try {
      this.project = projectWorkspaceProjectState(response);
      this.projectStatus = PROJECT_STATUS_READY;
    } catch {
      if (this.authority !== authority) return;
      this.project = null;
      this.projectStatus = PROJECT_STATUS_UNAVAILABLE;
    }
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
    this.#cancelPermission();
    this.authority = null;
    this.messages = [];
    this.messageCounter = 0;
    this.seenInterjectionIds.clear();
    this.runningSessionIds.clear();
    this.transcriptTruncated = false;
    this.#clearActivities();
    this.#clearBackgroundTasks();
    this.#clearSessionPlan();
    this.#clearArtifacts();
    this.#clearProjectState();
    this.#publish({ phase: 'idle' });
  }

  #clearActivities() {
    this.activities = [];
    this.activityByToolCallId.clear();
  }

  #clearBackgroundTasks() {
    this.backgroundTasks = [];
    this.backgroundTaskByPrivateId.clear();
    this.backgroundStatus = BACKGROUND_STATUS_READY;
  }

  #clearSessionPlan() {
    this.planRefreshGeneration += 1;
    this.planRefreshPromise = null;
    this.planRefreshQueued = false;
    this.planEntries = [];
    this.planStatus = PLAN_STATUS_READY;
  }

  #clearArtifacts() {
    this.artifacts = [];
    this.artifactStatus = ARTIFACT_STATUS_READY;
  }

  #clearProjectState() {
    this.project = null;
    this.projectStatus = PROJECT_STATUS_READY;
  }

  #cancelPermission() {
    const interaction = this.permissionInteraction;
    if (!interaction) return;
    this.permissionInteraction = null;
    this.#cancelHostPermission(interaction.hostRequestId);
  }

  #cancelHostPermission(requestId) {
    if (requestId === undefined || requestId === null) return;
    try {
      this.host.respondPermission(requestId, null);
    } catch {
      // The Host may already have closed or expired the reverse request.
    }
  }

  #publish(value) {
    this.snapshot = deepFreeze(JSON.parse(JSON.stringify(value)));
    for (const listener of this.listeners) listener(this.snapshot);
  }
}

function projectWorkspaceArtifacts(value) {
  if (
    value?.schemaVersion !== 1
    || !Number.isSafeInteger(value?.revision)
    || value.revision < 0
    || !Array.isArray(value?.artifacts)
    || value.artifacts.length > MAX_PUBLIC_ARTIFACTS
    || (value.revision === 0 && value.artifacts.length !== 0)
  ) {
    throw new Error('invalid Workspace Artifact projection');
  }
  const ids = new Set();
  return value.artifacts.map((artifact) => {
    const artifactId = artifact?.artifactId;
    const title = typeof artifact?.title === 'string' ? artifact.title.trim() : '';
    if (
      !ARTIFACT_ID_PATTERN.test(artifactId || '')
      || ids.has(artifactId)
      || title.length < 1
      || title.length > 120
      || /[\u0000-\u001F\u007F-\u009F]/.test(title)
      || !SAFE_ARTIFACT_KINDS.has(artifact?.kind)
      || !Number.isSafeInteger(artifact?.sizeBytes)
      || artifact.sizeBytes < 0
    ) {
      throw new Error('invalid Workspace Artifact');
    }
    ids.add(artifactId);
    return {
      artifactId,
      title,
      kind: artifact.kind,
      sizeBytes: artifact.sizeBytes,
    };
  });
}

function projectSessionPlan(value) {
  if (
    !value
    || typeof value !== 'object'
    || !Array.isArray(value.entries)
    || value.entries.length > MAX_PUBLIC_PLAN_ENTRIES
  ) {
    throw new Error('invalid Session plan projection');
  }
  return value.entries.map((entry, index) => {
    const content = typeof entry?.content === 'string' ? entry.content.trim() : '';
    if (
      !content
      || Array.from(content).length > MAX_PLAN_CONTENT_CHARS
      || Buffer.byteLength(content, 'utf8') > MAX_PLAN_CONTENT_BYTES
      || /[\u0000-\u001F\u007F-\u009F]/.test(content)
      || !SAFE_PLAN_STATUSES.has(entry?.status)
    ) {
      throw new Error('invalid Session plan entry');
    }
    return {
      planId: `plan-${index + 1}`,
      content,
      status: entry.status,
    };
  });
}

function projectWorkspaceProjectState(value) {
  if (
    value?.schemaVersion !== 1
    || !Number.isSafeInteger(value?.revision)
    || value.revision < 0
    || (value.revision === 0 && value.project !== null)
    || (value.revision > 0 && (!value.project || typeof value.project !== 'object'))
  ) {
    throw new Error('invalid Workspace Project State projection');
  }
  if (value.revision === 0) return null;

  const title = safeProjectText(value.project.title, 120);
  const summary = safeProjectText(value.project.summary, 500);
  if (
    !title
    || !summary
    || !SAFE_PROJECT_STATUSES.has(value.project.status)
    || !Array.isArray(value.project.steps)
    || value.project.steps.length > MAX_PUBLIC_PROJECT_STEPS
  ) {
    throw new Error('invalid Workspace Project State');
  }
  const stepIds = new Set();
  const steps = value.project.steps.map((step) => {
    const stepId = step?.stepId;
    const label = safeProjectText(step?.label, 160);
    if (
      !PROJECT_STEP_ID_PATTERN.test(stepId || '')
      || stepIds.has(stepId)
      || !label
      || !SAFE_PROJECT_STEP_STATUSES.has(step?.status)
    ) {
      throw new Error('invalid Workspace Project step');
    }
    stepIds.add(stepId);
    return {
      stepId,
      label,
      status: step.status,
    };
  });
  return {
    title,
    status: value.project.status,
    summary,
    steps,
  };
}

function safeProjectText(value, maxChars) {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  if (
    !text
    || Array.from(text).length > maxChars
    || /[\u0000-\u001F\u007F-\u009F]/.test(text)
  ) {
    return '';
  }
  return text;
}

function projectPermissionRequest(request, interactionCounter) {
  if (
    (typeof request?.requestId !== 'string' && typeof request?.requestId !== 'number')
    || !request.toolCall
    || typeof request.toolCall !== 'object'
    || !Array.isArray(request.options)
  ) {
    return null;
  }
  const title = safePermissionText(
    request.toolCall.title,
    MAX_PERMISSION_TITLE_CHARS,
    'Agent 请求执行一项操作',
  );
  const toolKind = SAFE_TOOL_KINDS.has(request.toolCall.kind)
    ? request.toolCall.kind
    : 'other';
  const options = new Map();
  const publicOptions = [];
  const privateIds = new Set();
  for (const option of request.options) {
    const supported = SAFE_PERMISSION_OPTIONS.get(option?.optionId);
    if (
      !option
      || typeof option.optionId !== 'string'
      || !option.optionId
      || option.optionId.length > MAX_PERMISSION_OPTION_ID_CHARS
      || !supported
      || option.kind !== supported.kind
      || privateIds.has(option.optionId)
    ) {
      continue;
    }
    privateIds.add(option.optionId);
    const publicOptionId = `option-${publicOptions.length + 1}`;
    const label = safePermissionText(
      option.name,
      MAX_PERMISSION_OPTION_CHARS,
      supported.decision === 'allow' ? '仅本次允许' : '本次拒绝',
    );
    publicOptions.push({
      optionId: publicOptionId,
      label,
      decision: supported.decision,
    });
    options.set(publicOptionId, option.optionId);
  }
  if (!publicOptions.length) return null;
  return {
    public: {
      interactionId: `permission-${interactionCounter}`,
      kind: 'permission',
      title,
      toolKind,
      options: publicOptions,
    },
    options,
  };
}

function safePermissionText(value, maxChars, fallback) {
  const text = typeof value === 'string'
    ? value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim()
    : '';
  return (text || fallback).slice(0, maxChars);
}

function safePrivateToolCallId(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_PRIVATE_TOOL_CALL_ID_CHARS
    ? value
    : null;
}

function safePrivateTaskId(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_PRIVATE_TASK_ID_CHARS
    && !/[\u0000-\u001F\u007F-\u009F]/.test(value)
    ? value
    : null;
}

function isHarnessBackgroundMethod(method, sessionUpdate) {
  if (sessionUpdate === 'task_backgrounded') {
    return method === 'x.ai/task_backgrounded'
      || method === 'x.ai/session/update'
      || method === '_x.ai/session/update';
  }
  if (sessionUpdate === 'task_completed') {
    return method === 'x.ai/task_completed'
      || method === 'x.ai/session/update'
      || method === '_x.ai/session/update';
  }
  return false;
}

function backgroundCompletionStatus(snapshot) {
  if (
    snapshot.signal === 'session_restart'
    || snapshot.explicitly_killed === true
  ) {
    return 'stopped';
  }
  const exitCode = snapshot.exit_code;
  const signal = snapshot.signal;
  if (exitCode === 0) return 'completed';
  if (
    (exitCode === null || exitCode === undefined)
    && (signal === null || signal === undefined)
  ) {
    return 'completed';
  }
  if (
    (Number.isSafeInteger(exitCode) && exitCode !== 0)
    || (typeof signal === 'string' && signal.length > 0)
  ) {
    return 'failed';
  }
  return null;
}

function safeActivityToolKind(value) {
  return SAFE_ACTIVITY_TOOL_KINDS.has(value) ? value : 'other';
}

function safeActivityStatus(value, defaultPending) {
  if (value === undefined && defaultPending) return 'pending';
  return SAFE_ACTIVITY_STATUSES.has(value) ? value : null;
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

function validatePromptRequest(value) {
  if (typeof value === 'string') return { text: validatePrompt(value), attachmentIds: [] };
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('消息格式无效');
  }
  const text = String(value.text || '').trim();
  if (text.length > MAX_PROMPT_CHARS) throw new Error('消息过长');
  if (!Array.isArray(value.attachmentIds) || value.attachmentIds.length > 10) {
    throw new Error('附件列表无效');
  }
  const attachmentIds = value.attachmentIds.map((attachmentId) => {
    if (typeof attachmentId !== 'string' || attachmentId.length > 64) {
      throw new Error('附件标识无效');
    }
    return attachmentId;
  });
  if (!text && attachmentIds.length === 0) throw new Error('请输入消息或添加附件');
  return { text, attachmentIds };
}

function unavailableAttachmentStore() {
  return {
    list: () => [],
    stagePaths: async () => { throw new Error('附件服务不可用'); },
    stageBytes: async () => { throw new Error('附件服务不可用'); },
    stageLink: () => { throw new Error('附件服务不可用'); },
    discard: async () => { throw new Error('附件服务不可用'); },
    clearAccount: async () => {},
    preparePrompt: async ({ text, attachmentIds }) => {
      if (attachmentIds.length) throw new Error('附件服务不可用');
      return { prompt: [{ type: 'text', text }], attachmentIds: [] };
    },
    consume: async () => {},
  };
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
  validatePromptRequest,
};
