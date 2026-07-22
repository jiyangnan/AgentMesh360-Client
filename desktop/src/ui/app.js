'use strict';

const bridge = window.agentmesh360;
const root = document.getElementById('app');
let currentState = { phase: 'starting' };

bridge.onState(render);
bridge.getState().then(render).catch(() => render({
  phase: 'unavailable',
  message: '桌面身份服务没有响应',
  canLogout: false,
}));

function render(state) {
  currentState = state || { phase: 'unavailable', message: '身份状态无效' };
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
  const subscription = state.subscription || {};
  const credits = state.credits || {};
  const agents = Array.isArray(state.agents) ? state.agents : [];
  root.innerHTML = `
    <section class="shell workspace">
      <aside class="sidebar">
        ${brand()}
        <p class="nav-label">Workspace</p>
        <div class="nav-item active"><i class="nav-dot"></i>常驻 Agent</div>
        <div class="nav-item"><i class="nav-dot"></i>会话 <span class="muted">后续</span></div>
        <div class="nav-item"><i class="nav-dot"></i>设置 <span class="muted">后续</span></div>
        <div class="sidebar-spacer"></div>
        <div class="sidebar-account">
          <div class="avatar">${escapeHtml(initials(account))}</div>
          <div class="copy"><strong>${escapeHtml(account.displayName || 'AgentMesh360 用户')}</strong><span>${escapeHtml(account.email || '')}</span></div>
          <button class="ghost" id="logout" title="退出登录">↗</button>
        </div>
      </aside>
      <main class="workspace-main">
        <header class="workspace-header">
          <div><p class="eyebrow">Persistent Agent Workspace</p><h1>欢迎回来，${escapeHtml(firstName(account))}</h1><p>${escapeHtml(subscriptionLabel(subscription))} · 订阅验证通过</p></div>
          <div class="credit-card"><span>AgentMesh360 Credits</span><strong>${formatNumber(credits.balance)}</strong></div>
        </header>
        <div class="section-head"><h2>你的专业 Agent</h2><span>${agents.filter(isResident).length} 个正在常驻</span></div>
        ${state.activationError ? `<div class="activation-error">${escapeHtml(state.activationError)}</div>` : ''}
        <div class="agent-grid">${agents.length ? agents.map((agent, index) => agentCard(agent, index, state.activatingAgentId)).join('') : '<div class="empty-agents">当前没有可用的 Agent Package。</div>'}</div>
        <div class="security-row">订阅状态已由 Core 与本地 Host 双重确认 · ${formatCheckedAt(state.checkedAt)}</div>
      </main>
    </section>`;
  document.getElementById('logout').addEventListener('click', () => bridge.logout());
  for (const button of document.querySelectorAll('[data-agent-id]')) {
    button.addEventListener('click', () => bridge.activateAgent(button.dataset.agentId));
  }
}

function agentCard(agent, index, activatingAgentId) {
  const resident = isResident(agent);
  const activating = activatingAgentId === agent.agentId;
  const symbols = ['J', 'L', 'D'];
  const tones = ['tone-violet', 'tone-mint', 'tone-blue'];
  return `
    <article class="agent-card ${tones[index % tones.length]}">
      <div class="agent-symbol">${escapeHtml(symbols[index % symbols.length])}</div>
      <h3>${escapeHtml(agent.displayName)}</h3>
      <p>${escapeHtml(agent.description)}</p>
      <div class="agent-meta">
        <span class="runtime ${resident ? 'running' : ''}">${escapeHtml(runtimeLabel(agent.runtimeState, agent.desiredState))}</span>
        <button class="agent-action" data-agent-id="${escapeHtml(agent.agentId)}" ${activating ? 'disabled' : ''}>${activating ? '正在唤醒…' : resident ? '打开对话' : '激活常驻'}</button>
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
