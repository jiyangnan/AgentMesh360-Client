'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');

const opens = [];
const prompts = [];

app.whenReady().then(async () => {
  ipcMain.handle('identity:get-state', () => readyState());
  ipcMain.handle('conversation:get-snapshot', () => ({ phase: 'idle' }));
  ipcMain.handle('conversation:open', (event, agentId) => {
    opens.push(agentId);
    assert.equal(agentId, 'job-agent');
    const state = conversationState([
      { id: 'message-1', role: 'user', text: '上次的岗位分析还在吗？' },
      { id: 'message-2', role: 'assistant', text: '在，我们可以从证据匹配继续。' },
    ]);
    event.sender.send('conversation:state', state);
    return state;
  });
  ipcMain.handle('conversation:send', (event, text) => {
    prompts.push(text);
    const state = conversationState([
      { id: 'message-1', role: 'user', text: '上次的岗位分析还在吗？' },
      { id: 'message-2', role: 'assistant', text: '在，我们可以从证据匹配继续。' },
      { id: 'message-3', role: 'user', text },
      { id: 'message-4', role: 'assistant', text: '已继续分析。' },
    ]);
    event.sender.send('conversation:state', state);
    return state;
  });
  ipcMain.handle('conversation:close', () => ({ phase: 'idle' }));
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
    "document.querySelector('[data-open-conversation=\"job-agent\"]') !== null",
  ));
  const agentActions = await window.webContents.executeJavaScript(`({
    jobConversation: document.querySelector('[data-open-conversation="job-agent"]') !== null,
    lectureActivation: document.querySelector('[data-activate-agent="lecturecast-agent"]') !== null,
  })`);
  assert.deepEqual(agentActions, { jobConversation: true, lectureActivation: true });
  await window.webContents.executeJavaScript(
    "document.querySelector('[data-open-conversation=\"job-agent\"]').click()",
  );
  await waitFor(() => window.webContents.executeJavaScript(
    "document.getElementById('conversation-form') !== null",
  ));

  const openedDom = await window.webContents.executeJavaScript(`({
    body: document.body.innerText,
    messages: document.querySelectorAll('.conversation-message').length,
  })`);
  assert.deepEqual(opens, ['job-agent']);
  assert.equal(openedDom.messages, 2);
  assert.equal(openedDom.body.includes('上次的岗位分析还在吗？'), true);
  assert.equal(openedDom.body.includes('private-session-id'), false);
  assert.equal(openedDom.body.includes('/private/account-7'), false);

  await window.webContents.executeJavaScript(
    "document.querySelector('.conversation-back').click()",
  );
  await waitFor(() => window.webContents.executeJavaScript(
    "document.querySelector('[data-open-conversation=\"job-agent\"]') !== null",
  ));
  window.webContents.send('conversation:state', {
    ...conversationState([
      { id: 'message-1', role: 'assistant', text: '后台更新不应抢走当前页面。' },
    ]),
    streaming: true,
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(await window.webContents.executeJavaScript(
    "document.querySelector('[data-open-conversation=\"job-agent\"]') !== null",
  ), true);
  await window.webContents.executeJavaScript(
    "document.getElementById('nav-conversation').click()",
  );

  await window.webContents.executeJavaScript(`
    (() => {
      const form = document.getElementById('conversation-form');
      form.elements.message.value = '继续匹配这份 JD';
      form.requestSubmit();
    })()
  `);
  await waitFor(() => prompts.length === 1);
  await waitFor(() => window.webContents.executeJavaScript(
    "document.body.innerText.includes('已继续分析。')",
  ));
  assert.deepEqual(prompts, ['继续匹配这份 JD']);
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
        desiredState: 'stopped',
        runtimeState: 'available',
      },
    ],
    checkedAt: new Date().toISOString(),
  };
}

function conversationState(messages) {
  return {
    phase: 'ready',
    agentId: 'job-agent',
    displayName: 'Job Agent',
    messages,
    streaming: false,
    transcriptTruncated: false,
    error: null,
    stopReason: 'end_turn',
  };
}

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('等待对话 UI 超时');
}
