'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  ConversationAttachmentStore,
  MAX_ATTACHMENT_BYTES,
} = require('../src/conversation-attachment-store');

const SCOPE = Object.freeze({ accountId: 'account-7', agentId: 'job-agent' });
const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

async function fixture(t) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmesh-attachments-'));
  const rootDir = path.join(parent, 'private-drafts');
  const sourceDir = path.join(parent, 'user-files');
  await fs.mkdir(sourceDir);
  const store = new ConversationAttachmentStore({ rootDir });
  await store.initialize();
  t.after(async () => {
    await store.dispose().catch(() => {});
    await fs.rm(parent, { recursive: true, force: true });
  });
  return { parent, rootDir, sourceDir, store };
}

test('stages local files privately and builds exact ACP content blocks without public path leakage', async (t) => {
  const { rootDir, sourceDir, store } = await fixture(t);
  const imagePath = path.join(sourceDir, 'screen.png');
  const textPath = path.join(sourceDir, 'resume.md');
  await fs.writeFile(imagePath, PNG);
  await fs.writeFile(textPath, '# Resume\nAgent systems');

  const staged = await store.stagePaths({ ...SCOPE, paths: [imagePath, textPath] });
  const link = await store.stageLink({ ...SCOPE, url: 'https://example.com/jobs#private-fragment' });
  const publicSnapshot = store.list(SCOPE);

  assert.equal(staged.length, 2);
  assert.deepEqual(publicSnapshot.map((item) => item.kind), ['image', 'file', 'link']);
  assert.ok(publicSnapshot.every((item) => !Object.hasOwn(item, 'path')));
  assert.ok(publicSnapshot.every((item) => !Object.hasOwn(item, 'url')));
  assert.ok(!JSON.stringify(publicSnapshot).includes(sourceDir));
  assert.ok(!JSON.stringify(publicSnapshot).includes(rootDir));

  const prepared = await store.preparePrompt({
    ...SCOPE,
    text: '请比较这些材料',
    attachmentIds: [...staged.map((item) => item.attachmentId), link.attachmentId],
  });
  assert.deepEqual(prepared.prompt.map((block) => block.type), [
    'text',
    'image',
    'resource',
    'resource_link',
  ]);
  assert.match(prepared.prompt[0].text, /图片：screen\.png/u);
  assert.match(prepared.prompt[0].text, /文件：resume\.md/u);
  assert.equal(prepared.prompt[1].mimeType, 'image/png');
  assert.equal(prepared.prompt[1].data, PNG.toString('base64'));
  assert.equal(prepared.prompt[2].resource.text, '# Resume\nAgent systems');
  assert.equal(prepared.prompt[2].resource.uri, 'file:///agentmesh360-attachment/resume.md');
  assert.equal(prepared.prompt[3].uri, 'https://example.com/jobs');
  assert.deepEqual(prepared.prompt[3]._meta, { agentmesh360: { kind: 'user_link' } });

  await store.consume({ ...SCOPE, attachmentIds: prepared.attachmentIds });
  assert.deepEqual(store.list(SCOPE), []);
  assert.deepEqual(await fs.readdir(rootDir), ['manifest-v1.json']);
});

test('supports attachment-only prompts, deduplicates content, and isolates account and Agent scope', async (t) => {
  const { store } = await fixture(t);
  const first = await store.stageBytes({
    ...SCOPE,
    items: [{ name: 'note.txt', mimeType: 'text/plain', bytes: Buffer.from('hello') }],
  });
  const duplicate = await store.stageBytes({
    ...SCOPE,
    items: [{ name: 'note.txt', mimeType: 'text/plain', bytes: Buffer.from('hello') }],
  });
  assert.equal(duplicate[0].attachmentId, first[0].attachmentId);
  assert.equal(store.list(SCOPE).length, 1);

  const prepared = await store.preparePrompt({
    ...SCOPE,
    text: '',
    attachmentIds: [first[0].attachmentId],
  });
  assert.match(prepared.prompt[0].text, /^请查看我附加的内容。/u);
  await assert.rejects(
    store.preparePrompt({
      accountId: 'account-8',
      agentId: 'job-agent',
      text: 'steal',
      attachmentIds: [first[0].attachmentId],
    }),
    /不属于当前 Agent/u,
  );
  await assert.rejects(
    store.discard({
      accountId: 'account-7',
      agentId: 'deploy-agent',
      attachmentId: first[0].attachmentId,
    }),
    /不属于当前 Agent/u,
  );
});

