'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  PackageController,
  compareSemver,
  normalizeApprovalId,
  normalizePackageId,
} = require('../src/package-controller');

const PACKAGE_ID = 'com.agentmesh360.job-agent';
const APPROVAL_ID = '019f7c3c-0f0d-7b3e-8f4b-8b95278f3a44';

test('snapshot is ready-gated and projects only Renderer-safe Package metadata', async () => {
  let calls = 0;
  const identity = { getState: () => ({ phase: 'ready', account: { id: 41 } }) };
  const host = {
    async getAgentPackageCatalog() {
      calls += 1;
      return {
        catalog: {
          schemaVersion: 1,
          catalogRevision: 7,
          packages: [{
            schemaVersion: 1,
            packageId: PACKAGE_ID,
            version: '0.4.7',
            publisher: 'agentmesh360',
            sourceRepository: 'https://private.example/repository',
            requestedPermissions: ['local_files', 'network_access'],
            agent: {
              agentId: 'job-agent',
              displayName: 'Job Agent',
              description: 'Persistent career copilot',
              sortOrder: 10,
            },
            runtime: {
              promptBody: 'private system prompt',
              agentsMd: true,
            },
            skills: {
              canonicalWorkflow: 'private workflow',
              adapters: [{ host: 'codex', path: '/private/skill/path' }],
            },
            modelPolicy: { requiredCapabilities: ['reasoning'] },
          }],
        },
      };
    },
    async getAgentPackageStatus() {
      calls += 1;
      return {
        catalogGeneration: 3,
        catalogRevision: 7,
        remoteRegistry: {
          outcome: 'ready',
          cache: {
            rootKeyId: 'private-root-id',
            trustSequence: 4,
            trustExpiresAt: '2026-08-01T00:00:00Z',
            registryRevision: 9,
            registryExpiresAt: '2026-07-29T00:00:00Z',
            packageCount: 6,
            verifiedAt: '2026-07-26T00:00:00Z',
          },
          checkedAt: '2026-07-26T00:00:01Z',
          conditionalRequest: true,
        },
        packages: [{
          kind: 'installed_active',
          packageId: PACKAGE_ID,
          agentId: 'job-agent',
          version: '0.4.7',
          slot: 'active',
          localPath: '/private/packages/active',
          artifactSha256: 'a'.repeat(64),
        }],
        accessToken: 'private-token',
      };
    },
    async getRemoteAgentPackageCatalog() {
      calls += 1;
      return {
        outcome: 'ready',
        registryRevision: 9,
        registryExpiresAt: '2026-08-01T00:00:00Z',
        rootKeyId: 'private-discovery-root',
        packages: [
          {
            packageId: PACKAGE_ID,
            agentId: 'job-agent',
            version: '0.4.8',
            publisher: 'agentmesh360',
            releaseManifestUrl: 'https://packages.example/private-release',
            releaseManifestSha256: 'b'.repeat(64),
            artifactUrl: 'https://packages.example/private',
            artifactSha256: 'c'.repeat(64),
            hostProjectionUrl: 'https://packages.example/private-host-projection',
            hostBundles: [{
              host: 'codex',
              bundleUrl: 'https://packages.example/private-host-bundle',
              bundleSha256: 'd'.repeat(64),
            }],
          },
          {
            packageId: 'com.agentmesh360.lecturecast-agent',
            agentId: 'lecturecast-agent',
            version: '1.0.0',
            publisher: 'agentmesh360',
            envelopeUrl: 'https://packages.example/private-envelope',
          },
        ],
      };
    },
  };
  const controller = new PackageController({ identity, host });

  const snapshot = await controller.getSnapshot();
  assert.equal(calls, 3);
  assert.deepEqual(snapshot.catalog.packages[0], {
    packageId: PACKAGE_ID,
    version: '0.4.7',
    publisher: 'agentmesh360',
    requestedPermissions: ['local_files', 'network_access'],
    agent: {
      agentId: 'job-agent',
      displayName: 'Job Agent',
      description: 'Persistent career copilot',
    },
  });
  assert.deepEqual(snapshot.status.remoteRegistry.cache, {
    trustSequence: 4,
    trustExpiresAt: '2026-08-01T00:00:00Z',
    registryRevision: 9,
    registryExpiresAt: '2026-07-29T00:00:00Z',
    packageCount: 6,
    verifiedAt: '2026-07-26T00:00:00Z',
  });
  assert.deepEqual(snapshot.discovery, {
    outcome: 'ready',
    registryRevision: 9,
    registryExpiresAt: '2026-08-01T00:00:00Z',
    packages: [
      {
        packageId: PACKAGE_ID,
        agentId: 'job-agent',
        version: '0.4.8',
        publisher: 'agentmesh360',
        availability: 'update_available',
        currentVersion: '0.4.7',
      },
      {
        packageId: 'com.agentmesh360.lecturecast-agent',
        agentId: 'lecturecast-agent',
        version: '1.0.0',
        publisher: 'agentmesh360',
        availability: 'new_agent',
      },
    ],
  });
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.catalog.packages[0]), true);
  const serialized = JSON.stringify(snapshot);
  for (const forbidden of [
    'private system prompt',
    'private workflow',
    '/private/skill/path',
    'private.example',
    'private-root-id',
    'private-discovery-root',
    'packages.example',
    '/private/packages/active',
    'releaseManifestSha256',
    'artifactSha256',
    'hostBundles',
    'private-token',
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }

  identity.getState = () => ({ phase: 'blocked' });
  await assert.rejects(() => controller.getSnapshot(), /订阅验证/);
  assert.equal(calls, 3);
});

