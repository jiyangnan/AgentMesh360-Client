import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  assertDistributionAuthorizationSafeForRetention,
  validateDistributionAuthorization,
  validateDistributionAuthorizationFile,
} from './validate-distribution-authorization.mjs';

const TEST_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const VALIDATOR = path.join(
  TEST_DIRECTORY,
  'validate-distribution-authorization.mjs',
);
const AUTHORIZATION = path.resolve(
  TEST_DIRECTORY,
  '../../docs/operations/tabletops/2026-07-28-p4-distribution-e1-authorization.json',
);
const P3_RECEIPT = path.resolve(
  TEST_DIRECTORY,
  '../../docs/operations/tabletops/2026-07-28-p3-release-provenance-e0.json',
);
const AUTHORIZATION_VALUE = JSON.parse(readFileSync(AUTHORIZATION, 'utf8'));

function validAuthorization() {
  return structuredClone(AUTHORIZATION_VALUE);
}

async function withTempDirectory(run) {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), 'agentmesh360-p4-e1-authorization-test-'),
  );
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('accepts the approved P4 E1 authorization', async () => {
  assert.deepEqual(validateDistributionAuthorization(validAuthorization()), []);
  assert.deepEqual(await validateDistributionAuthorizationFile(AUTHORIZATION), []);
  assert.doesNotThrow(() => {
    assertDistributionAuthorizationSafeForRetention(validAuthorization());
  });
});

test('binds the actual P3 receipt bytes and frozen candidate', () => {
  const authorization = validAuthorization();
  const receiptBytes = readFileSync(P3_RECEIPT);
  const receipt = JSON.parse(receiptBytes.toString('utf8'));
  const receiptSha256 = `sha256:${createHash('sha256')
    .update(receiptBytes)
    .digest('hex')}`;
  assert.equal(authorization.provenanceInput.rehearsalId, receipt.rehearsalId);
  assert.equal(authorization.provenanceInput.receiptSha256, receiptSha256);
  assert.equal(
    authorization.provenanceInput.candidateCommit,
    receipt.candidateFreeze.commit,
  );
});

test('pins the exact 72-hour window and approved budget model', () => {
  const authorization = validAuthorization();
  const start = Date.parse(authorization.authorizationWindow.startsAt);
  const stop = Date.parse(authorization.authorizationWindow.stopsAt);
  assert.equal((stop - start) / (60 * 60 * 1000), 72);
  const modeledCost = authorization.budget.dropletHourlyRate * 72
    + authorization.budget.spacesMonthlyBase * (72 / 720);
  assert.equal(modeledCost, 1.14296);
  assert.equal(authorization.budget.expectedCost, 1.15);
  assert.equal(authorization.budget.hardCap, 3);
});

test('pins an isolated SGP1 1GB Droplet and exactly two Spaces buckets', () => {
  const infrastructure = validAuthorization().infrastructurePlan;
  assert.equal(infrastructure.region, 'sgp1');
  assert.equal(infrastructure.existingProductionDropletReusable, false);
  assert.deepEqual(
    [
      infrastructure.stagingDroplet.sizeSlug,
      infrastructure.stagingDroplet.memoryMiB,
      infrastructure.stagingDroplet.vcpus,
      infrastructure.stagingDroplet.diskGiB,
      infrastructure.stagingDroplet.backupsEnabled,
    ],
    ['s-1vcpu-1gb', 1024, 1, 25, false],
  );
  assert.deepEqual(infrastructure.objectStorage.bucketAliases, [
    'package-staging-e1-releases',
    'package-staging-e1-metadata',
  ]);
  assert.equal(infrastructure.objectStorage.bucketCount, 2);
  assert.equal(infrastructure.objectStorage.cdnEnabled, false);
});

test('pins one ephemeral E1 Root and Publisher without production trust', () => {
  const trust = validAuthorization().trustPlan;
  assert.equal(trust.stagingRootKeyCount, 1);
  assert.equal(trust.stagingPublisherKeyCount, 1);
  assert.equal(trust.productionKeyAllowed, false);
  assert.equal(trust.p2OrP3PrivateMaterialReusable, false);
  assert.equal(trust.stagingClientInjection, 'test_only_explicit_e1_harness');
  assert.equal(trust.destroyPrivateMaterialAtEnd, true);
  assert.equal(trust.restoreProductionTrustEmpty, true);
});

