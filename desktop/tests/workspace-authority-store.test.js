'use strict';

const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  ConversationAttachmentStore,
  MAX_ATTACHMENT_BYTES,
} = require('../src/conversation-attachment-store');
const {
  WorkspaceAuthorityStore,
} = require('../src/workspace-authority-store');

const SCOPE = Object.freeze({ accountId: 'account-7', agentId: 'job-agent' });

async function fixture(t, { fsPromises = fsp } = {}) {
  const parent = await fsp.mkdtemp(path.join(os.tmpdir(), 'agentmesh-workspace-authority-'));
  const workspaceRoot = path.join(parent, '用户项目😊');
  const attachmentStore = new ConversationAttachmentStore({
    rootDir: path.join(parent, 'private-attachments'),
  });
  await fsp.mkdir(workspaceRoot, { recursive: true });
  await attachmentStore.initialize();
  const authorityStore = new WorkspaceAuthorityStore({
    rootDir: path.join(parent, 'private-authority'),
    attachmentStore,
    fsPromises,
  });
  await authorityStore.initialize();
  t.after(async () => {
    await authorityStore.dispose().catch(() => {});
    await attachmentStore.dispose().catch(() => {});
    await fsp.rm(parent, { recursive: true, force: true });
  });
  return { parent, workspaceRoot, attachmentStore, authorityStore };
}

test('projects only opaque workspace ids and relative Unicode-safe file results, then stages through the private attachment store', async (t) => {
  const { workspaceRoot, attachmentStore, authorityStore } = await fixture(t);
  await fsp.mkdir(path.join(workspaceRoot, '资料'));
  await fsp.writeFile(path.join(workspaceRoot, '资料', '中文简历😊.md'), '# 简历\nAgent 工程');
  await fsp.writeFile(path.join(workspaceRoot, 'Cafe\u0301.md'), 'decomposed filename');
  await fsp.writeFile(path.join(workspaceRoot, 'notes.txt'), 'notes');

  const workspace = await authorityStore.authorizeRoot({ ...SCOPE, rootPath: workspaceRoot });
  const listed = authorityStore.list(SCOPE);
  assert.deepEqual(listed, [workspace]);
  assert.match(workspace.workspaceId, /^workspace-/u);
  assert.equal(Object.hasOwn(workspace, 'rootPath'), false);
  assert.equal(JSON.stringify(workspace).includes(workspaceRoot), false);

  const results = await authorityStore.searchFiles({
    ...SCOPE,
    workspaceId: workspace.workspaceId,
    query: '中文简历😊',
  });
  assert.equal(results.length, 1);
  assert.deepEqual(results[0], {
    workspaceId: workspace.workspaceId,
    relativePath: '资料/中文简历😊.md',
    displayPath: '资料/中文简历😊.md',
    name: '中文简历😊.md',
    mimeType: 'text/markdown',
    sizeBytes: Buffer.byteLength('# 简历\nAgent 工程'),
  });
  assert.equal(JSON.stringify(results).includes(workspaceRoot), false);
  assert.equal(JSON.stringify(results).includes('cwd'), false);
  assert.equal(JSON.stringify(results).includes('sessionId'), false);

  const decomposed = await authorityStore.searchFiles({
    ...SCOPE,
    workspaceId: workspace.workspaceId,
    query: 'Café',
  });
  assert.equal(decomposed[0].relativePath, 'Cafe\u0301.md');
  const decomposedStage = await authorityStore.stageAttachment({
    ...SCOPE,
    workspaceId: workspace.workspaceId,
    relativePath: decomposed[0].relativePath,
  });
  assert.equal(decomposedStage.attachment.name, 'Cafe\u0301.md');

  const staged = await authorityStore.stageAttachment({
    ...SCOPE,
    workspaceId: workspace.workspaceId,
    relativePath: results[0].relativePath,
  });
  assert.equal(staged.reference.relativePath, '资料/中文简历😊.md');
  assert.equal(staged.attachment.name, '中文简历😊.md');
  assert.equal(attachmentStore.list(SCOPE).length, 2);
  assert.equal(JSON.stringify(staged).includes(workspaceRoot), false);

  // This is deliberately a Main-only adapter and is the sole API that returns cwd.
  const privateContext = await authorityStore.getPrivateHostContext({
    ...SCOPE,
    workspaceId: workspace.workspaceId,
  });
  assert.equal(privateContext.cwd, await fsp.realpath(workspaceRoot));
});

