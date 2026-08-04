'use strict';

const bridge = window.agentmesh360;
const root = document.getElementById('app');
let currentState = { phase: 'starting' };
let workspaceView = 'agents';
let readyAccountId = null;
let agentManagementUi = {
  phase: 'idle',
  agentId: null,
  tab: 'conversation',
  snapshot: null,
  error: null,
  message: null,
  busy: false,
};
let agentCustomizationDrafts = new Map();
let agentManagementRequestRevision = 0;
let agentOverviewUi = {
  phase: 'idle',
  snapshot: null,
  error: null,
};
let agentOverviewRequestRevision = 0;
let conversationOpenRevision = 0;
let pendingConversationOpen = null;
let conversationOpenTail = Promise.resolve();
let conversationSendRevision = 0;
let conversationSendPendingByAgent = new Map();
let conversationInterjectionPending = new Set();
let conversationStreamingAgents = new Set();
let settingsTab = 'account';
let providerUi = {
  phase: 'idle',
  snapshot: null,
  error: null,
  message: null,
  busy: false,
  editingProfileId: null,
  editorOpen: false,
  pendingDelete: null,
  focusAfterRender: null,
};
let providerDraft = null;
let conversationDrafts = new Map();
let conversationAttachmentErrors = new Map();
let conversationAttachmentMutationInFlight = false;
let conversationComposerIntents = new Map();
let conversationAttachmentAutoQueuePrevious = new Map();
let conversationQueueExpanded = new Set();
let conversationQueueEditing = new Map();
let conversationQueueMutationInFlight = false;
let conversationCancellationInFlight = new Set();
let conversationPasteCards = new Map();
let conversationPasteExpanded = new Set();
let conversationInputCapabilities = new Map();
let conversationDictationUi = emptyConversationDictationSnapshot();
let conversationDictationApplied = new Set();
let activeConversationDictationSink = null;
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
let backgroundRequestRevision = 0;
let conversationUi = { phase: 'idle' };
let permissionResponseInFlight = null;

bridge.onState(render);
bridge.onConversationState((state) => {
  const previousTurnRunning = conversationTurnIsRunning(conversationUi.agentId);
  const streamingStateChanged = trackConversationStreamingState(state);
  // The open IPC response is authoritative. Host push events emitted by a
  // previous load must not replace this request's fail-closed loading state.
  if (pendingConversationOpen) return;
  // A Host handoff can briefly project an agent-less idle snapshot while the
  // current send IPC is still resolving. Keep the known Agent snapshot and
  // local pending-turn owner until that IPC either returns a full state or
  // rejects; otherwise the missing agentId would strand the turn lock.
  if (conversationSendPendingByAgent.size && state?.phase === 'idle' && !state?.agentId) return;
  if (state?.agentId && state.agentId !== agentManagementUi.agentId) {
    if (
      streamingStateChanged
      && currentState.phase === 'ready'
      && workspaceView === 'agent-detail'
    ) {
      renderReady(currentState);
    }
    return;
  }
  conversationUi = state || { phase: 'idle' };
  const turnRunningChanged = previousTurnRunning !== conversationTurnIsRunning();
  if (
    currentState.phase === 'ready'
    && workspaceView === 'agent-detail'
    && (agentManagementUi.tab === 'conversation' || turnRunningChanged)
  ) {
    renderReady(currentState);
  }
});
if (typeof bridge.onDictationState === 'function') {
  bridge.onDictationState((state) => {
    const projected = safeConversationDictationSnapshot(state);
    if (!projected) return;
    conversationDictationUi = projected;
    activeConversationDictationSink?.(projected);
  });
}
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
      editorOpen: false,
      pendingDelete: null,
      focusAfterRender: null,
    };
    providerDraft = null;
    conversationDrafts = new Map();
    conversationAttachmentErrors = new Map();
    conversationAttachmentMutationInFlight = false;
    conversationComposerIntents = new Map();
    conversationAttachmentAutoQueuePrevious = new Map();
    conversationQueueExpanded = new Set();
    conversationQueueEditing = new Map();
    conversationQueueMutationInFlight = false;
    conversationCancellationInFlight = new Set();
    conversationPasteCards = new Map();
    conversationPasteExpanded = new Set();
    conversationInputCapabilities = new Map();
    conversationDictationUi = emptyConversationDictationSnapshot();
    conversationDictationApplied = new Set();
    activeConversationDictationSink = null;
    agentCustomizationDrafts = new Map();
    agentManagementUi = {
      phase: 'idle',
      agentId: null,
      tab: 'conversation',
      snapshot: null,
      error: null,
      message: null,
      busy: false,
    };
    agentOverviewUi = {
      phase: 'idle',
      snapshot: null,
      error: null,
    };
    agentOverviewRequestRevision += 1;
    conversationOpenRevision += 1;
    pendingConversationOpen = null;
    conversationSendRevision += 1;
    conversationSendPendingByAgent = new Map();
    conversationInterjectionPending = new Set();
    conversationStreamingAgents = new Set();
    settingsTab = 'account';
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
    backgroundRequestRevision += 1;
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
    conversationAttachmentErrors = new Map();
    conversationAttachmentMutationInFlight = false;
    conversationComposerIntents = new Map();
    conversationAttachmentAutoQueuePrevious = new Map();
    conversationQueueExpanded = new Set();
    conversationQueueEditing = new Map();
    conversationQueueMutationInFlight = false;
    conversationPasteCards = new Map();
    conversationPasteExpanded = new Set();
    conversationInputCapabilities = new Map();
    conversationDictationUi = emptyConversationDictationSnapshot();
    conversationDictationApplied = new Set();
    activeConversationDictationSink = null;
    agentCustomizationDrafts = new Map();
    agentManagementUi = {
      phase: 'idle',
      agentId: null,
      tab: 'conversation',
      snapshot: null,
      error: null,
      message: null,
      busy: false,
    };
    agentOverviewUi = {
      phase: 'idle',
      snapshot: null,
      error: null,
    };
    agentOverviewRequestRevision += 1;
    conversationOpenRevision += 1;
    pendingConversationOpen = null;
    conversationSendRevision += 1;
    conversationSendPendingByAgent = new Map();
    conversationInterjectionPending = new Set();
    conversationStreamingAgents = new Set();
    packageUi.snapshot = null;
    packageUi.phase = 'idle';
    packageUi.pendingApproval = null;
    packageUi.unknownOutcome = null;
    backgroundUi.snapshot = null;
    backgroundUi.phase = 'idle';
    backgroundRequestRevision += 1;
    conversationUi = { phase: 'idle' };
    permissionResponseInFlight = null;
  }
  if (currentState.phase !== 'ready') window.AgentMeshSelect?.destroyAll();
  switch (currentState.phase) {
    case 'signed_out':
      renderSignedOut(currentState);
      break;
    case 'blocked':
      renderBlocked(currentState);
      break;
    case 'ready':
      renderReady(currentState);
      if (backgroundUi.phase === 'idle') refreshBackgroundSnapshot();
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
    `订阅状态已安全验证 · ${formatCheckedAt(state.checkedAt)}`,
  );
  if (backgroundUi.phase !== 'loading') refreshBackgroundSnapshot({ quiet: true });
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
    trackConversationStreamingState(state);
    conversationUi = state;
    const requestRevision = ++agentManagementRequestRevision;
    agentManagementUi = {
      ...agentManagementUi,
      phase: 'loading',
      agentId: state.agentId,
      tab: 'conversation',
      snapshot: null,
      error: null,
      message: null,
      busy: false,
    };
    workspaceView = 'agent-detail';
    renderReady(currentState);
    await refreshAgentManagement(null, requestRevision);
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
  activeConversationDictationSink = null;
  captureRendererDrafts();
  window.AgentMeshSelect?.destroyAll();
  const account = state.account || {};
  const agentAreaActive = ['agents', 'agent-detail', 'add-agent'].includes(workspaceView);
  const hostStatus = hostConnectionStatus();
  const showAgentContext = shouldShowAgentContext(state);
  root.innerHTML = `
    <section class="shell workspace ${showAgentContext ? 'agent-workspace-layout' : ''}">
      <aside class="sidebar">
        ${brand()}
        <p class="nav-label">工作区</p>
        <button class="nav-item ${agentAreaActive ? 'active' : ''}" id="nav-agents" type="button"><i class="nav-dot"></i>Agent</button>
        <button class="nav-item ${workspaceView === 'providers' ? 'active' : ''}" id="nav-providers" type="button"><i class="nav-dot"></i>模型供应商</button>
        <button class="nav-item ${workspaceView === 'settings' ? 'active' : ''}" id="nav-settings" type="button"><i class="nav-dot"></i>设置</button>
        <div class="sidebar-spacer"></div>
        <button class="sidebar-host ${hostStatus.code}" id="sidebar-host" type="button">
          <i></i><span><strong>后台 Agent 服务</strong><small data-host-status>${escapeHtml(hostStatus.label)} · 点击查看</small></span>
        </button>
        <div class="sidebar-account">
          <div class="avatar">${escapeHtml(initials(account))}</div>
          <div class="copy"><strong data-ready-account-name>${escapeHtml(account.displayName || 'AgentMesh360 用户')}</strong><span data-ready-account-email>${escapeHtml(account.email || '')}</span></div>
          <button class="ghost" id="logout" title="退出登录">↗</button>
        </div>
      </aside>
      ${showAgentContext ? agentWorkspaceRail(state) : ''}
      <main class="workspace-main ${showAgentContext ? 'agent-workspace-main' : ''}">${readyWorkspaceContent(state)}</main>
    </section>`;
  document.getElementById('logout').addEventListener('click', () => bridge.logout());
  document.getElementById('nav-agents').addEventListener('click', () => {
    workspaceView = 'agents';
    renderReady(currentState);
    if (agentOverviewUi.phase === 'idle') refreshAgentOverview();
  });
  document.getElementById('nav-providers').addEventListener('click', () => {
    workspaceView = 'providers';
    renderReady(currentState);
    if (providerUi.phase === 'idle') refreshProviderSnapshot();
  });
  document.getElementById('nav-settings').addEventListener('click', () => {
    workspaceView = 'settings';
    renderReady(currentState);
  });
  document.getElementById('sidebar-host').addEventListener('click', () => {
    settingsTab = 'background';
    workspaceView = 'settings';
    renderReady(currentState);
    if (backgroundUi.phase === 'idle') refreshBackgroundSnapshot();
  });
  if (showAgentContext) wireAgentWorkspaceRail();
  if (workspaceView === 'agent-detail') {
    wireAgentDetail();
  } else if (workspaceView === 'add-agent') {
    wirePackageCenter();
  } else if (workspaceView === 'providers') {
    wireProviderSettings();
  } else if (workspaceView === 'settings') {
    wireSettings();
  }
  if (workspaceView === 'agents') wireOnboardingGuide();
  for (const button of document.querySelectorAll('[data-manage-agent]')) {
    button.addEventListener('click', () => {
      const agent = currentState.agents?.find(
        (item) => item.agentId === button.dataset.manageAgent,
      );
      if (
        isResident(agent)
        && conversationTurnIsRunning(agent.agentId)
        && showExistingConversation(agent.agentId)
      ) return;
      openAgentDetail(agent?.agentId, isResident(agent) ? 'conversation' : 'model');
    });
  }
  if (workspaceView === 'agents' && agentOverviewUi.phase === 'idle') refreshAgentOverview();
  window.AgentMeshSelect?.enhance(root);
}

function readyWorkspaceContent(state) {
  if (workspaceView === 'agent-detail') return agentDetailView(state);
  if (workspaceView === 'add-agent') return packageCenterView();
  if (workspaceView === 'providers') return providerSettingsView(state);
  if (workspaceView === 'settings') return settingsView(state);
  return agentWorkspaceView(state);
}

function shouldShowAgentContext(state) {
  if (workspaceView !== 'agent-detail') return false;
  const agent = (state.agents || []).find(
    (item) => item.agentId === agentManagementUi.agentId,
  );
  return Boolean(agent && isResident(agent));
}

function agentWorkspaceRail(state) {
  const agents = (state.agents || []).filter(isResident);
  const activeAgent = agents.find((agent) => agent.agentId === agentManagementUi.agentId);
  const sessions = activeAgent ? publicAgentSessions(activeAgent) : [];
  return `
    <aside class="agent-workspace-rail" aria-label="持久 Agent 与会话">
      <section class="agent-rail-section resident-agent-section">
        <header><span>常驻 Agent</span><small>${agents.length}</small></header>
        <nav class="resident-agent-list" aria-label="选择持久 Agent">
          ${agents.map((agent) => {
    const active = agent.agentId === activeAgent?.agentId;
    const status = conversationTurnIsRunning(agent.agentId)
      ? '正在处理'
      : runtimeLabel(agent.runtimeState, agent.desiredState);
    return `
            <button
              type="button"
              class="agent-rail-item ${active ? 'active' : ''}"
              data-switch-resident-agent="${escapeHtml(agent.agentId)}"
              ${active ? 'aria-current="true"' : ''}
            >
              <span class="agent-rail-avatar">${escapeHtml(agentInitial(agent))}</span>
              <span><strong>${escapeHtml(agent.displayName)}</strong><small>${escapeHtml(status)}</small></span>
            </button>`;
  }).join('') || '<p class="agent-rail-empty">尚未激活持久 Agent</p>'}
        </nav>
      </section>
      <section class="agent-rail-section agent-session-section">
        <header><span>会话</span><small>${sessions.length}</small></header>
        <nav class="agent-session-list" aria-label="选择当前 Agent 会话">
          ${sessions.map((session) => `
            <button
              type="button"
              class="agent-session-item ${agentManagementUi.tab === 'conversation' ? 'active' : ''}"
              data-agent-session="${escapeHtml(session.key)}"
              ${agentManagementUi.tab === 'conversation' ? 'aria-current="page"' : ''}
            >
              <span class="session-glyph" aria-hidden="true">主</span>
              <span><strong>${escapeHtml(session.title)}</strong><small>${escapeHtml(session.subtitle)}</small></span>
            </button>
          `).join('') || '<p class="agent-rail-empty">激活后将创建持久主会话</p>'}
        </nav>
      </section>
    </aside>`;
}

function publicAgentSessions(agent) {
  if (!isResident(agent)) return [];
  return [{ key: 'main', title: '主会话', subtitle: '持续保留' }];
}

function wireAgentWorkspaceRail() {
  document.querySelectorAll('[data-switch-resident-agent]').forEach((button) => {
    button.addEventListener('click', () => {
      const agentId = button.dataset.switchResidentAgent;
      if (!agentId) return;
      if (showExistingConversation(agentId)) return;
      openAgentDetail(agentId, 'conversation');
    });
  });
  document.querySelector('[data-agent-session="main"]')?.addEventListener('click', () => {
    if (!agentManagementUi.agentId) return;
    if (showExistingConversation(agentManagementUi.agentId)) return;
    openConversation(agentManagementUi.agentId);
  });
}

function showExistingConversation(agentId) {
  if (
    !agentId
    || conversationUi.agentId !== agentId
    || !['loading', 'sending', 'ready', 'error'].includes(conversationUi.phase)
  ) {
    return false;
  }
  agentManagementRequestRevision += 1;
  workspaceView = 'agent-detail';
  agentManagementUi = {
    ...agentManagementUi,
    agentId,
    tab: 'conversation',
    error: null,
    message: null,
    busy: false,
  };
  renderReady(currentState);
  return true;
}

