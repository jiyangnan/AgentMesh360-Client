'use strict';

const bridge = window.agentmesh360;
const root = document.getElementById('app');
let currentState = { phase: 'starting' };
let workspaceView = 'agents';
let readyAccountId = null;
let providerUi = {
  phase: 'idle',
  snapshot: null,
  error: null,
  message: null,
  busy: false,
  editingProfileId: null,
};
let providerDraft = null;
let conversationDrafts = new Map();
let packageUi = {
  phase: 'idle',
  snapshot: null,
  error: null,
  message: null,
  busy: false,
  pendingApproval: null,
  unknownOutcome: null,
};
let backgroundUi = {
  phase: 'idle',
  snapshot: null,
  error: null,
  message: null,
  busy: false,
};
let conversationUi = { phase: 'idle' };
let permissionResponseInFlight = null;

bridge.onState(render);
bridge.onConversationState((state) => {
  conversationUi = state || { phase: 'idle' };
  if (currentState.phase === 'ready' && workspaceView === 'conversation') {
    renderReady(currentState);
  }
});
bridge.getState().then(render).catch(() => render({
  phase: 'unavailable',
  message: '桌面身份服务没有响应',
  canLogout: false,
}));

function render(state) {
  const previousState = currentState;
  currentState = state || { phase: 'unavailable', message: '身份状态无效' };
  if (isBackgroundReadyRefresh(previousState, currentState)) {
    refreshReadyIdentityMetadata(currentState);
    return;
  }
  if (currentState.phase === 'ready' && currentState.account?.id !== readyAccountId) {
    document.getElementById('provider-profile-form')?.remove();
    document.getElementById('conversation-form')?.remove();
    readyAccountId = currentState.account?.id ?? null;
    workspaceView = 'agents';
    providerUi = {
      phase: 'idle',
      snapshot: null,
      error: null,
      message: null,
      busy: false,
      editingProfileId: null,
    };
    providerDraft = null;
    conversationDrafts = new Map();
    packageUi = {
      phase: 'idle',
      snapshot: null,
      error: null,
      message: null,
      busy: false,
      pendingApproval: null,
      unknownOutcome: null,
    };
    backgroundUi = {
      phase: 'idle',
      snapshot: null,
      error: null,
      message: null,
      busy: false,
    };
    conversationUi = { phase: 'idle' };
    permissionResponseInFlight = null;
    restoreConversationSnapshot(readyAccountId);
  } else if (['signed_out', 'blocked', 'unavailable'].includes(currentState.phase)) {
    readyAccountId = null;
    workspaceView = 'agents';
    providerUi.snapshot = null;
    providerUi.phase = 'idle';
    providerDraft = null;
    conversationDrafts = new Map();
    packageUi.snapshot = null;
    packageUi.phase = 'idle';
    packageUi.pendingApproval = null;
    packageUi.unknownOutcome = null;
    backgroundUi.snapshot = null;
    backgroundUi.phase = 'idle';
    conversationUi = { phase: 'idle' };
    permissionResponseInFlight = null;
  }
  switch (currentState.phase) {
    case 'signed_out':
      renderSignedOut(currentState);
      break;
    case 'blocked':
      renderBlocked(currentState);
      break;
    case 'ready':
      renderReady(currentState);
      break;
    case 'unavailable':
      renderUnavailable(currentState);
      break;
    case 'starting':
    case 'checking':
    default:
      renderChecking(currentState);
  }
}

function isBackgroundReadyRefresh(previousState, nextState) {
  return (
    previousState?.phase === 'ready'
    && nextState?.phase === 'ready'
    && previousState.account?.id === nextState.account?.id
    && Number.isInteger(previousState.validationRevision)
    && Number.isInteger(nextState.validationRevision)
    && previousState.validationRevision !== nextState.validationRevision
  );
}

function refreshReadyIdentityMetadata(state) {
  const account = state.account || {};
  const subscription = state.subscription || {};
  const credits = state.credits || {};
  setText('[data-ready-account-name]', account.displayName || 'AgentMesh360 用户');
  setText('[data-ready-account-email]', account.email || '');
  setText('[data-ready-welcome]', `欢迎回来，${firstName(account)}`);
  setText('[data-ready-subscription]', `${subscriptionLabel(subscription)} · 订阅验证通过`);
  setText('[data-ready-credits]', formatNumber(credits.balance));
  setText(
    '[data-ready-checked-at]',
    `订阅状态已由 Core 与本地 Host 双重确认 · ${formatCheckedAt(state.checkedAt)}`,
  );
}

function setText(selector, value) {
  const element = document.querySelector(selector);
  if (element) element.textContent = value;
}

async function restoreConversationSnapshot(accountId) {
  try {
    const state = await bridge.getConversationSnapshot();
    if (
      currentState.phase !== 'ready'
      || currentState.account?.id !== accountId
      || !state
      || state.phase === 'idle'
    ) {
      return;
    }
    conversationUi = state;
    workspaceView = 'conversation';
    renderReady(currentState);
  } catch {
    // The Agent cards remain available as the safe recovery path.
  }
}

function brand() {
  return '<div class="brand"><i class="brand-mark" aria-hidden="true"></i><span>AgentMesh360</span></div>';
}

function renderSignedOut(state) {
  root.innerHTML = `
    <section class="shell auth-layout">
      <div class="auth-story">
        ${brand()}
        <div class="story-copy">
          <p class="eyebrow">Persistent Agent Workspace</p>
          <h1>你的专业 Agent，<br><span>始终在场。</span></h1>
          <p>激活一次，长期驻留。每个已激活的产品 Agent 都会保留自己的固定主会话，随时从上次进度继续。</p>
        </div>
        <div class="resident-line"><i class="pulse" aria-hidden="true"></i>Grok Build Harness · 本地持久会话</div>
      </div>
      <div class="auth-pane">
        <form class="auth-card" id="login-form">
          <p class="eyebrow">AgentMesh360 Account</p>
          <h2>登录你的工作台</h2>
          <p class="subtitle">客户端会先验证有效订阅，再启动本地 Agent Host。</p>
          ${state.error ? `<div class="form-error" role="alert">${escapeHtml(state.error)}</div>` : ''}
          <div class="oauth-actions">
            <button class="oauth-button" type="button" data-oauth-provider="google"><span>G</span>使用 Google 登录</button>
            <button class="oauth-button" type="button" data-oauth-provider="github"><span>GH</span>使用 GitHub 登录</button>
          </div>
          <div class="auth-divider"><span>或使用邮箱密码</span></div>
          <label class="field"><span>邮箱</span><input name="email" type="email" autocomplete="username" required autofocus placeholder="you@example.com"></label>
          <label class="field"><span>密码</span><input name="password" type="password" autocomplete="current-password" required placeholder="输入登录密码"></label>
          <button class="primary" type="submit">登录并验证订阅</button>
          <p class="auth-note">还没有账号？<button type="button" class="text-link" id="open-registration">注册并订阅 AgentMesh360</button><br>刷新令牌仅通过系统安全存储加密保存在本机。</p>
        </form>
      </div>
    </section>`;
  document.getElementById('login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = event.currentTarget.querySelector('button[type="submit"]');
    const data = new FormData(event.currentTarget);
    button.disabled = true;
    button.textContent = '正在登录…';
    await bridge.login({ email: data.get('email'), password: data.get('password') });
  });
  document.querySelectorAll('[data-oauth-provider]').forEach((button) => {
    button.addEventListener('click', async () => {
      const provider = button.dataset.oauthProvider;
      document.querySelectorAll('[data-oauth-provider]').forEach((item) => {
        item.disabled = true;
      });
      button.textContent = '正在打开系统浏览器…';
      await bridge.oauthLogin(provider);
    });
  });
  document.getElementById('open-registration').addEventListener('click', () => bridge.openRegistration());
}

function renderChecking(state) {
  root.innerHTML = `
    <section class="shell state-wrap">
      <div class="state-card">
        <div class="spinner" aria-hidden="true"></div>
        <p class="eyebrow">Secure Access Check</p>
        <h2>正在建立安全工作区</h2>
        <p class="subtitle">${escapeHtml(state.message || '正在检查本机登录状态与 AgentMesh360 订阅…')}</p>
        <div class="security-row">登录凭据不会暴露给界面或 Agent 会话</div>
      </div>
    </section>`;
}

function renderBlocked(state) {
  const account = state.account || {};
  const subscription = state.subscription || {};
  const reason = blockedReason(state.access?.reason, subscription.status);
  root.innerHTML = `
    <section class="shell state-wrap">
      <div class="state-card">
        <div class="state-icon warning" aria-hidden="true">◇</div>
        <p class="eyebrow">Subscription Required</p>
        <h2>${escapeHtml(reason.title)}</h2>
        <p class="subtitle">${escapeHtml(reason.message)}你的本地 Agent 会话仍保留在磁盘中，恢复订阅后可继续使用。</p>
        ${accountChip(account)}
        <div class="state-actions">
          <button class="secondary" id="open-subscription">前往官网订阅</button>
          <button class="ghost" id="recheck">我已完成，重新检查</button>
          <button class="ghost" id="logout">退出登录</button>
        </div>
      </div>
    </section>`;
  document.getElementById('open-subscription').addEventListener('click', () => bridge.openSubscription());
  document.getElementById('recheck').addEventListener('click', () => bridge.recheck());
  document.getElementById('logout').addEventListener('click', () => bridge.logout());
}

function renderUnavailable(state) {
  root.innerHTML = `
    <section class="shell state-wrap">
      <div class="state-card">
        <div class="state-icon error" aria-hidden="true">!</div>
        <p class="eyebrow">Access Check Unavailable</p>
        <h2>暂时无法进入工作台</h2>
        <p class="subtitle">${escapeHtml(state.message || '订阅验证暂时不可用。为保护本地 Agent 会话，客户端已保持关闭状态。')}</p>
        <div class="state-actions">
          <button class="secondary" id="retry">重新检查</button>
          ${state.canLogout ? '<button class="ghost" id="logout">退出登录</button>' : ''}
        </div>
        <div class="security-row">验证失败时不会启动或恢复任何产品 Agent</div>
      </div>
    </section>`;
  document.getElementById('retry').addEventListener('click', () => bridge.recheck());
  document.getElementById('logout')?.addEventListener('click', () => bridge.logout());
}

function renderReady(state) {
  captureRendererDrafts();
  const account = state.account || {};
  root.innerHTML = `
    <section class="shell workspace">
      <aside class="sidebar">
        ${brand()}
        <p class="nav-label">Workspace</p>
        <button class="nav-item ${workspaceView === 'agents' ? 'active' : ''}" id="nav-agents" type="button"><i class="nav-dot"></i>常驻 Agent</button>
        <button class="nav-item ${workspaceView === 'conversation' ? 'active' : ''}" id="nav-conversation" type="button" ${conversationUi.phase === 'idle' ? 'disabled' : ''}><i class="nav-dot"></i>当前对话</button>
        <button class="nav-item ${workspaceView === 'packages' ? 'active' : ''}" id="nav-packages" type="button"><i class="nav-dot"></i>Agent Package</button>
        <button class="nav-item ${workspaceView === 'providers' ? 'active' : ''}" id="nav-providers" type="button"><i class="nav-dot"></i>Provider 设置</button>
        <button class="nav-item ${workspaceView === 'client' ? 'active' : ''}" id="nav-client" type="button"><i class="nav-dot"></i>客户端设置</button>
        <div class="sidebar-spacer"></div>
        <div class="sidebar-account">
          <div class="avatar">${escapeHtml(initials(account))}</div>
          <div class="copy"><strong data-ready-account-name>${escapeHtml(account.displayName || 'AgentMesh360 用户')}</strong><span data-ready-account-email>${escapeHtml(account.email || '')}</span></div>
          <button class="ghost" id="logout" title="退出登录">↗</button>
        </div>
      </aside>
      <main class="workspace-main">${workspaceView === 'conversation' ? conversationView() : workspaceView === 'packages' ? packageCenterView() : workspaceView === 'providers' ? providerSettingsView(state) : workspaceView === 'client' ? backgroundSettingsView() : agentWorkspaceView(state)}</main>
    </section>`;
  document.getElementById('logout').addEventListener('click', () => bridge.logout());
  document.getElementById('nav-agents').addEventListener('click', () => {
    workspaceView = 'agents';
    renderReady(currentState);
  });
  document.getElementById('nav-conversation')?.addEventListener('click', () => {
    workspaceView = 'conversation';
    renderReady(currentState);
  });
  document.getElementById('nav-packages').addEventListener('click', () => {
    workspaceView = 'packages';
    renderReady(currentState);
    if (packageUi.phase === 'idle') refreshPackageSnapshot();
  });
  document.getElementById('nav-providers').addEventListener('click', () => {
    workspaceView = 'providers';
    renderReady(currentState);
    if (providerUi.phase === 'idle') refreshProviderSnapshot();
  });
  document.getElementById('nav-client').addEventListener('click', () => {
    workspaceView = 'client';
    renderReady(currentState);
    if (backgroundUi.phase === 'idle') refreshBackgroundSnapshot();
  });
  if (workspaceView === 'conversation') {
    wireConversation();
  } else if (workspaceView === 'packages') {
    wirePackageCenter();
  } else if (workspaceView === 'providers') {
    wireProviderSettings();
  } else if (workspaceView === 'client') {
    wireBackgroundSettings();
  }
  for (const button of document.querySelectorAll('[data-open-conversation]')) {
    button.addEventListener('click', () => openConversation(button.dataset.openConversation));
  }
}

function captureRendererDrafts() {
  captureProviderDraft();
  const conversationForm = document.getElementById('conversation-form');
  const draftKey = conversationDraftKey();
  if (conversationForm && draftKey) {
    const value = String(conversationForm.elements.message?.value || '');
    if (value) conversationDrafts.set(draftKey, value);
    else conversationDrafts.delete(draftKey);
  }
}