test('download returns an allowlisted approval Challenge bound to the requested Package', async () => {
  const calls = [];
  const controller = new PackageController({
    identity: { getState: () => ({ phase: 'ready', account: { id: 41 } }) },
    host: {
      async downloadAgentPackage(packageId) {
        calls.push(packageId);
        return {
          status: 'approval_required',
          approval: {
            approvalId: APPROVAL_ID,
            packageId,
            version: '0.4.8',
            addedPermissions: ['process_execution'],
            expiresInSeconds: 600,
            relativePath: '../private',
            digest: 'private-digest',
            accountId: 41,
          },
        };
      },
    },
  });

  const result = await controller.download(` ${PACKAGE_ID} `);
  assert.deepEqual(calls, [PACKAGE_ID]);
  assert.equal(result.outcome, 'completed');
  assert.equal(result.operation, 'download');
  assert.deepEqual(result.value, {
    status: 'approval_required',
    approval: {
      approvalId: APPROVAL_ID,
      packageId: PACKAGE_ID,
      version: '0.4.8',
      addedPermissions: ['process_execution'],
      expiresInSeconds: 600,
    },
  });
  assert.equal(JSON.stringify(result).includes('private'), false);
});

test('remote refresh returns a projected Registry status and a fresh safe snapshot', async () => {
  let refreshCalls = 0;
  const controller = new PackageController({
    identity: { getState: () => ({ phase: 'ready', account: { id: 41 } }) },
    host: {
      async refreshAgentPackageRegistry() {
        refreshCalls += 1;
        return {
          outcome: 'disabled',
          reason: 'not_configured',
          conditionalRequest: false,
          rootKeyId: 'private-root',
        };
      },
      async getAgentPackageCatalog() {
        return {
          catalog: {
            schemaVersion: 1,
            catalogRevision: 1,
            packages: [{
              packageId: PACKAGE_ID,
              version: '0.4.7',
              publisher: 'agentmesh360',
              requestedPermissions: [],
              agent: {
                agentId: 'job-agent',
                displayName: 'Job Agent',
                description: 'Persistent career copilot',
              },
            }],
          },
        };
      },
      async getAgentPackageStatus() {
        return {
          catalogGeneration: 1,
          catalogRevision: 1,
          remoteRegistry: {
            outcome: 'disabled',
            reason: 'not_configured',
            conditionalRequest: false,
          },
          packages: [],
        };
      },
      async getRemoteAgentPackageCatalog() {
        return {
          outcome: 'disabled',
          reason: 'not_configured',
          packages: [],
        };
      },
    },
  });

  const result = await controller.refreshRegistry();
  assert.equal(refreshCalls, 1);
  assert.deepEqual(result.registry, {
    outcome: 'disabled',
    reason: 'not_configured',
    conditionalRequest: false,
  });
  assert.equal(result.snapshot.catalog.packages[0].packageId, PACKAGE_ID);
  assert.deepEqual(result.snapshot.discovery, {
    outcome: 'disabled',
    reason: 'not_configured',
    packages: [],
  });
  assert.equal(JSON.stringify(result).includes('private-root'), false);
  assert.equal(Object.isFrozen(result), true);
});