function captureRendererDrafts() {
  captureProviderDraft();
  const customizationForm = document.getElementById('agent-customization-form');
  if (customizationForm?.dataset.dirty === 'true') {
    const kind = String(customizationForm.elements.kind?.value || '');
    const accountId = String(customizationForm.dataset.accountId || '');
    const agentId = String(customizationForm.dataset.agentId || '');
    const key = accountId && agentId && kind ? `${accountId}:${agentId}:${kind}` : null;
    const content = String(customizationForm.elements.content?.value || '');
    if (key) agentCustomizationDrafts.set(key, content);
  }
  const conversationForm = document.getElementById('conversation-form');
  const draftKey = conversationDraftKey(
    conversationForm?.dataset.accountId,
    conversationForm?.dataset.agentId,
    conversationForm?.dataset.sessionKey,
  );
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

function conversationDraftKey(
  accountId = readyAccountId,
  agentId = conversationUi?.agentId,
  sessionKey = 'main',
) {
  if (!accountId || !agentId || sessionKey !== 'main') return null;
  return `${accountId}:${agentId}:${sessionKey}`;
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
  const ready = conversationUi.phase === 'ready';
  const sending = conversationTurnIsRunning(conversationUi.agentId);
  const cancelling = sending && conversationUi.cancelling === true;
  const displayName = conversationUi.displayName || 'Agent';
  const canReopen = conversationUi.phase === 'error' && conversationUi.agentId;
  const awaitingPermission = conversationUi.interaction?.kind === 'permission';
  const bindingIssue = agentManagementUi.phase === 'ready'
    ? agentManagementUi.snapshot?.bindingIssue
    : null;
  const modelBlocked = Boolean(bindingIssue);
  const draftAttachments = safeConversationDraftAttachments(conversationUi.draftAttachments);
  const draftKey = conversationDraftKey();
  const queue = safeConversationQueue(conversationUi.queue);
  const requestedIntent = draftKey ? conversationComposerIntents.get(draftKey) : null;
  const composerIntent = sending
    ? (draftAttachments.length > 0 ? 'queue' : (requestedIntent || 'adjust'))
    : 'send';
  const visibleDraftAttachments = draftAttachments;
  const pasteCards = draftKey ? (conversationPasteCards.get(draftKey) || []) : [];
  const attachmentError = draftKey ? conversationAttachmentErrors.get(draftKey) : null;
  const composerDisabled = !(ready || (sending && conversationUi.agentId)) || modelBlocked;
  const canSubmitWithoutTextarea = pasteCards.length > 0
    || (composerIntent !== 'adjust' && visibleDraftAttachments.length > 0);
  const submitLabel = composerIntent === 'adjust'
    ? '追加指令'
    : composerIntent === 'queue'
      ? '排队发送'
      : composerIntent === 'now'
        ? '立即执行'
        : '发送';
  const intentLabel = composerIntent === 'adjust'
    ? '调整当前任务'
    : composerIntent === 'queue'
      ? '排队等待'
      : composerIntent === 'now'
        ? '立即执行'
        : '普通发送';
  const gates = `${conversationUi.error ? `
    <div class="conversation-error" role="alert">
      <span>${escapeHtml(conversationUi.error)}</span>
      ${canReopen ? `<button class="ghost" type="button" data-reopen-conversation="${escapeHtml(conversationUi.agentId)}">重新打开</button>` : ''}
    </div>` : ''}${bindingIssue ? `
    <div class="conversation-error model-binding-error" role="alert">
      <span>${escapeHtml(bindingIssue.message || '模型设置不可用，请重新选择。')}</span>
      <button class="ghost" type="button" id="conversation-fix-model">重新选择模型</button>
    </div>` : ''}${awaitingPermission ? permissionInteractionView(conversationUi.interaction) : ''}`;
  return `
    <section class="conversation-shell" aria-label="${escapeHtml(displayName)} 主会话">
      <div class="conversation-gates">${gates}</div>
      <div class="conversation-transcript" id="conversation-transcript" aria-live="polite">
        <div class="conversation-feed">
          ${conversationUi.transcriptTruncated ? '<div class="conversation-truncated">较早内容仍安全保留，此处只显示最近消息。</div>' : ''}
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
          ${sending ? `<div class="conversation-typing"><i></i><i></i><i></i><span>${cancelling ? '正在停止当前任务…' : `${escapeHtml(displayName)} 正在继续这项工作`}</span></div>` : ''}
        </div>
      </div>
      <div class="conversation-composer-dock">
        ${conversationQueueView(queue, draftKey)}
        <form
          class="conversation-composer"
          id="conversation-form"
          data-account-id="${escapeHtml(String(readyAccountId || ''))}"
          data-agent-id="${escapeHtml(String(conversationUi.agentId || agentManagementUi.agentId || ''))}"
          data-session-key="main"
          data-composer-enabled="${composerDisabled ? 'false' : 'true'}"
          data-composer-mode="${escapeHtml(composerIntent)}"
          data-composer-layout="unified"
          aria-label="给 ${escapeHtml(displayName)} 发送消息"
        >
          ${pasteCards.length ? conversationPasteCardsView(pasteCards) : ''}
          ${visibleDraftAttachments.length ? `
            <div class="composer-attachment-strip" role="list" aria-label="待发送附件">
              ${visibleDraftAttachments.map(conversationAttachmentChip).join('')}
            </div>` : ''}
          <div class="composer-entry-row">
            <textarea name="message" maxlength="16000" rows="2" aria-label="消息内容" placeholder="${modelBlocked
    ? '请先重新选择可用模型…'
    : composerIntent === 'adjust'
      ? '继续补充要求，Agent 会在当前任务中调整方向…'
      : composerIntent === 'queue'
        ? '写下下一项任务，当前工作完成后会按顺序执行…'
        : composerIntent === 'now'
          ? '这条消息会立即执行，并打断当前任务…'
      : '继续上次的工作，或告诉这个 Agent 你现在需要什么…'}" ${composerDisabled ? 'disabled' : ''}></textarea>
          </div>
          <div class="composer-suggestions" id="composer-suggestions" role="listbox" hidden></div>
          <div class="composer-link-entry" id="composer-link-entry" hidden>
            <input name="attachmentLink" type="url" maxlength="2048" inputmode="url" autocomplete="off" placeholder="https://example.com">
            <button class="ghost" type="button" id="composer-cancel-link">取消</button>
            <button class="secondary" type="button" id="composer-save-link">添加链接</button>
          </div>
          ${attachmentError ? `<div class="composer-attachment-error" role="alert">${escapeHtml(attachmentError)}</div>` : ''}
          <div class="composer-footer">
            <span>${composerIntent === 'adjust'
    ? '这条要求会调整当前任务，不会创建新的排队任务'
    : composerIntent === 'queue'
      ? '这条消息会进入待处理队列；附件会跟随这条消息保留'
      : composerIntent === 'now'
        ? '这条消息会立即执行并打断当前任务，请确认优先级'
    : draftAttachments.some((attachment) => attachment.kind === 'image')
      ? '图片会交给当前模型；能否理解取决于该模型的视觉能力'
      : '附件仅在本机暂存，发送时交给当前模型；不会上传到 AgentMesh360'}</span>
            <div class="composer-toolbar-tools">
              <div class="composer-tool-wrap">
                <button
                  class="composer-tool-button"
                  id="composer-add-button"
                  type="button"
                  aria-label="添加图片、文件或链接"
                  title="添加图片、文件或链接"
                  aria-haspopup="menu"
                  aria-expanded="false"
                  ${composerDisabled ? 'disabled' : ''}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>
                </button>
                <div class="composer-tool-menu" id="composer-tool-menu" role="menu" hidden>
                  <button type="button" role="menuitem" id="composer-pick-files">
                    <i aria-hidden="true">↥</i><span><strong>图片或文件</strong><small>选择、拖放或粘贴，最多 10 个</small></span>
                  </button>
                  <button type="button" role="menuitem" id="composer-add-link">
                    <i aria-hidden="true">↗</i><span><strong>网页链接</strong><small>把网址作为上下文交给 Agent</small></span>
                  </button>
                  <button type="button" role="menuitem" id="composer-authorize-workspace">
                    <i aria-hidden="true">@</i><span><strong>授权工作文件夹</strong><small>允许当前 Agent 引用你选择的文件</small></span>
                  </button>
                  <button type="button" role="menuitem" id="composer-prompt-history">
                    <i aria-hidden="true">↺</i><span><strong>历史消息</strong><small>找回这个 Agent 主会话中的输入</small></span>
                  </button>
                </div>
              </div>
              ${sending ? `
                <div class="composer-intent-wrap">
                  <button class="composer-intent-toggle" type="button" aria-label="选择发送方式，当前为${escapeHtml(intentLabel)}" title="选择发送方式" aria-haspopup="menu" aria-expanded="false">
                    <strong>${escapeHtml(intentLabel)}</strong>
                    <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m6.5 8 3.5 3.5L13.5 8"/></svg>
                  </button>
                  <div class="composer-intent-menu" role="menu" hidden>
                    <button type="button" role="menuitemradio" aria-checked="${composerIntent === 'adjust'}" data-composer-intent="adjust"><strong>调整当前任务</strong><small>把要求加入正在执行的工作</small></button>
                    <button type="button" role="menuitemradio" aria-checked="${composerIntent === 'queue'}" data-composer-intent="queue"><strong>排队等待</strong><small>当前任务结束后按顺序执行</small></button>
                    <button type="button" role="menuitemradio" aria-checked="${composerIntent === 'now'}" data-composer-intent="now"><strong>立即执行</strong><small>打断当前任务并优先处理</small></button>
                  </div>
                </div>` : ''}
            </div>
            <div class="composer-actions">
              ${sending ? `<button class="composer-stop" type="button" aria-label="${cancelling ? '正在停止当前任务' : '停止当前任务'}" title="${cancelling ? '正在停止…' : '停止当前任务'}" ${cancelling ? 'disabled aria-busy="true"' : ''}><span class="visually-hidden">${cancelling ? '正在停止…' : '停止当前任务'}</span><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="8" height="8" rx="1.5"/></svg></button>` : ''}
              <button class="composer-dictation-button" type="button" aria-label="本机听写" title="本机听写" ${composerDisabled ? 'disabled' : ''}><span class="visually-hidden">本机听写</span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15.5a3.5 3.5 0 0 0 3.5-3.5V7a3.5 3.5 0 1 0-7 0v5a3.5 3.5 0 0 0 3.5 3.5Z"/><path d="M5.5 11.5v.5a6.5 6.5 0 0 0 13 0v-.5M12 18.5V22M9 22h6"/></svg></button>
              <div class="composer-submit-wrap">
                <button class="composer-send" type="submit" aria-label="${escapeHtml(submitLabel)}" title="${escapeHtml(submitLabel)}" ${composerDisabled || !canSubmitWithoutTextarea ? 'disabled' : ''}><span class="visually-hidden">${escapeHtml(submitLabel)}</span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5M6.5 10.5 12 5l5.5 5.5"/></svg></button>
              </div>
            </div>
          </div>
        </form>
      </div>
    </section>`;
}

function safeConversationDraftAttachments(value) {
  if (!Array.isArray(value)) return [];
  const safeKinds = new Set(['image', 'file', 'link']);
  const seen = new Set();
  return value.slice(0, 10).flatMap((attachment) => {
    const attachmentId = typeof attachment?.attachmentId === 'string'
      ? attachment.attachmentId
      : '';
    const name = typeof attachment?.name === 'string' ? attachment.name.trim() : '';
    const mimeType = typeof attachment?.mimeType === 'string' ? attachment.mimeType : '';
    if (
      !/^attachment-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(attachmentId)
      || seen.has(attachmentId)
      || !safeKinds.has(attachment?.kind)
      || !name
      || name.length > 180
      || /[\u0000-\u001F\u007F-\u009F]/u.test(name)
      || !Number.isSafeInteger(attachment?.sizeBytes)
      || attachment.sizeBytes < 0
      || attachment.sizeBytes > 20 * 1024 * 1024
      || mimeType.length > 160
    ) {
      return [];
    }
    seen.add(attachmentId);
    return [{
      attachmentId,
      kind: attachment.kind,
      name,
      mimeType,
      sizeBytes: attachment.sizeBytes,
    }];
  });
}

function safeConversationQueue(value) {
  const source = value && typeof value === 'object' ? value : {};
  const seen = new Set();
  const entries = Array.isArray(source.entries)
    ? source.entries.slice(0, 50).flatMap((entry) => {
      const queueId = typeof entry?.queueId === 'string' ? entry.queueId : '';
      const text = typeof entry?.text === 'string' ? entry.text : '';
      if (
        !/^queue-\d+$/.test(queueId)
        || seen.has(queueId)
        || !Number.isSafeInteger(entry?.version)
        || entry.version < 0
        || !Number.isSafeInteger(entry?.position)
        || entry.position < 0
        || text.length > 4_000
        || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u.test(text)
      ) return [];
      seen.add(queueId);
      return [{
        queueId,
        text,
        version: entry.version,
        position: entry.position,
        editable: entry.editable === true,
      }];
    }).sort((left, right) => left.position - right.position)
    : [];
  return {
    revision: Number.isSafeInteger(source.revision) && source.revision >= 0 ? source.revision : 0,
    synced: source.synced === true,
    running: source.running === true,
    confirmingCount: Number.isSafeInteger(source.confirmingCount)
      ? Math.max(0, Math.min(50, source.confirmingCount))
      : 0,
    entries,
    mutation: source.mutation && typeof source.mutation === 'object'
      ? {
        kind: String(source.mutation.kind || '').slice(0, 30),
        pending: source.mutation.pending === true,
        message: String(source.mutation.message || '').slice(0, 240),
      }
      : null,
  };
}

function conversationQueueView(queue, draftKey) {
  if (!queue.entries.length && queue.confirmingCount < 1) return '';
  const expanded = Boolean(draftKey && conversationQueueExpanded.has(draftKey));
  const editingQueueId = draftKey ? conversationQueueEditing.get(draftKey) : null;
  const visibleEntries = expanded ? queue.entries : queue.entries.slice(0, 3);
  const total = queue.entries.length + queue.confirmingCount;
  return `
    <section class="conversation-queue ${expanded ? 'expanded' : ''}" aria-label="待处理消息">
      <button class="conversation-queue-summary" type="button" data-toggle-queue aria-expanded="${expanded}">
        <span><i aria-hidden="true"></i><strong>待处理 ${total} 条</strong>${queue.confirmingCount ? `<small>${queue.confirmingCount} 条正在确认</small>` : '<small>按顺序执行</small>'}</span>
        <b>${expanded ? '收起' : '管理'}</b>
      </button>
      <div class="conversation-queue-list" role="list">
        ${visibleEntries.map((entry, index) => `
          <article class="conversation-queue-item" role="listitem" data-queue-id="${escapeHtml(entry.queueId)}">
            <span class="queue-position">${index + 1}</span>
            ${editingQueueId === entry.queueId
    ? `<input class="queue-edit-input" type="text" maxlength="16000" value="${escapeHtml(entry.text)}" aria-label="编辑待处理消息">`
    : `<p title="${escapeHtml(entry.text)}">${escapeHtml(entry.text || '仅附件消息')}</p>`}
            ${editingQueueId === entry.queueId ? `
              <div class="queue-item-actions editing">
                <button type="button" data-queue-save="${escapeHtml(entry.queueId)}">保存</button>
                <button type="button" data-queue-cancel-edit="${escapeHtml(entry.queueId)}">取消</button>
              </div>` : expanded && entry.editable ? `
              <div class="queue-item-actions">
                <button type="button" data-queue-up="${escapeHtml(entry.queueId)}" ${index === 0 ? 'disabled' : ''} aria-label="上移">↑</button>
                <button type="button" data-queue-down="${escapeHtml(entry.queueId)}" ${index === queue.entries.length - 1 ? 'disabled' : ''} aria-label="下移">↓</button>
                <button type="button" data-queue-edit="${escapeHtml(entry.queueId)}">编辑</button>
                <button type="button" data-queue-now="${escapeHtml(entry.queueId)}">立即执行</button>
                <button type="button" data-queue-remove="${escapeHtml(entry.queueId)}">删除</button>
              </div>` : ''}
          </article>`).join('')}
        ${!expanded && queue.entries.length > 3 ? `<div class="conversation-queue-more">另有 ${queue.entries.length - 3} 条，点击“管理”查看</div>` : ''}
        ${queue.confirmingCount ? `<div class="conversation-queue-confirming"><i></i>正在确认 ${queue.confirmingCount} 条消息是否已进入队列…</div>` : ''}
      </div>
      ${expanded ? `
        <footer>
          <span>${queue.synced ? `已同步 · 版本 ${queue.revision}` : '正在同步权威顺序…'}</span>
          <button class="ghost" type="button" data-queue-clear ${queue.entries.some((entry) => entry.editable) ? '' : 'disabled'}>清空本客户端待处理项</button>
        </footer>` : ''}
      ${queue.mutation ? `<div class="conversation-queue-mutation ${queue.mutation.pending ? 'pending' : 'failed'}">${escapeHtml(queue.mutation.pending ? '正在确认队列变化…' : queue.mutation.message || '队列已变化，请重试。')}</div>` : ''}
    </section>`;
}

function conversationPasteCardsView(cards) {
  return `
    <div class="composer-paste-strip" role="list" aria-label="大段粘贴内容">
      ${cards.map((card, index) => {
    const expanded = conversationPasteExpanded.has(card.id);
    const lineCount = String(card.text || '').split(/\r?\n/u).length;
    return `
        <article class="composer-paste-card ${expanded ? 'expanded' : ''}" role="listitem" data-paste-card="${escapeHtml(card.id)}">
          <header>
            <i aria-hidden="true">粘</i>
            <span><strong>粘贴内容 ${index + 1}</strong><small>${card.text.length.toLocaleString()} 字 · ${lineCount} 行</small></span>
            <button type="button" data-toggle-paste="${escapeHtml(card.id)}">${expanded ? '收起' : '查看'}</button>
            <button type="button" data-remove-paste="${escapeHtml(card.id)}" aria-label="删除粘贴内容">×</button>
          </header>
          ${expanded ? `<textarea class="paste-card-editor" maxlength="16000" rows="5" data-edit-paste="${escapeHtml(card.id)}">${escapeHtml(card.text)}</textarea>` : ''}
        </article>`;
  }).join('')}
    </div>`;
}

function composerTriggerAtCursor(textarea) {
  const value = String(textarea?.value || '');
  const cursor = Number.isSafeInteger(textarea?.selectionStart)
    ? textarea.selectionStart
    : value.length;
  const before = value.slice(0, cursor);
  const match = before.match(/(^|\s)([/@$])([^\s/@$]*)$/u);
  if (!match) return null;
  const token = `${match[2]}${match[3]}`;
  return {
    kind: match[2] === '/' ? 'command' : match[2] === '$' ? 'skill' : 'file',
    prefix: match[2],
    query: match[3].toLocaleLowerCase(),
    start: cursor - token.length,
    end: cursor,
  };
}

function unsafeComposerSlashCommand(text) {
  const firstToken = String(text || '').trim().match(/^(\/[^\s]*)/u)?.[1] || '';
  if (!firstToken) return null;
  if (['/compact', '/context', '/session-info'].includes(firstToken)) return null;
  return '此命令未获客户端允许。请从“/”菜单选择可用命令。';
}

function safeConversationInputCapabilities(value, expectedAgentId) {
  if (
    !value
    || typeof value !== 'object'
    || value.schemaVersion !== 1
    || value.agentId !== expectedAgentId
    || !Number.isSafeInteger(value.revision)
    || value.revision < 0
  ) return null;
  const project = (items, kind) => {
    if (!Array.isArray(items)) return [];
    const triggerPattern = kind === 'command'
      ? /^\/[a-z0-9][a-z0-9-]{0,48}$/
      : /^\$[a-z0-9][a-z0-9-]{0,48}$/;
    const seen = new Set();
    return items.slice(0, 50).flatMap((item) => {
      const id = String(item?.id || '');
      const trigger = String(item?.trigger || '');
      const displayName = String(item?.displayName || '').trim();
      const description = String(item?.description || '').trim();
      const promptText = kind === 'skill' ? String(item?.promptText || '') : trigger;
      if (
        !/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)
        || seen.has(id)
        || !triggerPattern.test(trigger)
        || !displayName
        || displayName.length > 80
        || description.length > 240
        || promptText.length > 4_000
        || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u.test(`${displayName}${description}${promptText}`)
      ) return [];
      seen.add(id);
      return [{
        kind,
        id,
        trigger,
        displayName,
        description,
        insertText: kind === 'command'
          ? `${trigger}${item.argumentHint ? ' ' : ''}`
          : promptText,
      }];
    });
  };
  return {
    revision: value.revision,
    commands: project(value.commands, 'command'),
    skills: project(value.skills, 'skill'),
  };
}

function safeConversationWorkspaceProjection(value, expectedAgentId) {
  if (
    !value
    || typeof value !== 'object'
    || value.schemaVersion !== 1
    || value.agentId !== expectedAgentId
  ) return { workspaces: [], files: [] };
  const workspacePattern = /^workspace-[0-9a-f-]{36}$/u;
  const workspaces = Array.isArray(value.workspaces)
    ? value.workspaces.slice(0, 16).flatMap((workspace) => {
      const workspaceId = String(workspace?.workspaceId || '');
      const displayName = String(workspace?.displayName || '').trim();
      if (
        !workspacePattern.test(workspaceId)
        || !displayName
        || displayName.length > 180
        || /[\u0000-\u001F\u007F-\u009F]/u.test(displayName)
      ) return [];
      return [{ workspaceId, displayName }];
    })
    : [];
  const workspaceIds = new Set(workspaces.map((workspace) => workspace.workspaceId));
  const files = Array.isArray(value.files)
    ? value.files.slice(0, 50).flatMap((file) => {
      const workspaceId = String(file?.workspaceId || '');
      const relativePath = String(file?.relativePath || '');
      const displayPath = String(file?.displayPath || relativePath);
      const workspaceName = String(file?.workspaceName || '').trim();
      if (
        !workspaceIds.has(workspaceId)
        || !relativePath
        || relativePath.length > 1_024
        || relativePath.startsWith('/')
        || relativePath.split('/').some((segment) => segment === '..' || segment === '.')
        || /[\u0000-\u001F\u007F-\u009F]/u.test(`${relativePath}${displayPath}${workspaceName}`)
        || !Number.isSafeInteger(file?.sizeBytes)
        || file.sizeBytes < 1
        || file.sizeBytes > 20 * 1024 * 1024
      ) return [];
      return [{
        workspaceId,
        relativePath,
        displayPath: displayPath.slice(0, 1_024),
        workspaceName: workspaceName.slice(0, 180),
        name: String(file?.name || relativePath.split('/').pop() || '文件').slice(0, 180),
        sizeBytes: file.sizeBytes,
      }];
    })
    : [];
  return { workspaces, files };
}

function safeConversationHistoryProjection(value, expectedAgentId) {
  if (
    !value
    || typeof value !== 'object'
    || value.schemaVersion !== 1
    || value.agentId !== expectedAgentId
    || !Array.isArray(value.history)
  ) return [];
  const seen = new Set();
  return value.history.slice(0, 20).flatMap((entry) => {
    const historyId = String(entry?.historyId || '');
    const preview = String(entry?.preview || '').trim();
    if (
      !/^history-[0-9a-f]{32}$/u.test(historyId)
      || seen.has(historyId)
      || !preview
      || Array.from(preview).length > 160
      || /[\u0000-\u001F\u007F-\u009F]/u.test(preview)
    ) return [];
    seen.add(historyId);
    return [{ historyId, preview }];
  });
}

function safeConversationDictationSnapshot(value) {
  const phases = new Set(['idle', 'starting', 'listening', 'transcribing', 'complete', 'error']);
  const phase = phases.has(value?.phase) ? value.phase : null;
  const revision = Number.isSafeInteger(value?.revision) && value.revision >= 0
    ? value.revision
    : null;
  const agentId = value?.agentId == null ? null : String(value.agentId);
  if (
    !phase
    || revision === null
    || (agentId !== null && !/^[a-z0-9][a-z0-9-]{1,198}[a-z0-9]$/u.test(agentId))
  ) return null;
  if (phase !== 'idle' && !agentId) return null;
  const dictationId = value?.dictationId == null ? null : String(value.dictationId);
  if (
    ['starting', 'listening', 'transcribing'].includes(phase)
    && !/^[A-Za-z0-9_-]{1,200}$/u.test(dictationId || '')
  ) return null;
  const safeText = (text, maxCodePoints) => {
    if (typeof text !== 'string') return '';
    const projected = Array.from(text).slice(0, maxCodePoints).join('');
    return /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u.test(projected)
      ? ''
      : projected;
  };
  const errorCode = typeof value?.error?.code === 'string'
    ? value.error.code.slice(0, 80)
    : '';
  const errorMessage = safeText(value?.error?.message, 240);
  const displayName = safeText(value?.service?.displayName, 100);
  return {
    revision,
    phase,
    dictationId,
    agentId,
    interimText: safeText(value?.interimText, 20_000),
    transcript: safeText(value?.transcript, 20_000),
    error: phase === 'error'
      ? {
        code: errorCode || 'dictation_failed',
        message: errorMessage || '听写没有完成，请稍后重试。',
      }
      : null,
    service: displayName ? { displayName } : null,
    limits: {
      maxDurationSeconds: Number.isSafeInteger(value?.limits?.maxDurationSeconds)
        ? Math.min(Math.max(value.limits.maxDurationSeconds, 1), 60)
        : 60,
      maxAudioBytes: Number.isSafeInteger(value?.limits?.maxAudioBytes)
        ? Math.min(Math.max(value.limits.maxAudioBytes, 1), 1_920_000)
        : 1_920_000,
    },
    disclosure: safeText(value?.disclosure, 200)
      || '语音只在这台 Mac 上转换为文字，不会上传到 AgentMesh360；听写结果只会放入输入框，不会自动发送。',
  };
}