function captureProviderDraft() {
  const form = document.getElementById('provider-profile-form');
  if (!form) return;
  const modelSelect = form.elements.enabledModels;
  const modelStatus = form.querySelector('#model-discovery-status');
  const connectionStatus = form.querySelector('#connection-test-status');
  providerDraft = {
    editingProfileId: providerUi.editingProfileId || null,
    presetId: String(form.elements.presetId?.value || ''),
    displayName: String(form.elements.displayName?.value || ''),
    protocol: String(form.elements.protocol?.value || 'openai_chat'),
    authKind: String(form.elements.authKind?.value || 'bearer_api_key'),
    baseUrl: String(form.elements.baseUrl?.value || ''),
    apiKey: String(form.elements.apiKey?.value || ''),
    manualModel: String(form.elements.manualModel?.value || ''),
    modelOptions: [...(modelSelect?.options || [])]
      .filter((optionElement) => optionElement.value)
      .map((optionElement) => ({
        value: optionElement.value,
        label: optionElement.textContent || optionElement.value,
      })),
    selectedModel: String(modelSelect?.value || ''),
    modelDiscoveryPassed: form.dataset.modelDiscoveryPassed === 'true',
    connectionTestPassed: form.dataset.connectionTestPassed === 'true',
    configRevision: String(form.dataset.configRevision || '0'),
    modelStatus: {
      status: modelStatus?.dataset.status || 'idle',
      title: modelStatus?.querySelector('strong')?.textContent || '',
      detail: modelStatus?.querySelector('span')?.textContent || '',
    },
    connectionStatus: {
      status: connectionStatus?.dataset.status || 'idle',
      title: connectionStatus?.querySelector('strong')?.textContent || '',
      detail: connectionStatus?.querySelector('span')?.textContent || '',
    },
  };
}

function conversationDraftKey() {
  const agentId = conversationUi?.agentId;
  if (!readyAccountId || !agentId) return null;
  return `${readyAccountId}:${agentId}`;
}

function conversationView() {
  const messages = Array.isArray(conversationUi.messages) ? conversationUi.messages : [];
  const activities = safeConversationActivities(conversationUi.activities);
  const backgroundTasks = safeConversationBackgroundTasks(conversationUi.backgroundTasks);
  const backgroundUnavailable = conversationUi.backgroundStatus === 'unavailable';
  const planEntries = safeConversationPlanEntries(conversationUi.planEntries);
  const planUnavailable = conversationUi.planStatus === 'unavailable';
  const artifacts = safeConversationArtifacts(conversationUi.artifacts);
  const artifactUnavailable = conversationUi.artifactStatus === 'unavailable';
  const project = safeConversationProject(conversationUi.project);
  const projectUnavailable = conversationUi.projectStatus === 'unavailable';
  const loading = conversationUi.phase === 'loading';
  const sending = conversationUi.streaming === true;
  const displayName = conversationUi.displayName || 'Agent';
  const canReopen = conversationUi.phase === 'error' && conversationUi.agentId;
  const awaitingPermission = conversationUi.interaction?.kind === 'permission';
  const gates = `${conversationUi.error ? `
    <div class="conversation-error" role="alert">
      <span>${escapeHtml(conversationUi.error)}</span>
      ${canReopen ? `<button class="ghost" type="button" data-reopen-conversation="${escapeHtml(conversationUi.agentId)}">重新打开</button>` : ''}
    </div>` : ''}${awaitingPermission ? permissionInteractionView(conversationUi.interaction) : ''}`;
  return `
    <section class="conversation-shell" aria-label="固定 Main Session 对话">
      <header class="conversation-header">
        <button class="ghost conversation-back" type="button">← 返回 Agent</button>
        <div>
          <p class="eyebrow">Persistent Main Session</p>
          <h1>${escapeHtml(displayName)}</h1>
          <p>${loading ? '正在由 Host 解析并加载固定主会话…' : '同一账号、同一 Agent、同一个持久主会话'}</p>
        </div>
        <span class="conversation-state ${sending ? 'working' : ''}">${awaitingPermission ? '等待你的确认' : sending ? 'Agent 正在处理' : loading ? '正在加载' : conversationUi.phase === 'error' ? '需要重新打开' : '已连接'}</span>
      </header>
      <div class="conversation-gates">${gates}</div>
      <div class="conversation-transcript" id="conversation-transcript" aria-live="polite">
        ${conversationUi.transcriptTruncated ? '<div class="conversation-truncated">较早内容仍保存在 Host 中，此处只显示最近消息。</div>' : ''}
        ${project || projectUnavailable
    ? conversationProjectView(project, projectUnavailable)
    : ''}
        ${planEntries.length || planUnavailable
    ? conversationPlanView(planEntries, planUnavailable)
    : ''}
        ${backgroundTasks.length || backgroundUnavailable
    ? conversationBackgroundTasksView(backgroundTasks, backgroundUnavailable)
    : ''}
        ${activities.length ? conversationActivitiesView(activities) : ''}
        ${artifacts.length || artifactUnavailable
    ? conversationArtifactsView(artifacts, artifactUnavailable)
    : ''}
        ${messages.length
    ? messages.map(conversationMessage).join('')
    : `<div class="conversation-empty">${loading ? '正在恢复历史…' : `这里会显示 ${escapeHtml(displayName)} 的持久对话历史。`}</div>`}
        ${sending ? `<div class="conversation-typing"><i></i><i></i><i></i><span>${escapeHtml(displayName)} 正在继续这项工作</span></div>` : ''}
      </div>
      <form class="conversation-composer" id="conversation-form">
        <textarea name="message" maxlength="16000" rows="3" placeholder="继续上次的工作，或告诉这个 Agent 你现在需要什么…" ${loading || sending || conversationUi.phase === 'error' ? 'disabled' : ''}></textarea>
        <div>
          <span>Renderer 只接收安全文本投影；Session ID、路径和 Provider 凭据留在 Host。</span>
          <button class="secondary" type="submit" ${loading || sending || conversationUi.phase === 'error' ? 'disabled' : ''}>发送</button>
        </div>
      </form>
    </section>`;
}

function safeConversationBackgroundTasks(value) {
  if (!Array.isArray(value)) return [];
  const safeKinds = new Set(['command', 'monitor']);
  const safeStatuses = new Set(['running', 'completed', 'failed', 'stopped']);
  const seen = new Set();
  return value.slice(-50).flatMap((task) => {
    const backgroundId = typeof task?.backgroundId === 'string' ? task.backgroundId : '';
    if (
      !/^background-\d+$/.test(backgroundId)
      || seen.has(backgroundId)
      || !safeKinds.has(task?.kind)
      || !safeStatuses.has(task?.status)
    ) {
      return [];
    }
    seen.add(backgroundId);
    return [{
      backgroundId,
      kind: task.kind,
      status: task.status,
    }];
  });
}

function conversationBackgroundTasksView(tasks, unavailable) {
  return `
    <section class="conversation-background" aria-label="Agent 后台活动">
      <header>
        <div>
          <p class="eyebrow">Harness Runtime</p>
          <h2>后台活动</h2>
        </div>
        <span>只显示类型和运行状态</span>
      </header>
      ${unavailable
    ? '<p class="background-activity-error">后台活动状态暂时不可用。</p>'
    : `<div class="conversation-background-list">
        ${tasks.map((task) => `
          <div
            class="conversation-background-task ${escapeHtml(task.status)}"
            data-background-id="${escapeHtml(task.backgroundId)}"
          >
            <i aria-hidden="true"></i>
            <strong>${escapeHtml(backgroundTaskKindLabel(task.kind))}</strong>
            <span>${escapeHtml(backgroundTaskStatusLabel(task.status))}</span>
          </div>`).join('')}
      </div>`}
    </section>`;
}

function safeConversationPlanEntries(value) {
  if (!Array.isArray(value)) return [];
  const safeStatuses = new Set(['pending', 'in_progress', 'completed', 'cancelled']);
  const seen = new Set();
  return value.slice(0, 50).flatMap((entry) => {
    const planId = typeof entry?.planId === 'string' ? entry.planId : '';
    const content = typeof entry?.content === 'string' ? entry.content.trim() : '';
    if (
      !/^plan-\d+$/.test(planId)
      || seen.has(planId)
      || !content
      || Array.from(content).length > 300
      || new TextEncoder().encode(content).length > 1_200
      || /[\u0000-\u001F\u007F-\u009F]/.test(content)
      || !safeStatuses.has(entry?.status)
    ) {
      return [];
    }
    seen.add(planId);
    return [{
      planId,
      content,
      status: entry.status,
    }];
  });
}

function conversationPlanView(entries, unavailable) {
  return `
    <section class="conversation-plan" aria-label="Agent 本轮计划">
      <header>
        <div>
          <p class="eyebrow">Session Plan</p>
          <h2>本轮计划</h2>
        </div>
        <span>模型工作计划，不等同于业务进度</span>
      </header>
      ${unavailable
    ? '<p class="session-plan-error">本轮计划暂时不可用。</p>'
    : `<div class="conversation-plan-list">
        ${entries.map((entry) => `
          <div
            class="conversation-plan-entry ${escapeHtml(entry.status)}"
            data-plan-id="${escapeHtml(entry.planId)}"
          >
            <i aria-hidden="true"></i>
            <strong>${escapeHtml(entry.content)}</strong>
            <span>${escapeHtml(planStatusLabel(entry.status))}</span>
          </div>`).join('')}
      </div>`}
    </section>`;
}

function planStatusLabel(status) {
  return {
    pending: '待处理',
    in_progress: '进行中',
    completed: '已完成',
    cancelled: '已取消',
  }[status] || '待处理';
}

function safeConversationActivities(value) {
  if (!Array.isArray(value)) return [];
  const safeStatuses = new Set(['pending', 'in_progress', 'completed', 'failed']);
  return value.slice(-50).flatMap((activity) => {
    if (
      !/^activity-\d+$/.test(activity?.activityId || '')
      || !safeStatuses.has(activity?.status)
    ) {
      return [];
    }
    return [{
      activityId: activity.activityId,
      toolKind: activityToolKind(activity.toolKind),
      status: activity.status,
    }];
  });
}

function conversationActivitiesView(activities) {
  return `
    <section class="conversation-activities" aria-label="Agent 最近活动">
      <header>
        <div>
          <p class="eyebrow">Harness Activity</p>
          <h2>最近活动</h2>
        </div>
        <span>只显示操作类型和状态</span>
      </header>
      <div class="conversation-activity-list">
        ${activities.map((activity) => `
          <div
            class="conversation-activity ${escapeHtml(activity.status)}"
            data-activity-id="${escapeHtml(activity.activityId)}"
          >
            <i aria-hidden="true"></i>
            <strong>${escapeHtml(activityToolKindLabel(activity.toolKind))}</strong>
            <span>${escapeHtml(activityStatusLabel(activity.status))}</span>
          </div>`).join('')}
      </div>
    </section>`;
}

