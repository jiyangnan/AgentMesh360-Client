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
const QUEUE_CHANGED_METHODS = new Set([
  'x.ai/queue/changed',
  '_x.ai/queue/changed',
]);
const CLIENT_IDENTIFIER = 'agentmesh360-desktop';
const MAX_PUBLIC_QUEUE_ENTRIES = 50;
const MAX_QUEUE_TEXT_CHARS = 4_000;
const QUEUE_ENTRY_ID_PATTERN = /^[^\u0000-\u001F\u007F-\u009F]{1,200}$/u;
const SESSION_STATE_FIELDS = Object.freeze([
  'messages',
  'messageCounter',
  'seenInterjectionIds',
  'transcriptTruncated',
  'activities',
  'activityByToolCallId',
  'activityCounter',
  'backgroundTasks',
  'backgroundTaskByPrivateId',
  'backgroundTaskCounter',
  'backgroundStatus',
  'planEntries',
  'planStatus',
  'planRefreshGeneration',
  'planRefreshPromise',
  'planRefreshQueued',
  'artifacts',
  'artifactStatus',
  'project',
  'projectStatus',
  'permissionInteraction',
  'queueRevision',
  'queueEntries',
  'queueRunningPromptId',
  'queuePublicIds',
  'queuePrivateIds',
  'queuePublicCounter',
  'submissions',
  'queueMutation',
]);
const SAFE_STOP_REASONS = new Set([
  'end_turn',
  'max_tokens',
  'max_turn_requests',
  'refusal',
  'cancelled',
]);
const INPUT_CAPABILITIES_SCHEMA_VERSION = 1;
const MAX_PUBLIC_INPUT_SKILLS = 32;
const INPUT_SKILL_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/u;
const SAFE_INPUT_COMMANDS = new Map([
  ['compact', Object.freeze({
    id: 'compact',
    trigger: '/compact',
    displayName: '压缩当前对话',
    description: '压缩较早的对话内容，同时保留当前任务需要的上下文。',
    argumentHint: '可选：说明必须保留的内容',
  })],
  ['context', Object.freeze({
    id: 'context',
    trigger: '/context',
    displayName: '查看上下文用量',
    description: '查看当前会话的上下文窗口与用量信息。',
  })],
  ['session-info', Object.freeze({
    id: 'session-info',
    trigger: '/session-info',
    displayName: '查看会话状态',
    description: '查看当前会话的模型、轮次和上下文概况。',
  })],
]);
const SAFE_INPUT_COMMAND_TRIGGERS = new Set(
  [...SAFE_INPUT_COMMANDS.values()].map((command) => command.trigger),
);

class AgentConversationController {
  constructor({
    identity,
    host,
    activateAgent,
    attachmentStore = null,
    workspaceAuthorityStore = null,
    promptHistoryStore = null,
  }) {
    this.identity = identity;
    this.host = host;
    this.activateAgent = activateAgent;
    this.attachmentStore = attachmentStore || unavailableAttachmentStore();
    this.workspaceAuthorityStore = workspaceAuthorityStore;
    this.promptHistoryStore = promptHistoryStore;
    this.listeners = new Set();
    this.authority = null;
    this.accountId = null;
    this.messages = [];
    this.messageCounter = 0;
    this.seenInterjectionIds = new Set();
    this.runningSessionIds = new Set();
    this.sessionsByKey = new Map();
    this.sessionsByPrivateId = new Map();
    this.activeSessionKey = null;
    this.currentSessionRecord = null;
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
    this.queueRevision = -1;
    this.queueEntries = [];
    this.queueRunningPromptId = null;
    this.queuePublicIds = new Map();
    this.queuePrivateIds = new Map();
    this.queuePublicCounter = 0;
    this.submissions = new Map();
    this.queueMutation = null;
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

  #createSessionRecord(authority) {
    const key = sessionRecordKey(authority);
    const existing = this.sessionsByKey.get(key);
    if (existing) return existing;
    const record = {
      key,
      authority,
      state: createPrivateSessionState(),
      snapshot: Object.freeze({
        phase: 'loading',
        agentId: authority.agentId,
        displayName: authority.displayName,
        streaming: false,
      }),
    };
    this.sessionsByKey.set(key, record);
    this.sessionsByPrivateId.set(authority.sessionId, record);
    return record;
  }

