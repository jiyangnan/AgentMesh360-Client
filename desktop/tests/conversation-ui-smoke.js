'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');

const opens = [];
const prompts = [];
const immediatePrompts = [];
const interjections = [];
const queueMutations = [];
const cancellations = [];
const permissionResponses = [];
const stagedWorkspaceFiles = [];
const selectedHistory = [];
const dictationStarts = [];
const localDictationService = Object.freeze({
  serviceId: 'macos-on-device-speech',
  displayName: 'macOS 本机听写',
  processing: 'on_device',
});
const localDictationDisclosure = '语音只在这台 Mac 上转换为文字，不会上传到 AgentMesh360；听写结果只会放入输入框，不会自动发送。';
const workspaceId = 'workspace-12345678-1234-1234-1234-123456789abc';
const historyId = 'history-1234567890abcdef1234567890abcdef';
const delayedConversationOpens = new Map();
let delayedConversationSend = null;
let delayedWorkspaceSearch = null;
const workspaceSearchCalls = [];
let conversationSendFailure = false;
let attachmentCounter = 0;
const unsafeMarkdownText = [
  '在，我们可以从**上次进度**继续。',
  '',
  '- 第一项',
  '- 第二项',
  '',
  '`安全代码`',
  '<img src=x onerror="window.__unsafeMarkdownExecuted=true">',
].join('\n');
let currentConversation = { phase: 'idle' };
let managementBindingIssue = null;