test('remote discovery uses SemVer precedence for update classification', async () => {
  assert.equal(compareSemver('1.0.0', '1.0.0'), 0);
  assert.equal(compareSemver('1.0.1', '1.0.0'), 1);
  assert.equal(compareSemver('1.0.0-rc.1', '1.0.0'), -1);
  assert.equal(compareSemver('1.0.0-beta.11', '1.0.0-beta.2'), 1);
  assert.equal(compareSemver('1.0.0+build.2', '1.0.0+build.1'), 0);
  assert.equal(
    compareSemver('9007199254740993.0.0', '9007199254740992.0.0'),
    1,
  );
  assert.equal(
    compareSemver(
      '1.0.0-beta.9007199254740993',
      '1.0.0-beta.9007199254740992',
    ),
    1,
  );
});

test('remote discovery classifies current and local-newer packages without exposing authority', async () => {
  const controller = new PackageController({
    identity: { getState: () => ({ phase: 'ready', account: { id: 41 } }) },
    host: snapshotHost({
      outcome: 'ready',
      registryRevision: 9,
      registryExpiresAt: '2026-08-01T00:00:00Z',
      packages: [
        remoteSummary(PACKAGE_ID, 'job-agent', '0.4.7'),
        remoteSummary(
          'com.agentmesh360.lecturecast-agent',
          'lecturecast-agent',
          '0.9.9',
        ),
      ],
    }),
  });

  const snapshot = await controller.getSnapshot();
  assert.deepEqual(
    snapshot.discovery.packages.map((item) => ({
      packageId: item.packageId,
      availability: item.availability,
      currentVersion: item.currentVersion,
    })),
    [
      {
        packageId: PACKAGE_ID,
        availability: 'current',
        currentVersion: '0.4.7',
      },
      {
        packageId: 'com.agentmesh360.lecturecast-agent',
        availability: 'local_newer',
        currentVersion: '1.0.0',
      },
    ],
  );
  assert.equal(JSON.stringify(snapshot).includes('packages.example'), false);
});

test('remote discovery fails closed on malformed, oversized, or nonempty closed catalogs', async () => {
  const invalidCatalogs = [
    {
      outcome: 'disabled',
      reason: 'not_configured',
      registryRevision: 9,
      packages: [],
    },
    {
      outcome: 'unavailable',
      reason: 'cache_rejected',
      packages: [remoteSummary(PACKAGE_ID, 'job-agent', '0.4.8')],
    },
    {
      outcome: 'ready',
      registryRevision: 9,
      registryExpiresAt: 'not-a-time',
      packages: [],
    },
    {
      outcome: 'ready',
      registryRevision: 9,
      registryExpiresAt: '2026-08-01T00:00:00Z',
      packages: [remoteSummary(PACKAGE_ID, 'job-agent', '01.0.0')],
    },
    {
      outcome: 'ready',
      registryRevision: 9,
      registryExpiresAt: '2026-08-01T00:00:00Z',
      packages: Array.from(
        { length: 257 },
        (_value, index) => remoteSummary(
          `com.agentmesh360.agent-${index}`,
          `agent-${index}`,
          '1.0.0',
        ),
      ),
    },
  ];

  for (const discovery of invalidCatalogs) {
    const controller = new PackageController({
      identity: { getState: () => ({ phase: 'ready', account: { id: 41 } }) },
      host: snapshotHost(discovery),
    });
    await assert.rejects(
      () => controller.getSnapshot(),
      (error) => error.code === 'invalid_package_response',
    );
  }
});