  #captureSessionState(record = this.currentSessionRecord) {
    if (!record) return;
    for (const field of SESSION_STATE_FIELDS) record.state[field] = this[field];
  }

  #restoreSessionState(record) {
    for (const field of SESSION_STATE_FIELDS) this[field] = record.state[field];
    this.currentSessionRecord = record;
    this.authority = record.authority;
  }

  #withSessionRecord(record, operation) {
    const previousRecord = this.currentSessionRecord;
    const previousAuthority = this.authority;
    const previousSnapshot = this.snapshot;
    if (previousRecord === record) return operation();
    if (previousRecord) this.#captureSessionState(previousRecord);
    this.#restoreSessionState(record);
    this.snapshot = record.snapshot;
    try {
      return operation();
    } finally {
      this.#captureSessionState(record);
      if (previousRecord) {
        this.#restoreSessionState(previousRecord);
      } else {
        this.currentSessionRecord = null;
        this.authority = previousAuthority;
      }
      this.snapshot = previousSnapshot;
    }
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
    return this.#submit(value, false);
  }

  async sendNow(value) {
    return this.#submit(value, true);
  }

  async getInputCapabilities() {
    const authority = this.authority;
    if (!authority || !this.currentSessionRecord) throw new Error('请先打开 Agent 对话');
    this.#requireReadyAccount(authority.accountId);
    const response = await this.host.getAgentInputCapabilities({
      agentId: authority.agentId,
      sessionId: authority.sessionId,
    });
    if (this.authority !== authority || this.currentSessionRecord?.authority !== authority) {
      throw new Error('Agent 已切换，请重新打开输入菜单');
    }
    return deepFreeze(projectInputCapabilities(response, authority.agentId));
  }

  getAuthorizedWorkspaces() {
    const authority = this.#requireAttachmentAuthority();
    if (!this.workspaceAuthorityStore) throw new Error('工作文件夹功能尚未就绪');
    return deepFreeze({
      schemaVersion: 1,
      agentId: authority.agentId,
      workspaces: this.workspaceAuthorityStore.list({
        accountId: authority.accountId,
        agentId: authority.agentId,
      }),
    });
  }

  async authorizeWorkspaceRoot(rootPath) {
    const authority = this.#requireAttachmentAuthority();
    if (!this.workspaceAuthorityStore) throw new Error('工作文件夹功能尚未就绪');
    await this.workspaceAuthorityStore.authorizeRoot({
      accountId: authority.accountId,
      agentId: authority.agentId,
      rootPath,
    });
    if (this.authority !== authority) throw new Error('Agent 已切换，请重新授权工作文件夹');
    return this.getAuthorizedWorkspaces();
  }

  async revokeWorkspace(workspaceId) {
    const authority = this.#requireAttachmentAuthority();
    if (!this.workspaceAuthorityStore) throw new Error('工作文件夹功能尚未就绪');
    await this.workspaceAuthorityStore.revoke({
      accountId: authority.accountId,
      agentId: authority.agentId,
      workspaceId,
    });
    if (this.authority !== authority) throw new Error('Agent 已切换，请重新打开工作文件夹');
    return this.getAuthorizedWorkspaces();
  }

  async searchWorkspaceFiles({ query = '', workspaceId = null } = {}) {
    const authority = this.#requireAttachmentAuthority();
    if (!this.workspaceAuthorityStore) throw new Error('工作文件夹功能尚未就绪');
    const workspaces = this.workspaceAuthorityStore.list({
      accountId: authority.accountId,
      agentId: authority.agentId,
    });
    const selected = workspaceId
      ? workspaces.filter((workspace) => workspace.workspaceId === workspaceId)
      : workspaces;
    if (workspaceId && selected.length !== 1) throw new Error('工作文件夹未授权或已撤销');
    const groups = await Promise.all(selected.map(async (workspace) => ({
      workspace,
      files: await this.workspaceAuthorityStore.searchFiles({
        accountId: authority.accountId,
        agentId: authority.agentId,
        workspaceId: workspace.workspaceId,
        query,
        limit: 20,
      }),
    })));
    if (this.authority !== authority) throw new Error('Agent 已切换，请重新搜索工作文件');
    return deepFreeze({
      schemaVersion: 1,
      agentId: authority.agentId,
      workspaces,
      files: groups.flatMap(({ workspace, files }) => files.map((file) => ({
        ...file,
        workspaceName: workspace.displayName,
      }))).slice(0, 50),
    });
  }

  async stageWorkspaceFile({ workspaceId, relativePath } = {}) {
    const authority = this.#requireAttachmentAuthority();
    if (!this.workspaceAuthorityStore) throw new Error('工作文件夹功能尚未就绪');
    await this.workspaceAuthorityStore.stageAttachment({
      accountId: authority.accountId,
      agentId: authority.agentId,
      workspaceId,
      relativePath,
    });
    if (this.authority !== authority) throw new Error('Agent 已切换，请重新添加工作文件');
    return this.#publishDraftAttachments(authority);
  }

  async searchPromptHistory(query = '') {
    const authority = this.#requireAttachmentAuthority();
    if (!this.promptHistoryStore) throw new Error('历史消息功能尚未就绪');
    this.#bindPromptHistory(authority);
    const history = await this.promptHistoryStore.search({
      accountId: authority.accountId,
      agentId: authority.agentId,
      sessionKey: 'main',
      query,
      limit: 20,
    });
    if (this.authority !== authority) throw new Error('Agent 已切换，请重新打开历史消息');
    return deepFreeze({
      schemaVersion: 1,
      agentId: authority.agentId,
      history,
    });
  }

  selectPromptHistory(historyId) {
    const authority = this.#requireAttachmentAuthority();
    if (!this.promptHistoryStore) throw new Error('历史消息功能尚未就绪');
    this.#bindPromptHistory(authority);
    return deepFreeze(this.promptHistoryStore.select({
      accountId: authority.accountId,
      agentId: authority.agentId,
      sessionKey: 'main',
      historyId,
    }));
  }

  #bindPromptHistory(authority) {
    this.promptHistoryStore.bindSession({
      accountId: authority.accountId,
      agentId: authority.agentId,
      sessionKey: 'main',
      privateCwd: authority.cwd,
      privateSessionId: authority.sessionId,
    });
  }

  async #submit(value, sendNow) {
    const { text, attachmentIds } = validatePromptRequest(value);
    const authority = this.authority;
    const record = this.currentSessionRecord;
    if (!authority) {
      const message = this.snapshot.phase === 'error'
        ? '请重新打开 Agent 对话'
        : '尚未打开 Agent 对话';
      throw new Error(message);
    }
    this.#requireReadyAccount(authority.accountId);
    if (!record || record.authority !== authority) throw new Error('对话状态尚未就绪');
    if ([...this.submissions.values()].some((submission) => submission.status === 'unknown')) {
      throw new Error('上一条消息的提交状态仍在对账中。为避免重复执行，请等待后台恢复确认。');
    }
    const promptId = `prompt-${randomUUID()}`;
    let prepared;
    let reserved = false;
    try {
      if (typeof this.attachmentStore.reservePrompt === 'function') {
        prepared = await this.attachmentStore.reservePrompt({
          accountId: authority.accountId,
          agentId: authority.agentId,
          sessionId: authority.sessionId,
          promptId,
          text,
          attachmentIds,
        });
        reserved = attachmentIds.length > 0;
      } else {
        prepared = await this.attachmentStore.preparePrompt({
          accountId: authority.accountId,
          agentId: authority.agentId,
          text,
          attachmentIds,
        });
      }
    } catch (error) {
      this.#publish({
        ...this.#conversationBase(authority),
        phase: this.queueRunningPromptId ? 'sending' : 'ready',
        streaming: Boolean(this.queueRunningPromptId),
        error: safeConversationError(error, '没有成功准备这条消息。'),
        stopReason: null,
      });
      return this.snapshot;
    }
    let resolveAccepted;
    const acceptedPromise = new Promise((resolve) => { resolveAccepted = resolve; });
    const submission = {
      promptId,
      status: 'submitting',
      accepted: false,
      reserved,
      sendNow,
      text,
      attachmentIds: [...prepared.attachmentIds],
      resolveAccepted,
    };
    this.submissions.set(promptId, submission);
    this.runningSessionIds.add(authority.sessionId);
    const submittingIsRunning = Boolean(this.queueRunningPromptId) || this.queueRevision < 0;
    this.#publish({
      ...this.#conversationBase(authority),
      phase: submittingIsRunning ? 'sending' : 'ready',
      streaming: submittingIsRunning,
      error: null,
      stopReason: null,
    });
    const hostPromise = this.host.promptSession({
      sessionId: authority.sessionId,
      text,
      prompt: prepared.prompt,
      promptId,
      sendNow,
      clientIdentifier: CLIENT_IDENTIFIER,
    });
    submission.requestPromise = hostPromise;
    const completionPromise = hostPromise.then(
      async (response) => {
        await this.#completeSubmission(record, submission, response);
        return { kind: 'completed' };
      },
      async (error) => {
        await this.#failSubmission(record, submission, error);
        return { kind: 'failed' };
      },
    );
    await Promise.race([
      acceptedPromise.then(() => ({ kind: 'accepted' })),
      completionPromise,
      delay(750).then(() => ({ kind: 'pending' })),
    ]);
    return record.snapshot;
  }

  async #completeSubmission(record, submission, response) {
    if (submission.settled) return;
    submission.settled = true;
    submission.accepted = true;
    submission.status = 'completed';
    if (submission.reserved) {
      await this.attachmentStore.consumeReservation({
        accountId: record.authority.accountId,
        agentId: record.authority.agentId,
        sessionId: record.authority.sessionId,
        promptId: submission.promptId,
      }).catch(() => {});
    } else if (submission.attachmentIds.length) {
      await this.attachmentStore.consume({
        accountId: record.authority.accountId,
        agentId: record.authority.agentId,
        attachmentIds: submission.attachmentIds,
      }).catch(() => {});
    }
    this.#withSessionRecord(record, () => {
      this.submissions.delete(submission.promptId);
      if (this.queueRevision < 0) {
        this.queueRunningPromptId = null;
        this.runningSessionIds.delete(record.authority.sessionId);
      }
      this.#cancelPermission();
      this.#publish({
        ...this.#conversationBase(record.authority),
        phase: this.queueRunningPromptId ? 'sending' : 'ready',
        streaming: Boolean(this.queueRunningPromptId),
        error: null,
        stopReason: safeStopReason(response?.stopReason),
      });
    });
    if (record.key === this.activeSessionKey) {
      await this.#refreshActiveSessionResources(record);
    }
    submission.resolveAccepted?.({ status: 'completed' });
    submission.resolveAccepted = null;
  }

  async #failSubmission(record, submission, error) {
    if (submission.settled) return;
    submission.settled = true;
    const uncertain = isUncertainPromptFailure(error);
    if (submission.reserved) {
      const operation = uncertain
        ? this.attachmentStore.markReservationUnknown?.bind(this.attachmentStore)
        : this.attachmentStore.releaseReservation?.bind(this.attachmentStore);
      if (operation) {
        await operation({
          accountId: record.authority.accountId,
          agentId: record.authority.agentId,
          sessionId: record.authority.sessionId,
          promptId: submission.promptId,
        }).catch(() => {});
      }
    }
    this.#withSessionRecord(record, () => {
      submission.status = uncertain ? 'unknown' : 'failed';
      if (!uncertain) this.submissions.delete(submission.promptId);
      if (this.queueRevision < 0) this.runningSessionIds.delete(record.authority.sessionId);
      this.#cancelPermission();
      this.#publish({
        ...this.#conversationBase(record.authority),
        phase: uncertain
          ? 'error'
          : (this.queueRunningPromptId ? 'sending' : 'ready'),
        streaming: Boolean(this.queueRunningPromptId),
        error: uncertain
          ? '后台连接中断，暂时无法确认这条消息是否已提交。为避免重复执行，客户端不会自动重发。'
          : safeConversationError(
            error,
            submission.attachmentIds.length
              ? '当前模型未能处理这条包含附件的消息。请确认模型支持相应内容，或更换模型后重试。'
              : '发送失败，请稍后重试。',
          ),
        stopReason: null,
        ...(!uncertain ? { recoverableDraft: { text: submission.text } } : {}),
      });
    });
    submission.resolveAccepted?.({ status: submission.status });
    submission.resolveAccepted = null;
  }

  async #refreshActiveSessionResources(record) {
    if (this.currentSessionRecord !== record || this.authority !== record.authority) return;
    const authority = record.authority;
    await this.#refreshBackgroundTasks(authority);
    if (this.currentSessionRecord !== record) return;
    await this.#refreshSessionPlan(authority);
    if (this.currentSessionRecord !== record) return;
    await this.#refreshArtifacts(authority);
    if (this.currentSessionRecord !== record) return;
    await this.#refreshProjectState(authority);
    if (this.currentSessionRecord !== record) return;
    this.#publish({
      ...this.#conversationBase(authority),
      phase: this.queueRunningPromptId ? 'sending' : 'ready',
      streaming: Boolean(this.queueRunningPromptId),
      error: this.snapshot.error ?? null,
      stopReason: this.snapshot.stopReason ?? null,
    });
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

  async removeQueuedPrompt(queueId) {
    return this.#mutateQueue('remove', queueId, async (entry, authority) => {
      await this.host.removeQueuedPrompt({
        sessionId: authority.sessionId,
        id: entry.privateId,
        expectedVersion: entry.public.version,
      });
    });
  }

  async editQueuedPrompt(queueId, value) {
    const text = validatePrompt(value);
    return this.#mutateQueue('edit', queueId, async (entry, authority) => {
      const submission = this.submissions.get(entry.privateId);
      if (submission?.attachmentIds.length) {
        throw new Error('包含附件的待处理消息暂不支持直接编辑，请删除后重新发送');
      }
      this.queueMutation.expectedText = text;
      await this.host.editQueuedPrompt({
        sessionId: authority.sessionId,
        id: entry.privateId,
        newText: text,
      });
    });
  }

  async reorderQueuedPrompts(queueIds) {
    const authority = this.#requireQueueAuthority();
    if (
      !Array.isArray(queueIds)
      || queueIds.length !== this.queueEntries.length
      || new Set(queueIds).size !== queueIds.length
    ) {
      throw new Error('队列顺序无效');
    }
    const orderedEntries = queueIds.map((queueId) => this.#queueEntry(queueId));
    if (orderedEntries.some((entry) => !entry.public.editable)) {
      throw new Error('当前队列包含其他客户端提交的任务，不能整体重排');
    }
    const orderedPrivateIds = orderedEntries.map((entry) => entry.privateId);
    this.queueMutation = {
      kind: 'reorder',
      baseRevision: this.queueRevision,
      orderedPrivateIds,
    };
    this.#publishQueueMutation(authority);
    try {
      await this.host.reorderQueuedPrompts({
        sessionId: authority.sessionId,
        orderedIds: orderedPrivateIds,
      });
    } catch (error) {
      this.queueMutation = null;
      this.#publishQueueError(authority, error, '没有成功调整待处理顺序');
    }
    return this.snapshot;
  }

  async clearQueuedPrompts() {
    const authority = this.#requireQueueAuthority();
    this.queueMutation = { kind: 'clear', baseRevision: this.queueRevision };
    this.#publishQueueMutation(authority);
    try {
      await this.host.clearQueuedPrompts({ sessionId: authority.sessionId });
    } catch (error) {
      this.queueMutation = null;
      this.#publishQueueError(authority, error, '没有成功清空待处理任务');
    }
    return this.snapshot;
  }

  async sendQueuedPromptNow(queueId) {
    return this.#mutateQueue('send_now', queueId, async (entry, authority) => {
      await this.host.sendQueuedPromptNow({
        sessionId: authority.sessionId,
        id: entry.privateId,
        expectedVersion: entry.public.version,
      });
    });
  }

  async cancelCurrentTask() {
    const authority = this.#requireQueueAuthority();
    if (!this.queueRunningPromptId && !this.runningSessionIds.has(authority.sessionId)) {
      throw new Error('Agent 当前没有正在执行的任务');
    }
    await this.host.cancelSession(authority.sessionId);
    this.#publish({
      ...this.#conversationBase(authority),
      phase: 'sending',
      streaming: true,
      cancelling: true,
      error: null,
      stopReason: null,
    });
    return this.snapshot;
  }

  async #mutateQueue(kind, queueId, operation) {
    const authority = this.#requireQueueAuthority();
    const entry = this.#queueEntry(queueId);
    if (!entry.public.editable) throw new Error('只能管理由本客户端提交的待处理消息');
    this.queueMutation = {
      kind,
      baseRevision: this.queueRevision,
      privateId: entry.privateId,
    };
    this.#publishQueueMutation(authority);
    try {
      await operation(entry, authority);
    } catch (error) {
      this.queueMutation = null;
      this.#publishQueueError(authority, error, '队列操作没有成功');
    }
    return this.snapshot;
  }

  #requireQueueAuthority() {
    const authority = this.authority;
    if (!authority || !this.currentSessionRecord) throw new Error('请先打开 Agent 对话');
    this.#requireReadyAccount(authority.accountId);
    if (this.queueRevision < 0) throw new Error('待处理任务尚未完成同步');
    if (this.queueMutation) throw new Error('上一项队列操作仍在确认');
    return authority;
  }

  #queueEntry(queueId) {
    if (typeof queueId !== 'string' || !/^queue-\d+$/.test(queueId)) {
      throw new Error('待处理消息标识无效');
    }
    const privateId = this.queuePrivateIds.get(queueId);
    const entry = this.queueEntries.find((candidate) => candidate.privateId === privateId);
    if (!entry) throw new Error('待处理消息已经发生变化');
    return entry;
  }

  #publishQueueMutation(authority) {
    this.#publish({
      ...this.#conversationBase(authority),
      phase: this.queueRunningPromptId ? 'sending' : 'ready',
      streaming: Boolean(this.queueRunningPromptId),
      error: null,
      stopReason: this.snapshot.stopReason ?? null,
    });
  }

  #publishQueueError(authority, error, fallback) {
    this.#publish({
      ...this.#conversationBase(authority),
      phase: this.queueRunningPromptId ? 'sending' : 'ready',
      streaming: Boolean(this.queueRunningPromptId),
      error: safeConversationError(error, fallback),
      stopReason: this.snapshot.stopReason ?? null,
    });
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
    await this.attachmentStore.stageLink({
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
    for (const record of this.sessionsByKey.values()) {
      this.#cancelHostPermission(record.state.permissionInteraction?.hostRequestId);
    }
    this.sessionsByKey.clear();
    this.sessionsByPrivateId.clear();
    this.listeners.clear();
    this.authority = null;
    this.currentSessionRecord = null;
    this.activeSessionKey = null;
    this.runningSessionIds.clear();
  }

  async #open(agentId) {
    const state = this.#requireReadyAccount();
    const publicAgent = state.agents?.find((agent) => agent.agentId === agentId);
    if (!publicAgent) throw new Error('当前账号没有此 Agent');
    if (this.currentSessionRecord) this.#captureSessionState(this.currentSessionRecord);
    this.currentSessionRecord = null;
    this.activeSessionKey = null;
    this.authority = null;
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
      queue: emptyPublicQueue(),
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
      const resolvedAuthority = Object.freeze({
        accountId: state.account.id,
        agentId,
        displayName: publicAgent.displayName || agentId,
        sessionId,
        cwd,
      });
      const existingRecord = this.sessionsByKey.get(sessionRecordKey(resolvedAuthority));
      const record = existingRecord || this.#createSessionRecord(resolvedAuthority);
      const authority = record.authority;
      if (this.promptHistoryStore) this.#bindPromptHistory(authority);
      this.activeSessionKey = record.key;
      this.#restoreSessionState(record);
      if (!existingRecord) {
        await this.host.loadSession({ sessionId, cwd });
      }
      if (this.authority !== authority) return this.snapshot;
      this.#requireReadyAccount(authority.accountId);
      await this.host.syncQueueSession?.(sessionId);
      if (this.authority !== authority) return this.snapshot;
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
        phase: this.queueRunningPromptId ? 'sending' : 'ready',
        streaming: Boolean(this.queueRunningPromptId),
        error: null,
        stopReason: null,
      });
    } catch (error) {
      if (this.currentSessionRecord && this.authority) {
        this.#publish({
          ...this.#conversationBase(this.authority),
          phase: 'error',
          streaming: Boolean(this.queueRunningPromptId),
          error: safeConversationError(error, '暂时无法打开此 Agent 的主对话。'),
          stopReason: null,
        });
      } else {
        this.currentSessionRecord = null;
        this.activeSessionKey = null;
        this.authority = null;
        this.#publish({
          phase: 'error',
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
          queue: emptyPublicQueue(),
          streaming: false,
          transcriptTruncated: false,
          error: safeConversationError(error, '暂时无法打开此 Agent 的主对话。'),
        });
      }
    }
    return this.snapshot;
  }

  #handleIdentity(state) {
    if (state?.phase === 'ready') {
      const nextAccountId = state.account?.id ?? null;
      if (this.accountId !== null && this.accountId !== nextAccountId) {
        this.attachmentStore.clearAccount(this.accountId).catch(() => {});
        this.promptHistoryStore?.clearAccount?.(this.accountId);
        this.#reset();
      }
      this.accountId = nextAccountId;
      return;
    }
    if (['signed_out', 'blocked', 'unavailable'].includes(state?.phase)) {
      if (this.accountId !== null) this.attachmentStore.clearAccount(this.accountId).catch(() => {});
      if (this.accountId !== null) this.promptHistoryStore?.clearAccount?.(this.accountId);
      this.accountId = null;
      this.#reset();
    }
  }

  #handleReconnect() {
    if (!this.sessionsByKey.size) return;
    for (const record of this.sessionsByKey.values()) {
      this.#withSessionRecord(record, () => {
        // queueRevision is monotonic only within one live Host SessionActor.
        // A replacement transport starts a fresh generation, so the first
        // authoritative snapshot must be accepted even when its revision is
        // lower than the prior generation's last value.
        this.queueRevision = -1;
        this.queueMutation = null;
      });
    }
    this.#markSessionsDisconnected('后台连接已恢复，正在自动对账会话与待处理任务…');
    this.#recoverSessions().catch(() => {});
  }

  #handleHostExit() {
    if (!this.sessionsByKey.size) return;
    this.#markSessionsDisconnected('后台连接暂时中断；客户端不会自动重发尚未确认的消息。');
  }

  #markSessionsDisconnected(message) {
    for (const record of this.sessionsByKey.values()) {
      this.#withSessionRecord(record, () => {
        this.#cancelPermission();
        for (const submission of this.submissions.values()) {
          if (submission.status === 'submitting') submission.status = 'unknown';
        }
        this.#publish({
          ...this.#conversationBase(record.authority),
          phase: 'error',
          streaming: Boolean(this.queueRunningPromptId),
          error: message,
          stopReason: null,
        });
      });
    }
  }

  async #recoverSessions() {
    for (const record of this.sessionsByKey.values()) {
      try {
        await this.host.loadSession({
          sessionId: record.authority.sessionId,
          cwd: record.authority.cwd,
        });
        await this.host.syncQueueSession?.(record.authority.sessionId);
        this.#withSessionRecord(record, () => {
          this.#publish({
            ...this.#conversationBase(record.authority),
            phase: this.queueRunningPromptId ? 'sending' : 'ready',
            streaming: Boolean(this.queueRunningPromptId),
            error: null,
            stopReason: null,
          });
        });
        if (record.key === this.activeSessionKey) await this.#refreshActiveSessionResources(record);
      } catch (error) {
        this.#withSessionRecord(record, () => {
          this.#publish({
            ...this.#conversationBase(record.authority),
            phase: 'error',
            streaming: false,
            error: safeConversationError(error, '暂时无法恢复此 Agent 的主会话。'),
            stopReason: null,
          });
        });
      }
    }
  }

  #handlePermissionRequest(request) {
    const record = typeof request?.sessionId === 'string'
      ? this.sessionsByPrivateId.get(request.sessionId)
      : null;
    if (!record) {
      this.#cancelHostPermission(request?.requestId);
      return;
    }
    this.#withSessionRecord(record, () => this.#handleSessionPermissionRequest(request));
  }

  #handleSessionPermissionRequest(request) {
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
    const record = [...this.sessionsByKey.values()].find(
      (candidate) => candidate.state.permissionInteraction?.hostRequestId === event?.requestId,
    );
    if (!record) return;
    this.#withSessionRecord(record, () => {
      const interaction = this.permissionInteraction;
      if (!interaction || interaction.hostRequestId !== event?.requestId) return;
      this.permissionInteraction = null;
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
    });
  }

  #handleNotification(message) {
    const sessionId = message?.params?.sessionId;
    const record = typeof sessionId === 'string'
      ? this.sessionsByPrivateId.get(sessionId)
      : null;
    if (!record) return;
    if (QUEUE_CHANGED_METHODS.has(message?.method)) {
      this.#handleQueueChanged(record, message.params);
      return;
    }
    this.#withSessionRecord(record, () => this.#handleSessionNotification(message));
  }

  #handleSessionNotification(message) {
    const authority = this.authority;
    if (!authority) return;
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

  #handleQueueChanged(record, params) {
    let next;
    try {
      next = projectQueueChanged(params);
    } catch {
      return;
    }
    const acceptedPromptIds = [];
    const reconciledPromptIds = [];
    let removedPromptIds = new Set();
    let applied = false;
    this.#withSessionRecord(record, () => {
      if (next.queueRevision <= this.queueRevision) return;
      applied = true;
      const previousLivePromptIds = new Set([
        ...this.queueEntries.map((entry) => entry.privateId),
        ...(this.queueRunningPromptId ? [this.queueRunningPromptId] : []),
      ]);
      this.queueRevision = next.queueRevision;
      const livePrivateIds = new Set([
        ...next.entries.map((entry) => entry.id),
        ...(next.runningPromptId ? [next.runningPromptId] : []),
      ]);
      for (const privateId of livePrivateIds) this.#ensurePublicQueueId(privateId);
      for (const privateId of [...this.queuePublicIds.keys()]) {
        if (!livePrivateIds.has(privateId) && !this.submissions.has(privateId)) {
          const publicId = this.queuePublicIds.get(privateId);
          this.queuePublicIds.delete(privateId);
          this.queuePrivateIds.delete(publicId);
        }
      }
      this.queueEntries = next.entries.map((entry) => ({
        privateId: entry.id,
        owner: entry.owner,
        public: {
          queueId: this.queuePublicIds.get(entry.id),
          version: entry.version,
          kind: safeQueueKind(entry.kind),
          text: entry.text,
          position: entry.position,
          editable: entry.owner === CLIENT_IDENTIFIER,
        },
      }));
      this.queueRunningPromptId = next.runningPromptId;
      removedPromptIds = new Set(
        [...previousLivePromptIds].filter((promptId) => !livePrivateIds.has(promptId)),
      );
      if (next.runningPromptId) this.runningSessionIds.add(record.authority.sessionId);
      else this.runningSessionIds.delete(record.authority.sessionId);

      for (const submission of this.submissions.values()) {
        const queued = this.queueEntries.some((entry) => entry.privateId === submission.promptId);
        const running = next.runningPromptId === submission.promptId;
        if (queued || running) {
          submission.status = running ? 'running' : 'queued';
          submission.accepted = true;
          acceptedPromptIds.push(submission.promptId);
          submission.resolveAccepted?.({ status: submission.status });
          submission.resolveAccepted = null;
          continue;
        }
        if (submission.status === 'unknown' || previousLivePromptIds.has(submission.promptId)) {
          submission.status = 'reconciled';
          submission.settled = true;
          submission.resolveAccepted?.({ status: submission.status });
          submission.resolveAccepted = null;
          reconciledPromptIds.push(submission.promptId);
          this.submissions.delete(submission.promptId);
        }
      }
      this.#reconcileQueueMutation();
      this.#publish({
        ...this.#conversationBase(record.authority),
        phase: next.runningPromptId ? 'sending' : 'ready',
        streaming: Boolean(next.runningPromptId),
        error: null,
        stopReason: this.snapshot.stopReason ?? null,
      });
    });
    if (!applied) return;
    for (const promptId of new Set(acceptedPromptIds)) {
      if (typeof this.attachmentStore.markReservationAccepted === 'function') {
        this.attachmentStore.markReservationAccepted({
          accountId: record.authority.accountId,
          agentId: record.authority.agentId,
          sessionId: record.authority.sessionId,
          promptId,
        }).catch(() => {});
      }
    }
    this.#reconcileRestoredReservations(
      record,
      next,
      new Set([...removedPromptIds, ...reconciledPromptIds]),
    ).catch(() => {});
  }

  #ensurePublicQueueId(privateId) {
    if (this.queuePublicIds.has(privateId)) return this.queuePublicIds.get(privateId);
    const publicId = `queue-${++this.queuePublicCounter}`;
    this.queuePublicIds.set(privateId, publicId);
    this.queuePrivateIds.set(publicId, privateId);
    return publicId;
  }

  #reconcileQueueMutation() {
    const mutation = this.queueMutation;
    if (!mutation || this.queueRevision <= mutation.baseRevision) return;
    const entry = mutation.privateId
      ? this.queueEntries.find((candidate) => candidate.privateId === mutation.privateId)
      : null;
    const succeeded = mutation.kind === 'remove'
      ? !entry
      : mutation.kind === 'edit'
        ? entry?.public.text === mutation.expectedText
        : mutation.kind === 'send_now'
          ? this.queueRunningPromptId === mutation.privateId || !entry
          : mutation.kind === 'reorder'
            ? mutation.orderedPrivateIds.every((id, index) => this.queueEntries[index]?.privateId === id)
            : mutation.kind === 'clear'
              ? !this.queueEntries.some((candidate) => candidate.owner === CLIENT_IDENTIFIER)
              : false;
    this.queueMutation = succeeded
      ? null
      : { ...mutation, failed: true, message: '队列已发生变化，请按最新顺序重试。' };
  }

  async #reconcileRestoredReservations(record, queue, removedPromptIds = new Set()) {
    const reservations = this.attachmentStore.listReservations?.({
      accountId: record.authority.accountId,
      agentId: record.authority.agentId,
      sessionId: record.authority.sessionId,
    }) || [];
    const livePromptIds = new Set([
      ...queue.entries.map((entry) => entry.id),
      ...(queue.runningPromptId ? [queue.runningPromptId] : []),
    ]);
    for (const reservation of reservations) {
      if (livePromptIds.has(reservation.promptId)) {
        await this.attachmentStore.markReservationAccepted({
          accountId: record.authority.accountId,
          agentId: record.authority.agentId,
          sessionId: record.authority.sessionId,
          promptId: reservation.promptId,
        });
      } else if (removedPromptIds.has(reservation.promptId)) {
        await this.attachmentStore.consumeReservation({
          accountId: record.authority.accountId,
          agentId: record.authority.agentId,
          sessionId: record.authority.sessionId,
          promptId: reservation.promptId,
        });
      } else if (reservation.status === 'submitting') {
        await this.attachmentStore.markReservationUnknown({
          accountId: record.authority.accountId,
          agentId: record.authority.agentId,
          sessionId: record.authority.sessionId,
          promptId: reservation.promptId,
        });
      }
    }
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
      queue: this.#publicQueue(),
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

  #publicQueue() {
    return {
      revision: Math.max(0, this.queueRevision),
      synced: this.queueRevision >= 0,
      running: Boolean(this.queueRunningPromptId),
      entries: this.queueEntries.map((entry) => ({ ...entry.public })),
      confirmingCount: [...this.submissions.values()]
        .filter((submission) => ['submitting', 'unknown'].includes(submission.status)).length,
      ...(this.queueMutation
        ? {
          mutation: {
            kind: this.queueMutation.kind,
            pending: this.queueMutation.failed !== true,
            ...(this.queueMutation.message ? { message: this.queueMutation.message } : {}),
          },
        }
        : {}),
    };
  }

  #requireAttachmentAuthority() {
    const authority = this.authority;
    if (!authority || !['ready', 'sending'].includes(this.snapshot.phase)) {
      throw new Error('请先打开 Agent 对话');
    }
    this.#requireReadyAccount(authority.accountId);
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
    for (const record of this.sessionsByKey.values()) {
      this.#cancelHostPermission(record.state.permissionInteraction?.hostRequestId);
    }
    this.sessionsByKey.clear();
    this.sessionsByPrivateId.clear();
    this.authority = null;
    this.currentSessionRecord = null;
    this.activeSessionKey = null;
    this.runningSessionIds.clear();
    const empty = createPrivateSessionState();
    for (const field of SESSION_STATE_FIELDS) this[field] = empty[field];
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
    const projected = deepFreeze(JSON.parse(JSON.stringify(value)));
    const record = this.currentSessionRecord;
    if (record) {
      record.snapshot = projected;
      this.#captureSessionState(record);
    }
    if (!record || record.key === this.activeSessionKey) this.snapshot = projected;
    for (const listener of this.listeners) listener(projected);
  }
}

