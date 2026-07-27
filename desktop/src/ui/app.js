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
  currentState = state || { phase: 'unavailable', message: '身份状态无效' };
  if (currentState.phase === 'ready' && currentState.account?.id !== readyAccountId) {
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
    restoreConversationSnapshot(readyAccountId);
  } else if (['signed_out', 'blocked', 'unavailable'].includes(currentState.phase)) {
    readyAccountId = null;
    workspaceView = 'agents';
    providerUi.snapshot = null;
    providerUi.phase = 'idle';
    packageUi.snapshot = null;
    packageUi.phase = 'idle';
    packageUi.pendingApproval = null;
    packageUi.unknownOutcome = null;
    backgroundUi.snapshot = null;
    backgroundUi.phase = 'idle';
    conversationUi = { phase: 'idle' };
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
          <p>激活一次，长期驻留。Job Agent、Lecturecast Agent 与 Deploy Agent 会保留各自的固定主会话，随时从上次进度继续。</p>
        </div>
        <div class="resident-line"><i class="pulse" aria-hidden="true"></i>Grok Build Harness · 本地持久会话</div>
      </div>
      <div class="auth-pane">
        <form class="auth-card" id="login-form">
          <p class="eyebrow">AgentMesh360 Account</p>
          <h2>登录你的工作台</h2>
          <p class="subtitle">客户端会先验证有效订阅，再启动本地 Agent Host。</p>
          ${state.error ? `<div class="form-error" role="alert">${escapeHtml(state.error)}</div>` : ''}
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
          <div class="copy"><strong>${escapeHtml(account.displayName || 'AgentMesh360 用户')}</strong><span>${escapeHtml(account.email || '')}</span></div>
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
  for (const button of document.querySelectorAll('[data-activate-agent]')) {
    button.addEventListener('click', () => bridge.activateAgent(button.dataset.activateAgent));
  }
}

function conversationView() {
  const messages = Array.isArray(conversationUi.messages) ? conversationUi.messages : [];
  const loading = conversationUi.phase === 'loading';
  const sending = conversationUi.streaming === true;
  return `
    <section class="conversation-shell" aria-label="固定 Main Session 对话">
      <header class="conversation-header">
        <button class="ghost conversation-back" type="button">← 返回 Agent</button>
        <div>
          <p class="eyebrow">Persistent Main Session</p>
          <h1>${escapeHtml(conversationUi.displayName || 'Job Agent')}</h1>
          <p>${loading ? '正在由 Host 解析并加载固定主会话…' : '同一账号、同一 Agent、同一个持久主会话'}</p>
        </div>
        <span class="conversation-state ${sending ? 'working' : ''}">${sending ? 'Agent 正在处理' : loading ? '正在加载' : conversationUi.phase === 'error' ? '需要重新打开' : '已连接'}</span>
      </header>
      ${conversationUi.error ? `<div class="conversation-error" role="alert">${escapeHtml(conversationUi.error)}</div>` : ''}
      <div class="conversation-transcript" id="conversation-transcript" aria-live="polite">
        ${conversationUi.transcriptTruncated ? '<div class="conversation-truncated">较早内容仍保存在 Host 中，此处只显示最近消息。</div>' : ''}
        ${messages.length
    ? messages.map(conversationMessage).join('')
    : `<div class="conversation-empty">${loading ? '正在恢复历史…' : '这里会显示 Job Agent 的持久对话历史。'}</div>`}
        ${sending ? '<div class="conversation-typing"><i></i><i></i><i></i><span>Job Agent 正在继续这项工作</span></div>' : ''}
      </div>
      <form class="conversation-composer" id="conversation-form">
        <textarea name="message" maxlength="16000" rows="3" placeholder="继续上次的工作，或告诉 Job Agent 你现在需要什么…" ${loading || sending || conversationUi.phase === 'error' ? 'disabled' : ''}></textarea>
        <div>
          <span>Renderer 只接收安全文本投影；Session ID、路径和 Provider 凭据留在 Host。</span>
          <button class="secondary" type="submit" ${loading || sending || conversationUi.phase === 'error' ? 'disabled' : ''}>发送</button>
        </div>
      </form>
    </section>`;
}

function conversationMessage(message) {
  const role = message?.role === 'user' ? 'user' : 'assistant';
  return `
    <article class="conversation-message ${role}">
      <span>${role === 'user' ? '你' : 'J'}</span>
      <div><b>${role === 'user' ? '你' : escapeHtml(conversationUi.displayName || 'Job Agent')}</b><p>${escapeHtml(message?.text || '')}</p></div>
    </article>`;
}