test('rejects absolute and parent paths, excludes symlink escapes, and enforces size and type allowlists', async (t) => {
  const { parent, workspaceRoot, authorityStore } = await fixture(t);
  const outside = path.join(parent, 'outside-secret.md');
  await fsp.writeFile(outside, 'secret');
  await fsp.symlink(outside, path.join(workspaceRoot, 'escape.md'));
  await fsp.writeFile(path.join(workspaceRoot, 'payload.bin'), Buffer.from([1, 2, 3]));
  await fsp.writeFile(path.join(workspaceRoot, 'normal.md'), 'normal');
  const tooLarge = path.join(workspaceRoot, 'huge.txt');
  await fsp.writeFile(tooLarge, 'x');
  await fsp.truncate(tooLarge, MAX_ATTACHMENT_BYTES + 1);
  const workspace = await authorityStore.authorizeRoot({ ...SCOPE, rootPath: workspaceRoot });

  const results = await authorityStore.searchFiles({
    ...SCOPE,
    workspaceId: workspace.workspaceId,
    query: '',
    limit: 50,
  });
  assert.deepEqual(results.map((item) => item.relativePath), ['normal.md']);

  await assert.rejects(
    authorityStore.stageAttachment({
      ...SCOPE,
      workspaceId: workspace.workspaceId,
      relativePath: outside,
    }),
    /相对路径/u,
  );
  await assert.rejects(
    authorityStore.stageAttachment({
      ...SCOPE,
      workspaceId: workspace.workspaceId,
      relativePath: '../outside-secret.md',
    }),
    /跳出工作区/u,
  );
  await assert.rejects(
    authorityStore.stageAttachment({
      ...SCOPE,
      workspaceId: workspace.workspaceId,
      relativePath: 'escape.md',
    }),
    /超出已授权工作区/u,
  );
  await assert.rejects(
    authorityStore.stageAttachment({
      ...SCOPE,
      workspaceId: workspace.workspaceId,
      relativePath: 'payload.bin',
    }),
    /文件类型/u,
  );
  await assert.rejects(
    authorityStore.stageAttachment({
      ...SCOPE,
      workspaceId: workspace.workspaceId,
      relativePath: 'huge.txt',
    }),
    /20 MB/u,
  );
});

test('isolates workspace authority by account and Agent, persists valid roots, and denies every access after revocation', async (t) => {
  const { parent, workspaceRoot, authorityStore } = await fixture(t);
  await fsp.writeFile(path.join(workspaceRoot, 'private.md'), 'private');
  const workspace = await authorityStore.authorizeRoot({ ...SCOPE, rootPath: workspaceRoot });
  const duplicate = await authorityStore.authorizeRoot({ ...SCOPE, rootPath: workspaceRoot });
  assert.equal(duplicate.workspaceId, workspace.workspaceId);
  assert.deepEqual(authorityStore.list({ accountId: 'account-8', agentId: 'job-agent' }), []);

  await assert.rejects(
    authorityStore.searchFiles({
      accountId: 'account-8',
      agentId: 'job-agent',
      workspaceId: workspace.workspaceId,
      query: 'private',
    }),
    /未授权或已撤销/u,
  );
  await assert.rejects(
    authorityStore.revoke({
      accountId: 'account-7',
      agentId: 'deploy-agent',
      workspaceId: workspace.workspaceId,
    }),
    /未授权或已撤销/u,
  );

  await authorityStore.dispose();
  const restored = new WorkspaceAuthorityStore({
    rootDir: path.join(parent, 'private-authority'),
    attachmentStore: { stageBytes: async () => [] },
  });
  await restored.initialize();
  t.after(() => restored.dispose().catch(() => {}));
  assert.equal(restored.list(SCOPE)[0].workspaceId, workspace.workspaceId);
  await restored.revoke({ ...SCOPE, workspaceId: workspace.workspaceId });
  assert.deepEqual(restored.list(SCOPE), []);
  await assert.rejects(
    restored.searchFiles({ ...SCOPE, workspaceId: workspace.workspaceId, query: '' }),
    /未授权或已撤销/u,
  );
  await assert.rejects(
    restored.getPrivateHostContext({ ...SCOPE, workspaceId: workspace.workspaceId }),
    /未授权或已撤销/u,
  );
});

test('invalidates authority if an approved root is replaced at the same path', async (t) => {
  const { workspaceRoot, authorityStore } = await fixture(t);
  await fsp.writeFile(path.join(workspaceRoot, 'note.md'), 'original');
  const workspace = await authorityStore.authorizeRoot({ ...SCOPE, rootPath: workspaceRoot });
  const oldRoot = `${workspaceRoot}-old`;
  await fsp.rename(workspaceRoot, oldRoot);
  await fsp.mkdir(workspaceRoot);
  await fsp.writeFile(path.join(workspaceRoot, 'note.md'), 'replacement');

  await assert.rejects(
    authorityStore.searchFiles({ ...SCOPE, workspaceId: workspace.workspaceId, query: 'note' }),
    /授权已失效/u,
  );
});