function safeConversationProject(value) {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== 'object') return null;
  const title = safeProjectText(value.title, 120);
  const summary = safeProjectText(value.summary, 500);
  const safeStatuses = new Set(['active', 'waiting_for_user', 'blocked', 'completed']);
  const safeStepStatuses = new Set(['pending', 'in_progress', 'blocked', 'completed']);
  if (
    !title
    || !summary
    || !safeStatuses.has(value.status)
    || !Array.isArray(value.steps)
    || value.steps.length > 20
  ) {
    return null;
  }
  const seen = new Set();
  const steps = [];
  for (const step of value.steps) {
    const stepId = typeof step?.stepId === 'string' ? step.stepId : '';
    const label = safeProjectText(step?.label, 160);
    if (
      !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(stepId)
      || seen.has(stepId)
      || !label
      || !safeStepStatuses.has(step?.status)
    ) {
      return null;
    }
    seen.add(stepId);
    steps.push({ stepId, label, status: step.status });
  }
  return {
    title,
    status: value.status,
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

function conversationProjectView(project, unavailable) {
  return `
    <section class="conversation-project" aria-label="Agent 当前项目">
      <header>
        <div>
          <p class="eyebrow">Workspace Project</p>
          <h2>当前进度</h2>
        </div>
        <span>Agent 业务状态的只读摘要</span>
      </header>
      ${unavailable
    ? '<p class="project-state-error">项目状态暂时不可用。</p>'
    : `<div class="conversation-project-summary">
          <div>
            <strong>${escapeHtml(project.title)}</strong>
            <span class="${escapeHtml(project.status)}">${escapeHtml(projectStatusLabel(project.status))}</span>
          </div>
          <p>${escapeHtml(project.summary)}</p>
        </div>
        ${project.steps.length
    ? `<div class="conversation-project-steps">
            ${project.steps.map((step) => `
              <div
                class="conversation-project-step ${escapeHtml(step.status)}"
                data-project-step-id="${escapeHtml(step.stepId)}"
              >
                <i aria-hidden="true"></i>
                <strong>${escapeHtml(step.label)}</strong>
                <span>${escapeHtml(projectStepStatusLabel(step.status))}</span>
              </div>`).join('')}
          </div>`
    : ''}`}
    </section>`;
}

function projectStatusLabel(status) {
  return {
    active: '进行中',
    waiting_for_user: '等待确认',
    blocked: '已阻塞',
    completed: '已完成',
  }[status] || '进行中';
}

function projectStepStatusLabel(status) {
  return {
    pending: '待处理',
    in_progress: '进行中',
    blocked: '已阻塞',
    completed: '已完成',
  }[status] || '待处理';
}

function safeConversationArtifacts(value) {
  if (!Array.isArray(value)) return [];
  const safeKinds = new Set([
    'document',
    'image',
    'audio',
    'video',
    'archive',
    'code',
    'data',
    'other',
  ]);
  const seen = new Set();
  return value.slice(0, 100).flatMap((artifact) => {
    const artifactId = typeof artifact?.artifactId === 'string' ? artifact.artifactId : '';
    const title = typeof artifact?.title === 'string' ? artifact.title.trim() : '';
    if (
      !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(artifactId)
      || seen.has(artifactId)
      || !title
      || title.length > 120
      || /[\u0000-\u001F\u007F-\u009F]/.test(title)
      || !safeKinds.has(artifact?.kind)
      || !Number.isSafeInteger(artifact?.sizeBytes)
      || artifact.sizeBytes < 0
    ) {
      return [];
    }
    seen.add(artifactId);
    return [{
      artifactId,
      title,
      kind: artifact.kind,
      sizeBytes: artifact.sizeBytes,
    }];
  });
}

function conversationArtifactsView(artifacts, unavailable) {
  return `
    <section class="conversation-artifacts" aria-label="Agent 产物">
      <header>
        <div>
          <p class="eyebrow">Workspace Artifacts</p>
          <h2>产物</h2>
        </div>
        <span>Host 验证的只读索引</span>
      </header>
      ${unavailable
    ? '<p class="artifact-index-error">产物索引暂时不可用。</p>'
    : `<div class="conversation-artifact-list">
          ${artifacts.map((artifact) => `
            <article class="conversation-artifact" data-artifact-id="${escapeHtml(artifact.artifactId)}">
              <span aria-hidden="true">${escapeHtml(artifactKindSymbol(artifact.kind))}</span>
              <div>
                <strong>${escapeHtml(artifact.title)}</strong>
                <small>${escapeHtml(artifactKindLabel(artifact.kind))} · ${escapeHtml(formatArtifactSize(artifact.sizeBytes))}</small>
              </div>
            </article>`).join('')}
        </div>`}
    </section>`;
}

function artifactKindSymbol(kind) {
  return {
    document: '文',
    image: '图',
    audio: '音',
    video: '影',
    archive: '包',
    code: '码',
    data: '数',
    other: '件',
  }[kind] || '件';
}

function artifactKindLabel(kind) {
  return {
    document: '文档',
    image: '图片',
    audio: '音频',
    video: '视频',
    archive: '归档',
    code: '代码',
    data: '数据',
    other: '其他',
  }[kind] || '其他';
}

function formatArtifactSize(sizeBytes) {
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)} KB`;
  if (sizeBytes < 1024 * 1024 * 1024) {
    return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(sizeBytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function activityToolKind(kind) {
  return [
    'read',
    'edit',
    'delete',
    'move',
    'search',
    'execute',
    'fetch',
    'think',
    'switch_mode',
    'other',
  ].includes(kind) ? kind : 'other';
}

function activityToolKindLabel(kind) {
  return {
    read: '读取资料',
    edit: '编辑内容',
    delete: '删除内容',
    move: '移动内容',
    search: '搜索信息',
    execute: '执行操作',
    fetch: '获取外部信息',
    think: '分析处理',
    switch_mode: '切换工作模式',
    other: '处理工具任务',
  }[kind] || '处理工具任务';
}

function activityStatusLabel(status) {
  return {
    pending: '等待执行',
    in_progress: '执行中',
    completed: '已完成',
    failed: '未完成',
  }[status] || '状态未知';
}

function backgroundTaskKindLabel(kind) {
  return {
    command: '后台命令',
    monitor: '监控任务',
  }[kind] || '后台活动';
}

function backgroundTaskStatusLabel(status) {
  return {
    running: '运行中',
    completed: '已完成',
    failed: '失败',
    stopped: '已停止',
  }[status] || '状态未知';
}

function permissionInteractionView(interaction) {
  const options = Array.isArray(interaction?.options) ? interaction.options : [];
  const responding = interaction?.responding === true;
  return `
    <section class="conversation-permission" aria-label="Agent 操作确认">
      <div class="permission-operation">
        <span>${escapeHtml(permissionToolKindLabel(interaction?.toolKind))}</span>
        <div>
          <p class="eyebrow">One-time Permission</p>
          <h2>${escapeHtml(interaction?.title || 'Agent 请求执行一项操作')}</h2>
          <p>请明确选择本次是否执行。客户端不会替你记住允许，也不会自动批准。</p>
        </div>
      </div>
      <div class="conversation-permission-actions">
        <button class="ghost cancel-conversation-permission" type="button" ${responding ? 'disabled' : ''}>${responding ? '正在提交…' : '暂不执行'}</button>
        ${options.map((option) => `
          <button
            class="${option.decision === 'allow' ? 'secondary' : 'ghost danger-text'} conversation-permission-option"
            type="button"
            data-permission-option="${escapeHtml(option.optionId)}"
            ${responding ? 'disabled' : ''}
          >${escapeHtml(option.label)}</button>`).join('')}
      </div>
    </section>`;
}

function permissionToolKindLabel(kind) {
  return {
    read: '读取',
    edit: '编辑',
    delete: '删除',
    move: '移动',
    search: '搜索',
    execute: '执行',
    fetch: '联网',
  }[kind] || '操作';
}

function conversationMessage(message) {
  const role = message?.role === 'user' ? 'user' : 'assistant';
  const displayName = conversationUi.displayName || 'Agent';
  const initial = Array.from(displayName.trim())[0]?.toUpperCase() || 'A';
  return `
    <article class="conversation-message ${role}">
      <span>${role === 'user' ? '你' : escapeHtml(initial)}</span>
      <div><b>${role === 'user' ? '你' : escapeHtml(displayName)}</b><p>${escapeHtml(message?.text || '')}</p></div>
    </article>`;
}

function wireConversation() {
  document.querySelector('.conversation-back')?.addEventListener('click', () => {
    workspaceView = 'agents';
    renderReady(currentState);
  });
  document.querySelector('[data-reopen-conversation]')?.addEventListener('click', (event) => {
    openConversation(event.currentTarget.dataset.reopenConversation);
  });
  document.querySelector('.cancel-conversation-permission')?.addEventListener('click', () => {
    respondConversationPermission(null);
  });
  for (const button of document.querySelectorAll('[data-permission-option]')) {
    button.addEventListener('click', () => {
      respondConversationPermission(button.dataset.permissionOption);
    });
  }
  const transcript = document.getElementById('conversation-transcript');
  if (transcript) transcript.scrollTop = transcript.scrollHeight;
  const form = document.getElementById('conversation-form');
  const restoredDraft = conversationDrafts.get(conversationDraftKey()) || '';
  if (form?.elements.message && restoredDraft) form.elements.message.value = restoredDraft;
  form?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const textarea = form.elements.message;
    const text = textarea.value.trim();
    if (!text) return;
    const draftKey = conversationDraftKey();
    textarea.value = '';
    try {
      const state = await bridge.sendConversationMessage(text);
      conversationUi = state;
      if (draftKey) conversationDrafts.delete(draftKey);
    } catch (error) {
      if (draftKey) conversationDrafts.set(draftKey, text);
      conversationUi = {
        ...conversationUi,
        error: publicError(error, '消息发送失败'),
      };
    }
    if (currentState.phase === 'ready') renderReady(currentState);
  });
}

async function respondConversationPermission(optionId) {
  const interactionId = conversationUi.interaction?.interactionId;
  if (!interactionId || permissionResponseInFlight) return;
  permissionResponseInFlight = interactionId;
  conversationUi = {
    ...conversationUi,
    interaction: {
      ...conversationUi.interaction,
      responding: true,
    },
  };
  if (currentState.phase === 'ready') renderReady(currentState);
  try {
    conversationUi = await bridge.respondConversationPermission(interactionId, optionId);
  } catch (error) {
    conversationUi = {
      ...conversationUi,
      interaction: undefined,
      error: publicError(error, '权限请求已失效'),
    };
  } finally {
    if (permissionResponseInFlight === interactionId) permissionResponseInFlight = null;
  }
  if (currentState.phase === 'ready') renderReady(currentState);
}

async function openConversation(agentId) {
  workspaceView = 'conversation';
  conversationUi = {
    phase: 'loading',
    agentId,
    displayName: currentState.agents?.find((agent) => agent.agentId === agentId)?.displayName || agentId,
    messages: [],
    activities: [],
    backgroundTasks: [],
    backgroundStatus: 'ready',
    planEntries: [],
    planStatus: 'ready',
    artifacts: [],
    artifactStatus: 'ready',
    project: null,
    projectStatus: 'ready',
    streaming: false,
    error: null,
  };
  renderReady(currentState);
  try {
    conversationUi = await bridge.openAgentConversation(agentId);
  } catch (error) {
    conversationUi = {
      ...conversationUi,
      phase: 'error',
      error: publicError(error, '暂时无法打开此 Agent 的主对话'),
    };
  }
  if (currentState.phase === 'ready') renderReady(currentState);
}

function packageCenterView() {
  const snapshot = packageUi.snapshot;
  const catalog = snapshot?.catalog || { packages: [] };
  const status = snapshot?.status || { packages: [], remoteRegistry: {} };
  const discovery = snapshot?.discovery || { outcome: 'unavailable', packages: [] };
  const packages = Array.isArray(catalog.packages) ? catalog.packages : [];
  const installed = Array.isArray(status.packages) ? status.packages : [];
  const registry = status.remoteRegistry || {};
  const remoteAvailable = ['ready', 'updated', 'not_modified', 'last_known_good']
    .includes(registry.outcome) && discovery.outcome === 'ready';
  const activeCount = installed.filter((item) => item.kind === 'installed_active').length;
  const issueCount = installed.filter((item) => item.issue).length
    + (status.lastRefreshIssue ? 1 : 0);
  return `
    <header class="workspace-header package-header">
      <div>
        <p class="eyebrow">Signed Package Center</p>
        <h1>让新的 Agent 安全进入长期工作区。</h1>
        <p>Host 独占签名、Registry、下载地址和本地路径；这里仅显示公开身份、权限变化与运行时结果。</p>
      </div>
      <div class="route-health ${['disabled', 'unavailable'].includes(registry.outcome) ? 'warning-health' : ''}">
        <i></i><span>Remote Registry</span><strong>${escapeHtml(registryStatusLabel(registry))}</strong>
      </div>
    </header>
    ${packageUi.message ? `<div class="provider-notice success" role="status">${escapeHtml(packageUi.message)}</div>` : ''}
    ${packageUi.error ? `<div class="provider-notice error" role="alert">${escapeHtml(packageUi.error)}</div>` : ''}
    ${packageUi.unknownOutcome ? `
      <div class="provider-notice warning package-unknown" role="alert">
        <strong>操作结果未知</strong>
        <span>${escapeHtml(packageUi.unknownOutcome.message)}</span>
        <button class="ghost refresh-package-state" type="button">重新读取状态</button>
      </div>` : ''}
    ${packageUi.phase === 'loading' ? packageLoadingView() : ''}
    ${packageUi.phase === 'error' ? '<button class="secondary retry-packages" type="button">重新读取 Package 状态</button>' : ''}
    ${packageUi.phase === 'ready' ? `
      <section class="package-overview" aria-label="Agent Package 状态">
        <div><span>Runtime packages</span><strong>${packages.length}</strong></div>
        <div><span>Installed active</span><strong>${activeCount}</strong></div>
        <div><span>Catalog generation</span><strong>${escapeHtml(status.catalogGeneration ?? '—')}</strong></div>
        <div><span>Issues</span><strong>${issueCount}</strong></div>
        <p>${escapeHtml(registryStatusCopy(registry))}</p>
      </section>
      <div class="package-toolbar">
        <form class="package-install-form" id="package-install-form">
          <label class="field">
            <span>Agent Package ID <em>只提交身份，不提交 URL 或文件</em></span>
            <input name="packageId" maxlength="128" autocomplete="off" required placeholder="com.agentmesh360.example-agent" ${remoteAvailable ? '' : 'disabled'}>
          </label>
          <button class="secondary" type="submit" ${packageUi.busy || !remoteAvailable ? 'disabled' : ''}>下载并验证</button>
        </form>
        <button class="ghost package-refresh-action" id="refresh-package-registry" type="button" ${packageUi.busy ? 'disabled' : ''}>刷新签名目录</button>
      </div>
      ${packageUi.pendingApproval ? packageApprovalView(packageUi.pendingApproval) : ''}
      ${remoteDiscoveryView(discovery, remoteAvailable)}
      <div class="section-head package-section-head"><h2>Runtime Catalog</h2><span>${packages.length} 个 Agent Package</span></div>
      <div class="package-grid">
        ${packages.length
    ? packages.map((packageRecord) => packageCard(packageRecord, installed, remoteAvailable)).join('')
    : '<div class="empty-agents">Host 当前没有公开的 Agent Package。</div>'}
      </div>
      ${packageStatusAudit(installed)}
    ` : ''}
    <div class="security-row">Renderer 不接收 Registry 原文、下载地址、digest、签名材料、Prompt、Skill 路径或账户 authority</div>`;
}

function remoteDiscoveryView(discovery, remoteAvailable) {
  const packages = Array.isArray(discovery.packages) ? discovery.packages : [];
  if (discovery.outcome !== 'ready') return '';
  const changes = packages.filter((item) => ['new_agent', 'update_available'].includes(item.availability));
  return `
    <section class="remote-discovery" aria-label="可发现 Agent Package">
      <div class="section-head compact">
        <h2>已验证远端目录</h2>
        <span>revision ${escapeHtml(discovery.registryRevision || '—')} · ${escapeHtml(formatPackageTime(discovery.registryExpiresAt, '有效期'))}</span>
      </div>
      ${changes.length ? `
        <div class="remote-package-grid">
          ${changes.map((item) => `
            <article class="remote-package-row">
              <div>
                <b>${escapeHtml(discoveryAvailabilityLabel(item.availability))}</b>
                <strong>${escapeHtml(item.agentId)}</strong>
                <span>${escapeHtml(item.packageId)}</span>
              </div>
              <div class="remote-version">
                <small>${item.currentVersion ? `v${escapeHtml(item.currentVersion)} → ` : ''}</small>
                <strong>v${escapeHtml(item.version)}</strong>
                <span>${escapeHtml(item.publisher)}</span>
              </div>
              <button class="secondary" type="button" data-download-package="${escapeHtml(item.packageId)}" ${packageUi.busy || !remoteAvailable ? 'disabled' : ''}>${item.availability === 'new_agent' ? '下载并验证' : '检查权限并更新'}</button>
            </article>`).join('')}
        </div>
      ` : '<div class="empty-provider">签名目录中没有比当前 Runtime Catalog 更新的 Agent Package。</div>'}
    </section>`;
}

function packageLoadingView() {
  return `
    <div class="provider-loading" role="status">
      <div class="spinner" aria-hidden="true"></div>
      <div><strong>正在读取 Host Package 状态</strong><span>Catalog 与安装审计会在主进程完成白名单投影。</span></div>
    </div>`;
}

function packageApprovalView(approval) {
  const permissions = Array.isArray(approval.addedPermissions)
    ? approval.addedPermissions
    : [];
  return `
    <section class="package-approval" aria-label="Agent Package 权限批准">
      <div class="approval-heading">
        <div>
          <p class="eyebrow">Explicit Approval Required</p>
          <h2>${escapeHtml(approval.packageId)} <span>v${escapeHtml(approval.version)}</span></h2>
        </div>
        <span class="approval-expiry">${escapeHtml(formatApprovalExpiry(approval.expiresInSeconds))}</span>
      </div>
      <p>签名和内容已经由 Host 验证。安装会新增以下权限；只有点击确认后，Renderer 才会把一次性 approvalId 交回 Host。</p>
      <div class="permission-list">
        ${permissions.map((permission) => `<span>${escapeHtml(permissionLabel(permission))}</span>`).join('')}
      </div>
      <div class="approval-actions">
        <button class="ghost cancel-package-approval" type="button" ${packageUi.busy ? 'disabled' : ''}>暂不安装</button>
        <button class="secondary approve-package" type="button" ${packageUi.busy ? 'disabled' : ''}>确认权限并安装</button>
      </div>
    </section>`;
}

function packageCard(packageRecord, installed, remoteAvailable) {
  const statuses = installed.filter((item) => item.packageId === packageRecord.packageId);
  const active = statuses.find((item) => item.kind === 'installed_active');
  const previous = statuses.find((item) => item.kind === 'installed_previous');
  const builtIn = statuses.find((item) => item.kind === 'built_in');
  const current = active || builtIn || statuses[0] || null;
  const permissions = Array.isArray(packageRecord.requestedPermissions)
    ? packageRecord.requestedPermissions
    : [];
  return `
    <article class="package-card">
      <div class="package-card-head">
        <div class="package-sigil">${escapeHtml((packageRecord.agent?.displayName || 'A').slice(0, 1).toUpperCase())}</div>
        <div>
          <h3>${escapeHtml(packageRecord.agent?.displayName || packageRecord.packageId)}</h3>
          <span>${escapeHtml(packageRecord.packageId)} · v${escapeHtml(packageRecord.version)}</span>
        </div>
        <b class="${active ? 'active' : ''}">${escapeHtml(packageStatusLabel(current))}</b>
      </div>
      <p>${escapeHtml(packageRecord.agent?.description || '')}</p>
      <div class="package-permissions">
        ${permissions.map((permission) => `<span>${escapeHtml(permissionLabel(permission))}</span>`).join('')}
      </div>
      ${current?.issue ? `<div class="package-issue">${escapeHtml(current.issue.summary)}</div>` : ''}
      <div class="package-actions">
        <button class="ghost" type="button" data-download-package="${escapeHtml(packageRecord.packageId)}" ${packageUi.busy || !remoteAvailable ? 'disabled' : ''}>下载 / 检查更新</button>
        ${active ? `<button class="ghost" type="button" data-reconcile-package="${escapeHtml(packageRecord.packageId)}" ${packageUi.busy ? 'disabled' : ''}>恢复可见性</button>` : ''}
        ${previous ? `<button class="ghost danger-text" type="button" data-rollback-package="${escapeHtml(packageRecord.packageId)}" ${packageUi.busy ? 'disabled' : ''}>回滚</button>` : ''}
      </div>
    </article>`;
}

function packageStatusAudit(installed) {
  const audit = installed.filter((item) => !['built_in', 'installed_active'].includes(item.kind));
  if (!audit.length) return '';
  return `
    <section class="package-audit">
      <div class="section-head compact"><h2>本地安装审计</h2><span>${audit.length} 条</span></div>
      ${audit.map((item) => `
        <div class="package-audit-row">
          <div><strong>${escapeHtml(item.packageId)}</strong><span>${escapeHtml(item.version || '版本未知')}</span></div>
          <b>${escapeHtml(packageStatusLabel(item))}</b>
          <p>${escapeHtml(item.issue?.summary || 'Host 保留该版本用于受控恢复。')}</p>
        </div>`).join('')}
    </section>`;
}

function wirePackageCenter() {
  document.querySelector('.retry-packages')?.addEventListener('click', () => refreshPackageSnapshot());
  document.querySelector('.refresh-package-state')?.addEventListener('click', () => refreshPackageSnapshot());
  document.getElementById('refresh-package-registry')?.addEventListener('click', refreshPackageRegistry);
  document.getElementById('package-install-form')?.addEventListener('submit', submitPackageDownload);
  document.querySelector('.cancel-package-approval')?.addEventListener('click', () => {
    packageUi = { ...packageUi, pendingApproval: null, message: '本次安装未批准。' };
    renderReady(currentState);
  });
  document.querySelector('.approve-package')?.addEventListener('click', approvePendingPackage);
  for (const button of document.querySelectorAll('[data-download-package]')) {
    button.addEventListener('click', () => downloadPackage(button.dataset.downloadPackage));
  }
  for (const button of document.querySelectorAll('[data-reconcile-package]')) {
    button.addEventListener('click', () => mutatePackage(
      'reconcile',
      button.dataset.reconcilePackage,
      'Agent Package 运行时状态已重新核对。',
    ));
  }
  for (const button of document.querySelectorAll('[data-rollback-package]')) {
    button.addEventListener('click', () => {
      const packageId = button.dataset.rollbackPackage;
      if (!window.confirm(`回滚 ${packageId} 会切换到 Host 已验证的 Previous 版本。继续吗？`)) return;
      mutatePackage('rollback', packageId, 'Agent Package 磁盘回滚已提交。');
    });
  }
}

async function refreshPackageSnapshot(message = null) {
  packageUi = {
    ...packageUi,
    phase: 'loading',
    error: null,
    message,
    busy: false,
    unknownOutcome: null,
  };
  if (workspaceView === 'packages') renderReady(currentState);
  try {
    packageUi = {
      ...packageUi,
      phase: 'ready',
      snapshot: await bridge.getPackageSnapshot(),
      error: null,
      message,
      busy: false,
      unknownOutcome: null,
    };
  } catch (error) {
    packageUi = {
      ...packageUi,
      phase: 'error',
      snapshot: null,
      error: publicError(error, '无法读取 Agent Package 状态'),
      message: null,
      busy: false,
    };
  }
  if (workspaceView === 'packages' && currentState.phase === 'ready') renderReady(currentState);
}

async function refreshPackageRegistry() {
  packageUi = {
    ...packageUi,
    busy: true,
    error: null,
    message: null,
    unknownOutcome: null,
  };
  renderReady(currentState);
  try {
    const response = await bridge.refreshPackageRegistry();
    packageUi = {
      ...packageUi,
      phase: 'ready',
      snapshot: response.snapshot,
      busy: false,
      error: null,
      message: registryRefreshNotice(response.registry),
      unknownOutcome: null,
    };
  } catch (error) {
    packageUi = {
      ...packageUi,
      phase: 'ready',
      busy: false,
      error: publicError(error, '无法刷新 Agent Package Registry'),
      message: null,
    };
  }
  if (workspaceView === 'packages' && currentState.phase === 'ready') renderReady(currentState);
}

async function submitPackageDownload(event) {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  await downloadPackage(data.get('packageId'));
}

async function downloadPackage(packageId) {
  packageUi = {
    ...packageUi,
    busy: true,
    error: null,
    message: null,
    unknownOutcome: null,
  };
  renderReady(currentState);
  try {
    const result = await bridge.downloadAgentPackage(packageId);
    if (handleUnknownPackageOutcome(result)) return;
    if (result.value?.status === 'approval_required') {
      packageUi = {
        ...packageUi,
        phase: 'ready',
        busy: false,
        pendingApproval: result.value.approval,
        message: null,
      };
    } else if (result.value?.status === 'installed') {
      await refreshPackageSnapshot(packageReceiptNotice(result.value.receipt, '安装'));
      return;
    } else {
      throw new Error('Agent Package 下载结果无效');
    }
  } catch (error) {
    setPackageOperationError(error, 'Agent Package 下载失败');
  }
  if (workspaceView === 'packages' && currentState.phase === 'ready') renderReady(currentState);
}

async function approvePendingPackage() {
  const approval = packageUi.pendingApproval;
  if (!approval) return;
  packageUi = {
    ...packageUi,
    busy: true,
    error: null,
    message: null,
    unknownOutcome: null,
  };
  renderReady(currentState);
  try {
    const result = await bridge.approveAgentPackage(approval.approvalId);
    packageUi.pendingApproval = null;
    if (handleUnknownPackageOutcome(result)) return;
    await refreshPackageSnapshot(packageReceiptNotice(result.value, '安装'));
    return;
  } catch (error) {
    packageUi.pendingApproval = null;
    setPackageOperationError(error, 'Agent Package 安装失败');
  }
  if (workspaceView === 'packages' && currentState.phase === 'ready') renderReady(currentState);
}

async function mutatePackage(operation, packageId, successMessage) {
  packageUi = {
    ...packageUi,
    busy: true,
    error: null,
    message: null,
    unknownOutcome: null,
  };
  renderReady(currentState);
  try {
    const result = operation === 'rollback'
      ? await bridge.rollbackAgentPackage(packageId)
      : await bridge.reconcileAgentPackage(packageId);
    if (handleUnknownPackageOutcome(result)) return;
    await refreshPackageSnapshot(packageReceiptNotice(result.value, successMessage));
    return;
  } catch (error) {
    setPackageOperationError(error, `Agent Package ${operation === 'rollback' ? '回滚' : '恢复'}失败`);
  }
  if (workspaceView === 'packages' && currentState.phase === 'ready') renderReady(currentState);
}

function handleUnknownPackageOutcome(result) {
  if (result?.outcome !== 'unknown') return false;
  packageUi = {
    ...packageUi,
    phase: 'ready',
    busy: false,
    error: null,
    message: null,
    pendingApproval: null,
    unknownOutcome: {
      operation: result.operation,
      message: result.message || '操作结果未知，请先重新读取状态。',
    },
  };
  if (workspaceView === 'packages' && currentState.phase === 'ready') renderReady(currentState);
  return true;
}

function setPackageOperationError(error, fallback) {
  packageUi = {
    ...packageUi,
    phase: 'ready',
    busy: false,
    error: publicError(error, fallback),
    message: null,
    unknownOutcome: null,
  };
}

function backgroundSettingsView() {
  const snapshot = backgroundUi.snapshot;
  const host = snapshot?.host || {};
  const loginItem = snapshot?.loginItem || {};
  const enabled = loginItem.openAtLogin === true;
  const approvalRequired = loginItem.status === 'requires-approval';
  const loginTitle = approvalRequired
    ? '等待系统批准'
    : enabled
      ? '已开启'
      : '未开启';
  return `
    <header class="workspace-header background-header">
      <div>
        <p class="eyebrow">Persistent Runtime</p>
        <h1>让 Agent 在窗口之外继续工作。</h1>
        <p>客户端窗口只是入口。共享 Grok Leader 持有固定 Main Session；系统登录启动负责在重启后重新验证订阅并恢复 Agent。</p>
      </div>
      <div class="route-health"><i></i><span>Runtime mode</span><strong>${escapeHtml(host.mode || '检测中')}</strong></div>
    </header>
    ${backgroundUi.message ? `<div class="provider-notice success" role="status">${escapeHtml(backgroundUi.message)}</div>` : ''}
    ${backgroundUi.error ? `<div class="provider-notice error" role="alert">${escapeHtml(backgroundUi.error)}</div>` : ''}
    ${backgroundUi.phase === 'loading' ? providerLoadingView() : ''}
    ${backgroundUi.phase === 'ready' ? `
      <div class="background-grid">
        <section class="control-panel runtime-panel">
          <div class="panel-kicker"><span>01</span><div><strong>后台 Host</strong><small>Grok Leader ownership</small></div></div>
          <div class="runtime-fact"><span>运行方式</span><strong>${escapeHtml(host.mode === 'persistent_leader' ? '独立 Leader' : '嵌入诊断模式')}</strong></div>
          <div class="runtime-fact"><span>当前连接</span><strong>${escapeHtml(host.bridgeState === 'connected' ? '桌面已连接' : '桌面已断开')}</strong></div>
          <div class="runtime-fact"><span>通信边界</span><strong>${escapeHtml(host.socketName || '无独立 socket')}</strong></div>
          <p>关闭窗口或退出 UI 只会断开 Bridge，不会删除 Agent、Main Session 或本地工作进度。</p>
        </section>
        <section class="control-panel runtime-panel login-runtime-panel">
          <div class="panel-kicker"><span>02</span><div><strong>系统登录启动</strong><small>Restore after device restart</small></div></div>
          <div class="login-runtime-state ${enabled ? 'enabled' : ''}">
            <i></i>
            <div><span>当前状态</span><strong>${escapeHtml(loginTitle)}</strong></div>
          </div>
          <p>${escapeHtml(backgroundStatusCopy(loginItem))}</p>
          <button class="secondary" id="toggle-background-startup" type="button" ${backgroundUi.busy || !loginItem.supported ? 'disabled' : ''}>${enabled ? '关闭系统登录启动' : '开启系统登录启动'}</button>
          ${approvalRequired ? '<small class="approval-note">请前往“系统设置 → 通用 → 登录项”，允许 AgentMesh360 在后台运行。</small>' : ''}
        </section>
      </div>
      <div class="background-policy">
        <strong>关闭这项设置会发生什么？</strong>
        <p>只影响下次登录系统后的自动恢复。当前 Host 不会被强制终止，历史会话不会删除，订阅与 BYOK 配置也不会改变。</p>
      </div>
    ` : ''}
    ${backgroundUi.phase === 'error' ? '<button class="secondary retry-background" type="button">重新读取运行状态</button>' : ''}
    <div class="security-row">后台恢复仍需 Core 与 Host 双重订阅校验 · 不向 Rust Host 复制 Refresh Token</div>`;
}

function wireBackgroundSettings() {
  document.querySelector('.retry-background')?.addEventListener('click', () => refreshBackgroundSnapshot());
  document.getElementById('toggle-background-startup')?.addEventListener('click', async () => {
    const enabled = backgroundUi.snapshot?.loginItem?.openAtLogin === true;
    backgroundUi = { ...backgroundUi, busy: true, error: null, message: null };
    renderReady(currentState);
    try {
      const snapshot = await bridge.setBackgroundStartup(!enabled);
      backgroundUi = {
        phase: 'ready',
        snapshot,
        busy: false,
        error: null,
        message: !enabled ? '系统登录启动已请求开启。' : '系统登录启动已关闭。',
      };
    } catch (error) {
      backgroundUi = {
        ...backgroundUi,
        phase: 'ready',
        busy: false,
        error: publicError(error, '无法修改系统登录启动'),
      };
    }
    if (workspaceView === 'client' && currentState.phase === 'ready') renderReady(currentState);
  });
}

async function refreshBackgroundSnapshot() {
  backgroundUi = { ...backgroundUi, phase: 'loading', error: null, message: null };
  if (workspaceView === 'client') renderReady(currentState);
  try {
    backgroundUi = {
      phase: 'ready',
      snapshot: await bridge.getBackgroundSnapshot(),
      error: null,
      message: null,
      busy: false,
    };
  } catch (error) {
    backgroundUi = {
      phase: 'error',
      snapshot: null,
      error: publicError(error, '无法读取后台运行状态'),
      message: null,
      busy: false,
    };
  }
  if (workspaceView === 'client' && currentState.phase === 'ready') renderReady(currentState);
}

function backgroundStatusCopy(loginItem) {
  if (!loginItem.supported && loginItem.reason === 'packaged_app_required') {
    return '开发运行不会修改系统登录项；打包后的正式客户端才会开放这项设置。';
  }
  if (!loginItem.supported) return '当前系统不支持由客户端管理登录启动。';
  if (loginItem.status === 'requires-approval') {
    return 'AgentMesh360 已提交登录项，但 macOS 仍要求用户在系统设置中批准。';
  }
  if (loginItem.openAtLogin) {
    return '登录系统后，客户端会在无窗口模式恢复身份、验证订阅并连接同一个后台 Host。';
  }
  return '设备重启后不会自动恢复 Agent；你仍可手动打开客户端继续原有会话。';
}

function agentWorkspaceView(state) {
  const account = state.account || {};
  const subscription = state.subscription || {};
  const credits = state.credits || {};
  const agents = Array.isArray(state.agents) ? state.agents : [];
  return `
    <header class="workspace-header">
      <div><p class="eyebrow">Persistent Agent Workspace</p><h1 data-ready-welcome>欢迎回来，${escapeHtml(firstName(account))}</h1><p data-ready-subscription>${escapeHtml(subscriptionLabel(subscription))} · 订阅验证通过</p></div>
      <div class="credit-card"><span>AgentMesh360 Credits</span><strong data-ready-credits>${formatNumber(credits.balance)}</strong></div>
    </header>
    <div class="section-head"><h2>你的专业 Agent</h2><span>${agents.filter(isResident).length} 个正在常驻</span></div>
    ${state.activationError ? `<div class="activation-error">${escapeHtml(state.activationError)}</div>` : ''}
    <div class="agent-grid">${agents.length ? agents.map((agent, index) => agentCard(agent, index, state.activatingAgentId)).join('') : '<div class="empty-agents">当前没有可用的 Agent Package。</div>'}</div>
    <div class="security-row" data-ready-checked-at>订阅状态已由 Core 与本地 Host 双重确认 · ${formatCheckedAt(state.checkedAt)}</div>`;
}

function providerSettingsView(state) {
  const profiles = providerUi.snapshot?.profiles || [];
  const assignments = providerUi.snapshot?.assignments || [];
  const probes = providerUi.snapshot?.probes || [];
  const catalog = providerUi.snapshot?.catalog || { providers: [] };
  return `
    <header class="workspace-header provider-header">
      <div>
        <p class="eyebrow">BYOK Routing Console</p>
        <h1>你的模型，按角色就位。</h1>
        <p>Provider 凭据保存在本机 Host Vault；Agent 只获得短时租约，永远读不到 Key。</p>
      </div>
      <div class="route-health"><i></i><span>Host Authority</span><strong>${profiles.length} 个 Provider</strong></div>
    </header>
    ${providerUi.message ? `<div class="provider-notice success" role="status">${escapeHtml(providerUi.message)}</div>` : ''}
    ${providerUi.error ? `<div class="provider-notice error" role="alert">${escapeHtml(providerUi.error)}</div>` : ''}
    ${providerUi.phase === 'loading' ? providerLoadingView() : ''}
    ${providerUi.phase === 'error' ? `<button class="secondary retry-providers" type="button">重新加载 Provider</button>` : ''}
    ${providerUi.phase === 'ready' ? `
      <section class="provider-overview" aria-label="Provider 状态">
        <div><span>Profiles</span><strong>${profiles.length}</strong></div>
        <div><span>Assignments</span><strong>${assignments.length}</strong></div>
        <div><span>Probe records</span><strong>${probes.length}</strong></div>
        <div><span>Catalog revision</span><strong>${escapeHtml(catalog.catalogRevision || '—')}</strong></div>
        <p>新 Provider 必须先测试连接，再保存到本机 Vault。</p>
      </section>
      <div class="provider-layout">
        <section class="provider-column">
          ${providerProfileEditor(catalog, profiles)}
          ${providerProfileList(profiles, assignments, probes)}
        </section>
        <section class="provider-column route-column">
          ${providerAssignmentEditor(state, profiles, catalog)}
          ${providerAssignmentList(assignments, profiles)}
        </section>
      </div>
    ` : ''}
    <div class="security-row">Provider 数据由本机 Host 独占 · Renderer 只能读取公开配置状态</div>`;
}

function providerLoadingView() {
  return `
    <div class="provider-loading" role="status">
      <div class="spinner" aria-hidden="true"></div>
      <div><strong>正在读取 Host 路由状态</strong><span>Profile、Catalog 与 Assignment 会在本机汇合。</span></div>
    </div>`;
}

function providerProfileEditor(catalog, profiles) {
  const editing = profiles.find((item) => item.profileId === providerUi.editingProfileId) || null;
  const editingProfileId = providerUi.editingProfileId || null;
  const draft = providerDraft?.editingProfileId === editingProfileId ? providerDraft : null;
  const providers = Array.isArray(catalog.providers) ? catalog.providers : [];
  const selectedPreset = draft?.presetId ?? (editing ? (editing.presetId || '__custom__') : '');
  const selectedProvider = providers.find((provider) => provider.presetId === selectedPreset) || null;
  const managed = selectedProvider?.classification === 'official';
  const officialProviders = providers.filter((provider) => provider.classification === 'official');
  const advancedProviders = providers.filter((provider) => provider.classification !== 'official');
  const savedModels = Array.isArray(editing?.enabledModels) ? editing.enabledModels : [];
  const modelOptions = draft?.modelOptions
    ?? savedModels.map((model) => ({ value: model, label: model }));
  const modelDiscoveryPassed = draft
    ? draft.modelDiscoveryPassed
    : Boolean(editing && managed);
  const connectionTestPassed = draft
    ? draft.connectionTestPassed
    : Boolean(editing);
  const displayName = draft?.displayName ?? editing?.displayName ?? '';
  const protocol = draft?.protocol ?? editing?.protocol;
  const authKind = draft?.authKind ?? editing?.authKind;
  const baseUrl = draft?.baseUrl ?? editing?.baseUrl ?? '';
  const manualModel = draft?.manualModel ?? (savedModels[0] || '');
  const selectedModel = draft?.selectedModel ?? (savedModels[0] || '');
  const modelStatus = draft?.modelStatus ?? {
    status: editing && managed ? 'passed' : 'idle',
    title: editing && managed ? '当前显示已保存模型' : '尚未读取可用模型',
    detail: editing && managed
      ? '重新输入 Key 可从供应商刷新模型列表。'
      : '模型读取不执行推理，通常不会产生 Provider 费用。',
  };
  const connectionStatus = draft?.connectionStatus ?? {
    status: editing ? 'passed' : 'idle',
    title: editing ? '当前已保存配置可继续使用' : '保存前需要先测试连接',
    detail: editing
      ? '若更换 Key、模型或接口设置，需要重新测试。'
      : '测试会尝试调用第一个模型，可能产生极小 Provider 费用；不消耗 AgentMesh credits，也不会保存 Key。',
  };
  const advanced = selectedPreset === '__custom__' || Boolean(selectedProvider && !managed);
  return `
    <form class="control-panel provider-form" id="provider-profile-form"
      data-connection-test-passed="${connectionTestPassed ? 'true' : 'false'}"
      data-model-discovery-passed="${modelDiscoveryPassed ? 'true' : 'false'}"
      data-config-revision="${escapeHtml(draft?.configRevision || '0')}">
      <div class="panel-kicker"><span>01</span><div><strong>${editing ? '编辑供应商' : '添加模型供应商'}</strong><small>选择供应商 → 填 Key 获取模型 → 选择模型 → 测试 → 保存</small></div></div>
      <div class="form-grid two">
        <label class="field"><span>供应商</span>
          <select name="presetId" id="provider-preset" required>
            <option value="" ${selectedPreset ? '' : 'selected'} disabled>请选择供应商</option>
            ${officialProviders.length ? `<optgroup label="官方供应商（自动配置）">
              ${officialProviders.map((provider) => `<option value="${escapeHtml(provider.presetId)}" ${selectedPreset === provider.presetId ? 'selected' : ''}>${escapeHtml(provider.displayName)}</option>`).join('')}
            </optgroup>` : ''}
            ${advancedProviders.length ? `<optgroup label="兼容与本地接口（高级）">
              ${advancedProviders.map((provider) => `<option value="${escapeHtml(provider.presetId)}" ${selectedPreset === provider.presetId ? 'selected' : ''}>${escapeHtml(provider.displayName)}</option>`).join('')}
            </optgroup>` : ''}
            <option value="__custom__" ${selectedPreset === '__custom__' ? 'selected' : ''}>其他自定义接口（高级）</option>
          </select>
        </label>
        <label class="field"><span>名称 <em>方便你自己区分</em></span><input name="displayName" maxlength="80" required value="${escapeHtml(displayName)}" placeholder="例如：我的 Gemini"></label>
      </div>
      <div class="managed-provider-card" id="managed-provider-card" ${managed ? '' : 'hidden'}>
        <i aria-hidden="true"></i>
        <div>
          <strong id="managed-provider-title">${managed ? `已为 ${escapeHtml(selectedProvider.displayName)} 自动配置` : '已自动配置'}</strong>
          <span>接口协议、认证方式和官方地址已自动选择，你不需要判断技术选项。</span>
          <details>
            <summary>查看技术信息</summary>
            <p id="managed-provider-detail">${managed ? `${escapeHtml(protocolLabel(selectedProvider.protocol))} · ${escapeHtml(selectedProvider.defaultBaseUrl || '')}` : ''}</p>
          </details>
          <p class="provider-plan-notice" id="provider-plan-notice" ${providerPlanNotice(selectedPreset) ? '' : 'hidden'}>${escapeHtml(providerPlanNotice(selectedPreset) || '')}</p>
        </div>
      </div>
      <details class="advanced-provider-settings" id="advanced-provider-settings" ${advanced ? 'open' : 'hidden'}>
        <summary>高级连接设置</summary>
        <p>只有服务商文档明确写明“兼容 OpenAI / Anthropic 接口”时才需要在这里选择。</p>
        <div class="form-grid two">
          <label class="field"><span>接口兼容方式</span>
            <select name="protocol" required>
              ${option('openai_responses', 'OpenAI Responses 兼容', protocol)}
              ${option('openai_chat', 'OpenAI Chat Completions 兼容（最常见）', protocol)}
              ${option('anthropic_messages', 'Anthropic Messages 兼容', protocol)}
            </select>
          </label>
          <label class="field"><span>Key 发送方式</span>
            <select name="authKind" required>
              ${option('bearer_api_key', 'Authorization: Bearer', authKind)}
              ${option('x_api_key', 'x-api-key Header', authKind)}
            </select>
          </label>
        </div>
        <label class="field"><span>接口地址</span><input name="baseUrl" type="url" required value="${escapeHtml(baseUrl)}" placeholder="https://api.example.com/v1"></label>
      </details>
      <div class="credential-action-row">
        <label class="field secret-field"><span>${editing ? '替换 API Key（可留空）' : 'API Key'}</span><input name="apiKey" type="password" autocomplete="off" ${editing ? '' : 'required'} placeholder="${editing ? '重新获取模型或替换 Key 时填写' : '粘贴供应商 API Key'}"><i>仅交给本机 Host</i></label>
        <button class="secondary model-discovery-button" id="provider-discover-models" type="button" ${managed ? '' : 'hidden'} ${providerUi.busy ? 'disabled' : ''}>验证 Key 并获取模型</button>
      </div>
      <section class="model-discovery-panel" id="official-model-discovery" ${managed ? '' : 'hidden'}>
        <label class="field"><span>可用模型 <em>由当前 Key 从供应商实时读取</em></span>
          <select name="enabledModels" id="provider-model-select" required ${modelDiscoveryPassed ? '' : 'disabled'}>
            <option value="" ${modelOptions.length ? '' : 'selected'} disabled>${modelOptions.length ? '请选择模型' : '请先验证 Key 并获取模型'}</option>
            ${modelOptions.map((model) => `<option value="${escapeHtml(model.value)}" ${selectedModel === model.value ? 'selected' : ''}>${escapeHtml(model.label)}</option>`).join('')}
          </select>
        </label>
        <div class="model-discovery-status" id="model-discovery-status" data-status="${escapeHtml(modelStatus.status)}" role="status">
          <i aria-hidden="true"></i>
          <div>
            <strong>${escapeHtml(modelStatus.title)}</strong>
            <span>${escapeHtml(modelStatus.detail)}</span>
          </div>
        </div>
      </section>
      <label class="field manual-model-field" id="manual-model-field" ${advanced ? '' : 'hidden'}>
        <span>模型 ID <em>兼容与本地接口需要手工填写</em></span>
        <input name="manualModel" ${advanced ? 'required' : 'disabled'} value="${escapeHtml(advanced ? manualModel : '')}" placeholder="例如：local-model">
      </label>
      <div class="connection-test-status" id="connection-test-status" data-status="${escapeHtml(connectionStatus.status)}" role="status">
        <i aria-hidden="true"></i>
        <div>
          <strong>${escapeHtml(connectionStatus.title)}</strong>
          <span>${escapeHtml(connectionStatus.detail)}</span>
        </div>
      </div>
      <div class="panel-actions">
        ${editing ? '<button class="ghost" id="cancel-profile-edit" type="button">取消编辑</button>' : '<span></span>'}
        <div class="provider-save-actions">
          <button class="secondary connection-test-button" id="provider-test-connection" type="button" ${providerUi.busy ? 'disabled' : ''}>测试连接</button>
          <button class="secondary provider-save-button" type="submit" ${providerUi.busy || !connectionTestPassed ? 'disabled' : ''}>安全保存</button>
        </div>
      </div>
    </form>`;
}

function providerProfileList(profiles, assignments, probes) {
  return `
    <section class="profile-stack">
      <div class="section-head compact"><h2>已连接 Provider</h2><span>${profiles.length} 个</span></div>
      ${profiles.length ? profiles.map((profile) => {
        const routes = assignments.filter((assignment) => assignment.providerProfileId === profile.profileId).length;
        const latestProbe = probes.find((probe) => probe.providerProfileId === profile.profileId);
        const models = Array.isArray(profile.enabledModels) ? profile.enabledModels : [];
        return `
          <article class="profile-row">
            <div class="profile-sigil">${escapeHtml((profile.displayName || '?').slice(0, 1).toUpperCase())}</div>
            <div class="profile-copy">
              <strong>${escapeHtml(profile.displayName)}</strong>
              <span>${escapeHtml(protocolLabel(profile.protocol))} · ${escapeHtml(profile.baseUrl)}</span>
              <small>${profile.credentialConfigured ? `Key ···· ${escapeHtml(profile.credentialLastFour || '已配置')}` : '尚未配置 Key'} · ${routes} 条路由</small>
            </div>
            <div class="row-actions">
              <button class="ghost" type="button" data-edit-profile="${escapeHtml(profile.profileId)}">编辑</button>
              <button class="ghost danger-text" type="button" data-delete-profile="${escapeHtml(profile.profileId)}">删除</button>
            </div>
            <div class="probe-console">
              <div class="probe-model">
                <span>检查模型</span>
                <select aria-label="${escapeHtml(profile.displayName)} Probe 模型" ${models.length ? '' : 'disabled'}>
                  ${models.map((model) => `<option value="${escapeHtml(model)}">${escapeHtml(model)}</option>`).join('')}
                </select>
              </div>
              <div class="probe-actions">
                <button class="probe-action local" type="button" data-probe-profile="${escapeHtml(profile.profileId)}" data-probe-level="local_validation" ${providerUi.busy || !models.length ? 'disabled' : ''}>本地检查</button>
                <button class="probe-action metadata" type="button" data-probe-profile="${escapeHtml(profile.profileId)}" data-probe-level="metadata" ${providerUi.busy || !models.length ? 'disabled' : ''}>元数据</button>
                <button class="probe-action inference" type="button" data-probe-profile="${escapeHtml(profile.profileId)}" data-probe-level="minimal_inference" ${providerUi.busy || !models.length ? 'disabled' : ''}>真实响应 <i>可能计费</i></button>
              </div>
              ${probeResult(latestProbe)}
            </div>
          </article>`;
      }).join('') : '<div class="empty-provider">还没有 Provider。先从上方接入你的第一个 BYOK 端点。</div>'}
    </section>`;
}

function probeResult(probe) {
  if (!probe) {
    return '<div class="probe-result empty"><i></i><span>尚未检查</span><small>保存 Profile 不会自动发起 Probe</small></div>';
  }
  const label = probeStatusLabel(probe);
  const detail = probeDetail(probe);
  return `
    <div class="probe-result ${escapeHtml(probe.status || 'unknown')}">
      <i></i>
      <span>${escapeHtml(label)}</span>
      <small>${escapeHtml(detail)}</small>
    </div>`;
}

function providerAssignmentEditor(state, profiles, catalog) {
  const agents = Array.isArray(state.agents) ? state.agents : [];
  const modelOptions = collectModelOptions(profiles, catalog);
  return `
    <form class="control-panel assignment-form" id="provider-assignment-form">
      <div class="panel-kicker"><span>02</span><div><strong>分配模型角色</strong><small>Global → Agent → Session</small></div></div>
      <div class="route-diagram" aria-hidden="true"><b>Agent</b><i></i><b>Role</b><i></i><b>Provider</b></div>
      <div class="form-grid two">
        <label class="field"><span>范围</span>
          <select name="scopeKind" id="assignment-scope">
            ${option('global', '全局默认', 'global')}
            ${option('agent', '指定 Agent', null)}
          </select>
        </label>
        <label class="field" id="assignment-agent-field"><span>Agent</span>
          <select name="scopeId" disabled>
            ${agents.map((agent) => `<option value="${escapeHtml(agent.agentId)}">${escapeHtml(agent.displayName)}</option>`).join('')}
          </select>
        </label>
      </div>
      <label class="field"><span>模型角色</span>
        <select name="role">
          ${[
            'main', 'subagent', 'vision', 'permission_classifier', 'compaction',
            'laziness', 'recap', 'memory', 'side_question', 'suggestion',
          ].map((role) => `<option value="${role}">${escapeHtml(role)}</option>`).join('')}
        </select>
      </label>
      <label class="field"><span>Provider Profile</span>
        <select name="providerProfileId" required>
          <option value="">选择 Provider</option>
          ${profiles.map((profile) => `<option value="${escapeHtml(profile.profileId)}">${escapeHtml(profile.displayName)}</option>`).join('')}
        </select>
      </label>
      <label class="field"><span>模型 ID</span><input name="modelId" list="provider-model-options" required placeholder="选择或输入模型 ID"></label>
      <datalist id="provider-model-options">${modelOptions.map((model) => `<option value="${escapeHtml(model)}"></option>`).join('')}</datalist>
      <button class="secondary route-submit" type="submit" ${providerUi.busy || !profiles.length ? 'disabled' : ''}>保存 Assignment</button>
    </form>`;
}

function providerAssignmentList(assignments, profiles) {
  const profileNames = new Map(profiles.map((profile) => [profile.profileId, profile.displayName]));
  return `
    <section class="assignment-stack">
      <div class="section-head compact"><h2>当前路由矩阵</h2><span>${assignments.length} 条</span></div>
      ${assignments.length ? assignments.map((assignment) => `
        <article class="assignment-row">
          <div><strong>${escapeHtml(assignment.role)}</strong><span>${escapeHtml(scopeLabel(assignment))}</span></div>
          <i></i>
          <div class="assignment-target"><strong>${escapeHtml(profileNames.get(assignment.providerProfileId) || assignment.providerProfileId)}</strong><span>${escapeHtml(assignment.modelId)}</span></div>
          <button class="ghost danger-text" type="button" data-delete-assignment="${escapeHtml(assignment.assignmentId)}">×</button>
        </article>`).join('') : '<div class="empty-provider">尚未设置模型角色。至少配置一条 global / main 路由，产品 Agent 才能开始推理。</div>'}
    </section>`;
}

function wireProviderSettings() {
  document.querySelector('.retry-providers')?.addEventListener('click', () => refreshProviderSnapshot());
  document.getElementById('cancel-profile-edit')?.addEventListener('click', () => {
    document.getElementById('provider-profile-form')?.remove();
    providerDraft = null;
    providerUi.editingProfileId = null;
    renderReady(currentState);
  });
  document.getElementById('provider-preset')?.addEventListener('change', applySelectedPreset);
  const providerForm = document.getElementById('provider-profile-form');
  if (
    providerForm?.elements.apiKey
    && providerDraft?.editingProfileId === (providerUi.editingProfileId || null)
    && providerDraft.apiKey
  ) {
    providerForm.elements.apiKey.value = providerDraft.apiKey;
  }
  providerForm?.addEventListener('submit', submitProviderProfile);
  providerForm?.addEventListener('input', invalidateProviderConnectionTest);
  providerForm?.addEventListener('change', invalidateProviderConnectionTest);
  document.getElementById('provider-discover-models')?.addEventListener('click', discoverProviderModels);
  document.getElementById('provider-test-connection')?.addEventListener('click', testProviderConnection);
  syncProviderConnectionMode(providerForm);
  document.getElementById('provider-assignment-form')?.addEventListener('submit', submitAssignment);
  document.getElementById('assignment-scope')?.addEventListener('change', syncAssignmentScope);
  syncAssignmentScope();
  for (const button of document.querySelectorAll('[data-edit-profile]')) {
    button.addEventListener('click', () => {
      document.getElementById('provider-profile-form')?.remove();
      providerDraft = null;
      providerUi.editingProfileId = button.dataset.editProfile;
      providerUi.message = null;
      renderReady(currentState);
      document.getElementById('provider-profile-form')?.scrollIntoView({ behavior: 'smooth' });
    });
  }
  for (const button of document.querySelectorAll('[data-delete-profile]')) {
    button.addEventListener('click', () => deleteProviderProfile(button.dataset.deleteProfile));
  }
  for (const button of document.querySelectorAll('[data-delete-assignment]')) {
    button.addEventListener('click', () => deleteAssignment(button.dataset.deleteAssignment));
  }
  for (const button of document.querySelectorAll('[data-probe-profile]')) {
    button.addEventListener('click', () => runProviderProbe(button));
  }
}

async function refreshProviderSnapshot(message = null) {
  providerUi = { ...providerUi, phase: 'loading', error: null, message, busy: false };
  if (workspaceView === 'providers') renderReady(currentState);
  try {
    const snapshot = await bridge.getProviderSnapshot();
    providerUi = {
      ...providerUi,
      phase: 'ready',
      snapshot,
      error: null,
      message,
      busy: false,
    };
  } catch (error) {
    providerUi = {
      ...providerUi,
      phase: 'error',
      error: publicError(error, '无法读取 Provider 配置'),
      message: null,
      busy: false,
    };
  }
  if (workspaceView === 'providers' && currentState.phase === 'ready') renderReady(currentState);
}

async function submitProviderProfile(event) {
  event.preventDefault();
  const form = event.currentTarget;
  if (form.dataset.connectionTestPassed !== 'true') {
    updateConnectionTestStatus(
      form,
      'failed',
      '请先测试连接',
      '只有连接成功后才能保存，避免把无效 Key 或错误模型写入本机。',
    );
    return;
  }
  const data = new FormData(form);
  const editingProfileId = providerUi.editingProfileId;
  const apiKey = String(data.get('apiKey') || '').trim();
  const profile = providerProfileFromForm(data);
  form.elements.apiKey.value = '';
  const saved = await runProviderOperation(async () => {
    if (editingProfileId) {
      await bridge.updateProviderProfile({ profileId: editingProfileId, profile });
      if (apiKey) await bridge.replaceProviderSecret({ profileId: editingProfileId, apiKey });
    } else {
      await bridge.createProviderProfile({ profile, apiKey });
    }
    providerUi.editingProfileId = null;
  }, editingProfileId ? 'Provider 已更新，Key 输入已清空。' : 'Provider 已安全保存，Key 输入已清空。');
  if (saved) {
    document.getElementById('provider-profile-form')?.remove();
    providerDraft = null;
    if (workspaceView === 'providers' && currentState.phase === 'ready') renderReady(currentState);
  }
}

async function discoverProviderModels(event) {
  const button = event.currentTarget;
  const form = button.closest('form');
  if (!form) return;
  const preset = (providerUi.snapshot?.catalog?.providers || [])
    .find((item) => item.presetId === form.elements.presetId.value);
  if (preset?.classification !== 'official') {
    updateModelDiscoveryStatus(
      form,
      'failed',
      '当前接口需要手工填写模型',
      '动态模型读取只用于客户端内置的官方供应商。',
    );
    return;
  }
  if (!form.elements.presetId.reportValidity() || !form.elements.displayName.reportValidity()) return;
  const data = new FormData(form);
  const apiKey = String(data.get('apiKey') || '').trim();
  if (!apiKey) {
    updateModelDiscoveryStatus(
      form,
      'failed',
      '请先填写 API Key',
      '客户端会把 Key 一次性交给本机 Host，用它读取当前账号可用的模型。',
    );
    form.elements.apiKey.focus();
    return;
  }
  const profile = providerProfileFromForm(data, { allowEmptyModel: true });
  const revision = form.dataset.configRevision;
  const modelSelect = form.elements.enabledModels;
  const testButton = form.querySelector('.connection-test-button');
  const saveButton = form.querySelector('.provider-save-button');
  button.disabled = true;
  modelSelect.disabled = true;
  testButton.disabled = true;
  saveButton.disabled = true;
  form.dataset.modelDiscoveryPassed = 'false';
  form.dataset.connectionTestPassed = 'false';
  updateModelDiscoveryStatus(
    form,
    'testing',
    `正在验证 ${preset.displayName} Key`,
    '正在从供应商官方接口读取这个 Key 实际可用的模型…',
  );
  updateConnectionTestStatus(
    form,
    'idle',
    '等待选择模型',
    '先获取模型并完成选择，再执行真实连接测试。',
  );
  try {
    const response = await bridge.discoverProviderModels({ profile, apiKey });
    if (!form.isConnected || form.dataset.configRevision !== revision) {
      if (form.isConnected) {
        updateModelDiscoveryStatus(
          form,
          'idle',
          '配置已发生变化',
          '读取期间你修改了配置，请使用最新内容重新获取模型。',
        );
      }
      return;
    }
    const result = response?.modelDiscovery;
    if (result?.status !== 'passed' || !Array.isArray(result.models) || !result.models.length) {
      resetDiscoveredModels(form);
      updateModelDiscoveryStatus(
        form,
        'failed',
        '没有读取到可用模型',
        modelDiscoveryFailureMessage(result),
      );
      return;
    }
    resetDiscoveredModels(form);
    for (const model of result.models) {
      const optionElement = document.createElement('option');
      optionElement.value = model.modelId;
      optionElement.textContent = model.displayName && model.displayName !== model.modelId
        ? `${model.displayName} · ${model.modelId}`
        : model.modelId;
      modelSelect.append(optionElement);
    }
    modelSelect.disabled = false;
    testButton.disabled = false;
    form.dataset.modelDiscoveryPassed = 'true';
    updateModelDiscoveryStatus(
      form,
      'passed',
      `Key 有效，已获取 ${result.models.length} 个模型`,
      `${result.truncated ? '列表较长，已显示前 512 个。' : ''}请选择一个模型，再执行连接测试。`,
    );
  } catch (error) {
    resetDiscoveredModels(form);
    updateModelDiscoveryStatus(
      form,
      'failed',
      '模型读取失败',
      modelDiscoveryError(error),
    );
  } finally {
    if (form.isConnected) button.disabled = false;
  }
}

async function testProviderConnection(event) {
  const button = event.currentTarget;
  const form = button.closest('form');
  if (!form?.reportValidity()) return;
  const data = new FormData(form);
  const apiKey = String(data.get('apiKey') || '').trim();
  if (!apiKey) {
    updateConnectionTestStatus(
      form,
      'failed',
      '需要输入 API Key',
      '出于安全原因，客户端无法读回已经保存的 Key；重新测试时请再次输入。',
    );
    return;
  }
  const profile = providerProfileFromForm(data);
  const modelId = profile.enabledModels[0];
  if (!modelId) {
    updateConnectionTestStatus(form, 'failed', '需要填写模型', '请至少填写一个模型 ID。');
    return;
  }
  const confirmed = window.confirm(
    `将尝试调用 ${modelId} 完成极短连接测试，可能产生极小 Provider 费用。`
      + '不会消耗 AgentMesh credits，不会保存当前 Key，也不会写入 Agent 会话。继续吗？',
  );
  if (!confirmed) return;

  const revision = form.dataset.configRevision;
  const saveButton = form.querySelector('.provider-save-button');
  button.disabled = true;
  saveButton.disabled = true;
  updateConnectionTestStatus(form, 'testing', '正在测试连接', `正在等待 ${modelId} 返回最小响应…`);
  try {
    const response = await bridge.testProviderConnection({
      profile,
      apiKey,
      modelId,
      confirmPaidInference: true,
    });
    if (!form.isConnected || form.dataset.configRevision !== revision) {
      if (form.isConnected) {
        updateConnectionTestStatus(
          form,
          'idle',
          '配置已发生变化',
          '测试期间你修改了配置，请使用最新内容重新测试。',
        );
      }
      return;
    }
    if (response?.connectionTest?.status !== 'passed') {
      updateConnectionTestStatus(
        form,
        'failed',
        '连接没有通过',
        connectionTestFailureMessage(response?.connectionTest),
      );
      return;
    }
    form.dataset.connectionTestPassed = 'true';
    saveButton.disabled = false;
    updateConnectionTestStatus(
      form,
      'passed',
      '连接成功，可以保存',
      `${modelId} 已返回有效响应；测试 Key 仍未保存。`,
    );
  } catch (error) {
    updateConnectionTestStatus(
      form,
      'failed',
      '连接失败',
      connectionTestError(error),
    );
  } finally {
    if (form.isConnected) button.disabled = false;
  }
}

async function submitAssignment(event) {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  const scopeKind = String(data.get('scopeKind'));
  await runProviderOperation(() => bridge.upsertModelAssignment({
    scopeKind,
    scopeId: scopeKind === 'global' ? null : data.get('scopeId'),
    role: data.get('role'),
    providerProfileId: data.get('providerProfileId'),
    modelId: data.get('modelId'),
  }), '模型角色已写入 Host 路由表。');
}

async function deleteProviderProfile(profileId) {
  if (!window.confirm('删除 Provider 会同时移除依赖它的 Assignment。已有 Session Binding 仍保留历史快照。继续吗？')) return;
  await runProviderOperation(() => bridge.deleteProviderProfile(profileId), 'Provider 已删除。');
}

async function deleteAssignment(assignmentId) {
  await runProviderOperation(() => bridge.deleteModelAssignment(assignmentId), 'Assignment 已删除。');
}

async function runProviderProbe(button) {
  const level = button.dataset.probeLevel;
  const profileId = button.dataset.probeProfile;
  const modelId = button.closest('.probe-console')?.querySelector('select')?.value;
  let confirmPaidInference = false;
  if (level === 'minimal_inference') {
    confirmPaidInference = window.confirm(
      `即将向 ${modelId || '所选模型'} 发送一次最小推理请求。此请求可能产生 Provider 费用，但不会写入任何 Agent 会话。继续吗？`,
    );
    if (!confirmPaidInference) return;
  }
  providerUi = { ...providerUi, busy: true, error: null, message: null };
  renderReady(currentState);
  try {
    const response = await bridge.runProviderProbe({
      profileId,
      modelId,
      level,
      confirmPaidInference,
    });
    await refreshProviderSnapshot(probeNotice(response?.probe));
  } catch (error) {
    providerUi = {
      ...providerUi,
      phase: 'ready',
      busy: false,
      error: publicError(error, 'Provider Probe 失败'),
      message: null,
    };
    renderReady(currentState);
  }
}

async function runProviderOperation(operation, successMessage) {
  providerUi = { ...providerUi, busy: true, error: null, message: null };
  renderReady(currentState);
  try {
    await operation();
    await refreshProviderSnapshot(successMessage);
    return true;
  } catch (error) {
    providerUi = {
      ...providerUi,
      phase: 'ready',
      busy: false,
      error: publicError(error, 'Provider 操作失败'),
      message: null,
    };
    renderReady(currentState);
    return false;
  }
}

function applySelectedPreset(event) {
  const preset = (providerUi.snapshot?.catalog?.providers || [])
    .find((item) => item.presetId === event.currentTarget.value);
  const form = document.getElementById('provider-profile-form');
  if (!form) return;
  const custom = event.currentTarget.value === '__custom__';
  form.elements.displayName.value = preset?.displayName || '';
  form.elements.protocol.value = preset?.protocol || 'openai_chat';
  form.elements.baseUrl.value = preset?.defaultBaseUrl || '';
  form.elements.authKind.value = preset?.authKind || 'bearer_api_key';
  form.elements.apiKey.value = '';
  form.elements.manualModel.value = '';
  resetDiscoveredModels(form);
  form.dataset.modelDiscoveryPassed = 'false';
  if (!preset && !custom) form.elements.protocol.value = 'openai_chat';
  syncProviderConnectionMode(form, preset);
}

function providerProfileFromForm(data, { allowEmptyModel = false } = {}) {
  const model = data.get('enabledModels') || data.get('manualModel');
  return {
    presetId: ['', '__custom__'].includes(String(data.get('presetId') || ''))
      ? null
      : String(data.get('presetId')),
    displayName: data.get('displayName'),
    protocol: data.get('protocol'),
    baseUrl: data.get('baseUrl'),
    authKind: data.get('authKind'),
    enabledModels: allowEmptyModel ? [] : parseModels(model),
  };
}

function syncProviderConnectionMode(form, selectedPreset = null) {
  if (!form) return;
  const preset = selectedPreset || (providerUi.snapshot?.catalog?.providers || [])
    .find((item) => item.presetId === form.elements.presetId.value);
  const managed = preset?.classification === 'official';
  const advanced = form.elements.presetId.value === '__custom__' || Boolean(preset && !managed);
  const managedCard = document.getElementById('managed-provider-card');
  const advancedSettings = document.getElementById('advanced-provider-settings');
  const officialModelDiscovery = document.getElementById('official-model-discovery');
  const manualModelField = document.getElementById('manual-model-field');
  const discoverButton = document.getElementById('provider-discover-models');
  const planNotice = document.getElementById('provider-plan-notice');
  const testButton = form.querySelector('.connection-test-button');
  managedCard.hidden = !managed;
  advancedSettings.hidden = !advanced;
  officialModelDiscovery.hidden = !managed;
  manualModelField.hidden = !advanced;
  form.elements.manualModel.disabled = !advanced;
  form.elements.manualModel.required = advanced;
  discoverButton.hidden = !managed;
  testButton.disabled = managed
    ? form.dataset.modelDiscoveryPassed !== 'true'
    : !advanced;
  form.elements.enabledModels.disabled =
    !managed || form.dataset.modelDiscoveryPassed !== 'true';
  if (managed) {
    document.getElementById('managed-provider-title').textContent =
      `已为 ${preset.displayName} 自动配置`;
    document.getElementById('managed-provider-detail').textContent =
      `${protocolLabel(preset.protocol)} · ${preset.defaultBaseUrl || ''}`;
    const notice = providerPlanNotice(preset.presetId);
    planNotice.textContent = notice || '';
    planNotice.hidden = !notice;
    if (form.dataset.modelDiscoveryPassed !== 'true') {
      updateModelDiscoveryStatus(
        form,
        'idle',
        `等待验证 ${preset.displayName} Key`,
        '验证成功后会显示这个 Key 实际可用的模型。',
      );
    }
  }
}

function providerPlanNotice(presetId) {
  if (presetId === 'glm-coding-plan') {
    return '请使用 GLM Coding Plan 专属 Key；普通智谱 API Key 与 Coding Plan Key 不通用。套餐权益的适用工具范围以智谱当前官方条款为准。';
  }
  if (presetId === 'kimi-coding-plan') {
    return '请使用 Kimi Coding Plan Key。Standard 与 HighSpeed 会按当前 Key 的实际权限返回；套餐权益的适用工具范围以 Kimi 当前官方条款为准。';
  }
  return null;
}

function invalidateProviderConnectionTest(event) {
  const form = event.currentTarget;
  if (event.target?.name === 'displayName') return;
  if (['apiKey', 'presetId', 'protocol', 'authKind', 'baseUrl'].includes(event.target?.name)) {
    invalidateProviderModelDiscovery(form);
  }
  form.dataset.configRevision = String(Number(form.dataset.configRevision || 0) + 1);
  form.dataset.connectionTestPassed = 'false';
  form.querySelector('.provider-save-button').disabled = true;
  updateConnectionTestStatus(
    form,
    'idle',
    '配置已更改，请重新测试',
    'Key、模型或连接方式变化后，原测试结果不再有效。',
  );
}

function invalidateProviderModelDiscovery(form) {
  const preset = (providerUi.snapshot?.catalog?.providers || [])
    .find((item) => item.presetId === form.elements.presetId.value);
  if (preset?.classification !== 'official') return;
  form.dataset.modelDiscoveryPassed = 'false';
  resetDiscoveredModels(form);
  updateModelDiscoveryStatus(
    form,
    'idle',
    'Key 或供应商配置已更改',
    '请重新验证 Key 并获取当前可用模型。',
  );
}

function resetDiscoveredModels(form) {
  const select = form?.elements.enabledModels;
  if (!select) return;
  select.replaceChildren();
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = '请先验证 Key 并获取模型';
  placeholder.disabled = true;
  placeholder.selected = true;
  select.append(placeholder);
  select.disabled = true;
  form.querySelector('.connection-test-button').disabled = true;
}

function updateModelDiscoveryStatus(form, status, title, detail) {
  const container = form?.querySelector('#model-discovery-status');
  if (!container) return;
  container.dataset.status = status;
  container.querySelector('strong').textContent = title;
  container.querySelector('span').textContent = detail;
}

function updateConnectionTestStatus(form, status, title, detail) {
  const container = form?.querySelector('#connection-test-status');
  if (!container) return;
  container.dataset.status = status;
  container.querySelector('strong').textContent = title;
  container.querySelector('span').textContent = detail;
}

function connectionTestFailureMessage(result) {
  return ({
    minimal_inference_authentication_failed: 'API Key 已被供应商拒绝，请确认复制完整且仍然有效。',
    minimal_inference_permission_denied: '这个 Key 没有调用所选模型的权限，请更换模型或检查账号权限。',
    minimal_inference_model_not_found: '供应商找不到所选模型，请重新获取模型列表后再选择。',
    minimal_inference_rate_limited: '供应商当前触发限流，请稍后再试。',
    minimal_inference_network_failed: '无法连接供应商，请检查网络或稍后重试。',
    minimal_inference_timeout: '供应商响应超时，请稍后重试。',
    minimal_inference_empty_response: '接口已响应，但模型没有返回有效内容，请换一个模型测试。',
  })[result?.summaryCode] || '供应商拒绝了测试请求，请重新验证 Key、模型和账号权限。';
}

function connectionTestError(error) {
  const message = transportSafeErrorMessage(error);
  if (/Authentication required|订阅验证|身份正在恢复/i.test(message)) {
    return publicError(error, '当前订阅身份尚未准备好，请稍后重试。');
  }
  if (/API Key|secret|credential/i.test(message)) {
    return 'API Key 无效，请检查是否复制完整、是否包含多余空格。';
  }
  if (/model/i.test(message)) {
    return '模型 ID 无效或未启用，请按照供应商控制台中的名称填写。';
  }
  if (/base URL|endpoint host|URL invalid|地址/i.test(message)) {
    return '接口地址无效，请检查服务商提供的 API 地址。';
  }
  return '无法完成连接测试，请检查 API Key、模型名称、网络和供应商服务状态。';
}

function modelDiscoveryFailureMessage(result) {
  return ({
    model_discovery_authentication_failed: 'API Key 无效、已过期，或没有读取模型的权限。',
    model_discovery_rate_limited: '供应商暂时限制了请求频率，请稍后再试。',
    model_discovery_endpoint_not_found: '官方模型接口暂时不可用，请更新客户端或稍后重试。',
    model_discovery_provider_unavailable: '供应商模型服务暂时不可用，请稍后再试。',
    model_discovery_network_failed: '无法连接供应商，请检查网络或稍后重试。',
    model_discovery_timeout: '供应商响应超时，请稍后重试。',
    model_discovery_response_failed: '供应商响应中断，请稍后重试。',
    model_discovery_response_too_large: '供应商返回的模型列表异常过大，客户端已停止读取。',
    model_discovery_invalid_response: '供应商返回了无法识别的模型列表。',
    model_discovery_no_models: 'Key 已被接受，但当前账号没有返回可用于选择的模型。',
    model_discovery_request_rejected: '供应商拒绝读取模型，请检查 Key 的权限。',
  })[result?.summaryCode] || '没有读取到模型，请确认 Key 属于当前所选供应商。';
}

function modelDiscoveryError(error) {
  const message = transportSafeErrorMessage(error);
  if (/Authentication required|订阅验证|身份正在恢复/i.test(message)) {
    return '当前订阅身份尚未准备好，请稍后重试。';
  }
  if (/API Key|secret|credential/i.test(message)) {
    return 'API Key 无效，请检查是否复制完整、是否包含多余空格。';
  }
  if (/official Provider|trusted Catalog|connection settings/i.test(message)) {
    return '官方供应商配置已发生异常，客户端已阻止发送 Key。';
  }
  return '无法读取模型，请检查网络、API Key 和供应商服务状态。';
}

function transportSafeErrorMessage(error) {
  return String(error?.message || '')
    .replace(/^Error invoking remote method '[^']+':\s*/i, '')
    .replace(/^HostRequestError:\s*/i, '');
}

function syncAssignmentScope() {
  const scope = document.getElementById('assignment-scope');
  const field = document.getElementById('assignment-agent-field');
  if (!scope || !field) return;
  const select = field.querySelector('select');
  const isAgent = scope.value === 'agent';
  select.disabled = !isAgent;
  field.classList.toggle('field-disabled', !isAgent);
}

function collectModelOptions(profiles, catalog) {
  const models = new Set();
  for (const profile of profiles) {
    for (const model of profile.enabledModels || []) models.add(model);
  }
  for (const provider of catalog.providers || []) {
    for (const model of provider.models || []) models.add(model.modelId);
  }
  return [...models].sort();
}

function parseModels(value) {
  return [...new Set(String(value || '').split(/[\n,]/).map((item) => item.trim()).filter(Boolean))];
}

function option(value, label, selected) {
  return `<option value="${value}" ${selected === value ? 'selected' : ''}>${label}</option>`;
}

function registryStatusLabel(registry) {
  return ({
    disabled: '生产源未配置',
    ready: '可信缓存可用',
    updated: '签名目录已更新',
    not_modified: '目录已是最新',
    last_known_good: '使用最后良好版本',
    unavailable: '可信目录不可用',
  })[registry?.outcome] || '正在检测';
}

function registryStatusCopy(registry) {
  if (registry?.outcome === 'disabled') {
    return '当前正式构建没有内置发布根与 endpoint；远端安装保持关闭。';
  }
  if (registry?.outcome === 'last_known_good') {
    return `远端检查失败，Host 继续使用最近一次验证通过的目录${registry.cache?.packageCount != null ? `（${registry.cache.packageCount} 个 Package）` : ''}。`;
  }
  if (registry?.outcome === 'unavailable') {
    return '没有可安全使用的签名目录；下载会失败关闭。';
  }
  if (registry?.cache) {
    return `Registry revision ${registry.cache.registryRevision} · ${registry.cache.packageCount} 个已签名 Package · ${formatPackageTime(registry.cache.verifiedAt)}`;
  }
  return '远端目录状态由 Host 校验；界面不会接触 Registry 原文或下载地址。';
}

function registryRefreshNotice(registry) {
  if (registry?.outcome === 'disabled') return '生产 Agent Package 发布源尚未配置，远端更新保持关闭。';
  if (registry?.outcome === 'updated') return '签名 Agent Package Registry 已更新。';
  if (registry?.outcome === 'not_modified') return '签名 Agent Package Registry 已是最新版本。';
  if (registry?.outcome === 'last_known_good') return '远端刷新失败，Host 正继续使用最后良好目录。';
  if (registry?.outcome === 'unavailable') return '当前没有可安全使用的远端 Agent Package 目录。';
  return 'Agent Package Registry 状态已重新核对。';
}

function permissionLabel(permission) {
  return ({
    browser_control: '浏览器控制',
    external_actions: '外部操作',
    external_mutations: '外部写操作',
    local_files: '本地文件',
    network_access: '网络访问',
    process_execution: '进程执行',
  })[permission] || permission || '未知权限';
}

function packageStatusLabel(status) {
  if (!status) return '未安装';
  return ({
    built_in: '内置版本',
    installed_active: 'Active',
    installed_previous: 'Previous',
    invalid: '需要检查',
    orphan: '孤立记录',
  })[status.kind] || status.kind || '状态未知';
}

function discoveryAvailabilityLabel(availability) {
  return ({
    new_agent: '新 Agent',
    update_available: '可用更新',
    current: '当前版本',
    local_newer: '本地版本更新',
  })[availability] || '版本状态未知';
}

function packageReceiptNotice(receipt, action) {
  const base = String(action || '').startsWith('Agent Package')
    ? String(action)
    : `Agent Package ${action || '操作'}已提交。`;
  const visibility = receipt?.runtimeVisibility || {};
  if (visibility.status === 'refresh_pending') {
    return `${base} 磁盘状态已提交，但运行时仍使用最后良好目录；请执行“恢复可见性”。`;
  }
  if (visibility.status === 'superseded') {
    return `${base} 当前运行时已有更新版本 ${visibility.activeVersion || ''}。`;
  }
  return `${base} Runtime Catalog 已可见。`;
}

function formatApprovalExpiry(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return '即将过期';
  return `${Math.ceil(value / 60)} 分钟内有效`;
}

function formatPackageTime(value, prefix = '验证于') {
  const date = new Date(value || '');
  if (Number.isNaN(date.valueOf())) return '验证时间未知';
  return `${prefix} ${new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)}`;
}

function protocolLabel(protocol) {
  return ({
    openai_responses: 'OpenAI Responses 兼容',
    openai_chat: 'OpenAI Chat Completions 兼容',
    anthropic_messages: 'Anthropic Messages 兼容',
  })[protocol] || protocol || '未知协议';
}

function scopeLabel(assignment) {
  if (assignment.scopeKind === 'global') return '全局默认';
  return `${assignment.scopeKind} / ${assignment.scopeId || '—'}`;
}

function probeStatusLabel(probe) {
  if (probe.level === 'minimal_inference' && probe.status === 'passed') return '模型已真实响应';
  if (probe.level === 'local_validation' && probe.status === 'passed') return '本地配置有效';
  if (probe.status === 'unsupported') return '元数据检查不支持';
  if (probe.status === 'confirmation_required') return '等待付费确认';
  if (probe.status === 'failed') return '检查未通过';
  return '检查已完成';
}

function probeDetail(probe) {
  const network = probe.networkAttempted ? '已向 Provider 发出请求' : '零网络';
  const model = probe.modelId || '未知模型';
  return `${model} · ${network} · ${formatProbeTime(probe.completedAt)}`;
}

function probeNotice(probe) {
  if (!probe) return 'Provider 检查已完成。';
  if (probe.level === 'minimal_inference' && probe.status === 'passed') {
    return '模型已真实响应；本次最小推理可能产生 Provider 费用，且未写入 Agent 会话。';
  }
  if (probe.level === 'local_validation' && probe.status === 'passed') {
    return '本地配置、模型与 Vault 凭据有效；此次检查未连接 Provider。';
  }
  if (probe.status === 'unsupported') {
    return 'Catalog 未声明安全的非计费元数据端点；此次检查未连接 Provider。';
  }
  if (probe.status === 'failed') {
    return probe.networkAttempted
      ? 'Provider 已收到最小请求，但模型未成功响应；路由未发生切换。'
      : '本地检查未通过；没有连接 Provider，也没有切换路由。';
  }
  return '检查已完成，没有改变任何 Agent 会话或 Provider 路由。';
}

function formatProbeTime(value) {
  const date = new Date(value || '');
  if (Number.isNaN(date.valueOf())) return '时间未知';
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function publicError(error, fallback) {
  const message = String(error?.message || fallback);
  if (/Authentication required|HostRequestError|Error invoking remote method/i.test(message)) {
    return message.toLowerCase().includes('authentication required')
      ? '本地身份正在恢复，请稍后重试。'
      : fallback;
  }
  return message
    .replace(/sk-[A-Za-z0-9_-]+/g, '[已隐藏]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [已隐藏]')
    .slice(0, 500);
}

function agentCard(agent, index, activatingAgentId) {
  const resident = isResident(agent);
  const activating = activatingAgentId === agent.agentId;
  const tones = ['tone-violet', 'tone-mint', 'tone-blue'];
  const symbol = Array.from(String(agent.displayName || agent.agentId || '').trim())[0]
    ?.toUpperCase() || 'A';
  const buttonAttribute = `data-open-conversation="${escapeHtml(agent.agentId)}"`;
  const buttonLabel = activating
    ? '正在唤醒…'
    : resident ? '打开对话' : '激活并打开';
  return `
    <article class="agent-card ${tones[index % tones.length]}">
      <div class="agent-symbol">${escapeHtml(symbol)}</div>
      <h3>${escapeHtml(agent.displayName)}</h3>
      <p>${escapeHtml(agent.description)}</p>
      <div class="agent-meta">
        <span class="runtime ${resident ? 'running' : ''}">${escapeHtml(runtimeLabel(agent.runtimeState, agent.desiredState))}</span>
        <button class="agent-action" ${buttonAttribute} ${activating ? 'disabled' : ''}>${buttonLabel}</button>
      </div>
    </article>`;
}

function accountChip(account) {
  return `<div class="account-chip"><div class="avatar">${escapeHtml(initials(account))}</div><div><strong>${escapeHtml(account.displayName || 'AgentMesh360 用户')}</strong><span>${escapeHtml(account.email || '')}</span></div></div>`;
}

function initials(account) {
  const source = account.displayName || account.email || 'AM';
  return source.slice(0, 2).toUpperCase();
}

function firstName(account) {
  const name = account.displayName?.trim();
  if (name) return name.split(/\s+/)[0];
  return account.email?.split('@')[0] || '朋友';
}

function blockedReason(reason, status) {
  if (reason === 'subscription_expired' || status === 'expired') {
    return { title: '订阅已到期', message: '续订后即可恢复全部常驻 Agent。' };
  }
  if (reason === 'subscription_suspended' || status === 'suspended') {
    return { title: '订阅暂时不可用', message: '请前往官网处理订阅状态。' };
  }
  return { title: '需要有效订阅', message: 'AgentMesh360 客户端仅向有效订阅用户开放。' };
}

function subscriptionLabel(subscription) {
  const plan = subscription.plan ? String(subscription.plan).replaceAll('_', ' ') : '有效订阅';
  if (!subscription.periodEnd) return plan;
  const date = new Date(subscription.periodEnd.replace(' ', 'T') + (subscription.periodEnd.includes('Z') ? '' : 'Z'));
  if (Number.isNaN(date.valueOf())) return plan;
  return `${plan} · 有效期至 ${new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric' }).format(date)}`;
}

function isResident(agent) {
  return agent.desiredState === 'running' && ['resident', 'working', 'needs_input', 'dormant', 'starting'].includes(agent.runtimeState);
}

function runtimeLabel(runtime, desired) {
  if (desired !== 'running') return '尚未激活';
  return ({
    resident: '正在常驻',
    working: '正在工作',
    needs_input: '等待你的回复',
    dormant: '可随时恢复',
    starting: '正在启动',
    completed: '任务已完成',
    error: '需要检查',
  })[runtime] || '已激活';
}

function formatNumber(value) {
  return new Intl.NumberFormat('zh-CN').format(Number(value || 0));
}

function formatCheckedAt(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.valueOf())) return '刚刚验证';
  return `验证于 ${new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(date)}`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