function emptyConversationDictationSnapshot() {
  return {
    revision: 0,
    phase: 'idle',
    agentId: null,
    dictationId: null,
    interimText: '',
    transcript: '',
    error: null,
    service: null,
    limits: { maxDurationSeconds: 60, maxAudioBytes: 1_920_000 },
    disclosure: '语音只在这台 Mac 上转换为文字，不会上传到 AgentMesh360；听写结果只会放入输入框，不会自动发送。',
  };
}

function conversationAttachmentChip(attachment) {
  const glyph = attachment.kind === 'image' ? '图' : attachment.kind === 'link' ? '链' : '文';
  const detail = attachment.kind === 'link'
    ? '网页链接'
    : `${attachment.kind === 'image' ? '图片' : '文件'} · ${formatAttachmentBytes(attachment.sizeBytes)}`;
  return `
    <article class="composer-attachment-chip ${escapeHtml(attachment.kind)}" role="listitem" title="${escapeHtml(attachment.name)}">
      <i aria-hidden="true">${glyph}</i>
      <span><strong>${escapeHtml(attachment.name)}</strong><small>${escapeHtml(detail)}</small></span>
      <button type="button" data-remove-attachment="${escapeHtml(attachment.attachmentId)}" aria-label="移除 ${escapeHtml(attachment.name)}">×</button>
    </article>`;
}

function formatAttachmentBytes(value) {
  if (value < 1_024) return `${value} B`;
  if (value < 1_048_576) return `${Math.max(0.1, value / 1_024).toFixed(1)} KB`;
  return `${(value / 1_048_576).toFixed(1)} MB`;
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
      <div><b>${role === 'user' ? '你' : escapeHtml(displayName)}</b><div class="conversation-message-body">${renderConversationText(message?.text || '')}</div></div>
    </article>`;
}

function renderConversationText(value) {
  const lines = String(value || '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let paragraph = [];
  let list = [];
  const flushParagraph = () => {
    if (!paragraph.length) return;
    blocks.push(`<p>${paragraph.map(renderConversationInline).join('<br>')}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (!list.length) return;
    blocks.push(`<ul>${list.map((item) => `<li>${renderConversationInline(item)}</li>`).join('')}</ul>`);
    list = [];
  };
  for (const line of lines) {
    const item = line.match(/^\s*[-*]\s+(.+)$/u);
    if (item) {
      flushParagraph();
      list.push(item[1]);
      continue;
    }
    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }
    flushList();
    paragraph.push(line);
  }
  flushParagraph();
  flushList();
  return blocks.join('') || '<p></p>';
}

function renderConversationInline(value) {
  return escapeHtml(value)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
}