test('approval and local mutations pass only normalized Host-owned identifiers', async () => {
  const calls = [];
  const receipt = {
    packageId: PACKAGE_ID,
    agentId: 'job-agent',
    version: '0.4.8',
    runtimeVisibility: {
      status: 'visible',
      catalogGeneration: 4,
      catalogRevision: 8,
      localPath: '/private/path',
    },
    artifactSha256: 'b'.repeat(64),
  };
  const controller = new PackageController({
    identity: { getState: () => ({ phase: 'ready', account: { id: 41 } }) },
    host: {
      async approveAgentPackage(approvalId) {
        calls.push({ operation: 'approve', approvalId });
        return receipt;
      },
      async rollbackAgentPackage(packageId) {
        calls.push({ operation: 'rollback', packageId });
        return receipt;
      },
      async reconcileAgentPackage(packageId) {
        calls.push({ operation: 'reconcile', packageId });
        return receipt;
      },
    },
  });

  const approved = await controller.approve(APPROVAL_ID.toUpperCase());
  const rolledBack = await controller.rollback(PACKAGE_ID);
  const reconciled = await controller.reconcile(PACKAGE_ID);

  assert.deepEqual(calls, [
    { operation: 'approve', approvalId: APPROVAL_ID },
    { operation: 'rollback', packageId: PACKAGE_ID },
    { operation: 'reconcile', packageId: PACKAGE_ID },
  ]);
  for (const result of [approved, rolledBack, reconciled]) {
    assert.equal(result.outcome, 'completed');
    assert.equal(result.value.runtimeVisibility.status, 'visible');
    assert.equal(JSON.stringify(result).includes('/private/path'), false);
    assert.equal(JSON.stringify(result).includes('artifactSha256'), false);
  }
});

test('transport ambiguity is returned as unknown and mutations are never retried', async () => {
  let calls = 0;
  const controller = new PackageController({
    identity: { getState: () => ({ phase: 'ready', account: { id: 41 } }) },
    host: {
      async approveAgentPackage() {
        calls += 1;
        const error = new Error('raw private host failure /Users/private');
        error.code = 'host_timeout';
        throw error;
      },
    },
  });

  const result = await controller.approve(APPROVAL_ID);
  assert.equal(calls, 1);
  assert.deepEqual(result, {
    outcome: 'unknown',
    operation: 'approve',
    message: 'Agent Host 连接中断，操作结果未知。请先重新读取状态，不要自动重试。',
  });
  assert.equal(JSON.stringify(result).includes('/Users/private'), false);
});

test('an account switch discards the prior account Challenge and reports unknown', async () => {
  let accountId = 41;
  let resolveDownload;
  const hostStarted = new Promise((resolve) => {
    resolveDownload = (value) => resolve(value);
  });
  let releaseHost;
  const hostResult = new Promise((resolve) => {
    releaseHost = resolve;
  });
  const controller = new PackageController({
    identity: { getState: () => ({ phase: 'ready', account: { id: accountId } }) },
    host: {
      async downloadAgentPackage() {
        resolveDownload();
        return hostResult;
      },
    },
  });

  const pending = controller.download(PACKAGE_ID);
  await hostStarted;
  accountId = 42;
  releaseHost({
    status: 'approval_required',
    approval: {
      approvalId: APPROVAL_ID,
      packageId: PACKAGE_ID,
      version: '0.4.8',
      addedPermissions: ['process_execution'],
      expiresInSeconds: 600,
    },
  });
  const result = await pending;
  assert.equal(result.outcome, 'unknown');
  assert.equal(result.operation, 'download');
  assert.equal(JSON.stringify(result).includes(APPROVAL_ID), false);
  assert.match(result.message, /账号状态/);
});