test('detects a TOCTOU file replacement between canonical validation and open', async (t) => {
  let targetPath = null;
  let swapped = false;
  const racingFs = new Proxy(fsp, {
    get(target, property) {
      if (property === 'open') {
        return async (filename, ...args) => {
          if (!swapped && filename === targetPath) {
            swapped = true;
            await target.rename(filename, `${filename}.old`);
            await target.writeFile(filename, 'replacement');
          }
          return target.open(filename, ...args);
        };
      }
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const { workspaceRoot, authorityStore } = await fixture(t, { fsPromises: racingFs });
  targetPath = path.join(workspaceRoot, 'race.md');
  await fsp.writeFile(targetPath, 'original');
  targetPath = await fsp.realpath(targetPath);
  const workspace = await authorityStore.authorizeRoot({ ...SCOPE, rootPath: workspaceRoot });

  await assert.rejects(
    authorityStore.stageAttachment({
      ...SCOPE,
      workspaceId: workspace.workspaceId,
      relativePath: 'race.md',
    }),
    /读取前已发生变化/u,
  );
});

test('filesystem failures are sanitized and never expose the private absolute path', async (t) => {
  let deniedPath = null;
  const failingFs = new Proxy(fsp, {
    get(target, property) {
      if (property === 'lstat') {
        return async (filename, ...args) => {
          if (filename === deniedPath) throw new Error(`EACCES at ${filename}`);
          return target.lstat(filename, ...args);
        };
      }
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const { workspaceRoot, authorityStore } = await fixture(t, { fsPromises: failingFs });
  const source = path.join(workspaceRoot, 'denied.md');
  await fsp.writeFile(source, 'denied');
  const workspace = await authorityStore.authorizeRoot({ ...SCOPE, rootPath: workspaceRoot });
  deniedPath = await fsp.realpath(source);

  const error = await authorityStore.stageAttachment({
    ...SCOPE,
    workspaceId: workspace.workspaceId,
    relativePath: 'denied.md',
  }).catch((caught) => caught);
  assert.match(error.message, /不存在或无法访问/u);
  assert.equal(error.message.includes(workspaceRoot), false);
  assert.equal(error.message.includes(deniedPath), false);
});

test('an in-flight search cannot publish results after its authority is revoked', async (t) => {
  let releaseScan;
  let markScanStarted;
  const scanStarted = new Promise((resolve) => { markScanStarted = resolve; });
  const scanGate = new Promise((resolve) => { releaseScan = resolve; });
  let blockedDirectory = null;
  let blocked = false;
  const gatedFs = new Proxy(fsp, {
    get(target, property) {
      if (property === 'readdir') {
        return async (directory, ...args) => {
          if (!blocked && directory === blockedDirectory) {
            blocked = true;
            markScanStarted();
            await scanGate;
          }
          return target.readdir(directory, ...args);
        };
      }
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const { workspaceRoot, authorityStore } = await fixture(t, { fsPromises: gatedFs });
  blockedDirectory = await fsp.realpath(workspaceRoot);
  await fsp.writeFile(path.join(workspaceRoot, 'note.md'), 'note');
  const workspace = await authorityStore.authorizeRoot({ ...SCOPE, rootPath: workspaceRoot });
  const pending = authorityStore.searchFiles({ ...SCOPE, workspaceId: workspace.workspaceId, query: '' });
  await scanStarted;
  await authorityStore.revoke({ ...SCOPE, workspaceId: workspace.workspaceId });
  releaseScan();
  await assert.rejects(pending, /未授权或已撤销/u);
});

test('an in-flight attachment conversion is not published and cleans its new draft after revocation', async (t) => {
  const { workspaceRoot, attachmentStore, authorityStore } = await fixture(t);
  await fsp.writeFile(path.join(workspaceRoot, 'pending.md'), 'pending');
  const workspace = await authorityStore.authorizeRoot({ ...SCOPE, rootPath: workspaceRoot });
  const originalStageBytes = attachmentStore.stageBytes.bind(attachmentStore);
  let markStageStarted;
  let releaseStage;
  const stageStarted = new Promise((resolve) => { markStageStarted = resolve; });
  const stageGate = new Promise((resolve) => { releaseStage = resolve; });
  attachmentStore.stageBytes = async (request) => {
    markStageStarted();
    await stageGate;
    return originalStageBytes(request);
  };

  const pending = authorityStore.stageAttachment({
    ...SCOPE,
    workspaceId: workspace.workspaceId,
    relativePath: 'pending.md',
  });
  await stageStarted;
  await authorityStore.revoke({ ...SCOPE, workspaceId: workspace.workspaceId });
  releaseStage();
  await assert.rejects(pending, /未授权或已撤销/u);
  assert.deepEqual(attachmentStore.list(SCOPE), []);
});