function wireConversation() {
  document.querySelector('.conversation-back')?.addEventListener('click', () => {
    workspaceView = 'agents';
    renderReady(currentState);
  });
  const transcript = document.getElementById('conversation-transcript');
  if (transcript) transcript.scrollTop = transcript.scrollHeight;
  const form = document.getElementById('conversation-form');
  form?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const textarea = form.elements.message;
    const text = textarea.value.trim();
    if (!text) return;
    textarea.value = '';
    try {
      const state = await bridge.sendConversationMessage(text);
      conversationUi = state;
    } catch (error) {
      conversationUi = {
        ...conversationUi,
        error: publicError(error, '消息发送失败'),
      };
    }
    if (currentState.phase === 'ready') renderReady(currentState);
  });
}

async function openConversation(agentId) {
  workspaceView = 'conversation';
  conversationUi = {
    phase: 'loading',
    agentId,
    displayName: currentState.agents?.find((agent) => agent.agentId === agentId)?.displayName || agentId,
    messages: [],
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
      <div><p class="eyebrow">Persistent Agent Workspace</p><h1>欢迎回来，${escapeHtml(firstName(account))}</h1><p>${escapeHtml(subscriptionLabel(subscription))} · 订阅验证通过</p></div>
      <div class="credit-card"><span>AgentMesh360 Credits</span><strong>${formatNumber(credits.balance)}</strong></div>
    </header>
    <div class="section-head"><h2>你的专业 Agent</h2><span>${agents.filter(isResident).length} 个正在常驻</span></div>
    ${state.activationError ? `<div class="activation-error">${escapeHtml(state.activationError)}</div>` : ''}
    <div class="agent-grid">${agents.length ? agents.map((agent, index) => agentCard(agent, index, state.activatingAgentId)).join('') : '<div class="empty-agents">当前没有可用的 Agent Package。</div>'}</div>
    <div class="security-row">订阅状态已由 Core 与本地 Host 双重确认 · ${formatCheckedAt(state.checkedAt)}</div>`;
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
        <p>保存配置不会自动测试模型，也不会产生 Provider 费用。</p>
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
  const providers = Array.isArray(catalog.providers) ? catalog.providers : [];
  const selectedPreset = editing?.presetId || '';
  const enabledModels = Array.isArray(editing?.enabledModels) ? editing.enabledModels.join('\n') : '';
  return `
    <form class="control-panel provider-form" id="provider-profile-form">
      <div class="panel-kicker"><span>01</span><div><strong>${editing ? '编辑 Provider' : '接入 Provider'}</strong><small>Profile + write-only credential</small></div></div>
      <div class="form-grid two">
        <label class="field"><span>预设</span>
          <select name="presetId" id="provider-preset">
            <option value="">自定义兼容端点</option>
            ${providers.map((provider) => `<option value="${escapeHtml(provider.presetId)}" ${selectedPreset === provider.presetId ? 'selected' : ''}>${escapeHtml(provider.displayName)}</option>`).join('')}
          </select>
        </label>
        <label class="field"><span>显示名称</span><input name="displayName" maxlength="80" required value="${escapeHtml(editing?.displayName || '')}" placeholder="例如：我的 OpenAI"></label>
      </div>
      <div class="form-grid two">
        <label class="field"><span>协议</span>
          <select name="protocol" required>
            ${option('openai_responses', 'OpenAI Responses', editing?.protocol)}
            ${option('openai_chat', 'OpenAI Chat', editing?.protocol)}
            ${option('anthropic_messages', 'Anthropic Messages', editing?.protocol)}
          </select>
        </label>
        <label class="field"><span>认证</span>
          <select name="authKind" required>
            ${option('bearer_api_key', 'Bearer API Key', editing?.authKind)}
            ${option('x_api_key', 'X-API-Key', editing?.authKind)}
          </select>
        </label>
      </div>
      <label class="field"><span>Base URL</span><input name="baseUrl" type="url" required value="${escapeHtml(editing?.baseUrl || '')}" placeholder="https://api.example.com/v1"></label>
      <label class="field"><span>启用模型 <em>一行一个，也可逗号分隔</em></span><textarea name="enabledModels" rows="3" placeholder="gpt-5&#10;gpt-5-mini">${escapeHtml(enabledModels)}</textarea></label>
      <label class="field secret-field"><span>${editing ? '替换 API Key（可留空）' : 'API Key'}</span><input name="apiKey" type="password" autocomplete="off" ${editing ? '' : 'required'} placeholder="${editing ? '不修改请留空' : '仅提交给本机 Host Vault'}"><i>提交后立即清空</i></label>
      <div class="panel-actions">
        ${editing ? '<button class="ghost" id="cancel-profile-edit" type="button">取消编辑</button>' : '<span></span>'}
        <button class="secondary" type="submit" ${providerUi.busy ? 'disabled' : ''}>${editing ? '保存 Profile' : '安全保存'}</button>
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
    providerUi.editingProfileId = null;
    renderReady(currentState);
  });
  document.getElementById('provider-preset')?.addEventListener('change', applySelectedPreset);
  document.getElementById('provider-profile-form')?.addEventListener('submit', submitProviderProfile);
  document.getElementById('provider-assignment-form')?.addEventListener('submit', submitAssignment);
  document.getElementById('assignment-scope')?.addEventListener('change', syncAssignmentScope);
  syncAssignmentScope();
  for (const button of document.querySelectorAll('[data-edit-profile]')) {
    button.addEventListener('click', () => {
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
  const data = new FormData(form);
  const editingProfileId = providerUi.editingProfileId;
  const apiKey = String(data.get('apiKey') || '').trim();
  const profile = {
    presetId: String(data.get('presetId') || '') || null,
    displayName: data.get('displayName'),
    protocol: data.get('protocol'),
    baseUrl: data.get('baseUrl'),
    authKind: data.get('authKind'),
    enabledModels: parseModels(data.get('enabledModels')),
  };
  form.elements.apiKey.value = '';
  await runProviderOperation(async () => {
    if (editingProfileId) {
      await bridge.updateProviderProfile({ profileId: editingProfileId, profile });
      if (apiKey) await bridge.replaceProviderSecret({ profileId: editingProfileId, apiKey });
    } else {
      await bridge.createProviderProfile({ profile, apiKey });
    }
    providerUi.editingProfileId = null;
  }, editingProfileId ? 'Provider 已更新，Key 输入已清空。' : 'Provider 已安全保存，Key 输入已清空。');
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
  } catch (error) {
    providerUi = {
      ...providerUi,
      phase: 'ready',
      busy: false,
      error: publicError(error, 'Provider 操作失败'),
      message: null,
    };
    renderReady(currentState);
  }
}

function applySelectedPreset(event) {
  const preset = (providerUi.snapshot?.catalog?.providers || [])
    .find((item) => item.presetId === event.currentTarget.value);
  if (!preset) return;
  const form = document.getElementById('provider-profile-form');
  form.elements.displayName.value = preset.displayName || '';
  form.elements.protocol.value = preset.protocol || 'openai_responses';
  form.elements.baseUrl.value = preset.defaultBaseUrl || '';
  form.elements.authKind.value = preset.authKind || 'bearer_api_key';
  form.elements.enabledModels.value = (preset.models || []).map((model) => model.modelId).join('\n');
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
    openai_responses: 'OpenAI Responses',
    openai_chat: 'OpenAI Chat',
    anthropic_messages: 'Anthropic Messages',
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
  return message
    .replace(/sk-[A-Za-z0-9_-]+/g, '[已隐藏]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [已隐藏]')
    .slice(0, 500);
}

function agentCard(agent, index, activatingAgentId) {
  const resident = isResident(agent);
  const activating = activatingAgentId === agent.agentId;
  const symbols = ['J', 'L', 'D'];
  const tones = ['tone-violet', 'tone-mint', 'tone-blue'];
  const conversationEnabled = agent.agentId === 'job-agent';
  const buttonAttribute = conversationEnabled
    ? `data-open-conversation="${escapeHtml(agent.agentId)}"`
    : `data-activate-agent="${escapeHtml(agent.agentId)}"`;
  const buttonLabel = activating
    ? '正在唤醒…'
    : conversationEnabled
      ? resident ? '打开对话' : '激活并打开'
      : resident ? '重新唤醒' : '激活常驻';
  return `
    <article class="agent-card ${tones[index % tones.length]}">
      <div class="agent-symbol">${escapeHtml(symbols[index % symbols.length])}</div>
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