app.whenReady().then(async () => {
  ipcMain.handle('identity:get-state', () => readyState());
  ipcMain.handle('conversation:get-snapshot', () => currentConversation);
  ipcMain.handle('conversation:get-input-capabilities', () => ({
    schemaVersion: 1,
    revision: 7,
    agentId: currentConversation.agentId,
    commands: [
      {
        id: 'compact',
        trigger: '/compact',
        displayName: '压缩当前对话',
        description: '压缩较早的对话内容，同时保留当前任务需要的上下文。',
        argumentHint: '可选：说明必须保留的内容',
      },
      {
        id: 'context',
        trigger: '/context',
        displayName: '查看上下文用量',
        description: '查看当前会话的上下文窗口与用量信息。',
      },
    ],
    skills: [{
      id: 'career-profile',
      trigger: '$career-profile',
      displayName: '建立求职档案',
      description: '梳理背景、技能与求职目标。',
      promptText: '请帮我建立求职档案，并先询问缺少的信息。',
    }],
  }));
  ipcMain.handle('conversation:get-workspaces', () => ({
    schemaVersion: 1,
    agentId: currentConversation.agentId,
    workspaces: [{ workspaceId, displayName: '求职材料' }],
  }));
  ipcMain.handle('conversation:authorize-workspace', () => ({
    schemaVersion: 1,
    agentId: currentConversation.agentId,
    workspaces: [{ workspaceId, displayName: '求职材料' }],
  }));
  ipcMain.handle('conversation:revoke-workspace', () => ({
    schemaVersion: 1,
    agentId: currentConversation.agentId,
    workspaces: [],
  }));
  ipcMain.handle('conversation:search-workspace-files', async (_event, request = {}) => {
    const query = String(request.query || '');
    workspaceSearchCalls.push(query);
    const delayed = delayedWorkspaceSearch;
    delayedWorkspaceSearch = null;
    if (delayed) await delayed.promise;
    return {
      schemaVersion: 1,
      agentId: currentConversation.agentId,
      workspaces: [{ workspaceId, displayName: '求职材料' }],
      files: query.includes('岗位') || !query
        ? [{
          workspaceId,
          workspaceName: '求职材料',
          relativePath: '申请/岗位说明.pdf',
          displayPath: '申请/岗位说明.pdf',
          name: '岗位说明.pdf',
          sizeBytes: 24_801,
        }]
        : [],
    };
  });
  ipcMain.handle('conversation:stage-workspace-file', (event, request) => {
    stagedWorkspaceFiles.push(request);
    const attachment = fixtureAttachment('file', '岗位说明.pdf', 'application/pdf', 24_801);
    currentConversation = {
      ...currentConversation,
      draftAttachments: [...(currentConversation.draftAttachments || []), attachment],
    };
    event.sender.send('conversation:state', currentConversation);
    return currentConversation;
  });
  ipcMain.handle('conversation:search-prompt-history', () => ({
    schemaVersion: 1,
    agentId: currentConversation.agentId,
    history: [{ historyId, preview: '继续上次的岗位匹配分析' }],
  }));
  ipcMain.handle('conversation:select-prompt-history', (_event, selectedId) => {
    selectedHistory.push(selectedId);
    return { historyId: selectedId, text: '继续上次的岗位匹配分析，并列出下一步。' };
  });
  let dictationRevision = 0;
  const dictationState = (phase, overrides = {}) => ({
    revision: ++dictationRevision,
    phase,
    dictationId: ['starting', 'listening', 'transcribing'].includes(phase)
      ? 'dictation-fixture-1'
      : null,
    agentId: currentConversation.agentId,
    interimText: '',
    transcript: '',
    error: null,
    service: { ...localDictationService },
    limits: { maxDurationSeconds: 60, maxAudioBytes: 1_920_000 },
    disclosure: localDictationDisclosure,
    ...overrides,
  });
  let currentDictation = {
    revision: 0,
    phase: 'idle',
    dictationId: null,
    agentId: null,
    interimText: '',
    transcript: '',
    error: null,
    service: null,
    limits: { maxDurationSeconds: 60, maxAudioBytes: 1_920_000 },
    disclosure: localDictationDisclosure,
  };
  ipcMain.handle('dictation:get-snapshot', () => currentDictation);
  ipcMain.handle('dictation:open', (event) => {
    currentDictation = dictationState('idle');
    event.sender.send('dictation:state', currentDictation);
    return currentDictation;
  });
  ipcMain.handle('dictation:start', async (event, request) => {
    assert.equal(request.disclosureAccepted, true);
    dictationStarts.push(currentConversation.agentId);
    currentDictation = dictationState('starting');
    event.sender.send('dictation:state', currentDictation);
    await new Promise((resolve) => setTimeout(resolve, 80));
    currentDictation = dictationState('listening', { interimText: '这是一段' });
    event.sender.send('dictation:state', currentDictation);
    return currentDictation;
  });
  ipcMain.handle('dictation:stop', (event) => {
    currentDictation = dictationState('transcribing');
    event.sender.send('dictation:state', currentDictation);
    setTimeout(() => {
      currentDictation = dictationState('complete', { transcript: '这是一段听写结果' });
      if (!event.sender.isDestroyed()) event.sender.send('dictation:state', currentDictation);
    }, 80);
    return currentDictation;
  });
  ipcMain.handle('dictation:cancel', (event) => {
    currentDictation = dictationState('idle');
    event.sender.send('dictation:state', currentDictation);
    return currentDictation;
  });
  ipcMain.handle('dictation:close', (event) => {
    currentDictation = dictationState('idle');
    event.sender.send('dictation:state', currentDictation);
    return currentDictation;
  });
  ipcMain.handle('agent:get-model-overview', () => ({
    agents: readyState().agents.map((agent) => ({
      agentId: agent.agentId,
      providerProfileId: 'pp_test',
      providerDisplayName: 'Test Provider',
      modelId: 'test-model',
      bindingIssue: null,
      inheritedFromLegacyGlobal: false,
    })),
  }));
  ipcMain.handle('runtime:get-background-snapshot', () => ({
    host: { bridgeState: 'connected', mode: 'persistent_leader' },
    loginItem: { supported: true, openAtLogin: true },
  }));
  ipcMain.handle('provider:get-snapshot', () => ({
    profiles: [{
      profileId: 'pp_test',
      displayName: 'Test Provider',
      enabledModels: ['test-model'],
    }],
    catalog: { providers: [], catalogRevision: 1 },
    probes: [],
  }));
  ipcMain.handle('agent:get-management-snapshot', (_event, agentId) => ({
    agentId,
    profiles: [{
      profileId: 'pp_test',
      displayName: 'Test Provider',
      enabledModels: ['test-model'],
    }],
    modelBinding: {
      scopeKind: 'agent',
      scopeId: agentId,
      role: 'main',
      providerProfileId: 'pp_test',
      modelId: 'test-model',
    },
    bindingIssue: managementBindingIssue,
    inheritedFromLegacyGlobal: false,
    customization: {
      packageName: readyState().agents.find((agent) => agent.agentId === agentId)?.displayName,
      packageVersion: '1.0.0',
      packageDescription: 'Public package description',
      requestedPermissions: [],
      agentMd: { kind: 'agent_md', content: '', revision: 0, customized: false },
      userMd: { kind: 'user_md', content: '', revision: 0, customized: false },
    },
  }));
  ipcMain.handle('conversation:open', async (event, agentId) => {
    opens.push(agentId);
    assert.equal(readyState().agents.some((agent) => agent.agentId === agentId), true);
    const delayedOpen = delayedConversationOpens.get(agentId);
    if (delayedOpen) {
      delayedConversationOpens.delete(agentId);
      await delayedOpen.promise;
    }
    currentConversation = conversationState(agentId, [
      { id: 'message-1', role: 'user', text: `上次的 ${agentId} 工作还在吗？` },
      { id: 'message-2', role: 'assistant', text: unsafeMarkdownText },
    ]);
    event.sender.send('conversation:state', currentConversation);
    return currentConversation;
  });
  ipcMain.handle('conversation:pick-attachments', (event) => {
    const attachment = fixtureAttachment('file', '岗位说明.pdf', 'application/pdf', 24_801);
    currentConversation = {
      ...currentConversation,
      draftAttachments: [...(currentConversation.draftAttachments || []), attachment],
    };
    event.sender.send('conversation:state', currentConversation);
    return currentConversation;
  });
  ipcMain.handle('conversation:stage-paths', () => {
    throw new Error('fixture does not expose local paths');
  });
  ipcMain.handle('conversation:stage-bytes', (event, items) => {
    assert.equal(Array.isArray(items), true);
    assert.equal(items.length > 0, true);
    const attachments = items.map((item) => fixtureAttachment(
      'image',
      item.name,
      item.mimeType,
      item.bytes.byteLength,
    ));
    currentConversation = {
      ...currentConversation,
      draftAttachments: [...(currentConversation.draftAttachments || []), ...attachments],
    };
    event.sender.send('conversation:state', currentConversation);
    return currentConversation;
  });
  ipcMain.handle('conversation:stage-link', (event, url) => {
    const attachment = fixtureAttachment('link', new URL(url).hostname, 'text/uri-list', url.length);
    currentConversation = {
      ...currentConversation,
      draftAttachments: [...(currentConversation.draftAttachments || []), attachment],
    };
    event.sender.send('conversation:state', currentConversation);
    return currentConversation;
  });
  ipcMain.handle('conversation:discard-attachment', (event, attachmentId) => {
    currentConversation = {
      ...currentConversation,
      draftAttachments: (currentConversation.draftAttachments || [])
        .filter((attachment) => attachment.attachmentId !== attachmentId),
    };
    event.sender.send('conversation:state', currentConversation);
    return currentConversation;
  });
  ipcMain.handle('conversation:send', async (event, request) => {
    const sendingAgentId = currentConversation.agentId;
    prompts.push(request);
    const delayedSend = delayedConversationSend;
    delayedConversationSend = null;
    if (delayedSend) await delayedSend.promise;
    if (conversationSendFailure) {
      conversationSendFailure = false;
      throw new Error('fixture conversation send failed');
    }
    const completedConversation = conversationState(sendingAgentId, [
      { id: 'message-1', role: 'user', text: '上次的岗位分析还在吗？' },
      { id: 'message-2', role: 'assistant', text: '在，我们可以从证据匹配继续。' },
      { id: 'message-3', role: 'user', text: request.text || '请查看我附加的内容。' },
      { id: 'message-4', role: 'assistant', text: '已继续分析。' },
    ]);
    if (currentConversation.agentId !== sendingAgentId) return currentConversation;
    currentConversation = completedConversation;
    event.sender.send('conversation:state', completedConversation);
    return completedConversation;
  });
  ipcMain.handle('conversation:send-now', (event, request) => {
    immediatePrompts.push(request);
    currentConversation = {
      ...currentConversation,
      phase: 'sending',
      streaming: true,
      queue: {
        ...(currentConversation.queue || {}),
        confirmingCount: 1,
      },
    };
    event.sender.send('conversation:state', currentConversation);
    return currentConversation;
  });
  ipcMain.handle('conversation:interject', (event, text) => {
    interjections.push(text);
    currentConversation = {
      ...currentConversation,
      phase: 'sending',
      streaming: true,
      messages: [
        ...(currentConversation.messages || []),
        { id: `interjection-${interjections.length}`, role: 'user', text },
      ],
    };
    event.sender.send('conversation:state', currentConversation);
    return currentConversation;
  });
  for (const [channel, kind] of [
    ['conversation:queue-remove', 'remove'],
    ['conversation:queue-edit', 'edit'],
    ['conversation:queue-reorder', 'reorder'],
    ['conversation:queue-clear', 'clear'],
    ['conversation:queue-send-now', 'send-now'],
  ]) {
    ipcMain.handle(channel, (event, ...args) => {
      queueMutations.push({ kind, args });
      event.sender.send('conversation:state', currentConversation);
      return currentConversation;
    });
  }
  ipcMain.handle('conversation:cancel-current', (event) => {
    cancellations.push(currentConversation.agentId);
    currentConversation = { ...currentConversation, cancelling: true };
    event.sender.send('conversation:state', currentConversation);
    return currentConversation;
  });
  ipcMain.handle('conversation:respond-permission', (event, interactionId, optionId) => {
    permissionResponses.push({ interactionId, optionId });
    currentConversation = { ...currentConversation };
    delete currentConversation.interaction;
    event.sender.send('conversation:state', currentConversation);
    return currentConversation;
  });
  ipcMain.handle('conversation:close', () => {
    currentConversation = { phase: 'idle' };
    return currentConversation;
  });
  for (const channel of [
    'identity:login',
    'identity:logout',
    'identity:recheck',
    'agent:activate',
    'external:open-subscription',
    'external:open-registration',
  ]) {
    ipcMain.handle(channel, () => ({}));
  }

  const window = new BrowserWindow({
    width: 1180,
    height: 760,
    show: false,
    backgroundColor: '#090d16',
    webPreferences: {
      preload: path.join(__dirname, '..', 'src', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  await window.loadFile(path.join(__dirname, '..', 'src', 'ui', 'index.html'));
  await waitFor(() => window.webContents.executeJavaScript(
    "document.querySelector('[data-manage-agent=\"job-agent\"]') !== null",
  ));
  const agentActions = await window.webContents.executeJavaScript(`({
    jobAgent: document.querySelector('[data-manage-agent="job-agent"]') !== null,
    lectureAgent: document.querySelector('[data-manage-agent="lecturecast-agent"]') !== null,
    deployAgent: document.querySelector('[data-manage-agent="deploy-agent"]') !== null,
    dynamicAgent: document.querySelector('[data-manage-agent="future-agent"]') !== null,
    topLevelConversation: document.getElementById('nav-conversation') !== null,
    symbols: Array.from(document.querySelectorAll('.agent-symbol'), (node) => node.textContent),
  })`);
  assert.deepEqual(agentActions, {
    jobAgent: true,
    lectureAgent: true,
    deployAgent: true,
    dynamicAgent: true,
    topLevelConversation: false,
    symbols: ['J', 'L', 'D', 'F'],
  });
  await window.webContents.executeJavaScript(
    "document.querySelector('[data-manage-agent=\"job-agent\"]').click()",
  );
  await waitFor(() => window.webContents.executeJavaScript(
    "document.getElementById('conversation-form') !== null",
  ));

  const openedDom = await window.webContents.executeJavaScript(`(() => {
    const workspace = document.querySelector('.workspace');
    const sidebar = document.querySelector('.sidebar');
    const rail = document.querySelector('.agent-workspace-rail');
    const main = document.querySelector('.agent-workspace-main');
    const gear = document.getElementById('agent-settings-button');
    const feed = document.querySelector('.conversation-feed');
    const transcript = document.querySelector('.conversation-transcript');
    const messageBody = document.querySelector('.conversation-message-body');
    const sender = document.querySelector('.conversation-message b');
    const composer = document.querySelector('#conversation-form textarea');
    const composerAdd = document.getElementById('composer-add-button');
    const state = document.querySelector('.conversation-state');
    const gearRect = gear.getBoundingClientRect();
    const sidebarRect = sidebar.getBoundingClientRect();
    const railRect = rail.getBoundingClientRect();
    const mainRect = main.getBoundingClientRect();
    return {
      body: document.body.innerText,
      messages: document.querySelectorAll('.conversation-message').length,
      emptyGatesDisplay: getComputedStyle(document.querySelector('.conversation-gates')).display,
      hasThreeColumnWorkspace: workspace.classList.contains('agent-workspace-layout')
        && Boolean(sidebar && rail && main),
      hasPureConversation: Boolean(document.querySelector('.agent-conversation-workspace'))
        && Boolean(document.querySelector('.agent-chat-toolbar'))
        && Boolean(document.getElementById('conversation-form')),
      legacyPeerTabs: document.querySelectorAll('.agent-tabs, .agent-detail-header, .conversation-back').length,
      inlineSettings: document.querySelectorAll('[data-agent-setting]').length,
      toolbarTitles: Array.from(document.querySelectorAll('.agent-chat-identity h1'), (node) => node.textContent.trim()),
      residentAgentCount: document.querySelectorAll('[data-switch-resident-agent]').length,
      residentAgentNames: Array.from(
        document.querySelectorAll('[data-switch-resident-agent] strong'),
        (node) => node.textContent.trim(),
      ),
      activeResidentAgent: document.querySelector('[data-switch-resident-agent].active')?.dataset.switchResidentAgent,
      sessionCount: document.querySelectorAll('[data-agent-session]').length,
      activeSession: document.querySelector('[data-agent-session].active')?.dataset.agentSession,
      sessionTitle: document.querySelector('[data-agent-session="main"] strong')?.textContent.trim(),
      gearLabel: gear.getAttribute('aria-label'),
      gearWidth: gearRect.width,
      gearHeight: gearRect.height,
      messageFont: parseFloat(getComputedStyle(messageBody).fontSize),
      senderFont: parseFloat(getComputedStyle(sender).fontSize),
      composerFont: parseFloat(getComputedStyle(composer).fontSize),
      composerAddWidth: composerAdd.getBoundingClientRect().width,
      composerAddHeight: composerAdd.getBoundingClientRect().height,
      composerMenuHidden: document.getElementById('composer-tool-menu').hidden,
      composerPrivacyCopy: document.querySelector('.composer-footer span')?.textContent.trim(),
      stateFont: parseFloat(getComputedStyle(state).fontSize),
      feedWidth: feed.getBoundingClientRect().width,
      transcriptWidth: transcript.getBoundingClientRect().width,
      noDocumentOverflow: document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
      noWorkspaceOverflow: workspace.scrollWidth <= workspace.clientWidth + 1,
      columnsOrdered: sidebarRect.right <= railRect.left + 1 && railRect.right <= mainRect.left + 1,
      strongText: document.querySelector('.conversation-message.assistant strong')?.textContent,
      listTexts: Array.from(
        document.querySelectorAll('.conversation-message.assistant li'),
        (node) => node.textContent,
      ),
      codeText: document.querySelector('.conversation-message.assistant code')?.textContent,
      unsafeElements: document.querySelectorAll('.conversation-message img, .conversation-message script').length,
      unsafeExecuted: window.__unsafeMarkdownExecuted === true,
    };
  })()`);
  assert.deepEqual(opens, ['job-agent']);
  assert.equal(openedDom.messages, 2);
  assert.equal(openedDom.emptyGatesDisplay, 'none');
  assert.equal(openedDom.body.includes('上次的 job-agent 工作还在吗？'), true);
  assert.equal(openedDom.body.includes('private-session-id'), false);
  assert.equal(openedDom.body.includes('/private/account-7'), false);
  assert.equal(openedDom.hasThreeColumnWorkspace, true);
  assert.equal(openedDom.hasPureConversation, true);
  assert.equal(openedDom.legacyPeerTabs, 0);
  assert.equal(openedDom.inlineSettings, 0);
  assert.deepEqual(openedDom.toolbarTitles, ['Job Agent']);
  assert.equal(openedDom.residentAgentCount, 2);
  assert.deepEqual(openedDom.residentAgentNames, ['Job Agent', 'Lecturecast Agent']);
  assert.equal(openedDom.activeResidentAgent, 'job-agent');
  assert.equal(openedDom.sessionCount, 1);
  assert.equal(openedDom.activeSession, 'main');
  assert.equal(openedDom.sessionTitle, '主会话');
  assert.equal(openedDom.gearLabel, '打开 Job Agent 设置');
  assert.equal(openedDom.gearWidth >= 44, true);
  assert.equal(openedDom.gearHeight >= 44, true);
  assert.equal(openedDom.messageFont >= 14 && openedDom.messageFont < 15, true);
  assert.equal(openedDom.senderFont >= 12, true);
  assert.equal(openedDom.composerFont >= 15, true);
  assert.equal(openedDom.composerAddWidth >= 40, true);
  assert.equal(openedDom.composerAddHeight >= 40, true);
  assert.equal(openedDom.composerMenuHidden, true);
  assert.equal(
    openedDom.composerPrivacyCopy,
    '附件仅在本机暂存，发送时交给当前模型；不会上传到 AgentMesh360',
  );
  assert.equal(openedDom.composerPrivacyCopy.includes('Core'), false);
  assert.equal(openedDom.stateFont >= 12, true);
  assert.equal(openedDom.feedWidth <= 881, true);
  assert.equal(openedDom.feedWidth <= openedDom.transcriptWidth, true);
  assert.equal(openedDom.noDocumentOverflow, true);
  assert.equal(openedDom.noWorkspaceOverflow, true);
  assert.equal(openedDom.columnsOrdered, true);
  assert.equal(openedDom.strongText, '上次进度');
  assert.deepEqual(openedDom.listTexts, ['第一项', '第二项']);
  assert.equal(openedDom.codeText, '安全代码');
  assert.equal(openedDom.unsafeElements, 0);
  assert.equal(openedDom.unsafeExecuted, false);

  const promptsBeforeInputTools = prompts.length;
  await window.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('#conversation-form [name="message"]');
    input.value = '/';
    input.setSelectionRange(1, 1);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await waitFor(() => window.webContents.executeJavaScript(
    "Array.from(document.querySelectorAll('[data-composer-suggestion]')).some((node) => node.innerText.includes('/compact'))",
  ));
  const commandMenu = await window.webContents.executeJavaScript(`({
    visible: document.getElementById('composer-suggestions')?.hidden === false,
    positioned: getComputedStyle(document.getElementById('composer-suggestions')).position,
    hasNativeSelect: document.querySelector('#conversation-form select') !== null,
    expanded: document.querySelector('#conversation-form [name="message"]')?.getAttribute('aria-expanded'),
    activeDescendant: document.querySelector('#conversation-form [name="message"]')?.getAttribute('aria-activedescendant'),
    selectedText: document.querySelector('[data-composer-suggestion][aria-selected="true"]')?.innerText,
    text: document.getElementById('composer-suggestions')?.innerText,
  })`);
  assert.equal(commandMenu.visible, true);
  assert.equal(commandMenu.positioned, 'absolute');
  assert.equal(commandMenu.hasNativeSelect, false);
  assert.equal(commandMenu.expanded, 'true');
  assert.equal(commandMenu.activeDescendant, 'composer-suggestion-0');
  assert.equal(commandMenu.selectedText.includes('/compact'), true);
  assert.equal(commandMenu.text.includes('/compact'), true);
  assert.equal(commandMenu.text.includes('/yolo'), false);
  await window.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('#conversation-form [name="message"]');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  })()`);
  const keyboardSelection = await window.webContents.executeJavaScript(`({
    activeDescendant: document.querySelector('#conversation-form [name="message"]')?.getAttribute('aria-activedescendant'),
    selectedText: document.querySelector('[data-composer-suggestion][aria-selected="true"]')?.innerText,
  })`);
  assert.equal(keyboardSelection.activeDescendant, 'composer-suggestion-1');
  assert.equal(keyboardSelection.selectedText.includes('/context · 查看上下文用量'), true);
  await window.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('#conversation-form [name="message"]');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })()`);
  await waitFor(() => window.webContents.executeJavaScript(
    "document.querySelector('#conversation-form [name=\"message\"]')?.value === '/compact '",
  ));
  assert.deepEqual(await window.webContents.executeJavaScript(`({
    expanded: document.querySelector('#conversation-form [name="message"]')?.getAttribute('aria-expanded'),
    hidden: document.getElementById('composer-suggestions')?.hidden,
  })`), { expanded: 'false', hidden: true });
  assert.equal(prompts.length, promptsBeforeInputTools);

  await window.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('#conversation-form [name="message"]');
    input.value = '/yolo';
    input.setSelectionRange(input.value.length, input.value.length);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })()`);
  await waitFor(() => window.webContents.executeJavaScript(
    "document.body.innerText.includes('此命令未获客户端允许')",
  ));
  assert.equal(prompts.length, promptsBeforeInputTools);

  await window.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('#conversation-form [name="message"]');
    input.value = '$care';
    input.setSelectionRange(input.value.length, input.value.length);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await waitFor(() => window.webContents.executeJavaScript(
    "Array.from(document.querySelectorAll('[data-composer-suggestion]')).some((node) => node.innerText.includes('建立求职档案'))",
  ));
  await window.webContents.executeJavaScript(`(() => {
    Array.from(document.querySelectorAll('[data-composer-suggestion]'))
      .find((node) => node.innerText.includes('建立求职档案'))?.click();
  })()`);
  await waitFor(() => window.webContents.executeJavaScript(
    "document.querySelector('#conversation-form [name=\"message\"]')?.value.includes('请帮我建立求职档案')",
  ));
  assert.equal(prompts.length, promptsBeforeInputTools);

  const staleWorkspaceSearch = createBarrier();
  delayedWorkspaceSearch = staleWorkspaceSearch;
  await window.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('#conversation-form [name="message"]');
    input.value = '@旧结果';
    input.setSelectionRange(input.value.length, input.value.length);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await waitFor(() => workspaceSearchCalls.at(-1) === '旧结果' && delayedWorkspaceSearch === null);
  await window.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('#conversation-form [name="message"]');
    input.value = '@岗位';
    input.setSelectionRange(input.value.length, input.value.length);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await waitFor(() => window.webContents.executeJavaScript(
    "Array.from(document.querySelectorAll('[data-composer-suggestion]')).some((node) => node.innerText.includes('岗位说明.pdf'))",
  ));
  staleWorkspaceSearch.resolve();
  await new Promise((resolve) => setTimeout(resolve, 220));
  const fileSuggestions = await window.webContents.executeJavaScript(
    "document.getElementById('composer-suggestions')?.innerText",
  );
  assert.deepEqual(workspaceSearchCalls.slice(-2), ['旧结果', '岗位']);
  assert.equal(fileSuggestions.includes('岗位说明.pdf'), true);
  assert.equal(fileSuggestions.includes('没有找到匹配内容'), false);
  assert.equal(fileSuggestions.includes('/Users/'), false);
  assert.equal(fileSuggestions.includes(workspaceId), false);
  await window.webContents.executeJavaScript(`(() => {
    Array.from(document.querySelectorAll('[data-composer-suggestion]'))
      .find((node) => node.innerText.includes('岗位说明.pdf'))?.click();
  })()`);
  await waitFor(() => window.webContents.executeJavaScript(
    "document.querySelector('.composer-attachment-chip strong')?.textContent === '岗位说明.pdf'",
  ));
  assert.deepEqual(stagedWorkspaceFiles, [{ workspaceId, relativePath: '申请/岗位说明.pdf' }]);
  assert.equal(prompts.length, promptsBeforeInputTools);
  await window.webContents.executeJavaScript(
    "document.querySelector('.composer-attachment-chip [data-remove-attachment]').click()",
  );
  await waitFor(() => window.webContents.executeJavaScript(
    "document.querySelector('.composer-attachment-chip') === null",
  ));

  await window.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('#conversation-form [name="message"]');
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('composer-add-button').click();
    document.getElementById('composer-prompt-history').click();
  })()`);
  await waitFor(() => window.webContents.executeJavaScript(
    "Array.from(document.querySelectorAll('[data-composer-suggestion]')).some((node) => node.innerText.includes('继续上次的岗位匹配分析'))",
  ));
  await window.webContents.executeJavaScript(
    "document.querySelector('[data-composer-suggestion]').click()",
  );
  await waitFor(() => window.webContents.executeJavaScript(
    "document.querySelector('#conversation-form [name=\"message\"]')?.value.includes('列出下一步')",
  ));
  assert.deepEqual(selectedHistory, [historyId]);
  assert.equal(prompts.length, promptsBeforeInputTools);

  await window.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('#conversation-form [name="message"]');
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('.composer-dictation-button').click();
  })()`);
  await waitFor(() => window.webContents.executeJavaScript(
    "document.querySelector('.composer-suggestion-header strong')?.innerText === 'macOS 本机听写'",
  ));
  const dictationDisclosure = await window.webContents.executeJavaScript(`(() => ({
    title: document.querySelector('.composer-suggestion-header strong')?.innerText,
    disclosure: document.querySelector('.composer-suggestion-header small')?.innerText,
    actions: Array.from(
      document.querySelectorAll('[data-composer-suggestion] strong'),
      (node) => node.innerText,
    ),
    mentionsProvider: document.getElementById('composer-suggestions')?.innerText.includes('Provider'),
  }))()`);
  assert.deepEqual(dictationDisclosure, {
    title: 'macOS 本机听写',
    disclosure: localDictationDisclosure,
    actions: ['开始听写'],
    mentionsProvider: false,
  });
  assert.equal(currentDictation.phase, 'idle');
  assert.deepEqual(currentDictation.service, localDictationService);
  assert.equal(currentDictation.disclosure, localDictationDisclosure);
  assert.equal(dictationStarts.length, 0);
  assert.equal(prompts.length, promptsBeforeInputTools);
  await window.webContents.executeJavaScript(`(() => {
    Array.from(document.querySelectorAll('[data-composer-suggestion]'))
      .find((node) => node.innerText.includes('开始听写'))?.click();
  })()`);
  await waitFor(() => window.webContents.executeJavaScript(
    "document.getElementById('composer-suggestions')?.innerText.includes('正在请求麦克风')",
  ));
  await waitFor(() => dictationStarts.length === 1);
  await waitFor(() => window.webContents.executeJavaScript(
    "document.getElementById('composer-suggestions')?.innerText.includes('完成听写')",
  ));
  assert.deepEqual(currentDictation.service, localDictationService);
  await window.webContents.executeJavaScript(`(() => {
    Array.from(document.querySelectorAll('[data-composer-suggestion]'))
      .find((node) => node.innerText.includes('完成听写'))?.click();
  })()`);
  await waitFor(() => window.webContents.executeJavaScript(
    "document.getElementById('composer-suggestions')?.innerText.includes('正在把语音转换为文字')",
  ));
  await waitFor(() => window.webContents.executeJavaScript(
    "document.querySelector('#conversation-form [name=\"message\"]')?.value === '这是一段听写结果'",
  ));
  assert.deepEqual(dictationStarts, ['job-agent']);
  assert.equal(prompts.length, promptsBeforeInputTools);
  assert.equal(await window.webContents.executeJavaScript(
    "document.getElementById('composer-suggestions')?.hidden",
  ), true);
  await window.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('#conversation-form [name="message"]');
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await window.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('#conversation-form [name="message"]');
    input.focus();
    input.setSelectionRange(0, 0);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
  })()`);
  await waitFor(() => window.webContents.executeJavaScript(
    "document.getElementById('composer-suggestions')?.innerText.includes('历史消息')",
  ));
  await window.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('#conversation-form [name="message"]');
    input.value = '这是一个新的问题';
    input.setSelectionRange(input.value.length, input.value.length);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  assert.equal(await window.webContents.executeJavaScript(
    "document.getElementById('composer-suggestions')?.hidden",
  ), true);
  await window.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('#conversation-form [name="message"]');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })()`);
  await waitFor(() => prompts.length === promptsBeforeInputTools + 1);
  assert.equal(prompts.at(-1).text, '这是一个新的问题');
  prompts.length = promptsBeforeInputTools;

  const delayedLecturecastOpen = delayNextConversationOpen('lecturecast-agent');
  const raceOpenStart = opens.length;
  await window.webContents.executeJavaScript(
    "document.querySelector('[data-switch-resident-agent=\"lecturecast-agent\"]').click()",
  );
  await waitFor(() => (
    opens.length === raceOpenStart + 1
    && opens.at(-1) === 'lecturecast-agent'
  ));
  assert.equal(await window.webContents.executeJavaScript(
    "document.querySelector('[data-switch-resident-agent=\"job-agent\"]')?.disabled",
  ), false);
  await window.webContents.executeJavaScript(
    "document.querySelector('[data-switch-resident-agent=\"job-agent\"]').click()",
  );
  await waitFor(() => window.webContents.executeJavaScript(
    "document.querySelector('.agent-chat-identity h1')?.textContent.trim() === 'Job Agent'",
  ));
  assert.deepEqual(opens.slice(raceOpenStart), ['lecturecast-agent']);
  delayedLecturecastOpen.release();
  await waitFor(() => (
    opens.length === raceOpenStart + 2
    && opens.at(-1) === 'job-agent'
  ));
  await waitFor(() => window.webContents.executeJavaScript(
    "document.querySelector('#conversation-form[data-agent-id=\"job-agent\"]') !== null"
      + " && document.body.innerText.includes('上次的 job-agent 工作还在吗？')",
  ));
  const raceResult = await window.webContents.executeJavaScript(`({
    activeAgent: document.querySelector('[data-switch-resident-agent].active')?.dataset.switchResidentAgent,
    formAgent: document.querySelector('#conversation-form')?.dataset.agentId,
    hasJobHistory: document.body.innerText.includes('上次的 job-agent 工作还在吗？'),
    hasLecturecastHistory: document.body.innerText.includes('上次的 lecturecast-agent 工作还在吗？'),
    asksForRetry: document.querySelector('[data-reopen-conversation]') !== null,
  })`);
  assert.deepEqual(raceResult, {
    activeAgent: 'job-agent',
    formAgent: 'job-agent',
    hasJobHistory: true,
    hasLecturecastHistory: false,
    asksForRetry: false,
  });
  window.webContents.send('conversation:state', conversationState('lecturecast-agent', [
    { id: 'stale-lecturecast', role: 'assistant', text: '过期的 Lecturecast 推送不得覆盖 Job Agent。' },
  ]));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(await window.webContents.executeJavaScript(`({
    activeAgent: document.querySelector('[data-switch-resident-agent].active')?.dataset.switchResidentAgent,
    formAgent: document.querySelector('#conversation-form')?.dataset.agentId,
    hasStalePush: document.body.innerText.includes('过期的 Lecturecast 推送不得覆盖 Job Agent。'),
    hasJobHistory: document.body.innerText.includes('上次的 job-agent 工作还在吗？'),
  })`), {
    activeAgent: 'job-agent',
    formAgent: 'job-agent',
    hasStalePush: false,
    hasJobHistory: true,
  });

  await window.webContents.executeJavaScript(`
    (() => {
      const input = document.querySelector('#conversation-form [name="message"]');
      input.value = '未发送的 Job Agent 草稿';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('agent-settings-button').click();
    })()
  `);
  await waitFor(() => window.webContents.executeJavaScript(
    "document.getElementById('agent-model-form') !== null",
  ));
  const settingsDom = await window.webContents.executeJavaScript(`({
    hasSettingsWorkspace: document.querySelector('.agent-settings-workspace') !== null,
    hasConversationForm: document.getElementById('conversation-form') !== null,
    hasRail: document.querySelector('.agent-workspace-rail') !== null,
    labels: Array.from(document.querySelectorAll('[data-agent-setting]'), (node) => node.textContent.trim()),
    activeSetting: document.querySelector('[data-agent-setting].active')?.dataset.agentSetting,
    sessionCount: document.querySelectorAll('[data-agent-session]').length,
  })`);
  assert.deepEqual(settingsDom, {
    hasSettingsWorkspace: true,
    hasConversationForm: false,
    hasRail: true,
    labels: ['模型', '行为', '用户偏好'],
    activeSetting: 'model',
    sessionCount: 1,
  });
  await window.webContents.executeJavaScript(
    "document.querySelector('[data-agent-session=\"main\"]').click()",
  );
  await waitFor(() => window.webContents.executeJavaScript(
    "document.querySelector('#conversation-form [name=\"message\"]')?.value === '未发送的 Job Agent 草稿'",
  ));
  assert.equal(await window.webContents.executeJavaScript(
    "document.documentElement.innerHTML.includes('未发送的 Job Agent 草稿')",
  ), false);

  await window.webContents.executeJavaScript(
    "document.querySelector('[data-switch-resident-agent=\"lecturecast-agent\"]').click()",
  );
  await waitFor(() => window.webContents.executeJavaScript(
    "document.querySelector('#conversation-form[data-agent-id=\"lecturecast-agent\"]') !== null",
  ));
  assert.equal(await window.webContents.executeJavaScript(
    "document.querySelector('#conversation-form [name=\"message\"]')?.value",
  ), '');
  await window.webContents.executeJavaScript(`
    (() => {
      const input = document.querySelector('#conversation-form [name="message"]');
      input.value = '未发送的 Lecturecast Agent 草稿';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('[data-switch-resident-agent="job-agent"]').click();
    })()
  `);
  await waitFor(() => window.webContents.executeJavaScript(
    "document.querySelector('#conversation-form[data-agent-id=\"job-agent\"] [name=\"message\"]')?.value === '未发送的 Job Agent 草稿'",
  ));
  await window.webContents.executeJavaScript(
    "document.querySelector('[data-switch-resident-agent=\"lecturecast-agent\"]').click()",
  );
  await waitFor(() => window.webContents.executeJavaScript(
    "document.querySelector('#conversation-form[data-agent-id=\"lecturecast-agent\"] [name=\"message\"]')?.value === '未发送的 Lecturecast Agent 草稿'",
  ));
  await window.webContents.executeJavaScript(
    "document.querySelector('[data-switch-resident-agent=\"job-agent\"]').click()",
  );
  await waitFor(() => window.webContents.executeJavaScript(
    "document.querySelector('#conversation-form[data-agent-id=\"job-agent\"] [name=\"message\"]')?.value === '未发送的 Job Agent 草稿'",
  ));
  window.webContents.send('conversation:state', {
    ...currentConversation,
    planEntries: [
      { planId: 'plan-draft-refresh', content: '保持草稿', status: 'in_progress' },
    ],
  });
  await waitFor(() => window.webContents.executeJavaScript(
    "document.querySelector('#conversation-form [name=\"message\"]')?.value === '未发送的 Job Agent 草稿'",
  ));
  await window.webContents.executeJavaScript(`
    (() => {
      const input = document.querySelector('#conversation-form [name="message"]');
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()
  `);

  await window.webContents.executeJavaScript(
    "document.getElementById('nav-agents').click()",
  );
  await waitFor(() => window.webContents.executeJavaScript(
    "document.querySelector('[data-manage-agent=\"job-agent\"]') !== null",
  ));
  window.webContents.send('conversation:state', {
    ...conversationState('job-agent', [
      { id: 'message-1', role: 'assistant', text: '后台更新不应抢走当前页面。' },
    ]),
    streaming: true,
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(await window.webContents.executeJavaScript(
    "document.querySelector('[data-manage-agent=\"job-agent\"]') !== null",
  ), true);
  const opensBeforeBackgroundAgentSwitch = opens.length;
  assert.equal(await window.webContents.executeJavaScript(
    "document.querySelector('[data-manage-agent=\"lecturecast-agent\"]')?.disabled",
  ), false);
  await window.webContents.executeJavaScript(
    "document.querySelector('[data-manage-agent=\"lecturecast-agent\"]').click()",
  );
  await waitFor(() => window.webContents.executeJavaScript(
    "document.querySelector('#conversation-form[data-agent-id=\"lecturecast-agent\"]') !== null",
  ));
  assert.equal(opens.length, opensBeforeBackgroundAgentSwitch + 1);
  assert.deepEqual(await window.webContents.executeJavaScript(`({
    activeAgent: document.querySelector('[data-switch-resident-agent].active')
      ?.dataset.switchResidentAgent,
    jobDisabled: document.querySelector(
      '[data-switch-resident-agent="job-agent"]',
    )?.disabled,
    jobStatus: document.querySelector(
      '[data-switch-resident-agent="job-agent"] small',
    )?.innerText,
  })`), {
    activeAgent: 'lecturecast-agent',
    jobDisabled: false,
    jobStatus: '正在处理',
  });
  window.webContents.send('conversation:state', {
    ...conversationState('job-agent', [
      { id: 'late-job', role: 'assistant', text: 'Job Agent 的迟到结果不能覆盖当前对话。' },
    ]),
    streaming: false,
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(await window.webContents.executeJavaScript(`({
    activeAgent: document.querySelector('[data-switch-resident-agent].active')
      ?.dataset.switchResidentAgent,
    formAgent: document.getElementById('conversation-form')?.dataset.agentId,
    hasLateJobResult: document.body.innerText.includes('Job Agent 的迟到结果不能覆盖当前对话。'),
  })`), {
    activeAgent: 'lecturecast-agent',
    formAgent: 'lecturecast-agent',
    hasLateJobResult: false,
  });
  await window.webContents.executeJavaScript(
    "document.querySelector('[data-switch-resident-agent=\"job-agent\"]').click()",
  );
  await waitFor(() => window.webContents.executeJavaScript(
    "document.querySelector('#conversation-form[data-agent-id=\"job-agent\"]') !== null",
  ));
  await waitFor(() => window.webContents.executeJavaScript(
    "document.querySelector('.conversation-state')?.innerText === '已连接'",
  ));

  const pendingSend = createBarrier();
  delayedConversationSend = pendingSend;
  await window.webContents.executeJavaScript(`
    (() => {
      const form = document.getElementById('conversation-form');
      form.elements.message.value = '继续匹配这份 JD';
      form.requestSubmit();
    })()
  `);
  await waitFor(() => prompts.length === 1);
  window.webContents.send('conversation:state', {
    ...currentConversation,
    streaming: false,
  });
  window.webContents.send('conversation:state', { phase: 'idle' });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const opensBeforePendingSendSwitch = opens.length;
  assert.deepEqual(await window.webContents.executeJavaScript(`({
    state: document.querySelector('.conversation-state')?.innerText,
    sendDisabled: document.querySelector('#conversation-form button[type="submit"]')?.disabled,
    textareaDisabled: document.querySelector('#conversation-form textarea')?.disabled,
    addDisabled: document.getElementById('composer-add-button')?.disabled,
    composerMode: document.getElementById('conversation-form')?.dataset.composerMode,
    sendLabel: document.querySelector('#conversation-form button[type="submit"]')?.innerText,
    helper: document.querySelector('.composer-footer span')?.innerText,
    lecturecastDisabled: document.querySelector('[data-switch-resident-agent="lecturecast-agent"]')?.disabled,
  })`), {
    state: 'Agent 正在处理',
    sendDisabled: true,
    textareaDisabled: false,
    addDisabled: false,
    composerMode: 'adjust',
    sendLabel: '追加指令',
    helper: '这条要求会调整当前任务，不会创建新的排队任务',
    lecturecastDisabled: false,
  });
  await window.webContents.executeJavaScript(`
    (() => {
      const textarea = document.querySelector('#conversation-form textarea');
      textarea.value = '先核对公司名称';
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      textarea.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter',
        isComposing: true,
        bubbles: true,
        cancelable: true,
      }));
      textarea.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter',
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }));
    })()
  `);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(interjections.length, 0);
  await window.webContents.executeJavaScript(`
    (() => {
      const textarea = document.querySelector('#conversation-form textarea');
      textarea.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true,
      }));
    })()
  `);
  await waitFor(() => interjections.length === 1);
  assert.deepEqual(interjections, ['先核对公司名称']);
  await waitFor(() => window.webContents.executeJavaScript(
    "document.body.innerText.includes('先核对公司名称')"
      + " && document.querySelector('#conversation-form textarea')?.value === ''",
  ));
  await window.webContents.executeJavaScript(
    "document.querySelector('[data-switch-resident-agent=\"lecturecast-agent\"]').click()",
  );
  await waitFor(() => window.webContents.executeJavaScript(
    "document.querySelector('#conversation-form[data-agent-id=\"lecturecast-agent\"]') !== null",
  ));
  assert.equal(opens.length, opensBeforePendingSendSwitch + 1);
  await window.webContents.executeJavaScript(`
    (() => {
      const form = document.getElementById('conversation-form');
      form.elements.message.value = '同时继续课程规划';
      form.requestSubmit();
    })()
  `);
  await waitFor(() => prompts.length === 2);
  await waitFor(() => window.webContents.executeJavaScript(
    "document.body.innerText.includes('同时继续课程规划')"
      + " && document.body.innerText.includes('已继续分析。')",
  ));
  pendingSend.resolve();
  await new Promise((resolve) => setTimeout(resolve, 75));
  assert.deepEqual(await window.webContents.executeJavaScript(`({
    activeAgent: document.querySelector('[data-switch-resident-agent].active')
      ?.dataset.switchResidentAgent,
    formAgent: document.getElementById('conversation-form')?.dataset.agentId,
    hasJobPrompt: document.body.innerText.includes('继续匹配这份 JD'),
    hasLecturecastPrompt: document.body.innerText.includes('同时继续课程规划'),
    jobDisabled: document.querySelector(
      '[data-switch-resident-agent="job-agent"]',
    )?.disabled,
  })`), {
    activeAgent: 'lecturecast-agent',
    formAgent: 'lecturecast-agent',
    hasJobPrompt: false,
    hasLecturecastPrompt: true,
    jobDisabled: false,
  });
  assert.deepEqual(prompts.map((prompt) => prompt.text), ['继续匹配这份 JD', '同时继续课程规划']);
  await window.webContents.executeJavaScript(
    "document.querySelector('[data-switch-resident-agent=\"job-agent\"]').click()",
  );
  await waitFor(() => window.webContents.executeJavaScript(
    "document.querySelector('#conversation-form[data-agent-id=\"job-agent\"]') !== null",
  ));

  const pendingFailedSend = createBarrier();
  delayedConversationSend = pendingFailedSend;
  conversationSendFailure = true;
  await window.webContents.executeJavaScript(`
    (() => {
      const form = document.getElementById('conversation-form');
      form.elements.message.value = '发送失败后保留这段草稿';
      form.elements.message.dispatchEvent(new Event('input', { bubbles: true }));
      form.requestSubmit();
    })()
  `);
  await waitFor(() => prompts.length === 3);
  window.webContents.send('conversation:state', { phase: 'idle' });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(await window.webContents.executeJavaScript(`({
    state: document.querySelector('.conversation-state')?.innerText,
    sendDisabled: document.querySelector('#conversation-form button[type="submit"]')?.disabled,
    lecturecastDisabled: document.querySelector('[data-switch-resident-agent="lecturecast-agent"]')?.disabled,
  })`), {
    state: 'Agent 正在处理',
    sendDisabled: true,
    lecturecastDisabled: false,
  });
  pendingFailedSend.resolve();
  await waitFor(() => window.webContents.executeJavaScript(
    "document.querySelector('#conversation-form [name=\"message\"]')?.value === '发送失败后保留这段草稿'",
  ));
  assert.deepEqual(await window.webContents.executeJavaScript(`({
    error: document.querySelector('.conversation-error')?.innerText || '',
    lecturecastDisabled: document.querySelector('[data-switch-resident-agent="lecturecast-agent"]')?.disabled,
  })`), {
    error: '消息发送失败',
    lecturecastDisabled: false,
  });
  await window.webContents.executeJavaScript(`
    (() => {
      const input = document.querySelector('#conversation-form [name="message"]');
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()
  `);

  await window.webContents.executeJavaScript(`
    (() => {
      document.getElementById('composer-add-button').click();
      return {
        expanded: document.getElementById('composer-add-button').getAttribute('aria-expanded'),
        hidden: document.getElementById('composer-tool-menu').hidden,
        items: Array.from(document.querySelectorAll('#composer-tool-menu [role="menuitem"]'), (node) => node.innerText),
      };
    })()
  `).then((menu) => {
    assert.equal(menu.expanded, 'true');
    assert.equal(menu.hidden, false);
    assert.equal(menu.items.some((text) => text.includes('图片或文件')), true);
    assert.equal(menu.items.some((text) => text.includes('网页链接')), true);
  });
  await window.webContents.executeJavaScript(
    "document.getElementById('composer-pick-files').click()",
  );
  await waitFor(() => window.webContents.executeJavaScript(
    "document.querySelectorAll('.composer-attachment-chip').length === 1",
  ));
  await window.webContents.executeJavaScript(`
    (() => {
      document.getElementById('composer-add-button').click();
      document.getElementById('composer-add-link').click();
      const input = document.querySelector('[name="attachmentLink"]');
      input.value = 'https://example.com/research';
      document.getElementById('composer-save-link').click();
    })()
  `);
  await waitFor(() => window.webContents.executeJavaScript(
    "document.querySelectorAll('.composer-attachment-chip').length === 2",
  ));
  await window.webContents.executeJavaScript(`
    (() => {
      const file = new File([
        new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82]),
      ], 'clipboard.png', { type: 'image/png' });
      const event = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', { value: { files: [file] } });
      document.querySelector('#conversation-form textarea').dispatchEvent(event);
    })()
  `);
  await waitFor(() => window.webContents.executeJavaScript(
    "document.querySelectorAll('.composer-attachment-chip').length === 3",
  ));
  const attachmentDom = await window.webContents.executeJavaScript(`({
    names: Array.from(document.querySelectorAll('.composer-attachment-chip strong'), (node) => node.textContent),
    kinds: Array.from(document.querySelectorAll('.composer-attachment-chip'), (node) =>
      ['image', 'file', 'link'].find((kind) => node.classList.contains(kind))),
    stripOverflowX: getComputedStyle(document.querySelector('.composer-attachment-strip')).overflowX,
    sendDisabled: document.querySelector('.composer-send').disabled,
    helper: document.querySelector('.composer-footer span').textContent,
    hasPath: document.documentElement.innerHTML.includes('/private/')
      || document.documentElement.innerHTML.includes('/Users/'),
  })`);
  assert.deepEqual(attachmentDom.names, ['岗位说明.pdf', 'example.com', 'clipboard.png']);
  assert.deepEqual(attachmentDom.kinds, ['file', 'link', 'image']);
  assert.equal(attachmentDom.stripOverflowX, 'auto');
  assert.equal(attachmentDom.sendDisabled, false);
  assert.match(attachmentDom.helper, /视觉能力/u);
  assert.equal(attachmentDom.hasPath, false);
  await window.webContents.executeJavaScript(`
    (() => {
      document.querySelector('.composer-attachment-chip.file [data-remove-attachment]').click();
    })()
  `);
  await waitFor(() => window.webContents.executeJavaScript(
    "document.querySelectorAll('.composer-attachment-chip').length === 2",
  ));
  await window.webContents.executeJavaScript(`
    (() => {
      document.querySelector('.composer-attachment-chip.image [data-remove-attachment]').click();
    })()
  `);
  await waitFor(() => window.webContents.executeJavaScript(
    "document.querySelectorAll('.composer-attachment-chip').length === 1"
      + " && document.querySelector('.composer-attachment-chip.link') !== null",
  ));
  await window.webContents.executeJavaScript(
    "document.getElementById('conversation-form').requestSubmit()",
  );
  await waitFor(() => prompts.length === 4);
  assert.equal(prompts[3].text, '');
  assert.equal(prompts[3].attachmentIds.length, 1);
  await waitFor(() => window.webContents.executeJavaScript(
    "document.querySelectorAll('.composer-attachment-chip').length === 0"
      + " && document.body.innerText.includes('已继续分析。')",
  ));

  currentConversation = {
    ...currentConversation,
    streaming: true,
    activities: [
      {
        activityId: 'activity-1',
        toolKind: 'read',
        status: 'completed',
        title: 'Read /private/account-7/resume.pdf',
        rawInput: { apiKey: 'sk-private' },
      },
      {
        activityId: 'activity-2',
        toolKind: 'execute',
        status: 'in_progress',
        title: 'rm -rf /private/account-7',
      },
    ],
    backgroundTasks: [
      {
        backgroundId: 'background-1',
        kind: 'command',
        status: 'running',
        command: 'curl -H "Authorization: Bearer sk-private" https://private.example',
        cwd: '/private/account-7',
      },
      {
        backgroundId: 'background-2',
        kind: 'monitor',
        status: 'stopped',
        output: 'private monitor output',
        signal: 'session_restart',
      },
      {
        backgroundId: 'private-background-id',
        kind: 'command',
        status: 'failed',
      },
    ],
    planEntries: [
      {
        planId: 'plan-1',
        content: '核对岗位要求',
        status: 'completed',
        todoId: 'private-todo-id',
        priority: 'high',
        meta: { token: 'sk-private' },
      },
      {
        planId: 'plan-2',
        content: '运行交叉测试',
        status: 'in_progress',
      },
      {
        planId: 'private-plan-id',
        content: 'Private invalid plan',
        status: 'pending',
      },
    ],
    planStatus: 'ready',
    artifacts: [
      {
        artifactId: 'role-fit-report',
        title: '岗位匹配报告',
        kind: 'document',
        sizeBytes: 183421,
        relativePath: 'artifacts/private-report.pdf',
        downloadUrl: 'file:///private/account-7/report.pdf',
        digest: 'private-digest',
      },
      {
        artifactId: 'lecture-audio',
        title: '课程音频',
        kind: 'audio',
        sizeBytes: 2383421,
      },
      {
        artifactId: 'control-title',
        title: 'Private\u0085Title',
        kind: 'document',
        sizeBytes: 10,
      },
    ],
    project: {
      title: '产品岗位第 3 轮',
      status: 'waiting_for_user',
      summary: '请确认下一批重点岗位。',
      privatePath: '/private/account-7/round.json',
      nextCommand: 'jobagent round status',
      steps: [
        {
          stepId: 'confirm-target',
          label: '确认目标岗位',
          status: 'completed',
          privateEvidence: 'private-digest',
        },
        {
          stepId: 'review-boss',
          label: '审核 Boss 机会',
          status: 'in_progress',
        },
      ],
    },
    projectStatus: 'ready',
    interaction: {
      interactionId: 'permission-1',
      kind: 'permission',
      title: 'Run the verified deploy command',
      toolKind: 'execute',
      options: [
        { optionId: 'option-1', label: '仅本次允许', decision: 'allow' },
        { optionId: 'option-2', label: '本次拒绝', decision: 'reject' },
      ],
    },
  };
  window.webContents.send('conversation:state', currentConversation);
  await waitFor(() => window.webContents.executeJavaScript(
    "document.querySelector('[data-permission-option=\"option-1\"]') !== null",
  ));
  const permissionDom = await window.webContents.executeJavaScript(`({
    body: document.body.innerText,
    activityCount: document.querySelectorAll('[data-activity-id]').length,
    backgroundCount: document.querySelectorAll('[data-background-id]').length,
    planEntryCount: document.querySelectorAll('[data-plan-id]').length,
    artifactCount: document.querySelectorAll('[data-artifact-id]').length,
    projectCount: document.querySelectorAll('.conversation-project').length,
    projectStepCount: document.querySelectorAll('[data-project-step-id]').length,
    optionCount: document.querySelectorAll('[data-permission-option]').length,
    hasPermanentChoice: document.body.innerText.includes('永久允许'),
  })`);
  assert.equal(permissionDom.body.includes('Run the verified deploy command'), true);
  assert.equal(permissionDom.body.includes('读取资料'), true);
  assert.equal(permissionDom.body.includes('执行操作'), true);
  assert.equal(permissionDom.body.includes('已完成'), true);
  assert.equal(permissionDom.body.includes('执行中'), true);
  assert.equal(permissionDom.body.includes('后台命令'), true);
  assert.equal(permissionDom.body.includes('监控任务'), true);
  assert.equal(permissionDom.body.includes('运行中'), true);
  assert.equal(permissionDom.body.includes('已停止'), true);
  assert.equal(permissionDom.body.includes('本轮计划'), true);
  assert.equal(permissionDom.body.includes('模型工作计划，不等同于业务进度'), true);
  assert.equal(permissionDom.body.includes('核对岗位要求'), true);
  assert.equal(permissionDom.body.includes('运行交叉测试'), true);
  assert.equal(permissionDom.body.includes('岗位匹配报告'), true);
  assert.equal(permissionDom.body.includes('课程音频'), true);
  assert.equal(permissionDom.body.includes('文档'), true);
  assert.equal(permissionDom.body.includes('音频'), true);
  assert.equal(permissionDom.body.includes('产品岗位第 3 轮'), true);
  assert.equal(permissionDom.body.includes('请确认下一批重点岗位。'), true);
  assert.equal(permissionDom.body.includes('等待确认'), true);
  assert.equal(permissionDom.body.includes('确认目标岗位'), true);
  assert.equal(permissionDom.body.includes('审核 Boss 机会'), true);
  assert.equal(permissionDom.body.includes('/private/account-7'), false);
  assert.equal(permissionDom.body.includes('sk-private'), false);
  assert.equal(permissionDom.body.includes('rm -rf'), false);
  assert.equal(permissionDom.body.includes('private-digest'), false);
  assert.equal(permissionDom.body.includes('artifacts/private-report.pdf'), false);
  assert.equal(permissionDom.body.includes('jobagent round status'), false);
  assert.equal(permissionDom.body.includes('Private'), false);
  assert.equal(permissionDom.body.includes('private monitor output'), false);
  assert.equal(permissionDom.body.includes('session_restart'), false);
  assert.equal(permissionDom.body.includes('private.example'), false);
  assert.equal(permissionDom.body.includes('private-todo-id'), false);
  assert.equal(permissionDom.body.includes('Private invalid plan'), false);
  assert.equal(permissionDom.activityCount, 2);
  assert.equal(permissionDom.backgroundCount, 2);
  assert.equal(permissionDom.planEntryCount, 2);
  assert.equal(permissionDom.artifactCount, 2);
  assert.equal(permissionDom.projectCount, 1);
  assert.equal(permissionDom.projectStepCount, 2);
  assert.equal(permissionDom.optionCount, 2);
  assert.equal(permissionDom.hasPermanentChoice, false);
  await window.webContents.executeJavaScript(`
    (() => {
      const button = document.querySelector('[data-permission-option="option-1"]');
      button.click();
      button.click();
    })()
  `);
  await waitFor(() => permissionResponses.length === 1);
  assert.deepEqual(permissionResponses, [{
    interactionId: 'permission-1',
    optionId: 'option-1',
  }]);
  assert.equal(await window.webContents.executeJavaScript(
    "document.body.innerText.includes('权限请求已失效')",
  ), false);

  await window.reload();
  await waitFor(() => window.webContents.executeJavaScript(
    "document.body.innerText.includes('已继续分析。')",
  ));
  assert.equal(await window.webContents.executeJavaScript(
    "document.getElementById('conversation-form') !== null",
  ), true);

  currentConversation = {
    ...currentConversation,
    backgroundTasks: [{
      backgroundId: 'background-unsafe',
      kind: 'command',
      status: 'running',
      command: 'private unavailable command',
    }],
    backgroundStatus: 'unavailable',
  };
  window.webContents.send('conversation:state', currentConversation);
  await waitFor(() => window.webContents.executeJavaScript(
    "document.body.innerText.includes('后台活动状态暂时不可用。')",
  ));
  assert.equal(await window.webContents.executeJavaScript(
    "document.body.innerText.includes('private unavailable command')",
  ), false);

  currentConversation = {
    ...currentConversation,
    planEntries: [{
      planId: 'plan-unsafe',
      content: 'private unavailable plan',
      status: 'pending',
    }],
    planStatus: 'unavailable',
  };
  window.webContents.send('conversation:state', currentConversation);
  await waitFor(() => window.webContents.executeJavaScript(
    "document.body.innerText.includes('本轮计划暂时不可用。')",
  ));
  assert.equal(await window.webContents.executeJavaScript(
    "document.body.innerText.includes('private unavailable plan')",
  ), false);

  currentConversation = conversationState('job-agent', [
    { id: 'paste-message-1', role: 'assistant', text: '可以粘贴长材料。' },
  ]);
  window.webContents.send('conversation:state', currentConversation);
  await waitFor(() => window.webContents.executeJavaScript(
    "document.querySelector('#conversation-form[data-agent-id=\"job-agent\"]') !== null",
  ));
  const promptsBeforeLargePaste = prompts.length;
  await window.webContents.executeJavaScript(`
    (() => {
      const textarea = document.querySelector('#conversation-form textarea');
      const event = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', {
        value: {
          files: [],
          getData: (kind) => kind === 'text/plain' ? '岗位材料一行\\n'.repeat(220) : '',
        },
      });
      textarea.dispatchEvent(event);
    })()
  `);
  await waitFor(() => window.webContents.executeJavaScript(
    "document.querySelector('.composer-paste-card') !== null",
  ));
  assert.deepEqual(await window.webContents.executeJavaScript(`({
    cardCount: document.querySelectorAll('.composer-paste-card').length,
    textareaValue: document.querySelector('#conversation-form textarea')?.value,
    sendDisabled: document.querySelector('.composer-send')?.disabled,
    showsFullPaste: document.querySelector('.composer-paste-card')?.innerText.includes('岗位材料一行'),
  })`), {
    cardCount: 1,
    textareaValue: '',
    sendDisabled: false,
    showsFullPaste: false,
  });
  await window.webContents.executeJavaScript(
    "document.querySelector('#conversation-form').requestSubmit()",
  );
  await waitFor(() => prompts.length === promptsBeforeLargePaste + 1);
  assert.equal(prompts.at(-1).text.startsWith('岗位材料一行\n岗位材料一行'), true);
  assert.equal(prompts.at(-1).text.includes('AgentMesh360 Core'), false);

  currentConversation = {
    ...conversationState('job-agent', [
      { id: 'queue-message-1', role: 'assistant', text: '当前任务仍在执行。' },
    ]),
    phase: 'sending',
    streaming: true,
    queue: {
      revision: 7,
      synced: true,
      running: true,
      confirmingCount: 0,
      entries: [
        { queueId: 'queue-1', version: 1, position: 0, text: '核对第一家公司', editable: true },
        { queueId: 'queue-2', version: 1, position: 1, text: '更新第二份简历', editable: true },
        { queueId: 'queue-3', version: 1, position: 2, text: '准备第三轮面试', editable: true },
        { queueId: 'queue-4', version: 1, position: 3, text: '来自其他客户端', editable: false },
      ],
    },
  };
  window.webContents.send('conversation:state', currentConversation);
  await waitFor(() => window.webContents.executeJavaScript(
    "document.querySelector('.conversation-queue-summary')?.innerText.includes('待处理 4 条')",
  ));
  assert.deepEqual(await window.webContents.executeJavaScript(`({
    compactHeight: document.querySelector('.conversation-queue')?.getBoundingClientRect().height,
    visibleItems: document.querySelectorAll('.conversation-queue-item').length,
    composerVisible: document.querySelector('#conversation-form')?.getBoundingClientRect().bottom <= window.innerHeight,
    addDisabled: document.getElementById('composer-add-button')?.disabled,
  })`), {
    compactHeight: 40,
    visibleItems: 3,
    composerVisible: true,
    addDisabled: false,
  });

  const promptsBeforeRunningAttachment = prompts.length;
  const interjectionsBeforeRunningAttachment = interjections.length;
  await window.webContents.executeJavaScript(`(() => {
    document.getElementById('composer-add-button').click();
    document.getElementById('composer-pick-files').click();
  })()`);
  await waitFor(() => window.webContents.executeJavaScript(
    "document.getElementById('conversation-form')?.dataset.composerMode === 'queue'"
      + " && document.querySelectorAll('.composer-attachment-chip').length === 1",
  ));
  assert.deepEqual(await window.webContents.executeJavaScript(`({
    mode: document.getElementById('conversation-form')?.dataset.composerMode,
    label: document.querySelector('.composer-send')?.innerText,
    helper: document.querySelector('.composer-footer span')?.innerText,
    sendDisabled: document.querySelector('.composer-send')?.disabled,
  })`), {
    mode: 'queue',
    label: '排队发送',
    helper: '这条消息会进入待处理队列；附件会跟随这条消息保留',
    sendDisabled: false,
  });
  assert.equal(prompts.length, promptsBeforeRunningAttachment);
  assert.equal(interjections.length, interjectionsBeforeRunningAttachment);
  await window.webContents.executeJavaScript(
    "document.querySelector('.composer-attachment-chip [data-remove-attachment]').click()",
  );
  await waitFor(() => window.webContents.executeJavaScript(
    "document.querySelector('.composer-attachment-chip') === null"
      + " && document.getElementById('conversation-form')?.dataset.composerMode === 'adjust'",
  ));
  assert.deepEqual(await window.webContents.executeJavaScript(`({
    mode: document.getElementById('conversation-form')?.dataset.composerMode,
    label: document.querySelector('.composer-send')?.innerText,
    helper: document.querySelector('.composer-footer span')?.innerText,
  })`), {
    mode: 'adjust',
    label: '追加指令',
    helper: '这条要求会调整当前任务，不会创建新的排队任务',
  });
  assert.equal(prompts.length, promptsBeforeRunningAttachment);
  assert.equal(interjections.length, interjectionsBeforeRunningAttachment);

  await window.webContents.executeJavaScript(
    "document.querySelector('[data-toggle-queue]').click()",
  );
  await waitFor(() => window.webContents.executeJavaScript(
    "document.querySelector('.conversation-queue.expanded') !== null"
      + " && document.querySelectorAll('.conversation-queue-item').length === 4",
  ));
  await window.webContents.executeJavaScript(
    "document.querySelector('[data-queue-down=\"queue-1\"]').click()",
  );
  await waitFor(() => queueMutations.some((entry) => entry.kind === 'reorder'));
  assert.deepEqual(
    queueMutations.find((entry) => entry.kind === 'reorder')?.args[0],
    ['queue-2', 'queue-1', 'queue-3', 'queue-4'],
  );
  await window.webContents.executeJavaScript(
    "document.querySelector('[data-queue-edit=\"queue-1\"]').click()",
  );
  await waitFor(() => window.webContents.executeJavaScript(
    "document.querySelector('.queue-edit-input') !== null",
  ));
  await window.webContents.executeJavaScript(`
    (() => {
      const input = document.querySelector('.queue-edit-input');
      input.value = '核对第一家公司和岗位';
      document.querySelector('[data-queue-save="queue-1"]').click();
    })()
  `);
  await waitFor(() => queueMutations.some((entry) => entry.kind === 'edit'));
  assert.deepEqual(
    queueMutations.find((entry) => entry.kind === 'edit')?.args,
    ['queue-1', '核对第一家公司和岗位'],
  );
  await window.webContents.executeJavaScript(
    "document.querySelector('[data-queue-now=\"queue-2\"]').click()",
  );
  await waitFor(() => queueMutations.some((entry) => entry.kind === 'send-now'));
  await window.webContents.executeJavaScript(
    "document.querySelector('.composer-stop').click()",
  );
  await waitFor(() => cancellations.length === 1);
  assert.deepEqual(cancellations, ['job-agent']);

  await window.webContents.executeJavaScript(
    "document.querySelector('.composer-intent-toggle').click();"
      + " document.querySelector('[data-composer-intent=\"now\"]').click();",
  );
  await waitFor(() => window.webContents.executeJavaScript(
    "document.getElementById('conversation-form')?.dataset.composerMode === 'now'",
  ));
  await window.webContents.executeJavaScript(`
    (() => {
      const form = document.getElementById('conversation-form');
      form.elements.message.value = '立即处理这条高优先级要求';
      form.requestSubmit();
    })()
  `);
  await waitFor(() => immediatePrompts.length === 1);
  assert.deepEqual(immediatePrompts, [{
    text: '立即处理这条高优先级要求',
    attachmentIds: [],
  }]);

  currentConversation = {
    ...currentConversation,
    phase: 'error',
    streaming: false,
    error: '后台连接已恢复，请重新打开对话以继续。',
  };
  window.webContents.send('conversation:state', currentConversation);
  await waitFor(() => window.webContents.executeJavaScript(
    "document.querySelector('[data-reopen-conversation=\"job-agent\"]') !== null",
  ));
  const opensBeforeReconnectRetry = opens.length;
  await window.webContents.executeJavaScript(
    "document.querySelector('[data-reopen-conversation=\"job-agent\"]').click()",
  );
  await waitFor(() => opens.length === opensBeforeReconnectRetry + 1);
  assert.equal(opens.at(-1), 'job-agent');

  currentConversation = conversationState('job-agent', [
    { id: 'restored-1', role: 'assistant', text: '这是重启后恢复的历史。' },
  ]);
  managementBindingIssue = {
    code: 'provider_unavailable',
    message: '原模型供应商已被删除或不可用，请重新选择。',
  };
  const restoreWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    show: false,
    backgroundColor: '#090d16',
    webPreferences: {
      preload: path.join(__dirname, '..', 'src', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  await restoreWindow.loadFile(path.join(__dirname, '..', 'src', 'ui', 'index.html'));
  await waitFor(() => restoreWindow.webContents.executeJavaScript(
    "document.getElementById('conversation-fix-model') !== null",
  ));
  assert.deepEqual(await restoreWindow.webContents.executeJavaScript(`({
    restored: document.body.innerText.includes('这是重启后恢复的历史。'),
    textareaDisabled: document.querySelector('#conversation-form textarea')?.disabled,
    sendDisabled: document.querySelector('#conversation-form button[type="submit"]')?.disabled,
  })`), {
    restored: true,
    textareaDisabled: true,
    sendDisabled: true,
  });
  restoreWindow.destroy();
  await app.quit();
}).catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  app.exit(1);
});

function readyState() {
  return {
    phase: 'ready',
    account: { id: 7, email: 'ferdinand@example.com', displayName: 'Ferdinand' },
    subscription: { status: 'active', plan: 'Pro', periodEnd: '2026-08-21 00:00:00' },
    credits: { balance: 1280 },
    access: { canEnterClient: true, reason: 'subscription_active' },
    agents: [
      {
        agentId: 'job-agent',
        displayName: 'Job Agent',
        description: '持续理解你的岗位目标、求职材料和当前进度。',
        desiredState: 'running',
        runtimeState: 'resident',
      },
      {
        agentId: 'lecturecast-agent',
        displayName: 'Lecturecast Agent',
        description: '把课程资料转化为可发布、可校验的音视频内容。',
        desiredState: 'running',
        runtimeState: 'resident',
      },
      {
        agentId: 'deploy-agent',
        displayName: 'Deploy Agent',
        description: '负责发布前检查、部署执行以及上线后的证据验证。',
        desiredState: 'stopped',
        runtimeState: 'available',
      },
      {
        agentId: 'future-agent',
        displayName: 'Future Agent',
        description: '通过动态 Agent Package 安装的未来 Agent。',
        desiredState: 'stopped',
        runtimeState: 'available',
      },
    ],
    checkedAt: new Date().toISOString(),
  };
}

function fixtureAttachment(kind, name, mimeType, sizeBytes) {
  attachmentCounter += 1;
  const suffix = attachmentCounter.toString(16).padStart(12, '0');
  return {
    attachmentId: `attachment-00000000-0000-4000-8000-${suffix}`,
    kind,
    name,
    mimeType,
    sizeBytes,
  };
}

function conversationState(agentId, messages) {
  const displayName = readyState().agents
    .find((agent) => agent.agentId === agentId)?.displayName || agentId;
  return {
    phase: 'ready',
    agentId,
    displayName,
    messages,
    activities: [],
    backgroundTasks: [],
    backgroundStatus: 'ready',
    planEntries: [],
    planStatus: 'ready',
    artifacts: [],
    project: null,
    projectStatus: 'ready',
    streaming: false,
    transcriptTruncated: false,
    draftAttachments: [],
    queue: {
      revision: 1,
      synced: true,
      running: false,
      entries: [],
      confirmingCount: 0,
    },
    error: null,
    stopReason: 'end_turn',
  };
}

function delayNextConversationOpen(agentId) {
  assert.equal(delayedConversationOpens.has(agentId), false);
  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  const delayedOpen = { promise, release };
  delayedConversationOpens.set(agentId, delayedOpen);
  return delayedOpen;
}

function createBarrier() {
  let resolve;
  const promise = new Promise((release) => {
    resolve = release;
  });
  return { promise, resolve };
}

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('等待对话 UI 超时');
}