test('rejects unsafe links, fake images, unsupported binary files, size overflow, and an eleventh item', async (t) => {
  const { store } = await fixture(t);
  await assert.rejects(
    store.stageLink({ ...SCOPE, url: 'file:///tmp/private.txt' }),
    /只支持/u,
  );
  await assert.rejects(
    store.stageLink({ ...SCOPE, url: 'https://user:pass@example.com/' }),
    /账号密码/u,
  );
  await assert.rejects(
    store.stageBytes({
      ...SCOPE,
      items: [{ name: 'fake.png', mimeType: 'image/png', bytes: Buffer.from('not png') }],
    }),
    /图片内容/u,
  );
  await assert.rejects(
    store.stageBytes({
      ...SCOPE,
      items: [{ name: 'payload.bin', mimeType: 'application/octet-stream', bytes: Buffer.from([1, 2, 3]) }],
    }),
    /暂不支持/u,
  );
  await assert.rejects(
    store.stageBytes({
      ...SCOPE,
      items: [{
        name: 'too-large.txt',
        mimeType: 'text/plain',
        bytes: Buffer.alloc(MAX_ATTACHMENT_BYTES + 1, 0x61),
      }],
    }),
    /20 MB/u,
  );
  const beforeFailedBatch = store.list(SCOPE);
  await assert.rejects(
    store.stageBytes({
      ...SCOPE,
      items: [
        { name: 'valid.txt', mimeType: 'text/plain', bytes: Buffer.from('valid') },
        { name: 'invalid.bin', mimeType: 'application/octet-stream', bytes: Buffer.from([1, 2, 3]) },
      ],
    }),
    /暂不支持/u,
  );
  assert.deepEqual(store.list(SCOPE), beforeFailedBatch);

  const heavyScope = { accountId: 'account-7', agentId: 'deploy-agent' };
  for (let index = 0; index < 2; index += 1) {
    await store.stageBytes({
      ...heavyScope,
      items: [{
        name: `large-${index}.txt`,
        mimeType: 'text/plain',
        bytes: Buffer.alloc(17 * 1024 * 1024, 0x61 + index),
      }],
    });
  }
  await assert.rejects(
    store.stageBytes({
      ...heavyScope,
      items: [{
        name: 'large-2.txt',
        mimeType: 'text/plain',
        bytes: Buffer.alloc(17 * 1024 * 1024, 0x63),
      }],
    }),
    /50 MB/u,
  );
  for (let index = 0; index < 10; index += 1) {
    await store.stageLink({ ...SCOPE, url: `https://example.com/${index}` });
  }
  await assert.rejects(
    store.stageLink({ ...SCOPE, url: 'https://example.com/eleven' }),
    /最多添加 10/u,
  );
});

