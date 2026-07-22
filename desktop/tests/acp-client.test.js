'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { AcpHostClient, resolveHostCommand } = require('../src/host/acp-client');

test('ACP client initializes the Host and unwraps AgentMesh360 extension responses', async () => {
  const received = [];
  const spawnImpl = () => fakeChild((request) => {
    received.push(request);
    if (request.method === 'initialize') return { capabilities: {} };
    if (request.method === '_x.agentmesh360/account/bootstrap') {
      return { result: { schemaVersion: 1, account: { id: 7 }, access: { canEnterClient: true } } };
    }
    if (request.method === '_x.agentmesh360/agents/list') {
      return { result: { agents: [{ agentId: 'job-agent' }] } };
    }
    return { result: null, error: 'unsupported' };
  });
  const client = new AcpHostClient({ command: '/fake/host', spawnImpl, requestTimeoutMs: 500 });

  const bootstrap = await client.bootstrap('access-token-private');
  const list = await client.listAgents();

  assert.equal(bootstrap.account.id, 7);
  assert.equal(list.agents[0].agentId, 'job-agent');
  assert.equal(received[0].method, 'initialize');
  assert.equal(received[0].params._meta.clientIdentifier, 'agentmesh360-desktop');
  assert.equal(received[1].method, '_x.agentmesh360/account/bootstrap');
  assert.deepEqual(received[1].params, { accessToken: 'access-token-private' });
  await client.stop();
});

test('Host command resolution prefers explicit and packaged binaries', () => {
  assert.equal(resolveHostCommand({ env: { AGENTMESH360_HOST_BIN: '/custom/host' } }).command, '/custom/host');
  const fallback = resolveHostCommand({ env: {}, resourcesPath: '/definitely/missing' });
  assert.ok(['grok', '/Users/ferdinandji/AgentMesh360-Client/target/release/xai-grok-pager', '/Users/ferdinandji/AgentMesh360-Client/target/debug/xai-grok-pager'].includes(fallback.command));
  assert.deepEqual(fallback.args, ['agent', '--no-leader', 'stdio']);
});

function fakeChild(handler) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.stdin = {
    writable: true,
    write(line) {
      const request = JSON.parse(line);
      queueMicrotask(() => {
        const result = handler(request);
        child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`);
      });
      return true;
    },
  };
  child.kill = () => {
    child.killed = true;
    child.emit('exit', 0);
  };
  return child;
}
