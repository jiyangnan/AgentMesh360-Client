'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  PROMPT_HISTORY_METHOD,
  PromptHistoryStore,
} = require('../src/prompt-history-store');

const SCOPE = Object.freeze({ accountId: 'account-7', agentId: 'job-agent' });

async function fixture(t, requestHistory) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmesh-prompt-history-'));
  const workspaceRoot = path.join(parent, '用户工作区');
  await fs.mkdir(workspaceRoot);
  const historyStore = new PromptHistoryStore({
    requestHistory,
  });
  historyStore.bindSession({
    ...SCOPE,
    sessionKey: 'main',
    privateCwd: workspaceRoot,
    privateSessionId: 'private-session-do-not-project',
  });
  t.after(async () => {
    historyStore.dispose();
    await fs.rm(parent, { recursive: true, force: true });
  });
  return { parent, workspaceRoot, historyStore };
}

test('injects private cwd/session authority into Grok history and exposes only safe previews plus editable selection text', async (t) => {
  const calls = [];
  const { workspaceRoot, historyStore } = await fixture(t, async (request) => {
    calls.push(request);
    return {
      prompts: [
        '  请继续分析中文岗位😊  ',
        '请继续分析中文岗位😊',
        '第二条\n多行内容',
      ],
      cwd: '/malicious/host/leak',
      session_id: 'malicious-host-session',
    };
  });

  const results = await historyStore.search({
    ...SCOPE,
    sessionKey: 'main',
    query: '中文岗位😊',
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    method: PROMPT_HISTORY_METHOD,
    params: {
      cwd: workspaceRoot,
      filter_session_id: 'private-session-do-not-project',
    },
  });
  assert.equal(results.length, 1);
  assert.match(results[0].historyId, /^history-[0-9a-f]{32}$/u);
  assert.equal(results[0].preview, '请继续分析中文岗位😊');
  const serialized = JSON.stringify(results);
  assert.equal(serialized.includes(workspaceRoot), false);
  assert.equal(serialized.includes('private-session'), false);
  assert.equal(serialized.includes('malicious-host'), false);
  assert.equal(serialized.includes('cwd'), false);

  const selected = historyStore.select({
    ...SCOPE,
    sessionKey: 'main',
    historyId: results[0].historyId,
  });
  assert.deepEqual(selected, { text: '请继续分析中文岗位😊' });
  assert.equal(Object.hasOwn(selected, 'send'), false);
  assert.equal(Object.hasOwn(selected, 'sendNow'), false);
});

test('isolates history by account, Agent, and public session binding without requiring an @ folder', async (t) => {
  let hostCalls = 0;
  const { historyStore } = await fixture(t, async () => {
    hostCalls += 1;
    return { prompts: ['private prompt'] };
  });

  await assert.rejects(
    historyStore.search({
      accountId: 'account-8',
      agentId: 'job-agent',
      sessionKey: 'main',
      query: '',
    }),
    /会话尚未建立/u,
  );
  await assert.rejects(
    historyStore.search({
      accountId: 'account-7',
      agentId: 'deploy-agent',
      sessionKey: 'main',
      query: '',
    }),
    /会话尚未建立/u,
  );
  await assert.rejects(
    historyStore.search({ ...SCOPE, sessionKey: 'other', query: '' }),
    /会话尚未建立/u,
  );
  assert.equal(hostCalls, 0);

  assert.equal((await historyStore.search({ ...SCOPE, sessionKey: 'main', query: '' })).length, 1);
  assert.equal(hostCalls, 1);
});

test('deduplicates and bounds Host history while keeping long prompt text behind explicit selection', async (t) => {
  const prompts = [];
  for (let index = 0; index < 260; index += 1) {
    prompts.push(`历史任务 ${index} ${'内容'.repeat(100)}`);
  }
  prompts.splice(2, 0, prompts[0]);
  const { historyStore } = await fixture(t, async () => ({ prompts }));

  const results = await historyStore.search({
    ...SCOPE,
    sessionKey: 'main',
    query: '历史任务',
    limit: 50,
  });
  assert.equal(results.length, 50);
  assert.ok(results.every((entry) => Array.from(entry.preview).length <= 160));
  assert.ok(results[0].preview.endsWith('…'));
  assert.equal(new Set(results.map((entry) => entry.historyId)).size, 50);
  const selected = historyStore.select({
    ...SCOPE,
    sessionKey: 'main',
    historyId: results[0].historyId,
  });
  assert.equal(selected.text, prompts[0]);

  await assert.rejects(
    historyStore.search({ ...SCOPE, sessionKey: 'main', query: '', limit: 51 }),
    /返回数量无效/u,
  );
});