function wireConversation() {
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
  const formDraftKey = conversationDraftKey(
    form?.dataset.accountId,
    form?.dataset.agentId,
    form?.dataset.sessionKey,
  );
  const restoredDraft = conversationDrafts.get(formDraftKey) || '';
  if (form?.elements.message && restoredDraft) form.elements.message.value = restoredDraft;
  const textarea = form?.elements.message;
  const sendButton = form?.querySelector('.composer-send');
  const addButton = form?.querySelector('#composer-add-button');
  const toolMenu = form?.querySelector('#composer-tool-menu');
  const intentToggle = form?.querySelector('.composer-intent-toggle');
  const intentMenu = form?.querySelector('.composer-intent-menu');
  const linkEntry = form?.querySelector('#composer-link-entry');
  const linkInput = form?.elements.attachmentLink;
  const suggestionBox = form?.querySelector('#composer-suggestions');
  const dictationButton = form?.querySelector('.composer-dictation-button');
  const attachmentIds = safeConversationDraftAttachments(conversationUi.draftAttachments)
    .map((attachment) => attachment.attachmentId);
  const queue = safeConversationQueue(conversationUi.queue);
  const composerEnabled = form?.dataset.composerEnabled === 'true';
  const composerIntent = String(form?.dataset.composerMode || 'send');
  const interjectMode = composerIntent === 'adjust';
  const sendNowMode = composerIntent === 'now';
  const promptAttachmentIds = interjectMode ? [] : attachmentIds;
  const pasteCards = formDraftKey ? (conversationPasteCards.get(formDraftKey) || []) : [];
  const interjectionKey = form
    ? conversationPendingKey(form.dataset.accountId, form.dataset.agentId)
    : '';
  let suggestionRequestRevision = 0;
  let suggestionDebounce = null;
  let handleDictationPanelClose = null;
  let suggestionState = {
    mode: null,
    title: '',
    hint: '',
    items: [],
    selected: 0,
    token: null,
    loading: false,
    error: null,
    statusText: '',
  };
  const composerRequestIsCurrent = (revision) => (
    revision === suggestionRequestRevision
    && form?.isConnected === true
    && currentState.phase === 'ready'
    && String(readyAccountId || '') === form.dataset.accountId
    && agentManagementUi.agentId === form.dataset.agentId
    && conversationUi.agentId === form.dataset.agentId
  );
  const rememberTextarea = () => {
    if (!formDraftKey || !textarea) return;
    if (textarea.value) conversationDrafts.set(formDraftKey, textarea.value);
    else conversationDrafts.delete(formDraftKey);
    updateSendState();
  };
  const closeSuggestions = () => {
    suggestionRequestRevision += 1;
    if (suggestionDebounce) clearTimeout(suggestionDebounce);
    suggestionDebounce = null;
    suggestionState = {
      mode: null,
      title: '',
      hint: '',
      items: [],
      selected: 0,
      token: null,
      loading: false,
      error: null,
      statusText: '',
    };
    if (suggestionBox) {
      suggestionBox.hidden = true;
      suggestionBox.innerHTML = '';
    }
    textarea?.removeAttribute('aria-activedescendant');
    textarea?.setAttribute('aria-expanded', 'false');
  };
  const renderSuggestions = () => {
    if (!suggestionBox || !suggestionState.mode) return;
    const items = suggestionState.items;
    const body = suggestionState.loading
      ? `<div class="composer-suggestion-status"><i></i><span>${escapeHtml(suggestionState.statusText || '正在读取可用内容…')}</span></div>`
      : suggestionState.error
        ? `<div class="composer-suggestion-status error"><span>${escapeHtml(suggestionState.error)}</span></div>`
        : items.length
          ? items.map((item, index) => `
            <button
              type="button"
              role="option"
              id="composer-suggestion-${index}"
              class="composer-suggestion-item ${index === suggestionState.selected ? 'selected' : ''}"
              aria-selected="${index === suggestionState.selected}"
              data-composer-suggestion="${index}"
            >
              <i aria-hidden="true">${escapeHtml(item.glyph || '·')}</i>
              <span><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.detail || '')}</small></span>
              ${item.actionLabel ? `<b>${escapeHtml(item.actionLabel)}</b>` : ''}
            </button>`).join('')
          : '<div class="composer-suggestion-status"><span>没有找到匹配内容</span></div>';
    suggestionBox.innerHTML = `
      <header class="composer-suggestion-header">
        <span><strong>${escapeHtml(suggestionState.title)}</strong><small>${escapeHtml(suggestionState.hint)}</small></span>
        <button type="button" data-close-composer-suggestions aria-label="关闭">×</button>
      </header>
      <div class="composer-suggestion-list">${body}</div>`;
    suggestionBox.hidden = false;
    textarea?.setAttribute('aria-expanded', 'true');
    if (items.length) {
      textarea?.setAttribute('aria-activedescendant', `composer-suggestion-${suggestionState.selected}`);
    } else {
      textarea?.removeAttribute('aria-activedescendant');
    }
    suggestionBox.querySelector('[data-close-composer-suggestions]')?.addEventListener('click', () => {
      if (suggestionState.mode === 'dictation' && handleDictationPanelClose) {
        handleDictationPanelClose();
        return;
      }
      closeSuggestions();
      textarea?.focus();
    });
    for (const button of suggestionBox.querySelectorAll('[data-composer-suggestion]')) {
      button.addEventListener('pointerdown', (event) => event.preventDefault());
      button.addEventListener('click', () => {
        selectSuggestion(Number(button.dataset.composerSuggestion));
      });
    }
  };
  const setSuggestionState = (next) => {
    suggestionState = {
      ...suggestionState,
      ...next,
      selected: Math.min(
        Math.max(0, Number(next.selected ?? suggestionState.selected) || 0),
        Math.max(0, (next.items ?? suggestionState.items).length - 1),
      ),
    };
    renderSuggestions();
  };
  const replaceComposerToken = (text, token = suggestionState.token) => {
    if (!textarea) return false;
    const value = String(textarea.value || '');
    const start = token ? token.start : textarea.selectionStart;
    const end = token ? token.end : textarea.selectionEnd;
    const next = `${value.slice(0, start)}${text}${value.slice(end)}`;
    const pasteLength = (conversationPasteCards.get(formDraftKey) || [])
      .reduce((sum, card) => sum + Array.from(String(card.text || '')).length, 0);
    if (Array.from(next).length + pasteLength > 16_000) {
      if (formDraftKey) conversationAttachmentErrors.set(formDraftKey, '当前输入与粘贴内容合计不能超过 16000 字');
      closeSuggestions();
      if (currentState.phase === 'ready') renderReady(currentState);
      return false;
    }
    textarea.value = next;
    const cursor = start + text.length;
    textarea.setSelectionRange(cursor, cursor);
    rememberTextarea();
    return true;
  };
  const openWorkspaceManager = async () => {
    const revision = ++suggestionRequestRevision;
    setSuggestionState({
      mode: 'workspaces',
      title: '当前 Agent 的工作文件夹',
      hint: '只显示文件夹名称，不会暴露本机完整路径',
      token: null,
      items: [],
      loading: true,
      error: null,
    });
    try {
      const value = await bridge.getConversationWorkspaces();
      if (!composerRequestIsCurrent(revision)) return;
      const projection = safeConversationWorkspaceProjection({ ...value, files: [] }, form.dataset.agentId);
      setSuggestionState({
        loading: false,
        items: [
          ...projection.workspaces.map((workspace) => ({
            glyph: '@',
            title: workspace.displayName,
            detail: '已允许当前 Agent 引用此文件夹中的受支持文件',
            actionLabel: '取消授权',
            action: 'revoke_workspace',
            workspaceId: workspace.workspaceId,
          })),
          {
            glyph: '+',
            title: '授权另一个工作文件夹',
            detail: '由 macOS 文件夹选择器确认，授权只属于当前 Agent',
            actionLabel: '选择',
            action: 'authorize_workspace',
          },
        ],
      });
    } catch (error) {
      if (revision === suggestionRequestRevision) {
        setSuggestionState({ loading: false, error: publicError(error, '暂时无法读取工作文件夹') });
      }
    }
  };
  const openPromptHistory = async (query = '') => {
    const revision = ++suggestionRequestRevision;
    setSuggestionState({
      mode: 'history',
      title: '历史消息',
      hint: '选择后只会放回输入框，不会自动发送',
      token: null,
      items: [],
      loading: true,
      error: null,
    });
    try {
      const value = await bridge.searchConversationPromptHistory(query);
      if (!composerRequestIsCurrent(revision)) return;
      const history = safeConversationHistoryProjection(value, form.dataset.agentId);
      setSuggestionState({
        loading: false,
        items: history.map((entry) => ({
          glyph: '↺',
          title: entry.preview,
          detail: '插入到输入框，仍需你确认发送',
          action: 'history',
          historyId: entry.historyId,
        })),
      });
    } catch (error) {
      if (revision === suggestionRequestRevision) {
        setSuggestionState({ loading: false, error: publicError(error, '暂时无法读取历史消息') });
      }
    }
  };
  const loadTriggeredSuggestions = async (token) => {
    const revision = ++suggestionRequestRevision;
    const meta = token.kind === 'command'
      ? ['命令', '选择后会插入输入框，不会自动执行']
      : token.kind === 'skill'
        ? ['当前 Agent 的 Skill', '选择后会插入可编辑要求，不会自动发送']
        : ['工作文件', '只搜索你明确授权给当前 Agent 的文件夹'];
    setSuggestionState({
      mode: token.kind,
      title: meta[0],
      hint: meta[1],
      token,
      items: [],
      loading: true,
      error: null,
    });
    try {
      if (token.kind === 'command' || token.kind === 'skill') {
        let capabilities = conversationInputCapabilities.get(formDraftKey);
        if (!capabilities) {
          capabilities = safeConversationInputCapabilities(
            await bridge.getConversationInputCapabilities(),
            form.dataset.agentId,
          );
          if (!capabilities) throw new Error('输入能力清单无效');
        }
        if (!composerRequestIsCurrent(revision)) return;
        const cached = conversationInputCapabilities.get(formDraftKey);
        if (!cached || capabilities.revision >= cached.revision) {
          conversationInputCapabilities.set(formDraftKey, capabilities);
        } else {
          capabilities = cached;
        }
        const source = token.kind === 'command' ? capabilities.commands : capabilities.skills;
        const query = token.query.normalize('NFKC').toLocaleLowerCase('zh-CN');
        const items = source.filter((item) => (
          !query
          || `${item.trigger} ${item.displayName} ${item.description}`
            .normalize('NFKC')
            .toLocaleLowerCase('zh-CN')
            .includes(query)
        )).map((item) => ({
          glyph: token.kind === 'command' ? '/' : '$',
          title: `${item.trigger} · ${item.displayName}`,
          detail: item.description,
          action: 'insert',
          insertText: item.insertText,
        }));
        setSuggestionState({ loading: false, items });
        return;
      }
      const value = await bridge.searchConversationWorkspaceFiles({ query: token.query });
      if (!composerRequestIsCurrent(revision)) return;
      const projection = safeConversationWorkspaceProjection(value, form.dataset.agentId);
      const items = projection.workspaces.length
        ? projection.files.map((file) => ({
          glyph: '文',
          title: file.name,
          detail: `${file.workspaceName || '工作文件夹'} · ${file.displayPath}`,
          action: 'file',
          workspaceId: file.workspaceId,
          relativePath: file.relativePath,
        }))
        : [{
          glyph: '+',
          title: '先授权一个工作文件夹',
          detail: '授权后，@ 只会搜索该文件夹中的受支持文件',
          actionLabel: '选择',
          action: 'authorize_workspace',
        }];
      setSuggestionState({ loading: false, items });
    } catch (error) {
      if (revision === suggestionRequestRevision) {
        setSuggestionState({ loading: false, error: publicError(error, '暂时无法读取输入建议') });
      }
    }
  };
  const refreshTriggeredSuggestions = () => {
    if (!textarea || !composerEnabled) return;
    const token = composerTriggerAtCursor(textarea);
    if (!token) {
      if (['command', 'skill', 'file', 'history', 'workspaces'].includes(suggestionState.mode)) {
        closeSuggestions();
      }
      return;
    }
    if (suggestionDebounce) clearTimeout(suggestionDebounce);
    const delay = token.kind === 'file' ? 180 : 0;
    suggestionDebounce = setTimeout(() => {
      suggestionDebounce = null;
      loadTriggeredSuggestions(token);
    }, delay);
  };
  let dictationDisclosureVisible = false;
  let dictationOperationInFlight = false;
  const dictationBelongsToComposer = (state) => (
    state?.agentId === form?.dataset.agentId
  );
  const setDictationButtonState = (state) => {
    if (!dictationButton) return;
    const active = dictationBelongsToComposer(state)
      && ['starting', 'listening', 'transcribing'].includes(state.phase);
    dictationButton.setAttribute('aria-pressed', active ? 'true' : 'false');
    dictationButton.setAttribute('aria-label', active ? '管理本机听写' : '本机听写');
    dictationButton.title = active ? '管理本机听写' : '本机听写';
  };
  const showDictationDisclosure = (state = conversationDictationUi) => {
    dictationDisclosureVisible = true;
    setSuggestionState({
      mode: 'dictation',
      title: 'macOS 本机听写',
      hint: state?.disclosure || '语音只在这台 Mac 上转换为文字，不会上传到 AgentMesh360；听写结果只会放入输入框，不会自动发送。',
      token: null,
      items: [{
        glyph: '◉',
        title: '开始听写',
        detail: `最长 ${state?.limits?.maxDurationSeconds || 60} 秒；识别结果只会放入输入框`,
        actionLabel: '开始',
        action: 'start_dictation',
      }],
      loading: false,
      error: null,
      statusText: '',
      selected: 0,
    });
  };
  const showDictationError = (state) => {
    dictationDisclosureVisible = false;
    const setupRequired = [
      'dictation_language_unavailable',
      'dictation_on_device_unavailable',
    ].includes(state?.error?.code);
    const permissionRequired = [
      'microphone_permission_denied',
      'speech_recognition_permission_denied',
      'speech_recognition_restricted',
    ].includes(state?.error?.code);
    setSuggestionState({
      mode: 'dictation',
      title: setupRequired ? '需要先开启本机听写' : '听写没有完成',
      hint: state?.error?.message || '听写服务暂时不可用，请稍后重试。',
      token: null,
      items: [{
        glyph: setupRequired || permissionRequired ? '设' : '↻',
        title: setupRequired ? '开启 macOS 听写后重试' : '重新开始听写',
        detail: setupRequired
          ? '前往“系统设置 → 键盘 → 听写”，启用并下载当前语言'
          : permissionRequired
            ? '请在“系统设置 → 隐私与安全性”中允许 AgentMesh360'
            : '重新确认说明后，再次请求麦克风',
        actionLabel: '重试',
        action: 'show_dictation_disclosure',
      }],
      loading: false,
      error: null,
      statusText: '',
      selected: 0,
    });
  };
  const insertDictationTranscript = (state) => {
    const transcriptText = String(state?.transcript || '').trim();
    if (!textarea || !transcriptText) return false;
    const key = `${form?.dataset.accountId || ''}:${form?.dataset.agentId || ''}:${state.revision}`;
    if (conversationDictationApplied.has(key)) return true;
    const value = String(textarea.value || '');
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const before = value.slice(0, start);
    const after = value.slice(end);
    const leading = before && !/\s$/u.test(before) ? ' ' : '';
    const trailing = after && !/^\s/u.test(after) ? ' ' : '';
    const insertion = `${leading}${transcriptText}${trailing}`;
    const next = `${before}${insertion}${after}`;
    const pasteLength = (conversationPasteCards.get(formDraftKey) || [])
      .reduce((sum, card) => sum + Array.from(String(card.text || '')).length, 0);
    if (Array.from(next).length + pasteLength > 16_000) {
      setSuggestionState({
        mode: 'dictation',
        title: '输入框空间不足',
        hint: '先缩短当前输入或移除一段粘贴内容，再插入这次听写结果。',
        token: null,
        items: [{
          glyph: '文',
          title: '再次插入听写结果',
          detail: '只会回填输入框，不会自动发送',
          actionLabel: '重试',
          action: 'insert_dictation_transcript',
        }],
        loading: false,
        error: null,
        statusText: '',
      });
      return false;
    }
    textarea.value = next;
    const cursor = start + insertion.length;
    textarea.setSelectionRange(cursor, cursor);
    rememberTextarea();
    conversationDictationApplied.add(key);
    closeSuggestions();
    textarea.focus();
    bridge.closeConversationDictation?.().catch(() => {});
    return true;
  };
  const showDictationState = (state) => {
    const projected = safeConversationDictationSnapshot(state);
    if (!projected || !dictationBelongsToComposer(projected)) {
      setDictationButtonState(projected);
      return;
    }
    conversationDictationUi = projected;
    setDictationButtonState(projected);
    if (projected.phase === 'complete') {
      insertDictationTranscript(projected);
      return;
    }
    if (projected.phase === 'error') {
      showDictationError(projected);
      return;
    }
    if (projected.phase === 'starting' || projected.phase === 'transcribing') {
      dictationDisclosureVisible = false;
      setSuggestionState({
        mode: 'dictation',
        title: projected.phase === 'starting' ? '正在准备听写' : '正在生成文字',
        hint: projected.service?.displayName
          ? `由 ${projected.service.displayName} 转写；语音不会上传到 AgentMesh360`
          : '语音只在本机转换为文字，结果不会自动发送',
        token: null,
        items: [],
        loading: true,
        error: null,
        statusText: projected.phase === 'starting' ? '正在请求麦克风…' : '正在把语音转换为文字…',
      });
      return;
    }
    if (projected.phase === 'listening') {
      dictationDisclosureVisible = false;
      setSuggestionState({
        mode: 'dictation',
        title: '正在听写',
        hint: projected.interimText || `最长 ${projected.limits.maxDurationSeconds} 秒；完成后仍需你确认发送`,
        token: null,
        items: [
          {
            glyph: '✓',
            title: '完成听写',
            detail: '停止录音并把识别结果放入输入框',
            actionLabel: '完成',
            action: 'stop_dictation',
          },
          {
            glyph: '×',
            title: '取消本次听写',
            detail: '丢弃本次录音，不改变输入框',
            actionLabel: '取消',
            action: 'cancel_dictation',
          },
        ],
        loading: false,
        error: null,
        statusText: '',
        selected: 0,
      });
      return;
    }
    if (projected.phase === 'idle') {
      if (dictationDisclosureVisible) showDictationDisclosure(projected);
      else if (suggestionState.mode === 'dictation') closeSuggestions();
    }
  };
  const runDictationOperation = async (operation, fallback) => {
    if (dictationOperationInFlight) return;
    dictationOperationInFlight = true;
    if (dictationButton) dictationButton.disabled = true;
    try {
      const state = await operation();
      const projected = safeConversationDictationSnapshot(state);
      if (projected) showDictationState(projected);
    } catch (error) {
      if (conversationDictationUi.phase !== 'error') {
        showDictationError({
          error: { code: 'dictation_failed', message: publicError(error, fallback) },
        });
      }
    } finally {
      dictationOperationInFlight = false;
      if (dictationButton) dictationButton.disabled = !composerEnabled;
    }
  };
  handleDictationPanelClose = () => {
    if (dictationOperationInFlight) return;
    if (
      dictationBelongsToComposer(conversationDictationUi)
      && ['starting', 'listening', 'transcribing'].includes(conversationDictationUi.phase)
    ) {
      runDictationOperation(
        () => bridge.cancelConversationDictation(),
        '没有成功取消听写',
      );
      return;
    }
    dictationDisclosureVisible = false;
    closeSuggestions();
    textarea?.focus();
  };
  const selectSuggestion = async (index) => {
    const item = suggestionState.items[index];
    if (!item) return;
    if (item.action === 'insert') {
      if (replaceComposerToken(item.insertText)) closeSuggestions();
      textarea?.focus();
      return;
    }
    if (item.action === 'file') {
      const token = suggestionState.token;
      if (token) replaceComposerToken('', token);
      closeSuggestions();
      await runAttachmentMutation(
        () => bridge.stageConversationWorkspaceFile({
          workspaceId: item.workspaceId,
          relativePath: item.relativePath,
        }),
        '没有成功添加这个工作文件',
        { queueOnRunning: true },
      );
      return;
    }
    if (item.action === 'history') {
      const revision = ++suggestionRequestRevision;
      try {
        const selected = await bridge.selectConversationPromptHistory(item.historyId);
        if (!composerRequestIsCurrent(revision) || typeof selected?.text !== 'string') return;
        const text = selected.text;
        if (Array.from(text).length > 16_000 || /[\u0000-\u001F\u007F-\u009F]/u.test(text)) {
          throw new Error('历史消息内容无效');
        }
        if (replaceComposerToken(text, null)) closeSuggestions();
        textarea?.focus();
      } catch (error) {
        if (revision === suggestionRequestRevision) {
          setSuggestionState({ error: publicError(error, '没有成功取回历史消息'), loading: false });
        }
      }
      return;
    }
    if (item.action === 'show_dictation_disclosure') {
      showDictationDisclosure(conversationDictationUi);
      return;
    }
    if (item.action === 'start_dictation') {
      dictationDisclosureVisible = false;
      setSuggestionState({
        mode: 'dictation',
        title: '正在准备听写',
        hint: '语音只在本机转换为文字，听写结果只会放入当前输入框',
        token: null,
        items: [],
        loading: true,
        error: null,
        statusText: '正在请求麦克风…',
      });
      await runDictationOperation(
        () => bridge.startConversationDictation(true),
        '没有成功开始听写',
      );
      return;
    }
    if (item.action === 'stop_dictation') {
      await runDictationOperation(
        () => bridge.stopConversationDictation(),
        '没有成功完成听写',
      );
      return;
    }
    if (item.action === 'cancel_dictation') {
      await runDictationOperation(
        () => bridge.cancelConversationDictation(),
        '没有成功取消听写',
      );
      return;
    }
    if (item.action === 'insert_dictation_transcript') {
      insertDictationTranscript(conversationDictationUi);
      return;
    }
    if (item.action === 'authorize_workspace') {
      const revision = ++suggestionRequestRevision;
      setSuggestionState({ loading: true, items: [], error: null });
      try {
        await bridge.authorizeConversationWorkspace();
        if (!composerRequestIsCurrent(revision)) return;
        await openWorkspaceManager();
      } catch (error) {
        if (revision === suggestionRequestRevision) {
          setSuggestionState({ loading: false, error: publicError(error, '没有成功授权工作文件夹') });
        }
      }
      return;
    }
    if (item.action === 'revoke_workspace') {
      const revision = ++suggestionRequestRevision;
      setSuggestionState({ loading: true, items: [], error: null });
      try {
        await bridge.revokeConversationWorkspace(item.workspaceId);
        if (!composerRequestIsCurrent(revision)) return;
        await openWorkspaceManager();
      } catch (error) {
        if (revision === suggestionRequestRevision) {
          setSuggestionState({ loading: false, error: publicError(error, '没有成功取消文件夹授权') });
        }
      }
    }
  };
  const updateSendState = () => {
    if (!sendButton) return;
    sendButton.disabled = !composerEnabled
      || conversationAttachmentMutationInFlight
      || (interjectMode && conversationInterjectionPending.has(interjectionKey))
      || (!String(textarea?.value || '').trim()
        && promptAttachmentIds.length === 0
        && pasteCards.length === 0);
  };
  const applyConversationState = (state) => {
    if (!state || state.agentId !== form?.dataset.agentId) return false;
    conversationUi = state;
    trackConversationStreamingState(state);
    return true;
  };
  const runQueueMutation = async (operation, fallback) => {
    if (!form || conversationQueueMutationInFlight) return;
    conversationQueueMutationInFlight = true;
    try {
      applyConversationState(await operation());
    } catch (error) {
      conversationUi = { ...conversationUi, error: publicError(error, fallback) };
    } finally {
      conversationQueueMutationInFlight = false;
      if (currentState.phase === 'ready') renderReady(currentState);
    }
  };
  const runCancelMutation = async () => {
    const agentId = form?.dataset.agentId;
    const accountId = form?.dataset.accountId;
    const cancellationRegistry = conversationCancellationInFlight;
    if (!form || !agentId || !accountId || cancellationRegistry.has(agentId)) return;
    cancellationRegistry.add(agentId);
    conversationUi = { ...conversationUi, cancelling: true, error: null };
    if (currentState.phase === 'ready') renderReady(currentState);
    try {
      const nextState = await bridge.cancelCurrentConversationTask();
      if (readyAccountId === accountId && agentManagementUi.agentId === agentId) {
        applyConversationState(nextState);
      }
    } catch (error) {
      if (readyAccountId === accountId && agentManagementUi.agentId === agentId) {
        conversationUi = {
          ...conversationUi,
          cancelling: false,
          error: publicError(error, '没有成功停止当前任务'),
        };
      }
    } finally {
      cancellationRegistry.delete(agentId);
      if (currentState.phase === 'ready') renderReady(currentState);
    }
  };
  const closeToolMenu = () => {
    if (!toolMenu || !addButton) return;
    toolMenu.hidden = true;
    addButton.setAttribute('aria-expanded', 'false');
  };
  const closeIntentMenu = () => {
    if (!intentMenu || !intentToggle) return;
    intentMenu.hidden = true;
    intentToggle.setAttribute('aria-expanded', 'false');
  };
  const showAttachmentError = (error, fallback) => {
    if (formDraftKey) {
      conversationAttachmentErrors.set(formDraftKey, publicError(error, fallback));
    }
  };
  const applyAttachmentState = (state) => {
    if (!state || state.agentId !== form?.dataset.agentId) return false;
    conversationUi = state;
    if (formDraftKey) conversationAttachmentErrors.delete(formDraftKey);
    return true;
  };
  const restoreIntentBeforeAutomaticQueue = () => {
    if (!formDraftKey || !conversationAttachmentAutoQueuePrevious.has(formDraftKey)) return;
    const previousIntent = conversationAttachmentAutoQueuePrevious.get(formDraftKey);
    if (previousIntent) conversationComposerIntents.set(formDraftKey, previousIntent);
    else conversationComposerIntents.delete(formDraftKey);
    conversationAttachmentAutoQueuePrevious.delete(formDraftKey);
  };
  const runAttachmentMutation = async (operation, fallback, { queueOnRunning = false } = {}) => {
    if (!form || !composerEnabled || conversationAttachmentMutationInFlight) return;
    const automaticQueue = Boolean(
      queueOnRunning
      && conversationTurnIsRunning(form.dataset.agentId)
      && formDraftKey,
    );
    if (automaticQueue) {
      if (!conversationAttachmentAutoQueuePrevious.has(formDraftKey)) {
        conversationAttachmentAutoQueuePrevious.set(
          formDraftKey,
          conversationComposerIntents.get(formDraftKey) || null,
        );
      }
      conversationComposerIntents.set(formDraftKey, 'queue');
    }
    conversationAttachmentMutationInFlight = true;
    form.classList.add('attachment-busy');
    updateSendState();
    let nextState = null;
    let succeeded = false;
    try {
      nextState = await operation();
      succeeded = applyAttachmentState(nextState);
    } catch (error) {
      showAttachmentError(error, fallback);
    } finally {
      const remainingAttachments = safeConversationDraftAttachments(nextState?.draftAttachments).length;
      if (
        formDraftKey
        && conversationAttachmentAutoQueuePrevious.has(formDraftKey)
        && ((!succeeded && automaticQueue) || (succeeded && remainingAttachments === 0))
      ) {
        restoreIntentBeforeAutomaticQueue();
      }
      conversationAttachmentMutationInFlight = false;
      if (currentState.phase === 'ready') renderReady(currentState);
    }
  };
  document.querySelector('[data-toggle-queue]')?.addEventListener('click', () => {
    if (!formDraftKey) return;
    if (conversationQueueExpanded.has(formDraftKey)) conversationQueueExpanded.delete(formDraftKey);
    else conversationQueueExpanded.add(formDraftKey);
    if (currentState.phase === 'ready') renderReady(currentState);
  });
  for (const button of document.querySelectorAll('[data-queue-up], [data-queue-down]')) {
    button.addEventListener('click', () => {
      const queueId = button.dataset.queueUp || button.dataset.queueDown;
      const index = queue.entries.findIndex((entry) => entry.queueId === queueId);
      const direction = button.dataset.queueUp ? -1 : 1;
      const target = index + direction;
      if (index < 0 || target < 0 || target >= queue.entries.length) return;
      const orderedIds = queue.entries.map((entry) => entry.queueId);
      [orderedIds[index], orderedIds[target]] = [orderedIds[target], orderedIds[index]];
      runQueueMutation(
        () => bridge.reorderQueuedConversationMessages(orderedIds),
        '没有成功调整待处理顺序',
      );
    });
  }
  for (const button of document.querySelectorAll('[data-queue-remove]')) {
    button.addEventListener('click', () => runQueueMutation(
      () => bridge.removeQueuedConversationMessage(button.dataset.queueRemove),
      '没有成功删除待处理消息',
    ));
  }
  for (const button of document.querySelectorAll('[data-queue-now]')) {
    button.addEventListener('click', () => runQueueMutation(
      () => bridge.sendQueuedConversationMessageNow(button.dataset.queueNow),
      '没有成功立即执行这条消息',
    ));
  }
  document.querySelector('[data-queue-clear]')?.addEventListener('click', () => runQueueMutation(
    () => bridge.clearQueuedConversationMessages(),
    '没有成功清空待处理消息',
  ));
  for (const button of document.querySelectorAll('[data-queue-edit]')) {
    button.addEventListener('click', () => {
      if (!formDraftKey) return;
      conversationQueueEditing.set(formDraftKey, button.dataset.queueEdit);
      if (currentState.phase === 'ready') renderReady(currentState);
      setTimeout(() => document.querySelector('.queue-edit-input')?.focus(), 0);
    });
  }
  for (const button of document.querySelectorAll('[data-queue-cancel-edit]')) {
    button.addEventListener('click', () => {
      if (formDraftKey) conversationQueueEditing.delete(formDraftKey);
      if (currentState.phase === 'ready') renderReady(currentState);
    });
  }
  for (const button of document.querySelectorAll('[data-queue-save]')) {
    button.addEventListener('click', () => {
      const text = String(button.closest('.conversation-queue-item')?.querySelector('.queue-edit-input')?.value || '').trim();
      if (!text) {
        conversationUi = { ...conversationUi, error: '待处理消息不能为空' };
        if (currentState.phase === 'ready') renderReady(currentState);
        return;
      }
      if (formDraftKey) conversationQueueEditing.delete(formDraftKey);
      runQueueMutation(
        () => bridge.editQueuedConversationMessage(button.dataset.queueSave, text),
        '没有成功编辑待处理消息',
      );
    });
  }
  addButton?.addEventListener('click', () => {
    const willOpen = toolMenu?.hidden === true;
    if (!toolMenu) return;
    toolMenu.hidden = !willOpen;
    addButton.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
    if (willOpen) {
      setTimeout(() => {
        document.addEventListener('pointerdown', (event) => {
          if (!form?.querySelector('.composer-tool-wrap')?.contains(event.target)) closeToolMenu();
        }, { once: true });
      }, 0);
    }
  });
  intentToggle?.addEventListener('click', () => {
    const willOpen = intentMenu?.hidden === true;
    if (!intentMenu) return;
    intentMenu.hidden = !willOpen;
    intentToggle.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
    if (willOpen) closeToolMenu();
  });
  for (const button of form?.querySelectorAll('[data-composer-intent]') || []) {
    button.addEventListener('click', () => {
      const nextIntent = button.dataset.composerIntent;
      if (!formDraftKey || !['adjust', 'queue', 'now'].includes(nextIntent)) return;
      if (nextIntent === 'adjust' && attachmentIds.length) {
        conversationAttachmentErrors.set(formDraftKey, '包含附件的消息需要选择“排队等待”或“立即执行”');
      } else {
        conversationComposerIntents.set(formDraftKey, nextIntent);
        conversationAttachmentAutoQueuePrevious.delete(formDraftKey);
        conversationAttachmentErrors.delete(formDraftKey);
      }
      closeIntentMenu();
      if (currentState.phase === 'ready') renderReady(currentState);
    });
  }
  form?.querySelector('.composer-stop')?.addEventListener('click', () => {
    runCancelMutation();
  });
  form?.addEventListener('focusout', () => {
    setTimeout(() => {
      if (form && !form.contains(document.activeElement)) {
        closeToolMenu();
        closeIntentMenu();
        closeSuggestions();
      }
    }, 0);
  });
  form?.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeToolMenu();
      closeIntentMenu();
      closeSuggestions();
      if (linkEntry && !linkEntry.hidden) {
        linkEntry.hidden = true;
        textarea?.focus();
      }
    }
    if (event.key === 'Enter' && event.target === linkInput) {
      event.preventDefault();
      form.querySelector('#composer-save-link')?.click();
    }
  });
  form?.querySelector('#composer-pick-files')?.addEventListener('click', () => {
    closeToolMenu();
    runAttachmentMutation(
      () => bridge.pickConversationAttachments(),
      '没有成功添加文件',
      { queueOnRunning: true },
    );
  });
  form?.querySelector('#composer-add-link')?.addEventListener('click', () => {
    closeToolMenu();
    if (!linkEntry) return;
    linkEntry.hidden = false;
    linkInput?.focus();
  });
  form?.querySelector('#composer-authorize-workspace')?.addEventListener('click', () => {
    closeToolMenu();
    openWorkspaceManager();
  });
  form?.querySelector('#composer-prompt-history')?.addEventListener('click', () => {
    closeToolMenu();
    openPromptHistory();
  });
  dictationButton?.addEventListener('click', () => {
    closeToolMenu();
    closeIntentMenu();
    if (
      dictationBelongsToComposer(conversationDictationUi)
      && ['starting', 'listening', 'transcribing', 'complete', 'error'].includes(conversationDictationUi.phase)
    ) {
      showDictationState(conversationDictationUi);
      return;
    }
    showDictationDisclosure(conversationDictationUi);
    runDictationOperation(
      () => bridge.openConversationDictation(),
      '暂时无法打开本机听写',
    );
  });
  form?.querySelector('#composer-cancel-link')?.addEventListener('click', () => {
    if (!linkEntry) return;
    linkEntry.hidden = true;
    if (linkInput) linkInput.value = '';
    textarea?.focus();
  });
  form?.querySelector('#composer-save-link')?.addEventListener('click', () => {
    const url = String(linkInput?.value || '').trim();
    if (!url) {
      showAttachmentError(new Error('请输入完整链接'), '链接无效');
      if (currentState.phase === 'ready') renderReady(currentState);
      return;
    }
    runAttachmentMutation(
      () => bridge.stageConversationLink(url),
      '没有成功添加链接',
      { queueOnRunning: true },
    );
  });
  for (const button of form?.querySelectorAll('[data-remove-attachment]') || []) {
    button.addEventListener('click', () => {
      runAttachmentMutation(
        () => bridge.discardConversationAttachment(button.dataset.removeAttachment),
        '没有成功移除附件',
      );
    });
  }
  for (const button of form?.querySelectorAll('[data-toggle-paste]') || []) {
    button.addEventListener('click', () => {
      const id = button.dataset.togglePaste;
      if (conversationPasteExpanded.has(id)) conversationPasteExpanded.delete(id);
      else conversationPasteExpanded.add(id);
      if (currentState.phase === 'ready') renderReady(currentState);
    });
  }
  for (const button of form?.querySelectorAll('[data-remove-paste]') || []) {
    button.addEventListener('click', () => {
      if (!formDraftKey) return;
      const id = button.dataset.removePaste;
      const next = (conversationPasteCards.get(formDraftKey) || [])
        .filter((card) => card.id !== id);
      if (next.length) conversationPasteCards.set(formDraftKey, next);
      else conversationPasteCards.delete(formDraftKey);
      conversationPasteExpanded.delete(id);
      if (currentState.phase === 'ready') renderReady(currentState);
    });
  }
  for (const editor of form?.querySelectorAll('[data-edit-paste]') || []) {
    editor.addEventListener('input', () => {
      if (!formDraftKey) return;
      const cards = conversationPasteCards.get(formDraftKey) || [];
      const card = cards.find((candidate) => candidate.id === editor.dataset.editPaste);
      if (card) card.text = String(editor.value || '').slice(0, 16_000);
      updateSendState();
    });
  }
  const stageDroppedFiles = (files) => {
    if (!files?.length) return;
    runAttachmentMutation(
      () => bridge.stageConversationFiles(files),
      '没有成功添加文件',
      { queueOnRunning: true },
    );
  };
  form?.addEventListener('dragenter', (event) => {
    if (!event.dataTransfer?.types?.includes('Files')) return;
    event.preventDefault();
    form.classList.add('drag-active');
  });
  form?.addEventListener('dragover', (event) => {
    if (!event.dataTransfer?.types?.includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    form.classList.add('drag-active');
  });
  form?.addEventListener('dragleave', (event) => {
    if (!form.contains(event.relatedTarget)) form.classList.remove('drag-active');
  });
  form?.addEventListener('drop', (event) => {
    form.classList.remove('drag-active');
    const files = Array.from(event.dataTransfer?.files || []);
    if (!files.length) return;
    event.preventDefault();
    stageDroppedFiles(files);
  });
  textarea?.addEventListener('paste', (event) => {
    const files = Array.from(event.clipboardData?.files || []);
    if (files.length) {
      event.preventDefault();
      stageDroppedFiles(files);
      return;
    }
    const pastedText = String(event.clipboardData?.getData('text/plain') || '');
    const pastedLines = pastedText.split(/\r?\n/u).length;
    if (Array.from(pastedText).length < 1_200 && pastedLines < 20) return;
    event.preventDefault();
    if (!formDraftKey) return;
    const existingCards = conversationPasteCards.get(formDraftKey) || [];
    const totalCodePoints = existingCards.reduce(
      (sum, card) => sum + Array.from(card.text).length,
      Array.from(String(textarea?.value || '')).length,
    );
    if (existingCards.length >= 4 || totalCodePoints + Array.from(pastedText).length > 16_000) {
      conversationAttachmentErrors.set(formDraftKey, '单条消息最多保留 4 段粘贴内容，合计不能超过 16000 字');
      if (currentState.phase === 'ready') renderReady(currentState);
      return;
    }
    const card = {
      id: `paste-${crypto.randomUUID()}`,
      text: pastedText,
    };
    conversationPasteCards.set(formDraftKey, [...existingCards, card]);
    conversationAttachmentErrors.delete(formDraftKey);
    if (currentState.phase === 'ready') renderReady(currentState);
  });
  form?.elements.message?.addEventListener('input', (event) => {
    if (!formDraftKey) return;
    const value = String(event.currentTarget.value || '');
    if (value) conversationDrafts.set(formDraftKey, value);
    else conversationDrafts.delete(formDraftKey);
    if (
      conversationAttachmentErrors.get(formDraftKey)
      === '此命令未获客户端允许。请从“/”菜单选择可用命令。'
      && !unsafeComposerSlashCommand(value)
    ) {
      conversationAttachmentErrors.delete(formDraftKey);
      form.querySelector('.composer-attachment-error')?.remove();
    }
    updateSendState();
    refreshTriggeredSuggestions();
  });
  textarea?.addEventListener('keydown', (event) => {
    if (!suggestionBox?.hidden && suggestionState.items.length) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const direction = event.key === 'ArrowDown' ? 1 : -1;
        const next = (
          suggestionState.selected
          + direction
          + suggestionState.items.length
        ) % suggestionState.items.length;
        setSuggestionState({ selected: next });
        suggestionBox.querySelector(`#composer-suggestion-${next}`)?.scrollIntoView({ block: 'nearest' });
        return;
      }
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
        event.preventDefault();
        selectSuggestion(suggestionState.selected);
        return;
      }
    }
    if (
      event.key === 'ArrowUp'
      && !event.metaKey
      && !event.ctrlKey
      && !event.altKey
      && textarea.value === ''
      && textarea.selectionStart === 0
      && suggestionBox?.hidden !== false
    ) {
      event.preventDefault();
      openPromptHistory();
      return;
    }
    if (
      event.key !== 'Enter'
      || event.shiftKey
      || event.isComposing
      || event.keyCode === 229
    ) return;
    event.preventDefault();
    form?.requestSubmit();
  });
  textarea?.addEventListener('click', refreshTriggeredSuggestions);
  textarea?.setAttribute('aria-autocomplete', 'list');
  textarea?.setAttribute('aria-controls', 'composer-suggestions');
  textarea?.setAttribute('aria-expanded', 'false');
  if (
    typeof bridge.openConversationDictation !== 'function'
    || typeof bridge.startConversationDictation !== 'function'
    || typeof bridge.stopConversationDictation !== 'function'
    || typeof bridge.cancelConversationDictation !== 'function'
  ) {
    if (dictationButton) {
      dictationButton.disabled = true;
      dictationButton.title = '当前版本暂不支持本机听写';
    }
  } else {
    activeConversationDictationSink = (state) => {
      if (!form?.isConnected || state?.agentId !== form.dataset.agentId) return;
      showDictationState(state);
    };
    if (dictationBelongsToComposer(conversationDictationUi)) {
      showDictationState(conversationDictationUi);
    } else {
      setDictationButtonState(conversationDictationUi);
    }
  }
  updateSendState();
  form?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const submittedPasteCards = formDraftKey
      ? (conversationPasteCards.get(formDraftKey) || []).map((card) => ({ ...card }))
      : [];
    const typedText = String(textarea.value || '').trim();
    const text = [
      ...submittedPasteCards.map((card) => String(card.text || '').trim()),
      typedText,
    ].filter(Boolean).join('\n\n');
    const agentId = form.dataset.agentId;
    const commandError = unsafeComposerSlashCommand(text);
    if (commandError) {
      if (formDraftKey) conversationAttachmentErrors.set(formDraftKey, commandError);
      if (currentState.phase === 'ready') renderReady(currentState);
      return;
    }
    if (
      (!text && promptAttachmentIds.length === 0)
      || !agentId
      || conversationAttachmentMutationInFlight
    ) return;
    const draftKey = formDraftKey;
    if (draftKey) conversationAttachmentAutoQueuePrevious.delete(draftKey);
    if (interjectMode) {
      if (!text || conversationInterjectionPending.has(interjectionKey)) return;
      const pendingInterjections = conversationInterjectionPending;
      pendingInterjections.add(interjectionKey);
      textarea.value = '';
      if (draftKey) conversationDrafts.delete(draftKey);
      if (draftKey) conversationPasteCards.delete(draftKey);
      if (draftKey) conversationAttachmentErrors.delete(draftKey);
      updateSendState();
      try {
        const state = await bridge.interjectConversationMessage(text);
        trackConversationStreamingState(state);
        if (
          currentState.phase === 'ready'
          && String(readyAccountId || '') === form.dataset.accountId
          && agentManagementUi.agentId === agentId
          && state?.agentId === agentId
        ) {
          conversationUi = state;
        }
      } catch (error) {
        if (draftKey && typedText) conversationDrafts.set(draftKey, typedText);
        if (draftKey && submittedPasteCards.length) {
          conversationPasteCards.set(draftKey, submittedPasteCards);
        }
        if (
          currentState.phase === 'ready'
          && String(readyAccountId || '') === form.dataset.accountId
          && agentManagementUi.agentId === agentId
        ) {
          conversationUi = {
            ...conversationUi,
            error: publicError(error, '没有成功追加这条要求'),
          };
        }
      } finally {
        pendingInterjections.delete(interjectionKey);
      }
      if (currentState.phase === 'ready') renderReady(currentState);
      return;
    }
    if (pendingConversationSend(agentId)) return;
    const mutation = {
      accountId: readyAccountId,
      agentId,
      revision: ++conversationSendRevision,
      intent: sendNowMode ? 'now' : (conversationTurnIsRunning(agentId) ? 'queue' : 'send'),
    };
    textarea.value = '';
    if (draftKey) conversationDrafts.delete(draftKey);
    if (draftKey) conversationPasteCards.delete(draftKey);
    if (draftKey) conversationAttachmentErrors.delete(draftKey);
    conversationSendPendingByAgent.set(
      conversationPendingKey(mutation.accountId, mutation.agentId),
      mutation,
    );
    conversationUi = { ...conversationUi, error: null };
    if (currentState.phase === 'ready') renderReady(currentState);
    try {
      const state = await (sendNowMode
        ? bridge.sendConversationMessageNow({
          text,
          attachmentIds: promptAttachmentIds,
        })
        : bridge.sendConversationMessage({
        text,
        attachmentIds: promptAttachmentIds,
        }));
      const mutationIsCurrent = (
        conversationSendIsCurrent(mutation)
        && state?.agentId === mutation.agentId
      );
      clearConversationSend(mutation);
      trackConversationStreamingState(state);
      if (!mutationIsCurrent) {
        if (currentState.phase === 'ready') renderReady(currentState);
        return;
      }
      conversationUi = state;
      if (draftKey) {
        if (state?.streaming === true) conversationComposerIntents.set(draftKey, 'adjust');
        else conversationComposerIntents.delete(draftKey);
      }
      if (
        state?.error
        && Number(state?.queue?.confirmingCount || 0) < 1
        && draftKey
      ) {
        if (typedText) conversationDrafts.set(draftKey, typedText);
        if (submittedPasteCards.length) conversationPasteCards.set(draftKey, submittedPasteCards);
      }
    } catch (error) {
      const mutationIsCurrent = conversationSendIsCurrent(mutation);
      clearConversationSend(mutation);
      if (!mutationIsCurrent) {
        if (currentState.phase === 'ready') renderReady(currentState);
        return;
      }
      // The pending-state render owns a fresh, intentionally empty form. Remove
      // it before restoring the failed message so captureRendererDrafts() cannot
      // overwrite the restored draft with that transient empty value.
      document.getElementById('conversation-form')?.remove();
      if (draftKey && typedText) conversationDrafts.set(draftKey, typedText);
      if (draftKey && submittedPasteCards.length) {
        conversationPasteCards.set(draftKey, submittedPasteCards);
      }
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

function loadingConversationState(agentId) {
  return {
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
}

function beginConversationOpen(agentId) {
  const revision = ++conversationOpenRevision;
  pendingConversationOpen = { agentId, revision };
  conversationUi = loadingConversationState(agentId);
  return revision;
}

function finishConversationOpen(revision) {
  if (pendingConversationOpen?.revision === revision) {
    pendingConversationOpen = null;
  }
}

function conversationOpenIsCurrent(agentId, revision) {
  return (
    revision === conversationOpenRevision
    && currentState.phase === 'ready'
    && workspaceView === 'agent-detail'
    && agentManagementUi.agentId === agentId
    && agentManagementUi.tab === 'conversation'
  );
}

function conversationSendIsCurrent(context) {
  return Boolean(
    context
    && context.revision === conversationSendRevision
    && currentState.phase === 'ready'
    && readyAccountId === context.accountId
    && agentManagementUi.agentId === context.agentId,
  );
}

function conversationPendingKey(accountId, agentId) {
  return `${String(accountId || '')}:${String(agentId || '')}`;
}

function pendingConversationSend(agentId, accountId = readyAccountId) {
  if (!accountId || !agentId) return null;
  return conversationSendPendingByAgent.get(conversationPendingKey(accountId, agentId)) || null;
}

function conversationSendOwnsPending(context) {
  return Boolean(
    context
    && pendingConversationSend(context.agentId, context.accountId)?.revision === context.revision,
  );
}

function clearConversationSend(context) {
  if (!conversationSendOwnsPending(context)) return;
  conversationSendPendingByAgent.delete(
    conversationPendingKey(context.accountId, context.agentId),
  );
  conversationStreamingAgents.delete(context.agentId);
}

function trackConversationStreamingState(state) {
  const agentId = state?.agentId;
  if (!agentId) return false;
  const wasStreaming = conversationStreamingAgents.has(agentId);
  if (state.streaming === true) conversationStreamingAgents.add(agentId);
  else conversationStreamingAgents.delete(agentId);
  return wasStreaming !== conversationStreamingAgents.has(agentId);
}

function conversationTurnIsRunning(agentId = conversationUi.agentId) {
  if (!agentId) return false;
  return Boolean(
    pendingConversationSend(agentId)
    || conversationStreamingAgents.has(agentId)
    || (conversationUi.agentId === agentId && conversationUi.streaming === true),
  );
}

async function openConversation(agentId, pendingRevision = null) {
  if (
    conversationUi.agentId === agentId
    && conversationTurnIsRunning(agentId)
  ) {
    showExistingConversation(agentId);
    return;
  }
  const requestRevision = (
    pendingRevision !== null
    && pendingConversationOpen?.agentId === agentId
    && pendingConversationOpen.revision === pendingRevision
  )
    ? pendingRevision
    : beginConversationOpen(agentId);
  agentManagementRequestRevision += 1;
  workspaceView = 'agent-detail';
  agentManagementUi = {
    ...agentManagementUi,
    agentId,
    tab: 'conversation',
  };
  conversationUi = loadingConversationState(agentId);
  renderReady(currentState);
  const skipped = Symbol('conversation-open-skipped');
  const openAttempt = conversationOpenTail
    .catch(() => undefined)
    .then(() => {
      if (!conversationOpenIsCurrent(agentId, requestRevision)) return skipped;
      return bridge.openAgentConversation(agentId);
    });
  conversationOpenTail = openAttempt.catch(() => undefined);
  try {
    const snapshot = await openAttempt;
    if (snapshot === skipped || !conversationOpenIsCurrent(agentId, requestRevision)) {
      finishConversationOpen(requestRevision);
      return;
    }
    trackConversationStreamingState(snapshot);
    conversationUi = snapshot;
    finishConversationOpen(requestRevision);
  } catch (error) {
    if (!conversationOpenIsCurrent(agentId, requestRevision)) {
      finishConversationOpen(requestRevision);
      return;
    }
    conversationUi = {
      ...conversationUi,
      phase: 'error',
      error: publicError(error, '暂时无法打开此 Agent 的主对话'),
    };
    finishConversationOpen(requestRevision);
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
        <button class="ghost package-back" id="back-from-add-agent" type="button">← 返回 Agent</button>
        <p class="eyebrow">Add Agent</p>
        <h1>添加 Agent</h1>
        <p>查看本机已经可信可用的 Agent。来源、签名和版本等技术信息只在需要时展开。</p>
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
      ${remoteAvailable ? `<div class="package-toolbar">
        <form class="package-install-form" id="package-install-form">
          <label class="field">
            <span>Agent Package ID <em>只提交身份，不提交 URL 或文件</em></span>
            <input name="packageId" maxlength="128" autocomplete="off" required placeholder="com.agentmesh360.example-agent" ${remoteAvailable ? '' : 'disabled'}>
          </label>
          <button class="secondary" type="submit" ${packageUi.busy || !remoteAvailable ? 'disabled' : ''}>下载并验证</button>
        </form>
        <button class="ghost package-refresh-action" id="refresh-package-registry" type="button" ${packageUi.busy ? 'disabled' : ''}>刷新签名目录</button>
      </div>` : '<div class="provider-notice warning"><strong>在线添加暂未开放</strong><br>当前只显示内置和本机已验证的 Agent，不会请求未知下载地址。</div>'}
      ${packageUi.pendingApproval ? packageApprovalView(packageUi.pendingApproval) : ''}
      ${remoteDiscoveryView(discovery, remoteAvailable)}
      <div class="section-head package-section-head"><h2>当前可用 Agent</h2><span>${packages.length} 个</span></div>
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
        ${remoteAvailable ? `<button class="ghost" type="button" data-download-package="${escapeHtml(packageRecord.packageId)}" ${packageUi.busy ? 'disabled' : ''}>检查在线更新</button>` : ''}
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
  document.getElementById('back-from-add-agent')?.addEventListener('click', () => {
    workspaceView = 'agents';
    renderReady(currentState);
  });
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
  if (workspaceView === 'add-agent') renderReady(currentState);
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
  if (workspaceView === 'add-agent' && currentState.phase === 'ready') renderReady(currentState);
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
  if (workspaceView === 'add-agent' && currentState.phase === 'ready') renderReady(currentState);
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
  if (workspaceView === 'add-agent' && currentState.phase === 'ready') renderReady(currentState);
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
  if (workspaceView === 'add-agent' && currentState.phase === 'ready') renderReady(currentState);
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
  if (workspaceView === 'add-agent' && currentState.phase === 'ready') renderReady(currentState);
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
  if (workspaceView === 'add-agent' && currentState.phase === 'ready') renderReady(currentState);
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

function settingsView(state) {
  const tabs = [
    ['account', '账号与订阅'],
    ['background', '后台运行'],
    ['guide', '使用指南'],
    ['diagnostics', '高级诊断'],
  ];
  return `
    <nav class="settings-tabs" aria-label="客户端设置">
      ${tabs.map(([id, label]) => `<button type="button" data-settings-tab="${id}" class="${settingsTab === id ? 'active' : ''}">${label}</button>`).join('')}
    </nav>
    ${settingsTab === 'background'
      ? backgroundSettingsView()
      : settingsTab === 'guide'
        ? guideSettingsView(state)
        : settingsTab === 'diagnostics'
          ? diagnosticsSettingsView()
          : accountSettingsView(state)}
  `;
}

function accountSettingsView(state) {
  const account = state.account || {};
  const subscription = state.subscription || {};
  const credits = state.credits || {};
  return `
    <header class="workspace-header settings-header">
      <div><p class="eyebrow">Account</p><h1>账号与订阅</h1><p>客户端使用资格由 AgentMesh360 订阅统一验证；模型费用由你的 BYOK Provider 承担。</p></div>
    </header>
    <section class="agent-settings-panel account-settings-card">
      ${accountChip(account)}
      <div class="runtime-fact"><span>订阅</span><strong>${escapeHtml(subscriptionLabel(subscription))}</strong></div>
      <div class="runtime-fact"><span>AgentMesh360 Credits</span><strong>${formatNumber(credits.balance)}</strong></div>
      <div class="runtime-fact"><span>最近验证</span><strong>${escapeHtml(formatCheckedAt(state.checkedAt))}</strong></div>
      <button class="ghost danger-text" id="settings-logout" type="button">退出当前账号</button>
    </section>`;
}

function guideSettingsView(state) {
  return `
    <header class="workspace-header settings-header">
      <div><p class="eyebrow">Guide</p><h1>使用指南</h1><p>这里会显示你的当前进度；离开后再回来，仍可继续真正的下一步。</p></div>
    </header>
    ${onboardingGuideView(state, { context: 'settings' })}`;
}

function diagnosticsSettingsView() {
  const hostStatus = hostConnectionStatus();
  return `
    <header class="workspace-header settings-header">
      <div><p class="eyebrow">Advanced diagnostics</p><h1>高级诊断</h1><p>这里仅用于排查本机 Host；普通使用不需要理解内部协议或路径。</p></div>
    </header>
    <section class="agent-settings-panel">
      <details>
        <summary>查看技术状态</summary>
        <div class="runtime-fact"><span>身份门禁</span><strong>${currentState.phase === 'ready' ? '已通过' : '不可用'}</strong></div>
        <div class="runtime-fact"><span>桌面与 Host</span><strong>${escapeHtml(hostStatus.label)}</strong></div>
        <div class="runtime-fact"><span>持久 Agent</span><strong>${(currentState.agents || []).filter(isResident).length}</strong></div>
      </details>
    </section>`;
}

function wireSettings() {
  document.querySelectorAll('[data-settings-tab]').forEach((button) => {
    button.addEventListener('click', () => {
      settingsTab = button.dataset.settingsTab;
      renderReady(currentState);
      if (settingsTab === 'background' && backgroundUi.phase === 'idle') {
        refreshBackgroundSnapshot();
      } else if (settingsTab === 'guide' && agentOverviewUi.phase === 'idle') {
        refreshAgentOverview();
      }
    });
  });
  document.getElementById('settings-logout')?.addEventListener('click', () => bridge.logout());
  wireOnboardingGuide();
  if (settingsTab === 'background') wireBackgroundSettings();
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
    ${backgroundUi.phase === 'loading' ? backgroundLoadingView() : ''}
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
    <div class="security-row">后台恢复会重新验证订阅 · 登录凭据由系统安全存储保护</div>`;
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
    if (workspaceView === 'settings' && settingsTab === 'background' && currentState.phase === 'ready') renderReady(currentState);
  });
}

function backgroundLoadingView() {
  return `
    <div class="provider-loading" role="status">
      <div class="spinner" aria-hidden="true"></div>
      <div><strong>正在读取后台运行状态</strong><span>客户端正在确认 Host 与系统登录启动设置。</span></div>
    </div>`;
}

async function refreshBackgroundSnapshot({ quiet = false } = {}) {
  const requestRevision = ++backgroundRequestRevision;
  const accountId = readyAccountId;
  backgroundUi = {
    ...backgroundUi,
    phase: 'loading',
    error: null,
    message: null,
  };
  updateHostStatusDom();
  if (!quiet && workspaceView === 'settings' && settingsTab === 'background') {
    renderReady(currentState);
  }
  try {
    const snapshot = await bridge.getBackgroundSnapshot();
    if (
      requestRevision !== backgroundRequestRevision
      || currentState.phase !== 'ready'
      || readyAccountId !== accountId
    ) {
      return;
    }
    backgroundUi = {
      phase: 'ready',
      snapshot,
      error: null,
      message: null,
      busy: false,
    };
  } catch (error) {
    if (
      requestRevision !== backgroundRequestRevision
      || currentState.phase !== 'ready'
      || readyAccountId !== accountId
    ) {
      return;
    }
    backgroundUi = {
      phase: 'error',
      snapshot: null,
      error: publicError(error, '无法读取后台运行状态'),
      message: null,
      busy: false,
    };
  }
  updateHostStatusDom();
  if (workspaceView === 'settings' && settingsTab === 'background' && currentState.phase === 'ready') renderReady(currentState);
}

function hostConnectionStatus() {
  if (backgroundUi.phase === 'error') {
    return { code: 'needs-attention', label: '需要处理' };
  }
  if (backgroundUi.phase !== 'ready') {
    return { code: 'recovering', label: '正在恢复' };
  }
  if (backgroundUi.snapshot?.host?.bridgeState === 'connected') {
    return { code: 'connected', label: '已连接' };
  }
  return { code: 'needs-attention', label: '需要处理' };
}

function updateHostStatusDom() {
  const button = document.getElementById('sidebar-host');
  const label = button?.querySelector('[data-host-status]');
  if (!button || !label) return;
  const status = hostConnectionStatus();
  button.classList.remove('connected', 'recovering', 'needs-attention');
  button.classList.add(status.code);
  label.textContent = `${status.label} · 点击查看`;
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

async function refreshAgentOverview({ refreshCatalog = false } = {}) {
  const requestRevision = ++agentOverviewRequestRevision;
  const accountId = readyAccountId;
  agentOverviewUi = { ...agentOverviewUi, phase: 'loading', error: null };
  if (
    workspaceView === 'agents'
    || (workspaceView === 'settings' && settingsTab === 'guide')
  ) renderReady(currentState);
  try {
    const snapshot = refreshCatalog
      ? await bridge.refreshAgentModelOverview()
      : await bridge.getAgentModelOverview();
    if (
      requestRevision !== agentOverviewRequestRevision
      || currentState.phase !== 'ready'
      || readyAccountId !== accountId
    ) {
      return;
    }
    agentOverviewUi = {
      phase: 'ready',
      snapshot,
      error: null,
    };
  } catch (error) {
    if (
      requestRevision !== agentOverviewRequestRevision
      || currentState.phase !== 'ready'
      || readyAccountId !== accountId
    ) {
      return;
    }
    agentOverviewUi = {
      phase: 'error',
      snapshot: null,
      error: publicError(error, '无法读取 Agent 模型摘要'),
    };
  }
  if (
    currentState.phase === 'ready'
    && (
      workspaceView === 'agents'
      || (workspaceView === 'settings' && settingsTab === 'guide')
    )
  ) renderReady(currentState);
}

function agentDisplayName(agentId) {
  return currentState.agents?.find((agent) => agent.agentId === agentId)?.displayName || agentId;
}

function onboardingProgress(state) {
  const agents = Array.isArray(state.agents) ? state.agents : [];
  const residentAgents = agents.filter(isResident);
  const runtimeStartingAgents = residentAgents.filter(
    (agent) => agent.runtimeState === 'starting',
  );
  const explicitlyActivatingAgent = agents.find(
    (agent) => agent.agentId === state.activatingAgentId,
  );
  const startingAgents = explicitlyActivatingAgent
    && !runtimeStartingAgents.some(
      (agent) => agent.agentId === explicitlyActivatingAgent.agentId,
    )
    ? [...runtimeStartingAgents, explicitlyActivatingAgent]
    : runtimeStartingAgents;
  const establishedResidentAgents = residentAgents.filter(
    (agent) => agent.runtimeState !== 'starting',
  );
  const activatableAgents = agents.filter((agent) => (
    !isResident(agent)
    && agent.agentId !== state.activatingAgentId
  ));
  const overviewAgents = Array.isArray(agentOverviewUi.snapshot?.agents)
    ? agentOverviewUi.snapshot.agents
    : [];
  const validResidentAgents = establishedResidentAgents.filter((agent) => {
    const model = overviewAgents.find((item) => item.agentId === agent.agentId);
    return model && !model.bindingIssue;
  });
  const invalidResidentAgents = establishedResidentAgents.filter((agent) => (
    !validResidentAgents.some((item) => item.agentId === agent.agentId)
  ));
  if (agentOverviewUi.phase === 'error') {
    return {
      phase: 'error',
      providerComplete: false,
      agentComplete: establishedResidentAgents.length > 0,
      residentAgents,
      startingAgents,
      activatableAgents,
      validResidentAgents: [],
      invalidResidentAgents: [],
    };
  }
  const configuredProviderCount = agentOverviewUi.snapshot?.configuredProviderCount;
  if (
    agentOverviewUi.phase !== 'ready'
    || !Number.isSafeInteger(configuredProviderCount)
    || configuredProviderCount < 0
  ) {
    return {
      phase: 'loading',
      providerComplete: false,
      agentComplete: establishedResidentAgents.length > 0,
      residentAgents,
      startingAgents,
      activatableAgents,
      validResidentAgents: [],
      invalidResidentAgents: [],
    };
  }
  return {
    phase: 'ready',
    providerComplete: configuredProviderCount > 0,
    agentComplete: establishedResidentAgents.length > 0,
    residentAgents,
    startingAgents,
    activatableAgents,
    validResidentAgents,
    invalidResidentAgents,
  };
}

function onboardingStepView({ number, label, description, status, action = null }) {
  const statusLabel = {
    complete: '已完成',
    current: '当前步骤',
    locked: '待完成',
    unknown: '待确认',
  }[status] || '待确认';
  const current = status === 'current';
  return `
    <li class="onboarding-step ${escapeHtml(status)}" ${current ? 'aria-current="step"' : ''}>
      <span class="onboarding-step-number" aria-hidden="true">${number}</span>
      <div class="onboarding-step-copy">
        <div><strong>${escapeHtml(label)}</strong><span class="onboarding-step-status">${escapeHtml(statusLabel)}</span></div>
        <p>${escapeHtml(description)}</p>
        ${action ? `<button class="onboarding-step-action" id="${escapeHtml(action.id)}" type="button"${action.agentId ? ` data-agent-id="${escapeHtml(action.agentId)}"` : ''}>${escapeHtml(action.label)}</button>` : ''}
      </div>
    </li>`;
}

function onboardingGuideView(state, { context = 'home' } = {}) {
  const progress = onboardingProgress(state);
  if (
    context === 'home'
    && progress.phase === 'ready'
    && progress.providerComplete
    && progress.validResidentAgents.length > 0
  ) return '';
  let heading = '正在确认你的设置进度';
  let summary = '不会打开新的页面，也不会打断现有 Agent。';
  let steps = [
    ['添加模型供应商', '验证 Key、读取可用模型并安全保存。', 'unknown'],
    ['激活 Agent', '选择一个专业 Agent 和模型，创建固定主会话。', 'unknown'],
    ['在 Agent 对话中开始工作', '进入主对话，以后仍会回到同一进度。', 'unknown'],
  ];
  let recoveryAction = null;

  if (progress.phase === 'error') {
    heading = '暂时无法确认当前进度';
    summary = '已有 Provider、Agent 和会话不会被改变；可以重新读取当前进度。';
    recoveryAction = { id: 'onboarding-retry', label: '重新确认进度' };
  } else if (progress.phase === 'ready') {
    if (!progress.providerComplete) {
      heading = '下一步：添加模型供应商';
      summary = '先连接你自己的模型，Agent 才能开始工作。';
      steps = [
        ['添加模型供应商', '验证 Key、读取可用模型并安全保存。', 'current', {
          id: 'onboarding-go-providers',
          label: '配置模型供应商',
        }],
        ['激活 Agent', progress.agentComplete ? '这个 Agent 已经激活；恢复模型后即可继续。' : '完成第 1 步后，从下方选择一个 Agent。', progress.agentComplete ? 'complete' : 'locked'],
        ['在 Agent 对话中开始工作', '模型供应商已配置且 Agent 已激活后即可进入。', 'locked'],
      ];
    } else if (progress.startingAgents.length > 0 && !progress.agentComplete) {
      const starting = progress.startingAgents[0];
      heading = `${starting.displayName} 正在启动`;
      summary = '启动会在后台继续，不会阻止你查看其他 Agent。';
      steps = [
        ['添加模型供应商', '模型供应商已经保存。', 'complete'],
        ['激活 Agent', `${starting.displayName} 正在后台启动。`, 'current', {
          id: 'onboarding-focus-agent',
          label: `查看 ${starting.displayName} 状态`,
          agentId: starting.agentId,
        }],
        ['在 Agent 对话中开始工作', '启动完成后即可进入这个 Agent 的主对话。', 'locked'],
      ];
    } else if (!progress.agentComplete) {
      const hasActivatableAgent = progress.activatableAgents.length > 0;
      heading = hasActivatableAgent
        ? '下一步：激活一个 Agent'
        : '暂时没有可激活的 Agent';
      summary = hasActivatableAgent
        ? '模型供应商已经保存，现在选择你需要的专业 Agent。'
        : '模型供应商已经保存，但 Agent 列表为空；重新读取不会改变已有设置。';
      steps = [
        ['添加模型供应商', '模型供应商已经保存。', 'complete'],
        ['激活 Agent', hasActivatableAgent
          ? '选择供应商和模型，确认后创建固定主会话。'
          : '当前没有可激活的 Agent。', 'current', {
          id: hasActivatableAgent ? 'onboarding-go-agents' : 'onboarding-refresh-agents',
          label: hasActivatableAgent ? '查看可激活 Agent' : '重新确认 Agent',
        }],
        ['在 Agent 对话中开始工作', '激活完成后会直接进入这个 Agent 的主对话。', 'locked'],
      ];
    } else if (!progress.validResidentAgents.length) {
      const resident = progress.invalidResidentAgents[0];
      heading = '下一步：修复 Agent 的模型';
      summary = 'Agent 已经常驻，但当前模型设置需要处理；对话历史不会删除。';
      steps = [
        ['添加模型供应商', '至少一个模型供应商已经保存。', 'complete'],
        ['激活 Agent', `${resident.displayName} 已经常驻。`, 'complete'],
        ['在 Agent 对话中开始工作', '重新选择可用的供应商和模型后即可继续。', 'current', {
          id: 'onboarding-fix-agent',
          label: `设置 ${resident.displayName} 模型`,
          agentId: resident.agentId,
        }],
      ];
    } else {
      const resident = progress.validResidentAgents[0];
      heading = '模型配置已经完成';
      summary = progress.validResidentAgents.length > 1
        ? `已有 ${progress.validResidentAgents.length} 个 Agent 可以进入主对话，也可从列表选择其他 Agent。`
        : '现在可以进入主对话，以后仍会回到同一进度。';
      steps = [
        ['添加模型供应商', '模型供应商已经保存。', 'complete'],
        ['激活 Agent', `${resident.displayName} 已经完成激活。`, 'complete'],
        ['在 Agent 对话中开始工作', '可以打开主对话，开始或继续工作。', 'current', {
          id: 'onboarding-open-agent',
          label: `打开或继续 ${resident.displayName}`,
          agentId: resident.agentId,
        }],
      ];
    }
  }

  return `
    <section class="onboarding-strip ${escapeHtml(progress.phase)} ${context === 'settings' ? 'settings-guide' : ''}" aria-label="Agent 使用顺序" aria-live="polite" data-onboarding-phase="${escapeHtml(progress.phase)}" ${progress.phase === 'loading' ? 'aria-busy="true"' : ''}>
      <header class="onboarding-heading">
        <div><p>三步开始</p><h2>${escapeHtml(heading)}</h2><span>${escapeHtml(summary)}</span></div>
        ${recoveryAction ? `<button class="onboarding-retry" id="${escapeHtml(recoveryAction.id)}" type="button">${escapeHtml(recoveryAction.label)}</button>` : ''}
      </header>
      <ol class="onboarding-steps">
        ${steps.map(([label, description, status, action], index) => onboardingStepView({
    number: index + 1,
    label,
    description,
    status,
    action,
  })).join('')}
      </ol>
    </section>`;
}

function wireOnboardingGuide() {
  document.getElementById('onboarding-go-providers')?.addEventListener('click', () => {
    workspaceView = 'providers';
    renderReady(currentState);
    if (providerUi.phase === 'idle') refreshProviderSnapshot();
  });
  document.getElementById('onboarding-go-agents')?.addEventListener('click', () => {
    workspaceView = 'agents';
    renderReady(currentState);
    const target = [...document.querySelectorAll('[data-manage-agent]')].find((button) => {
      const agent = currentState.agents?.find((item) => item.agentId === button.dataset.manageAgent);
      return agent && !isResident(agent);
    });
    target?.scrollIntoView({ block: 'center' });
    target?.focus();
  });
  document.getElementById('onboarding-open-agent')?.addEventListener('click', (event) => {
    openAgentDetail(event.currentTarget.dataset.agentId, 'conversation');
  });
  document.getElementById('onboarding-fix-agent')?.addEventListener('click', (event) => {
    openAgentDetail(event.currentTarget.dataset.agentId, 'model');
  });
  document.getElementById('onboarding-focus-agent')?.addEventListener('click', (event) => {
    const agentId = event.currentTarget.dataset.agentId;
    const target = document.querySelector(`[data-agent-card="${CSS.escape(agentId)}"]`);
    target?.scrollIntoView({ block: 'center' });
    target?.focus();
  });
  document.getElementById('onboarding-retry')?.addEventListener('click', () => {
    refreshAgentOverview();
  });
  document.getElementById('onboarding-refresh-agents')?.addEventListener('click', () => {
    refreshAgentOverview({ refreshCatalog: true });
  });
}

function agentWorkspaceView(state) {
  const account = state.account || {};
  const subscription = state.subscription || {};
  const credits = state.credits || {};
  const agents = Array.isArray(state.agents) ? state.agents : [];
  const residentCount = agents.filter(isResident).length;
  const overview = Array.isArray(agentOverviewUi.snapshot?.agents)
    ? agentOverviewUi.snapshot.agents
    : [];
  const invalidAgents = overview.filter((item) => (
    item.bindingIssue
    && item.bindingIssue.code !== 'model_not_configured'
    && agents.some((agent) => agent.agentId === item.agentId && isResident(agent))
  ));
  return `
    <header class="workspace-header">
      <div><p class="eyebrow">Persistent Agent Workspace</p><h1 data-ready-welcome>欢迎回来，${escapeHtml(firstName(account))}</h1><p data-ready-subscription>${escapeHtml(subscriptionLabel(subscription))} · 订阅验证通过</p></div>
      <div class="credit-card"><span>AgentMesh360 Credits</span><strong data-ready-credits>${formatNumber(credits.balance)}</strong></div>
    </header>
    ${onboardingGuideView(state)}
    ${invalidAgents.length ? `
      <div class="agent-model-alert" role="alert">
        <div><strong>${invalidAgents.length} 个 Agent 的模型需要重新选择</strong><span>${escapeHtml(invalidAgents.map((item) => agentDisplayName(item.agentId)).join('、'))}</span></div>
        <span>进入对应 Agent 的“模型”页即可修复，不会删除对话历史。</span>
      </div>` : ''}
    <div class="section-head">
      <h2>你的 Agent</h2>
      <span>${residentCount} 个已激活</span>
    </div>
    ${state.activationError ? `<div class="activation-error">${escapeHtml(state.activationError)}</div>` : ''}
    <div class="agent-grid">${agents.length ? agents.map((agent, index) => agentCard(
    agent,
    index,
    state.activatingAgentId,
    overview.find((item) => item.agentId === agent.agentId),
  )).join('') : '<div class="empty-agents">当前没有可用的 Agent Package。</div>'}</div>
    <div class="security-row" data-ready-checked-at>订阅状态已安全验证 · ${formatCheckedAt(state.checkedAt)}</div>`;
}

function agentDetailView(state) {
  const agent = (state.agents || []).find(
    (item) => item.agentId === agentManagementUi.agentId,
  );
  if (!agent) {
    return '<button class="ghost" id="back-to-agents" type="button">← 返回 Agent</button><div class="empty-agents">这个 Agent 当前不可用。</div>';
  }
  const resident = isResident(agent);
  const turnRunning = conversationTurnIsRunning(agent.agentId);
  const binding = agentManagementUi.snapshot?.modelBinding;
  const profile = (agentManagementUi.snapshot?.profiles || []).find(
    (item) => item.profileId === binding?.providerProfileId,
  );
  const draftBinding = agentManagementUi.modelDraft?.providerProfileId
    && agentManagementUi.modelDraft?.modelId
    ? agentManagementUi.modelDraft
    : null;
  const draftProfile = (agentManagementUi.snapshot?.profiles || []).find(
    (item) => item.profileId === draftBinding?.providerProfileId,
  );
  const modelSummary = draftBinding
    ? `${draftProfile?.displayName || '所选供应商'} · ${draftBinding.modelId}（尚未保存）`
    : binding
      ? `${profile?.displayName || '供应商不可用'} · ${binding.modelId}`
      : '尚未选择模型';
  if (resident && agentManagementUi.tab === 'conversation') {
    return agentConversationWorkspace(agent, turnRunning);
  }
  return agentSettingsWorkspace(agent, {
    resident,
    turnRunning,
    modelSummary,
  });
}

function agentConversationWorkspace(agent, turnRunning) {
  const status = conversationPresentationState();
  return `
    <section class="agent-conversation-workspace">
      <header class="agent-chat-toolbar">
        <div class="agent-chat-identity">
          <span class="agent-chat-avatar" aria-hidden="true">${escapeHtml(agentInitial(agent))}</span>
          <div><h1>${escapeHtml(agent.displayName)}</h1><p>主会话</p></div>
        </div>
        <div class="agent-chat-actions">
          <span class="conversation-state ${escapeHtml(status.className)}">${escapeHtml(status.label)}</span>
          <button
            class="agent-settings-button"
            id="agent-settings-button"
            type="button"
            aria-label="打开 ${escapeHtml(agent.displayName)} 设置"
            title="Agent 设置"
            ${turnRunning ? 'disabled' : ''}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8.25A3.75 3.75 0 1 0 12 15.75 3.75 3.75 0 0 0 12 8.25Zm8 3.75-.12-1.18 1.45-1.13-1.8-3.12-1.72.68a8.4 8.4 0 0 0-2.04-1.18L15.5 4.25h-3.6l-.27 1.82a8.4 8.4 0 0 0-2.04 1.18l-1.72-.68-1.8 3.12 1.45 1.13L7.4 12l.12 1.18-1.45 1.13 1.8 3.12 1.72-.68c.62.5 1.3.9 2.04 1.18l.27 1.82h3.6l.27-1.82a8.4 8.4 0 0 0 2.04-1.18l1.72.68 1.8-3.12-1.45-1.13L20 12Z"/></svg>
          </button>
        </div>
      </header>
      ${conversationView()}
    </section>`;
}

function conversationPresentationState() {
  if (conversationUi.interaction?.kind === 'permission') {
    return { label: '等待你的确认', className: 'waiting' };
  }
  if (conversationTurnIsRunning(conversationUi.agentId)) {
    return { label: 'Agent 正在处理', className: 'working' };
  }
  if (conversationUi.phase === 'loading') {
    return { label: '正在加载', className: 'loading' };
  }
  if (conversationUi.phase === 'error') {
    return { label: '需要重新打开', className: 'error' };
  }
  if (conversationUi.phase === 'ready') {
    return { label: '已连接', className: 'ready' };
  }
  return { label: '尚未连接', className: 'idle' };
}

function agentSettingsWorkspace(agent, { resident, turnRunning, modelSummary }) {
  const settings = [
    ['model', '模型'],
    ['agent_md', '行为'],
    ['user_md', '用户偏好'],
  ];
  return `
    <section class="agent-settings-workspace">
      <header class="agent-settings-header">
        <button class="ghost agent-settings-back" id="${resident ? 'back-to-agent-conversation' : 'back-to-agents'}" type="button">← ${resident ? '返回主会话' : '所有 Agent'}</button>
        <div>
          <p class="eyebrow">Agent 设置</p>
          <h1>${escapeHtml(agent.displayName)}</h1>
          <p>${escapeHtml(agent.description)}</p>
          <span class="agent-current-model">${escapeHtml(modelSummary)}</span>
        </div>
        <span class="agent-status-pill ${resident ? 'running' : ''}">${escapeHtml(runtimeLabel(agent.runtimeState, agent.desiredState))}</span>
      </header>
      <nav class="agent-settings-nav" aria-label="${escapeHtml(agent.displayName)} 设置">
        ${settings.map(([id, label]) => `
          <button type="button" data-agent-setting="${id}" class="${agentManagementUi.tab === id ? 'active' : ''}" ${turnRunning || agentManagementUi.busy ? 'disabled' : ''}>${escapeHtml(label)}</button>
        `).join('')}
      </nav>
      ${turnRunning ? '<div class="provider-notice" role="status">当前回答完成后即可修改模型、行为或偏好；正在生成的内容不会被中途改变。</div>' : ''}
      ${agentManagementUi.message ? `<div class="provider-notice success" role="status">${escapeHtml(agentManagementUi.message)}</div>` : ''}
      ${agentManagementUi.error ? `<div class="provider-notice error" role="alert">${escapeHtml(agentManagementUi.error)}</div>` : ''}
      ${agentManagementUi.phase === 'loading'
    ? '<div class="provider-loading"><div class="spinner"></div><div><strong>正在读取 Agent 设置</strong><span>模型和个性化内容由本机 Host 返回。</span></div></div>'
    : agentManagementUi.phase === 'error'
      ? '<button class="secondary retry-agent-management" type="button">重新读取 Agent 设置</button>'
      : agentManagementUi.tab === 'model'
        ? agentModelView(agent)
        : agentCustomizationView(agent, agentManagementUi.tab)}
    </section>`;
}

function agentModelView(agent) {
  const snapshot = agentManagementUi.snapshot || {};
  const profiles = Array.isArray(snapshot.profiles) ? snapshot.profiles : [];
  const binding = snapshot.modelBinding || null;
  const draft = agentManagementUi.modelDraft || {};
  const turnRunning = conversationTurnIsRunning(agent.agentId);
  const selectedProfileId = draft.providerProfileId
    || binding?.providerProfileId
    || (profiles.length === 1 ? profiles[0].profileId : '');
  const selectedProfile = profiles.find((profile) => profile.profileId === selectedProfileId);
  const models = Array.isArray(selectedProfile?.enabledModels)
    ? selectedProfile.enabledModels
    : [];
  const selectedModel = models.includes(draft.modelId)
    ? draft.modelId
    : models.includes(binding?.modelId)
      ? binding.modelId
      : '';
  const resident = isResident(agent);
  const requestedPermissions = Array.isArray(snapshot.customization?.requestedPermissions)
    ? snapshot.customization.requestedPermissions
    : [];
  if (!profiles.length) {
    return `
      <section class="agent-settings-panel empty-agent-setting">
        <p class="eyebrow">需要先完成一步</p>
        <h2>先添加模型供应商</h2>
        <p>Agent 必须绑定一个已验证并保存的模型才能激活或发送消息。</p>
        <button class="secondary" id="agent-go-providers" type="button">添加模型供应商</button>
      </section>`;
  }
  return `
    <form class="agent-settings-panel agent-model-form" id="agent-model-form">
      <div class="agent-setting-heading">
        <div><p class="eyebrow">${resident ? '下一条消息使用' : '激活设置'}</p><h2>${resident ? '这个 Agent 使用哪个模型' : '选择模型并激活 Agent'}</h2></div>
        ${snapshot.inheritedFromLegacyGlobal ? '<span class="migration-badge">已从旧版全局设置迁移</span>' : ''}
      </div>
      <p class="agent-setting-copy">${resident
    ? '保存后从下一条用户消息生效；正在生成的回答仍使用原模型，历史不会改变。'
    : '激活后会创建这个 Agent 的固定主会话。以后每次打开都会回到同一个进度。'}</p>
      ${snapshot.bindingIssue
    ? selectedModel
      ? `<div class="provider-notice" role="status">已选择 ${escapeHtml(selectedProfile?.displayName || '模型供应商')} · ${escapeHtml(selectedModel)}，点击下方按钮保存后生效。</div>`
      : `<div class="provider-notice error" role="alert">${escapeHtml(snapshot.bindingIssue.message)}</div>`
    : ''}
      <div class="form-grid two">
        <label class="field"><span>模型供应商</span>
          <select name="providerProfileId" required ${turnRunning || agentManagementUi.busy ? 'disabled' : ''}>
            <option value="">请选择</option>
            ${profiles.map((profile) => `<option value="${escapeHtml(profile.profileId)}" ${profile.profileId === selectedProfileId ? 'selected' : ''}>${escapeHtml(profile.displayName)}</option>`).join('')}
          </select>
        </label>
        <label class="field"><span>可用模型 <em>来自当前供应商验证结果</em></span>
          <select name="modelId" required ${selectedProfile && !turnRunning && !agentManagementUi.busy ? '' : 'disabled'}>
            <option value="">请选择</option>
            ${models.map((model) => `<option value="${escapeHtml(model)}" ${model === selectedModel ? 'selected' : ''}>${escapeHtml(model)}</option>`).join('')}
          </select>
        </label>
      </div>
      ${resident ? '' : `
        <div class="activation-permissions">
          <strong>激活后的本机能力范围</strong>
          <div class="package-permissions">
            ${requestedPermissions.length
    ? requestedPermissions.map((permission) => `<span>${escapeHtml(permissionLabel(permission))}</span>`).join('')
    : '<span>不申请额外系统权限</span>'}
          </div>
          <small>Agent 仍受客户端安全确认与订阅门禁约束；外部操作不会因为激活而自动执行。</small>
        </div>
        <label class="activation-confirm">
          <input name="confirmActivation" type="checkbox" ${turnRunning || agentManagementUi.busy ? 'disabled' : ''}>
          <span>我已查看上面的能力范围，确认激活 ${escapeHtml(agent.displayName)}，并从首次消息开始使用所选模型。</span>
        </label>`}
      <div class="agent-setting-actions">
        <button class="secondary" type="submit" ${agentManagementUi.busy || turnRunning || !selectedModel || !resident ? 'disabled' : ''}>${resident ? '保存模型设置' : '确认激活 Agent'}</button>
      </div>
    </form>`;
}

function agentCustomizationRecord(kind) {
  const customization = agentManagementUi.snapshot?.customization;
  return kind === 'agent_md' ? customization?.agentMd : customization?.userMd;
}

function agentCustomizationView(agent, kind) {
  const record = agentCustomizationRecord(kind) || {
    content: '',
    revision: 0,
    customized: false,
  };
  const draftKey = `${readyAccountId}:${agent.agentId}:${kind}`;
  const hasDraft = agentCustomizationDrafts.has(draftKey);
  const content = hasDraft ? agentCustomizationDrafts.get(draftKey) : record.content;
  const contentLength = [...(content || '')].length;
  const isBehavior = kind === 'agent_md';
  const hasConflict = agentManagementUi.customizationConflict?.kind === kind;
  const turnRunning = conversationTurnIsRunning(agent.agentId);
  return `
    <form
      class="agent-settings-panel customization-form"
      id="agent-customization-form"
      data-account-id="${escapeHtml(String(readyAccountId || ''))}"
      data-agent-id="${escapeHtml(String(agent.agentId || ''))}"
      data-dirty="false"
    >
      <input type="hidden" name="kind" value="${kind}">
      <div class="agent-setting-heading">
        <div>
          <p class="eyebrow">${isBehavior ? '行为设置' : '用户偏好'}</p>
          <h2>${isBehavior ? '补充这个 Agent 的工作方式' : '告诉这个 Agent 你偏好的协作方式'}</h2>
        </div>
        ${hasDraft ? '<span class="unsaved-badge">尚未保存</span>' : ''}
      </div>
      <p class="agent-setting-copy">${isBehavior
    ? '这里是你自己的行为补充，不会修改签名 Package 的基础定义。'
    : '偏好只属于当前账号和当前 Agent，不会自动共享给其他 Agent。'}</p>
      ${hasConflict ? `
        <div class="customization-conflict" role="alert">
          <div><strong>这项设置已在其他位置更新</strong><span>你的草稿没有丢失。先读取最新版本，再决定继续保存还是放弃本地草稿。</span></div>
          <div>
            <button class="ghost preserve-customization-draft" type="button">保留我的版本</button>
            <button class="ghost danger-text discard-customization-draft" type="button">放弃并重载</button>
          </div>
        </div>` : ''}
      <div class="package-public-meta">
        <strong>${escapeHtml(agentManagementUi.snapshot?.customization?.packageName || agent.displayName)}</strong>
        <span>v${escapeHtml(agentManagementUi.snapshot?.customization?.packageVersion || agent.version || '—')} · ${escapeHtml(agentManagementUi.snapshot?.customization?.packageDescription || agent.description)}</span>
      </div>
      <label class="field"><span>${isBehavior ? '行为补充' : '用户偏好'} <em>最多 8000 字符，请勿填写 API Key 或私钥</em></span>
        <textarea name="content" maxlength="16000" rows="14" ${turnRunning || agentManagementUi.busy ? 'disabled' : ''} placeholder="${isBehavior ? '例如：先给出简短计划，涉及外部发布前必须确认。' : '例如：默认用中文回答；状态更新要简洁；每周五总结进度。'}">${escapeHtml(content || '')}</textarea>
      </label>
      <div class="character-count ${contentLength > 8_000 ? 'invalid' : ''}">${contentLength} / 8000</div>
      <div class="agent-setting-actions">
        <button class="ghost danger-text" id="restore-customization" type="button" ${record.customized && !turnRunning && !agentManagementUi.busy ? '' : 'disabled'}>恢复默认</button>
        <button class="secondary" type="submit" ${agentManagementUi.busy || turnRunning || contentLength > 8_000 ? 'disabled' : ''}>保存并从下一条消息生效</button>
      </div>
    </form>`;
}

async function openAgentDetail(agentId, tab) {
  if (!agentId) return;
  if (tab === 'conversation') {
    if (conversationTurnIsRunning(agentId) && showExistingConversation(agentId)) return;
  }
  const requestRevision = ++agentManagementRequestRevision;
  const conversationRequestRevision = tab === 'conversation'
    ? beginConversationOpen(agentId)
    : null;
  workspaceView = 'agent-detail';
  agentManagementUi = {
    phase: 'loading',
    agentId,
    tab,
    snapshot: null,
    error: null,
    message: null,
    busy: false,
  };
  renderReady(currentState);
  await refreshAgentManagement(null, requestRevision);
  if (
    tab === 'conversation'
    && requestRevision === agentManagementRequestRevision
    && workspaceView === 'agent-detail'
    && agentManagementUi.agentId === agentId
    && agentManagementUi.tab === tab
  ) {
    await openConversation(agentId, conversationRequestRevision);
  } else if (conversationRequestRevision !== null) {
    finishConversationOpen(conversationRequestRevision);
  }
}

async function refreshAgentManagement(message = null, requestRevision = null) {
  const agentId = agentManagementUi.agentId;
  if (!agentId) return;
  const activeRevision = requestRevision ?? ++agentManagementRequestRevision;
  agentManagementUi = {
    ...agentManagementUi,
    phase: 'loading',
    error: null,
    message,
    busy: false,
  };
  if (workspaceView === 'agent-detail') renderReady(currentState);
  try {
    const snapshot = await bridge.getAgentManagementSnapshot(agentId);
    if (
      activeRevision !== agentManagementRequestRevision
      || workspaceView !== 'agent-detail'
      || agentManagementUi.agentId !== agentId
    ) {
      return;
    }
    agentManagementUi = {
      ...agentManagementUi,
      phase: 'ready',
      snapshot,
      error: null,
      message,
      busy: false,
    };
  } catch (error) {
    if (
      activeRevision !== agentManagementRequestRevision
      || workspaceView !== 'agent-detail'
      || agentManagementUi.agentId !== agentId
    ) {
      return;
    }
    agentManagementUi = {
      ...agentManagementUi,
      phase: 'error',
      error: publicError(error, '无法读取 Agent 设置'),
      message: null,
      busy: false,
    };
  }
  if (workspaceView === 'agent-detail') renderReady(currentState);
}

function wireAgentDetail() {
  document.getElementById('back-to-agents')?.addEventListener('click', () => {
    workspaceView = 'agents';
    renderReady(currentState);
  });
  document.getElementById('agent-settings-button')?.addEventListener('click', () => {
    agentManagementUi = {
      ...agentManagementUi,
      tab: 'model',
      error: null,
      message: null,
    };
    renderReady(currentState);
  });
  document.getElementById('back-to-agent-conversation')?.addEventListener('click', async () => {
    if (
      conversationUi.agentId === agentManagementUi.agentId
      && ['loading', 'ready', 'error'].includes(conversationUi.phase)
    ) {
      agentManagementUi = {
        ...agentManagementUi,
        tab: 'conversation',
        error: null,
        message: null,
      };
      renderReady(currentState);
      return;
    }
    await openConversation(agentManagementUi.agentId);
  });
  document.querySelector('.retry-agent-management')?.addEventListener(
    'click',
    () => refreshAgentManagement(),
  );
  document.querySelectorAll('[data-agent-setting]').forEach((button) => {
    button.addEventListener('click', () => {
      const tab = button.dataset.agentSetting;
      agentManagementUi = { ...agentManagementUi, tab, message: null, error: null };
      renderReady(currentState);
    });
  });
  if (agentManagementUi.tab === 'conversation') wireConversation();
  document.getElementById('conversation-fix-model')?.addEventListener('click', () => {
    agentManagementUi = {
      ...agentManagementUi,
      tab: 'model',
      error: null,
      message: null,
    };
    renderReady(currentState);
  });
  const modelForm = document.getElementById('agent-model-form');
  modelForm?.elements.providerProfileId?.addEventListener('change', (event) => {
    agentManagementUi.modelDraft = {
      providerProfileId: event.currentTarget.value,
      modelId: '',
    };
    renderReady(currentState);
  });
  modelForm?.elements.modelId?.addEventListener('change', (event) => {
    agentManagementUi.modelDraft = {
      providerProfileId: modelForm.elements.providerProfileId.value,
      modelId: event.currentTarget.value,
    };
    if (!modelForm.elements.confirmActivation) {
      renderReady(currentState);
      return;
    }
    modelForm.querySelector('button[type="submit"]').disabled = !(
      modelForm.elements.confirmActivation.checked
      && modelForm.elements.providerProfileId.value
      && event.currentTarget.value
    );
  });
  modelForm?.elements.confirmActivation?.addEventListener('change', (event) => {
    modelForm.querySelector('button[type="submit"]').disabled = !(
      event.currentTarget.checked
      && modelForm.elements.providerProfileId.value
      && modelForm.elements.modelId.value
    );
  });
  modelForm?.addEventListener('submit', saveAgentModel);
  document.getElementById('agent-go-providers')?.addEventListener('click', () => {
    workspaceView = 'providers';
    renderReady(currentState);
    if (providerUi.phase === 'idle') refreshProviderSnapshot();
  });
  const customizationForm = document.getElementById('agent-customization-form');
  customizationForm?.elements.content?.addEventListener('input', (event) => {
    const kind = customizationForm.elements.kind.value;
    const key = `${customizationForm.dataset.accountId}:${customizationForm.dataset.agentId}:${kind}`;
    const savedContent = agentCustomizationRecord(kind)?.content || '';
    const value = event.currentTarget.value;
    const changed = value !== savedContent;
    customizationForm.dataset.dirty = changed ? 'true' : 'false';
    if (changed) agentCustomizationDrafts.set(key, value);
    else agentCustomizationDrafts.delete(key);
    const counter = customizationForm.querySelector('.character-count');
    const length = [...value].length;
    if (counter) {
      counter.textContent = `${length} / 8000`;
      counter.classList.toggle('invalid', length > 8_000);
    }
    customizationForm.querySelector('button[type="submit"]').disabled = (
      agentManagementUi.busy || length > 8_000
    );
  });
  customizationForm?.addEventListener('submit', saveAgentCustomization);
  document.querySelector('.preserve-customization-draft')?.addEventListener(
    'click',
    async () => {
      agentManagementUi.customizationConflict = null;
      await refreshAgentManagement('已读取最新版本；你的草稿仍保留，请确认后再次保存。');
    },
  );
  document.querySelector('.discard-customization-draft')?.addEventListener(
    'click',
    async () => {
      const form = document.getElementById('agent-customization-form');
      const key = `${form?.dataset.accountId}:${form?.dataset.agentId}:${form?.elements.kind?.value}`;
      document.getElementById('agent-customization-form')?.remove();
      agentCustomizationDrafts.delete(key);
      agentManagementUi.customizationConflict = null;
      await refreshAgentManagement('已放弃本地草稿并读取最新版本。');
    },
  );
  document.getElementById('restore-customization')?.addEventListener(
    'click',
    clearAgentCustomization,
  );
}

function beginAgentManagementMutation(agentId, tab) {
  return {
    accountId: readyAccountId,
    agentId,
    tab,
    revision: ++agentManagementRequestRevision,
  };
}

function agentManagementMutationIsCurrent(context) {
  return Boolean(
    context
    && currentState.phase === 'ready'
    && readyAccountId === context.accountId
    && workspaceView === 'agent-detail'
    && agentManagementUi.agentId === context.agentId
    && agentManagementUi.tab === context.tab
    && agentManagementRequestRevision === context.revision,
  );
}

async function saveAgentModel(event) {
  event.preventDefault();
  if (conversationTurnIsRunning(agentManagementUi.agentId)) return;
  const form = event.currentTarget;
  const agentId = agentManagementUi.agentId;
  const agent = currentState.agents?.find((item) => item.agentId === agentId);
  if (!agent || (!isResident(agent) && !form.elements.confirmActivation?.checked)) return;
  const request = {
    agentId,
    providerProfileId: form.elements.providerProfileId.value,
    modelId: form.elements.modelId.value,
  };
  const mutation = beginAgentManagementMutation(agentId, 'model');
  agentManagementUi = { ...agentManagementUi, busy: true, error: null, message: null };
  renderReady(currentState);
  try {
    if (isResident(agent)) {
      const snapshot = await bridge.saveAgentModel(request);
      if (!agentManagementMutationIsCurrent(mutation)) {
        refreshAgentOverview();
        return;
      }
      agentManagementUi.snapshot = snapshot;
      agentManagementUi.message = '模型设置已保存，将从下一条消息开始使用。';
      agentManagementUi.phase = 'ready';
      agentManagementUi.busy = false;
      agentManagementUi.modelDraft = null;
      renderReady(currentState);
      refreshAgentOverview();
    } else {
      await bridge.configureAndActivateAgent(request);
      if (!agentManagementMutationIsCurrent(mutation)) {
        refreshAgentOverview();
        return;
      }
      agentManagementUi.busy = false;
      agentManagementUi.message = 'Agent 已激活，正在打开固定主对话。';
      refreshAgentOverview();
      await refreshAgentManagement(agentManagementUi.message);
      if (
        workspaceView === 'agent-detail'
        && agentManagementUi.agentId === agentId
        && agentManagementUi.tab === 'model'
      ) {
        await openConversation(agentId);
      }
    }
  } catch (error) {
    if (!agentManagementMutationIsCurrent(mutation)) return;
    agentManagementUi = {
      ...agentManagementUi,
      phase: 'ready',
      busy: false,
      error: publicError(error, '无法保存 Agent 模型设置'),
    };
    renderReady(currentState);
  }
}

async function saveAgentCustomization(event) {
  event.preventDefault();
  if (conversationTurnIsRunning(agentManagementUi.agentId)) return;
  const form = event.currentTarget;
  form.dataset.dirty = 'false';
  const kind = form.elements.kind.value;
  const content = form.elements.content.value;
  const agentId = form.dataset.agentId || agentManagementUi.agentId;
  const record = agentCustomizationRecord(kind) || { revision: 0 };
  const snapshotBeforeMutation = agentManagementUi.snapshot;
  const mutation = beginAgentManagementMutation(agentId, kind);
  agentManagementUi = { ...agentManagementUi, busy: true, error: null, message: null };
  renderReady(currentState);
  try {
    const updated = await bridge.saveAgentCustomization({
      agentId,
      kind,
      content,
      expectedRevision: record.revision,
    });
    agentCustomizationDrafts.delete(`${mutation.accountId}:${agentId}:${kind}`);
    if (!agentManagementMutationIsCurrent(mutation)) return;
    const customization = { ...(snapshotBeforeMutation?.customization || {}) };
    customization[kind === 'agent_md' ? 'agentMd' : 'userMd'] = updated;
    agentManagementUi = {
      ...agentManagementUi,
      phase: 'ready',
      busy: false,
      snapshot: { ...snapshotBeforeMutation, customization },
      message: '已保存，将从下一条消息开始生效。',
      customizationConflict: null,
    };
  } catch (error) {
    if (!agentManagementMutationIsCurrent(mutation)) return;
    const conflict = /revision conflict/i.test(String(error?.message || ''));
    agentManagementUi = {
      ...agentManagementUi,
      phase: 'ready',
      busy: false,
      error: conflict
        ? '这项设置已在其他位置更新；你的草稿仍保留，请选择如何处理。'
        : publicError(error, '无法保存 Agent 自定义内容'),
      customizationConflict: conflict ? { kind } : null,
    };
  }
  renderReady(currentState);
}

async function clearAgentCustomization() {
  if (conversationTurnIsRunning(agentManagementUi.agentId)) return;
  const kind = agentManagementUi.tab;
  const record = agentCustomizationRecord(kind);
  if (!record?.customized) return;
  const agentId = agentManagementUi.agentId;
  const snapshotBeforeMutation = agentManagementUi.snapshot;
  const mutation = beginAgentManagementMutation(agentId, kind);
  agentManagementUi = { ...agentManagementUi, busy: true, error: null, message: null };
  renderReady(currentState);
  try {
    const updated = await bridge.clearAgentCustomization({
      agentId,
      kind,
      expectedRevision: record.revision,
    });
    agentCustomizationDrafts.delete(`${mutation.accountId}:${agentId}:${kind}`);
    if (!agentManagementMutationIsCurrent(mutation)) return;
    const customization = { ...(snapshotBeforeMutation?.customization || {}) };
    customization[kind === 'agent_md' ? 'agentMd' : 'userMd'] = updated;
    agentManagementUi = {
      ...agentManagementUi,
      phase: 'ready',
      busy: false,
      snapshot: { ...snapshotBeforeMutation, customization },
      message: '已恢复默认设置，将从下一条消息开始生效。',
      customizationConflict: null,
    };
  } catch (error) {
    if (!agentManagementMutationIsCurrent(mutation)) return;
    const conflict = /revision conflict/i.test(String(error?.message || ''));
    agentManagementUi = {
      ...agentManagementUi,
      phase: 'ready',
      busy: false,
      error: conflict
        ? '这项设置已在其他位置更新，请重新读取后再恢复默认。'
        : publicError(error, '无法恢复默认设置'),
      customizationConflict: conflict ? { kind } : null,
    };
  }
  renderReady(currentState);
}

function providerSettingsView(state) {
  const profiles = providerUi.snapshot?.profiles || [];
  const probes = providerUi.snapshot?.probes || [];
  const catalog = providerUi.snapshot?.catalog || { providers: [] };
  return `
    <header class="workspace-header provider-header">
      <div>
        <p class="eyebrow">BYOK Model Providers</p>
        <h1>模型供应商</h1>
        <p>在这里添加、验证和维护模型供应商。具体 Agent 使用哪个模型，请到对应 Agent 的“模型”页设置。</p>
      </div>
      <div class="route-health"><i></i><span>本机安全存储</span><strong>${profiles.length} 个供应商</strong></div>
    </header>
    ${providerUi.message ? `<div class="provider-notice success" role="status">${escapeHtml(providerUi.message)}</div>` : ''}
    ${providerUi.error ? `<div class="provider-notice error" role="alert">${escapeHtml(providerUi.error)}</div>` : ''}
    ${providerUi.phase === 'loading' ? providerLoadingView() : ''}
    ${providerUi.phase === 'error' ? `<button class="secondary retry-providers" type="button">重新加载 Provider</button>` : ''}
    ${providerUi.phase === 'ready' ? `
      <section class="provider-column provider-only-column">
        ${providerProfileList(profiles, probes)}
      </section>
      ${providerUi.editorOpen ? providerEditorDialog(catalog, profiles) : ''}
      ${providerUi.pendingDelete ? providerDeleteDialog(profiles) : ''}
    ` : ''}
    <div class="security-row">Provider 数据由本机 Host 独占 · Renderer 只能读取公开配置状态</div>`;
}

function providerLoadingView() {
  return `
    <div class="provider-loading" role="status">
      <div class="spinner" aria-hidden="true"></div>
      <div><strong>正在读取模型供应商</strong><span>供应商、模型目录与检查记录会从本机 Host 安全读取。</span></div>
    </div>`;
}

function providerEditorDialog(catalog, profiles) {
  const editing = profiles.find((item) => item.profileId === providerUi.editingProfileId);
  const title = editing ? `编辑 ${editing.displayName}` : '配置新供应商';
  return `
    <div class="provider-modal-backdrop" data-provider-modal-backdrop>
      <section class="provider-editor-dialog" role="dialog" aria-modal="true"
        aria-labelledby="provider-editor-title" aria-describedby="provider-editor-description">
        <header class="provider-modal-header">
          <div>
            <p class="eyebrow">${editing ? 'Edit model provider' : 'Add model provider'}</p>
            <h2 id="provider-editor-title">${escapeHtml(title)}</h2>
            <p id="provider-editor-description">验证 Key、读取可用模型并完成连接测试后再保存。</p>
          </div>
          <button class="provider-modal-close" type="button" data-close-provider-editor
            aria-label="暂时关闭供应商配置">×</button>
        </header>
        <div class="provider-modal-scroll">
          ${providerUi.error ? `<div class="provider-notice error provider-modal-notice" role="alert">${escapeHtml(providerUi.error)}</div>` : ''}
          ${providerProfileEditor(catalog, profiles)}
        </div>
      </section>
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
    <form class="provider-form provider-modal-form" id="provider-profile-form"
      data-connection-test-passed="${connectionTestPassed ? 'true' : 'false'}"
      data-model-discovery-passed="${modelDiscoveryPassed ? 'true' : 'false'}"
      data-config-revision="${escapeHtml(draft?.configRevision || '0')}">
      <div class="form-grid two">
        <label class="field"><span>供应商</span>
          <select name="presetId" id="provider-preset" required>
            <option value="" ${selectedPreset ? '' : 'selected'}>请选择供应商</option>
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
        <div class="provider-secondary-actions">
          <button class="ghost" type="button" data-close-provider-editor>暂时关闭</button>
          <button class="ghost danger-text" type="button" data-discard-provider-draft>放弃更改</button>
        </div>
        <div class="provider-save-actions">
          <button class="secondary connection-test-button" id="provider-test-connection" type="button" ${providerUi.busy ? 'disabled' : ''}>测试连接</button>
          <button class="secondary provider-save-button" type="submit" ${providerUi.busy || !connectionTestPassed ? 'disabled' : ''}>安全保存</button>
        </div>
      </div>
    </form>`;
}

function providerProfileList(profiles, probes) {
  return `
    <section class="provider-list-shell">
      <div class="provider-list-toolbar">
        <div>
          <h2>已配置的模型供应商</h2>
          <p>${profiles.length
    ? `共 ${profiles.length} 个。Agent 使用哪个模型，请在对应 Agent 的“模型”页设置。`
    : '配置一个供应商后，Agent 才能选择模型并开始工作。'}</p>
        </div>
        <button class="primary provider-add-button" type="button" data-open-provider-editor>＋ 配置新供应商</button>
      </div>
      <div class="profile-stack" data-provider-count="${profiles.length}">
      ${profiles.length ? profiles.map((profile) => {
        const latestProbe = latestProviderProbe(probes, profile.profileId);
        const models = Array.isArray(profile.enabledModels) ? profile.enabledModels : [];
        const status = providerProfileStatus(profile, latestProbe);
        return `
          <article class="profile-row" data-provider-profile="${escapeHtml(profile.profileId)}">
            <div class="profile-sigil">${escapeHtml((profile.displayName || '?').slice(0, 1).toUpperCase())}</div>
            <div class="profile-copy">
              <strong>${escapeHtml(profile.displayName)}</strong>
              <span class="provider-row-status ${escapeHtml(status.code)}"><i></i>${escapeHtml(status.label)}</span>
              <small>${models.length} 个可用模型${profile.credentialConfigured
    ? ` · Key 尾号 ${escapeHtml(profile.credentialLastFour || '已配置')}`
    : ' · 尚未配置 Key'}</small>
            </div>
            <div class="row-actions">
              <button class="secondary provider-edit-button" type="button"
                data-edit-profile="${escapeHtml(profile.profileId)}">编辑</button>
              <button class="ghost danger-text provider-delete-button" type="button"
                data-delete-profile="${escapeHtml(profile.profileId)}">删除</button>
            </div>
            <details class="provider-technical-details">
              <summary>连接详情与诊断</summary>
              <div class="provider-technical-grid">
                <div><span>接口兼容方式</span><strong>${escapeHtml(protocolLabel(profile.protocol))}</strong></div>
                <div><span>接口地址</span><strong>${escapeHtml(profile.baseUrl)}</strong></div>
                <div><span>最近检查</span><strong>${latestProbe
    ? escapeHtml(formatProbeTime(latestProbe.completedAt))
    : '尚未单独检查'}</strong></div>
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
                  <button class="probe-action metadata" type="button" data-probe-profile="${escapeHtml(profile.profileId)}" data-probe-level="metadata" ${providerUi.busy || !models.length ? 'disabled' : ''}>读取元数据</button>
                  <button class="probe-action inference" type="button" data-probe-profile="${escapeHtml(profile.profileId)}" data-probe-level="minimal_inference" ${providerUi.busy || !models.length ? 'disabled' : ''}>真实响应 <i>可能计费</i></button>
                </div>
                ${probeResult(latestProbe)}
              </div>
            </details>
          </article>`;
      }).join('') : `
        <div class="empty-provider">
          <div class="empty-provider-icon" aria-hidden="true">＋</div>
          <strong>还没有模型供应商</strong>
          <p>配置一个供应商、验证 API Key 并选择可用模型后，你就可以把模型分配给具体 Agent。</p>
          <button class="secondary" type="button" data-open-provider-editor>配置第一个供应商</button>
        </div>`}
      </div>
    </section>`;
}

function latestProviderProbe(probes, profileId) {
  return probes
    .filter((probe) => probe.providerProfileId === profileId)
    .sort((left, right) => String(right.completedAt || '').localeCompare(String(left.completedAt || '')))[0]
    || null;
}

function providerProfileStatus(profile, probe) {
  if (probe?.status === 'passed') {
    if (probe.level === 'minimal_inference') return { code: 'passed', label: '最近连接可用' };
    if (probe.level === 'metadata') return { code: 'passed', label: '元数据读取成功' };
    return { code: 'passed', label: '本地配置有效' };
  }
  if (probe?.status === 'failed') {
    if (probe.level === 'minimal_inference') return { code: 'failed', label: '最近连接失败' };
    if (probe.level === 'metadata') return { code: 'failed', label: '元数据检查失败' };
    return { code: 'failed', label: '本地配置需处理' };
  }
  if (probe?.status === 'confirmation_required') return { code: 'warning', label: '需要确认后检查' };
  if (profile.credentialConfigured && profile.enabledModels?.length) {
    return { code: 'configured', label: '已配置' };
  }
  return { code: 'warning', label: '配置未完成' };
}

function providerDeleteDialog(profiles) {
  const pending = providerUi.pendingDelete;
  const profile = profiles.find((item) => item.profileId === pending?.profileId);
  if (!pending || !profile) return '';
  const affected = Array.isArray(pending.affected) ? pending.affected : [];
  return `
    <div class="provider-modal-backdrop" data-provider-delete-backdrop>
      <section class="provider-delete-dialog" role="dialog" aria-modal="true"
        aria-labelledby="provider-delete-title" aria-describedby="provider-delete-description">
        <div class="provider-delete-icon" aria-hidden="true">!</div>
        <h2 id="provider-delete-title">删除“${escapeHtml(profile.displayName)}”？</h2>
        <p id="provider-delete-description">删除后，本机不会再保留这个供应商的配置和 Key。已有对话历史不会删除。</p>
        ${affected.length ? `
          <div class="provider-delete-impact">
            <strong>${affected.length} 个 Agent 将停止发送新消息</strong>
            <ul>${affected.map((item) => `<li>${escapeHtml(agentDisplayName(item.agentId))} · ${escapeHtml(item.modelId || '模型未知')}</li>`).join('')}</ul>
          </div>
        ` : '<div class="provider-delete-impact safe"><strong>当前没有 Agent 使用这个供应商</strong></div>'}
        <div class="provider-delete-actions">
          <button class="secondary" type="button" data-cancel-provider-delete>取消</button>
          <button class="danger-button" type="button" data-confirm-provider-delete
            ${providerUi.busy ? 'disabled' : ''}>确认删除</button>
        </div>
      </section>
    </div>`;
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

function wireProviderSettings() {
  document.querySelector('.retry-providers')?.addEventListener('click', () => refreshProviderSnapshot());
  for (const button of document.querySelectorAll('[data-open-provider-editor]')) {
    button.addEventListener('click', () => openProviderEditor(null));
  }
  for (const button of document.querySelectorAll('[data-close-provider-editor]')) {
    button.addEventListener('click', () => closeProviderEditor({ discard: false }));
  }
  document.querySelector('[data-discard-provider-draft]')?.addEventListener('click', () => {
    closeProviderEditor({ discard: true });
  });
  document.querySelector('[data-provider-modal-backdrop]')?.addEventListener('mousedown', (event) => {
    if (event.target === event.currentTarget) closeProviderEditor({ discard: false });
  });
  document.getElementById('provider-preset')?.addEventListener('change', applySelectedPreset);
  const providerForm = document.getElementById('provider-profile-form');
  if (
    providerForm
    && !providerUi.editingProfileId
    && !providerDraft?.presetId
  ) {
    providerForm.elements.presetId.value = '';
  }
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
  for (const button of document.querySelectorAll('[data-edit-profile]')) {
    button.addEventListener('click', () => openProviderEditor(button.dataset.editProfile));
  }
  for (const button of document.querySelectorAll('[data-delete-profile]')) {
    button.addEventListener('click', () => prepareDeleteProviderProfile(button.dataset.deleteProfile));
  }
  document.querySelector('[data-cancel-provider-delete]')?.addEventListener('click', cancelProviderDelete);
  document.querySelector('[data-confirm-provider-delete]')?.addEventListener('click', confirmProviderDelete);
  document.querySelector('[data-provider-delete-backdrop]')?.addEventListener('mousedown', (event) => {
    if (event.target === event.currentTarget) cancelProviderDelete();
  });
  const activeModal = document.querySelector('.provider-editor-dialog, .provider-delete-dialog');
  if (activeModal) {
    activeModal.addEventListener('keydown', trapProviderModalFocus);
    requestAnimationFrame(() => {
      const preferred = activeModal.matches('.provider-editor-dialog')
        ? activeModal.querySelector('[data-close-provider-editor]')
        : activeModal.querySelector('[data-cancel-provider-delete]');
      preferred?.focus();
    });
  } else if (providerUi.focusAfterRender) {
    const selector = providerUi.focusAfterRender;
    providerUi.focusAfterRender = null;
    requestAnimationFrame(() => document.querySelector(selector)?.focus());
  }
  for (const button of document.querySelectorAll('[data-probe-profile]')) {
    button.addEventListener('click', () => runProviderProbe(button));
  }
}

function openProviderEditor(profileId) {
  const nextProfileId = profileId || null;
  if (providerDraft?.editingProfileId !== nextProfileId) providerDraft = null;
  providerUi = {
    ...providerUi,
    editorOpen: true,
    editingProfileId: nextProfileId,
    pendingDelete: null,
    error: null,
    message: null,
    focusAfterRender: null,
  };
  renderReady(currentState);
}

function closeProviderEditor({ discard }) {
  const editingProfileId = providerUi.editingProfileId;
  captureProviderDraft();
  if (discard) {
    document.getElementById('provider-profile-form')?.remove();
    providerDraft = null;
  }
  providerUi = {
    ...providerUi,
    editorOpen: false,
    editingProfileId: discard ? null : editingProfileId,
    error: null,
    focusAfterRender: editingProfileId
      ? `[data-edit-profile="${cssEscape(editingProfileId)}"]`
      : '[data-open-provider-editor]',
  };
  renderReady(currentState);
}

function cancelProviderDelete() {
  const profileId = providerUi.pendingDelete?.profileId;
  providerUi = {
    ...providerUi,
    pendingDelete: null,
    error: null,
    focusAfterRender: profileId
      ? `[data-delete-profile="${cssEscape(profileId)}"]`
      : null,
  };
  renderReady(currentState);
}

function trapProviderModalFocus(event) {
  if (event.key === 'Escape') {
    event.preventDefault();
    if (event.currentTarget.matches('.provider-editor-dialog')) {
      closeProviderEditor({ discard: false });
    } else {
      cancelProviderDelete();
    }
    return;
  }
  if (event.key !== 'Tab') return;
  const focusable = [...event.currentTarget.querySelectorAll(
    'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])',
  )].filter((element) => (
    !element.hidden
    && element.tabIndex >= 0
    && element.getClientRects().length > 0
  ));
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function cssEscape(value) {
  return String(value).replace(/["\\]/g, '\\$&');
}

async function refreshProviderSnapshot(message = null) {
  const hasSnapshot = Boolean(providerUi.snapshot);
  providerUi = {
    ...providerUi,
    phase: hasSnapshot ? 'ready' : 'loading',
    error: null,
    message,
    busy: false,
  };
  if (['providers', 'agents'].includes(workspaceView)) renderReady(currentState);
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
      phase: hasSnapshot ? 'ready' : 'error',
      error: publicError(error, '无法读取 Provider 配置'),
      message: null,
      busy: false,
    };
  }
  if (['providers', 'agents'].includes(workspaceView) && currentState.phase === 'ready') renderReady(currentState);
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
  const saved = await runProviderOperation(async () => {
    if (editingProfileId) {
      await bridge.updateProviderProfile({ profileId: editingProfileId, profile });
      if (apiKey) await bridge.replaceProviderSecret({ profileId: editingProfileId, apiKey });
    } else {
      await bridge.createProviderProfile({ profile, apiKey });
    }
  }, editingProfileId ? 'Provider 已更新，Key 输入已清空。' : 'Provider 已安全保存，Key 输入已清空。');
  if (saved) {
    document.getElementById('provider-profile-form')?.remove();
    providerDraft = null;
    providerUi = {
      ...providerUi,
      editorOpen: false,
      editingProfileId: null,
      focusAfterRender: editingProfileId
        ? `[data-edit-profile="${cssEscape(editingProfileId)}"]`
        : '[data-open-provider-editor]',
    };
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
    modelSelect.options[0].textContent = '请选择一个可用模型';
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

async function prepareDeleteProviderProfile(profileId) {
  let overview;
  try {
    overview = await bridge.getAgentModelOverview();
  } catch (error) {
    providerUi = {
      ...providerUi,
      error: publicError(error, '无法确认哪些 Agent 正在使用这个供应商，因此没有执行删除。'),
      message: null,
    };
    renderReady(currentState);
    return;
  }
  const affected = (overview?.agents || []).filter(
    (item) => item.providerProfileId === profileId,
  );
  providerUi = {
    ...providerUi,
    pendingDelete: { profileId, affected },
    error: null,
    message: null,
  };
  renderReady(currentState);
}

async function confirmProviderDelete() {
  const profileId = providerUi.pendingDelete?.profileId;
  if (!profileId) return;
  providerUi = { ...providerUi, pendingDelete: null };
  await runProviderOperation(() => bridge.deleteProviderProfile(profileId), '模型供应商已删除。');
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
    await refreshAgentOverview();
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

function agentCard(agent, index, activatingAgentId, overview = null) {
  const resident = isResident(agent);
  const activating = activatingAgentId === agent.agentId;
  const anotherActivationPending = Boolean(
    activatingAgentId
    && activatingAgentId !== agent.agentId
    && !resident,
  );
  const tones = ['tone-violet', 'tone-mint', 'tone-blue'];
  const symbol = agentInitial(agent);
  const buttonAttribute = `data-manage-agent="${escapeHtml(agent.agentId)}"`;
  const buttonLabel = activating
    ? '正在唤醒…'
    : anotherActivationPending
      ? '等待当前激活完成'
      : resident ? '打开 Agent' : '设置并激活';
  const modelSummary = overview?.modelId
    ? `${overview.providerDisplayName || '供应商不可用'} · ${overview.modelId}`
    : '尚未选择模型';
  const bindingInvalid = Boolean(
    overview?.bindingIssue
    && overview.bindingIssue.code !== 'model_not_configured',
  );
  const runtimeStatus = runtimeLabel(agent.runtimeState, agent.desiredState);
  return `
    <article class="agent-card ${tones[index % tones.length]}" data-agent-card="${escapeHtml(agent.agentId)}" tabindex="-1" aria-label="${escapeHtml(`${agent.displayName}，${runtimeStatus}`)}">
      <div class="agent-symbol">${escapeHtml(symbol)}</div>
      <h3>${escapeHtml(agent.displayName)}</h3>
      <p>${escapeHtml(agent.description)}</p>
      <div class="agent-model-summary ${bindingInvalid ? 'invalid' : ''}">
        <span>${bindingInvalid ? '模型需要处理' : '当前模型'}</span>
        <strong>${escapeHtml(modelSummary)}</strong>
      </div>
      <div class="agent-meta">
        <span class="runtime ${resident ? 'running' : ''}">${escapeHtml(runtimeStatus)}</span>
        <button class="agent-action" ${buttonAttribute} ${activating || anotherActivationPending ? 'disabled' : ''}>${buttonLabel}</button>
      </div>
    </article>`;
}

function agentInitial(agent) {
  return Array.from(String(agent?.displayName || agent?.agentId || '').trim())[0]
    ?.toUpperCase() || 'A';
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
