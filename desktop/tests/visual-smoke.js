'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');

const phase = process.env.AGENTMESH360_VISUAL_STATE || 'signed_out';
const output = process.env.AGENTMESH360_SCREENSHOT || path.join('/tmp', `agentmesh360-${phase}.png`);

app.whenReady().then(async () => {
  ipcMain.handle('identity:get-state', () => fixtureState(phase));
  for (const channel of [
    'identity:login',
    'identity:logout',
    'identity:recheck',
    'agent:activate',
    'external:open-subscription',
    'external:open-registration',
  ]) {
    ipcMain.handle(channel, () => fixtureState(phase));
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
  await new Promise((resolve) => setTimeout(resolve, 180));
  const image = await window.webContents.capturePage();
  fs.writeFileSync(output, image.toPNG());
  await app.quit();
}).catch(() => app.exit(1));

function fixtureState(selected) {
  if (selected === 'ready') {
    return {
      phase: 'ready',
      account: { id: 7, email: 'ferdinand@example.com', displayName: 'Ferdinand' },
      subscription: { status: 'active', plan: 'Pro', periodEnd: '2026-08-21 00:00:00' },
      credits: { balance: 1280 },
      access: { canEnterClient: true, reason: 'subscription_active' },
      agents: [
        { agentId: 'job-agent', displayName: 'Job Agent', description: '持续理解你的岗位目标、求职材料和当前进度。', desiredState: 'running', runtimeState: 'resident' },
        { agentId: 'lecturecast-agent', displayName: 'Lecturecast Agent', description: '把课程资料转化为可发布、可校验的音视频内容。', desiredState: 'stopped', runtimeState: 'available' },
        { agentId: 'deploy-agent', displayName: 'Deploy Agent', description: '负责发布前检查、部署执行以及上线后的证据验证。', desiredState: 'running', runtimeState: 'working' },
      ],
      checkedAt: new Date().toISOString(),
    };
  }
  if (selected === 'blocked') {
    return {
      phase: 'blocked',
      account: { id: 7, email: 'ferdinand@example.com', displayName: 'Ferdinand' },
      subscription: { status: 'expired' },
      credits: { balance: 1280 },
      access: { canEnterClient: false, reason: 'subscription_expired' },
    };
  }
  return { phase: 'signed_out' };
}