test('pins the four frozen Agent packages in publication order', () => {
  const release = validAuthorization().releaseSet;
  assert.equal(release.dualBuildRequired, true);
  assert.equal(release.uploadFromRetainedP3ArtifactsAllowed, false);
  assert.deepEqual(
    release.packages.map((entry) => [
      entry.packageId,
      entry.version,
      entry.hostBundleCount,
    ]),
    [
      ['com.agentmesh360.deploy-agent', '0.1.1', 0],
      ['com.agentmesh360.future-agent', '1.0.0', 2],
      ['com.agentmesh360.job-agent', '0.4.7', 2],
      ['com.agentmesh360.lecturecast-agent', '0.4.0', 3],
    ],
  );
});

test('pins zero Provider, zero credits, request ceiling, and USD hard cap', () => {
  const limits = validAuthorization().requestLimits;
  assert.deepEqual(limits, {
    maximumExternalNetworkRequests: 500,
    maximumProviderInferenceRequests: 0,
    maximumCredits: 0,
    maximumCurrencyCost: 3,
  });
});

test('rejects unknown fields and resource escalation', () => {
  for (const mutate of [
    (value) => {
      value.unreviewed = true;
    },
    (value) => {
      value.infrastructurePlan.externalResourcesMaximum = 6;
    },
    (value) => {
      value.infrastructurePlan.objectStorage.bucketCount = 3;
    },
    (value) => {
      value.infrastructurePlan.stagingDroplet.sizeSlug = 's-1vcpu-2gb';
    },
  ]) {
    const authorization = validAuthorization();
    mutate(authorization);
    assert.ok(validateDistributionAuthorization(authorization).length > 0);
  }
});

test('rejects window or budget drift', () => {
  for (const mutate of [
    (value) => {
      value.authorizationWindow.stopsAt = '2026-08-01T14:03:19Z';
    },
    (value) => {
      value.budget.expectedCost = 1;
    },
    (value) => {
      value.budget.hardCap = 4;
    },
    (value) => {
      value.requestLimits.maximumCurrencyCost = 4;
    },
  ]) {
    const authorization = validAuthorization();
    mutate(authorization);
    assert.ok(validateDistributionAuthorization(authorization).length > 0);
  }
});

test('rejects production reuse, Provider use, or credits', () => {
  for (const mutate of [
    (value) => {
      value.infrastructurePlan.existingProductionDropletReusable = true;
    },
    (value) => {
      value.trustPlan.productionKeyAllowed = true;
    },
    (value) => {
      value.requestLimits.maximumProviderInferenceRequests = 1;
    },
    (value) => {
      value.requestLimits.maximumCredits = 1;
    },
  ]) {
    const authorization = validAuthorization();
    mutate(authorization);
    assert.ok(validateDistributionAuthorization(authorization).length > 0);
  }
});

test('rejects URLs, IPs, local paths, private keys, and unsafe field names', () => {
  for (const mutate of [
    (value) => {
      value.roleAliases[0] = 'https://example.invalid/resource';
    },
    (value) => {
      value.roleAliases[0] = '198.51.100.8';
    },
    (value) => {
      value.roleAliases[0] = '/Users/example/private';
    },
    (value) => {
      value.roleAliases[0] = '-----BEGIN PRIVATE KEY-----';
    },
    (value) => {
      value.secret = 'redacted';
    },
  ]) {
    const authorization = validAuthorization();
    mutate(authorization);
    assert.ok(validateDistributionAuthorization(authorization).length > 0);
  }
});

test('rejects duplicate JSON object keys, symlinks, and oversized files', async () => {
  await withTempDirectory(async (directory) => {
    const duplicate = path.join(directory, 'duplicate.json');
    await writeFile(
      duplicate,
      '{"schemaVersion":1,"schemaVersion":1}',
      'utf8',
    );
    await assert.rejects(
      validateDistributionAuthorizationFile(duplicate),
      /duplicate JSON object keys/u,
    );

    const link = path.join(directory, 'authorization-link.json');
    await symlink(AUTHORIZATION, link);
    await assert.rejects(
      validateDistributionAuthorizationFile(link),
      /regular file/u,
    );

    const oversized = path.join(directory, 'oversized.json');
    await writeFile(oversized, `"${'x'.repeat(256 * 1024)}"`, 'utf8');
    await assert.rejects(
      validateDistributionAuthorizationFile(oversized),
      /size is invalid/u,
    );
  });
});

test('CLI validates the retained authorization receipt', () => {
  const result = spawnSync(process.execPath, [VALIDATOR, AUTHORIZATION], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /P4 E1 distribution authorization valid/u);
});
