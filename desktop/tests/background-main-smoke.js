'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

const userData = process.env.AGENTMESH360_BACKGROUND_SMOKE_HOME;
assert.ok(userData, 'AGENTMESH360_BACKGROUND_SMOKE_HOME is required');
assert.ok(process.argv.includes('--agentmesh360-background'));

app.setPath('userData', userData);
let windowsCreated = 0;
const timeout = setTimeout(() => {
  process.stderr.write('background startup smoke timed out\n');
  app.exit(1);
}, 10000);

app.on('browser-window-created', () => {
  windowsCreated += 1;
});
app.on('will-quit', () => {
  clearTimeout(timeout);
  assert.equal(windowsCreated, 0);
  fs.rmSync(path.dirname(userData), { recursive: true, force: true });
  process.stdout.write('background startup: no Renderer created\n');
});

require('../src/main');