test('reserves attachments per Session and Prompt, blocks reuse, and supports release or consume', async (t) => {
  const { rootDir, store } = await fixture(t);
  const [attachment] = await store.stageBytes({
    ...SCOPE,
    items: [{ name: 'queued.md', mimeType: 'text/markdown', bytes: Buffer.from('# queued') }],
  });
  const reservation = await store.reservePrompt({
    ...SCOPE,
    sessionId: 'private-main-session',
    promptId: 'prompt-queue-1',
    text: '稍后处理',
    attachmentIds: [attachment.attachmentId],
  });

  assert.deepEqual(reservation.prompt.map((block) => block.type), ['text', 'resource']);
  assert.deepEqual(store.list(SCOPE), []);
  assert.equal(store.listReservations({ ...SCOPE, sessionId: 'private-main-session' })[0].status, 'submitting');
  await assert.rejects(
    store.discard({ ...SCOPE, attachmentId: attachment.attachmentId }),
    /待处理消息/u,
  );
  await assert.rejects(
    store.reservePrompt({
      ...SCOPE,
      sessionId: 'private-main-session',
      promptId: 'prompt-queue-2',
      text: '重复使用',
      attachmentIds: [attachment.attachmentId],
    }),
    /另一条待处理消息/u,
  );

  assert.equal(await store.markReservationUnknown({
    ...SCOPE,
    sessionId: 'private-main-session',
    promptId: 'prompt-queue-1',
  }), 1);
  assert.equal(store.listReservations(SCOPE)[0].status, 'unknown');
  await store.releaseReservation({
    ...SCOPE,
    sessionId: 'private-main-session',
    promptId: 'prompt-queue-1',
  });
  assert.equal(store.list(SCOPE).length, 1);

  await store.reservePrompt({
    ...SCOPE,
    sessionId: 'private-main-session',
    promptId: 'prompt-queue-3',
    text: '确认处理',
    attachmentIds: [attachment.attachmentId],
  });
  await store.markReservationAccepted({
    ...SCOPE,
    sessionId: 'private-main-session',
    promptId: 'prompt-queue-3',
  });
  await store.consumeReservation({
    ...SCOPE,
    sessionId: 'private-main-session',
    promptId: 'prompt-queue-3',
  });
  assert.deepEqual(store.listReservations(SCOPE), []);
  assert.deepEqual(await fs.readdir(rootDir), ['manifest-v1.json']);
});

test('restores draft and reserved attachments from a private manifest and purges orphans', async (t) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmesh-attachment-restore-'));
  const rootDir = path.join(parent, 'drafts');
  const first = new ConversationAttachmentStore({ rootDir });
  t.after(async () => {
    await first.dispose().catch(() => {});
    await fs.rm(parent, { recursive: true, force: true });
  });
  await first.initialize();
  const [draft, reserved] = await first.stageBytes({
    ...SCOPE,
    items: [
      { name: 'draft.txt', mimeType: 'text/plain', bytes: Buffer.from('draft') },
      { name: 'reserved.txt', mimeType: 'text/plain', bytes: Buffer.from('reserved') },
    ],
  });
  await first.reservePrompt({
    ...SCOPE,
    sessionId: 'private-main-session',
    promptId: 'prompt-restart',
    text: '重启后继续',
    attachmentIds: [reserved.attachmentId],
  });
  await fs.writeFile(path.join(rootDir, 'orphan.bin'), 'orphan');
  await first.dispose();

  const restored = new ConversationAttachmentStore({ rootDir });
  await restored.initialize();
  t.after(() => restored.dispose().catch(() => {}));
  assert.deepEqual(restored.list(SCOPE).map((item) => item.attachmentId), [draft.attachmentId]);
  assert.equal(restored.listReservations(SCOPE)[0].promptId, 'prompt-restart');
  assert.equal((await fs.readdir(rootDir)).includes('orphan.bin'), false);
  await restored.consumeReservation({
    ...SCOPE,
    sessionId: 'private-main-session',
    promptId: 'prompt-restart',
  });
});

test('initialization purges stale drafts and clearAccount leaves other accounts intact', async (t) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmesh-attachment-purge-'));
  const rootDir = path.join(parent, 'drafts');
  await fs.mkdir(rootDir);
  await fs.writeFile(path.join(rootDir, 'stale-secret.bin'), 'stale');
  const store = new ConversationAttachmentStore({ rootDir });
  t.after(async () => {
    await store.dispose().catch(() => {});
    await fs.rm(parent, { recursive: true, force: true });
  });
  await store.initialize();
  assert.deepEqual(await fs.readdir(rootDir), ['manifest-v1.json']);

  await store.stageBytes({
    ...SCOPE,
    items: [{ name: 'a.txt', mimeType: 'text/plain', bytes: Buffer.from('a') }],
  });
  await store.stageBytes({
    accountId: 'account-8',
    agentId: 'job-agent',
    items: [{ name: 'b.txt', mimeType: 'text/plain', bytes: Buffer.from('b') }],
  });
  await store.clearAccount('account-7');
  assert.deepEqual(store.list(SCOPE), []);
  assert.equal(store.list({ accountId: 'account-8', agentId: 'job-agent' }).length, 1);
});