function createPrivateSessionState() {
  return {
    messages: [],
    messageCounter: 0,
    seenInterjectionIds: new Set(),
    transcriptTruncated: false,
    activities: [],
    activityByToolCallId: new Map(),
    activityCounter: 0,
    backgroundTasks: [],
    backgroundTaskByPrivateId: new Map(),
    backgroundTaskCounter: 0,
    backgroundStatus: BACKGROUND_STATUS_READY,
    planEntries: [],
    planStatus: PLAN_STATUS_READY,
    planRefreshGeneration: 0,
    planRefreshPromise: null,
    planRefreshQueued: false,
    artifacts: [],
    artifactStatus: ARTIFACT_STATUS_READY,
    project: null,
    projectStatus: PROJECT_STATUS_READY,
    permissionInteraction: null,
    queueRevision: -1,
    queueEntries: [],
    queueRunningPromptId: null,
    queuePublicIds: new Map(),
    queuePrivateIds: new Map(),
    queuePublicCounter: 0,
    submissions: new Map(),
    queueMutation: null,
  };
}

function sessionRecordKey(authority) {
  return `${String(authority.accountId)}\u0000${authority.agentId}\u0000${authority.sessionId}`;
}

function emptyPublicQueue() {
  return {
    revision: 0,
    synced: false,
    running: false,
    entries: [],
    confirmingCount: 0,
  };
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isUncertainPromptFailure(error) {
  return new Set([
    'host_timeout',
    'host_exited',
    'host_stopped',
  ]).has(String(error?.code || ''));
}

function projectQueueChanged(value) {
  if (
    !value
    || typeof value !== 'object'
    || !Number.isSafeInteger(value.queueRevision)
    || value.queueRevision < 0
    || !Array.isArray(value.entries)
    || value.entries.length > MAX_PUBLIC_QUEUE_ENTRIES
    || (value.runningPromptId !== undefined
      && value.runningPromptId !== null
      && !QUEUE_ENTRY_ID_PATTERN.test(value.runningPromptId))
  ) {
    throw new Error('invalid Prompt Queue snapshot');
  }
  const ids = new Set();
  const positions = new Set();
  const entries = value.entries.map((entry) => {
    if (
      !entry
      || typeof entry !== 'object'
      || !QUEUE_ENTRY_ID_PATTERN.test(entry.id || '')
      || ids.has(entry.id)
      || !Number.isSafeInteger(entry.version)
      || entry.version < 0
      || !Number.isSafeInteger(entry.position)
      || entry.position < 0
      || entry.position >= value.entries.length
      || positions.has(entry.position)
      || typeof entry.text !== 'string'
      || Array.from(entry.text).length > MAX_QUEUE_TEXT_CHARS
      || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u.test(entry.text)
      || !safeOptionalQueueClient(entry.owner)
      || !safeOptionalQueueClient(entry.lastEditor)
    ) {
      throw new Error('invalid Prompt Queue entry');
    }
    ids.add(entry.id);
    positions.add(entry.position);
    return {
      id: entry.id,
      version: entry.version,
      owner: entry.owner || null,
      lastEditor: entry.lastEditor || null,
      kind: typeof entry.kind === 'string' ? entry.kind : '',
      text: entry.text,
      position: entry.position,
    };
  }).sort((left, right) => left.position - right.position);
  return {
    queueRevision: value.queueRevision,
    entries,
    runningPromptId: value.runningPromptId || null,
  };
}

function projectInputCapabilities(value, expectedAgentId) {
  if (
    value?.schemaVersion !== INPUT_CAPABILITIES_SCHEMA_VERSION
    || !Number.isSafeInteger(value?.revision)
    || value.revision < 1
    || value.agentId !== expectedAgentId
    || !Array.isArray(value.commands)
    || value.commands.length > SAFE_INPUT_COMMANDS.size
    || !Array.isArray(value.skills)
    || value.skills.length > MAX_PUBLIC_INPUT_SKILLS
  ) {
    throw new Error('输入能力暂时不可用');
  }

  const commandIds = new Set();
  const commands = [];
  for (const source of value.commands) {
    const canonical = SAFE_INPUT_COMMANDS.get(source?.id);
    if (
      !canonical
      || source.trigger !== canonical.trigger
      || commandIds.has(canonical.id)
    ) {
      // Any non-product command makes the Host projection untrusted. Do not
      // partially return a menu which may conceal a compromised source.
      throw new Error('输入能力暂时不可用');
    }
    commandIds.add(canonical.id);
    commands.push({ ...canonical });
  }

  const skillIds = new Set();
  const skillTriggers = new Set();
  const skills = value.skills.map((skill) => {
    const id = skill?.id;
    const trigger = skill?.trigger;
    const displayName = safeInputCapabilityText(skill?.displayName, 80, false);
    const description = safeInputCapabilityText(skill?.description, 300, false);
    const promptText = safeInputCapabilityText(skill?.promptText, 2_000, true);
    if (
      !INPUT_SKILL_ID_PATTERN.test(id || '')
      || trigger !== `$${id}`
      || skillIds.has(id)
      || skillTriggers.has(trigger)
      || !displayName
      || !description
      || !promptText
    ) {
      throw new Error('输入能力暂时不可用');
    }
    skillIds.add(id);
    skillTriggers.add(trigger);
    return { id, trigger, displayName, description, promptText };
  });

  return {
    schemaVersion: INPUT_CAPABILITIES_SCHEMA_VERSION,
    revision: value.revision,
    agentId: expectedAgentId,
    commands,
    skills,
  };
}

function safeInputCapabilityText(value, maxChars, allowNewlines) {
  if (typeof value !== 'string' || value.trim() !== value) return '';
  if (!value || Array.from(value).length > maxChars) return '';
  const controls = allowNewlines
    ? /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u
    : /[\u0000-\u001F\u007F-\u009F]/u;
  return controls.test(value) ? '' : value;
}

function safeOptionalQueueClient(value) {
  return value === undefined
    || value === null
    || (typeof value === 'string'
      && value.length <= 100
      && !/[\u0000-\u001F\u007F-\u009F]/u.test(value));
}

function safeQueueKind(value) {
  return typeof value === 'string'
    && /^[a-z0-9_-]{1,40}$/i.test(value)
    ? value
    : 'prompt';
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
  validateSafeSlashCommand(text);
  return text;
}

function validatePromptRequest(value) {
  if (typeof value === 'string') return { text: validatePrompt(value), attachmentIds: [] };
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('消息格式无效');
  }
  const text = String(value.text || '').trim();
  if (text.length > MAX_PROMPT_CHARS) throw new Error('消息过长');
  if (text) validateSafeSlashCommand(text);
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

function validateSafeSlashCommand(text) {
  const firstToken = String(text || '').match(/^(\/[^\s]*)/u)?.[1] || '';
  if (!firstToken || SAFE_INPUT_COMMAND_TRIGGERS.has(firstToken)) return;
  throw new Error('此命令未获客户端允许。请从“/”菜单选择可用命令。');
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
  validateSafeSlashCommand,
  projectInputCapabilities,
};