test('rejects malformed, oversized, and control-character Host history without retaining it', async (t) => {
  let response = { prompts: ['valid'] };
  const { historyStore } = await fixture(t, async () => response);
  const valid = await historyStore.search({ ...SCOPE, sessionKey: 'main', query: '' });
  const validId = valid[0].historyId;

  response = { prompts: ['valid', { text: 'object injection' }] };
  await assert.rejects(
    historyStore.search({ ...SCOPE, sessionKey: 'main', query: '' }),
    /无效/u,
  );
  response = { prompts: ['a'.repeat(20_001)] };
  await assert.rejects(
    historyStore.search({ ...SCOPE, sessionKey: 'main', query: '' }),
    /安全范围/u,
  );
  response = { prompts: ['hidden\u0000payload'] };
  await assert.rejects(
    historyStore.search({ ...SCOPE, sessionKey: 'main', query: '' }),
    /安全范围/u,
  );
  response = { prompts: Array.from({ length: 1_001 }, () => 'x') };
  await assert.rejects(
    historyStore.search({ ...SCOPE, sessionKey: 'main', query: '' }),
    /无效/u,
  );

  // Failed projections never replace the last known-good cache.
  assert.deepEqual(
    historyStore.select({ ...SCOPE, sessionKey: 'main', historyId: validId }),
    { text: 'valid' },
  );
});

test('sanitizes Host failures that attempt to echo private cwd or Session values', async (t) => {
  let privateLeak = '';
  const { workspaceRoot, historyStore } = await fixture(t, async ({ params }) => {
    privateLeak = `${params.cwd}:${params.filter_session_id}`;
    throw new Error(`Host failed for ${privateLeak}`);
  });
  const error = await historyStore.search({
    ...SCOPE,
    sessionKey: 'main',
    query: '',
  }).catch((caught) => caught);
  assert.equal(error.message, '暂时无法读取 Prompt History');
  assert.equal(error.message.includes(workspaceRoot), false);
  assert.equal(error.message.includes('private-session'), false);
  assert.ok(privateLeak.includes('private-session-do-not-project'));
});

test('an older out-of-order Host response cannot overwrite newer history', async (t) => {
  const requests = [];
  const { historyStore } = await fixture(t, (request) => {
    const pending = deferred();
    requests.push({ request, pending });
    return pending.promise;
  });

  const older = historyStore.search({ ...SCOPE, sessionKey: 'main', query: 'old' });
  await waitFor(() => requests.length === 1);
  const newer = historyStore.search({ ...SCOPE, sessionKey: 'main', query: 'new' });
  await waitFor(() => requests.length === 2);
  requests[1].pending.resolve({ prompts: ['newest task', 'shared task'] });
  const newestResults = await newer;
  assert.equal(newestResults.length, 1);
  assert.equal(newestResults[0].preview, 'newest task');

  requests[0].pending.resolve({ prompts: ['old stale task'] });
  assert.deepEqual(await older, []);
  assert.deepEqual(
    historyStore.select({
      ...SCOPE,
      sessionKey: 'main',
      historyId: newestResults[0].historyId,
    }),
    { text: 'newest task' },
  );
});

test('an in-flight Host response is discarded when the private Session authority changes', async (t) => {
  const requests = [];
  const { parent, workspaceRoot, historyStore } = await fixture(t, () => {
    const pending = deferred();
    requests.push(pending);
    return pending.promise;
  });

  const rebound = historyStore.search({ ...SCOPE, sessionKey: 'main', query: '' });
  await waitFor(() => requests.length === 1);
  const secondRoot = path.join(parent, 'second-root');
  await fs.mkdir(secondRoot);
  historyStore.bindSession({
    ...SCOPE,
    sessionKey: 'main',
    privateCwd: secondRoot,
    privateSessionId: 'private-session-2',
  });
  requests[0].resolve({ prompts: ['must not escape after rebind'] });
  await assert.rejects(rebound, /会话授权已变化/u);

  const reboundAgain = historyStore.search({ ...SCOPE, sessionKey: 'main', query: '' });
  await waitFor(() => requests.length === 2);
  historyStore.bindSession({
    ...SCOPE,
    sessionKey: 'main',
    privateCwd: workspaceRoot,
    privateSessionId: 'private-session-3',
  });
  requests[1].resolve({ prompts: ['must not escape after rebind'] });
  await assert.rejects(reboundAgain, /会话授权已变化/u);
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('timed out waiting for async test state');
}