test('invalid identifiers and unexpected Host payloads fail closed without raw details', async () => {
  assert.throws(() => normalizePackageId('../../outside'), /Package ID 无效/);
  assert.throws(() => normalizePackageId('a'.repeat(129)), /Package ID 无效/);
  assert.throws(() => normalizeApprovalId('approval-1234'), /批准 ID 无效/);

  let calls = 0;
  const controller = new PackageController({
    identity: { getState: () => ({ phase: 'ready', account: { id: 41 } }) },
    host: {
      async downloadAgentPackage() {
        calls += 1;
        return {
          status: 'approval_required',
          approval: {
            approvalId: APPROVAL_ID,
            packageId: 'com.attacker.other',
            version: '1.0.0',
            addedPermissions: [],
            expiresInSeconds: 600,
          },
        };
      },
    },
  });
  await assert.rejects(
    () => controller.download(PACKAGE_ID),
    (error) => error.code === 'invalid_package_response'
      && !error.message.includes('com.attacker.other'),
  );
  assert.equal(calls, 1);
});

test('known Host failures map to stable public copy and never expose the error chain', async () => {
  const controller = new PackageController({
    identity: { getState: () => ({ phase: 'ready', account: { id: 41 } }) },
    host: {
      async rollbackAgentPackage() {
        const error = new Error('Previous /Users/private failed digest=secret');
        error.code = 'package_rollback_unavailable';
        throw error;
      },
    },
  });

  await assert.rejects(
    () => controller.rollback(PACKAGE_ID),
    (error) => error.code === 'package_rollback_unavailable'
      && error.message === 'Agent Package 当前无法回滚。'
      && !error.message.includes('/Users/private'),
  );
});

test('every mutation is subscription-gated before input validation or Host access', async () => {
  let calls = 0;
  const controller = new PackageController({
    identity: { getState: () => ({ phase: 'blocked' }) },
    host: new Proxy({}, {
      get() {
        return async () => {
          calls += 1;
          throw new Error('Host must not be reached');
        };
      },
    }),
  });

  for (const operation of [
    () => controller.download('../../outside'),
    () => controller.approve('not-an-approval'),
    () => controller.rollback('../../outside'),
    () => controller.reconcile('../../outside'),
  ]) {
    await assert.rejects(
      operation,
      (error) => error.code === 'subscription_required',
    );
  }
  assert.equal(calls, 0);
});

function snapshotHost(discovery) {
  return {
    async getAgentPackageCatalog() {
      return {
        catalog: {
          schemaVersion: 1,
          catalogRevision: 7,
          packages: [
            runtimePackage(PACKAGE_ID, 'job-agent', '0.4.7', 'Job Agent'),
            runtimePackage(
              'com.agentmesh360.lecturecast-agent',
              'lecturecast-agent',
              '1.0.0',
              'Lecturecast Agent',
            ),
          ],
        },
      };
    },
    async getAgentPackageStatus() {
      return {
        catalogGeneration: 1,
        catalogRevision: 7,
        remoteRegistry: {
          outcome: 'ready',
          cache: {
            trustSequence: 4,
            trustExpiresAt: '2026-08-01T00:00:00Z',
            registryRevision: 9,
            registryExpiresAt: '2026-08-01T00:00:00Z',
            packageCount: 2,
            verifiedAt: '2026-07-26T00:00:00Z',
          },
          conditionalRequest: false,
        },
        packages: [],
      };
    },
    async getRemoteAgentPackageCatalog() {
      return {
        rootKeyId: 'private-root',
        artifactUrl: 'https://packages.example/private',
        ...discovery,
      };
    },
  };
}

function runtimePackage(packageId, agentId, version, displayName) {
  return {
    packageId,
    version,
    publisher: 'agentmesh360',
    requestedPermissions: [],
    agent: {
      agentId,
      displayName,
      description: `${displayName} description`,
    },
  };
}

function remoteSummary(packageId, agentId, version) {
  return {
    packageId,
    agentId,
    version,
    publisher: 'agentmesh360',
    releaseManifestUrl: 'https://packages.example/private-release',
    releaseManifestSha256: 'b'.repeat(64),
    artifactUrl: 'https://packages.example/private',
    artifactSha256: 'a'.repeat(64),
    hostProjectionUrl: 'https://packages.example/private-host-projection',
    hostBundles: [{
      host: 'openclaw',
      bundleUrl: 'https://packages.example/private-host-bundle',
      bundleSha256: 'c'.repeat(64),
    }],
  };
}
