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
  validateDistributionPreflight,
  validateDistributionPreflightFile,
} from './validate-distribution-preflight.mjs';

const TEST_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const VALIDATOR = path.join(
  TEST_DIRECTORY,
  'validate-distribution-preflight.mjs',
);
const TEMPLATE = path.resolve(
  TEST_DIRECTORY,
  '../../docs/templates/distribution-preflight-v1.json',
);
const TEMPLATE_VALUE = JSON.parse(readFileSync(TEMPLATE, 'utf8'));
const P3_RECEIPT = path.resolve(
  TEST_DIRECTORY,
  '../../docs/operations/tabletops/2026-07-28-p3-release-provenance-e0.json',
);
const PACKAGE_SOURCE_ROOT = path.resolve(
  TEST_DIRECTORY,
  '../../crates/codegen/xai-grok-shell/src/agentmesh360',
);

function validPreflight() {
  return structuredClone(TEMPLATE_VALUE);
}

async function withTempDirectory(run) {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), 'agentmesh360-p4-preflight-test-'),
  );
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('accepts the blocked no-authority P4 preflight template', async () => {
  assert.deepEqual(validateDistributionPreflight(validPreflight()), []);
  assert.deepEqual(await validateDistributionPreflightFile(TEMPLATE), []);
});

test('binds the passed P3 receipt without claiming retained release objects', () => {
  const preflight = validPreflight();
  assert.equal(
    preflight.provenanceInput.rehearsalId,
    'release_provenance_e0_20260728_0001',
  );
  assert.equal(preflight.provenanceInput.productionR2Closed, false);
  assert.equal(preflight.provenanceInput.p3ArtifactsRetained, false);
  assert.equal(preflight.provenanceInput.e1ReleaseSet, 'requires_approval');
});

test('binds the actual retained P3 receipt bytes and frozen commits', () => {
  const preflight = validPreflight();
  const receiptBytes = readFileSync(P3_RECEIPT);
  const receipt = JSON.parse(receiptBytes.toString('utf8'));
  const receiptSha256 = `sha256:${createHash('sha256')
    .update(receiptBytes)
    .digest('hex')}`;
  assert.equal(preflight.provenanceInput.rehearsalId, receipt.rehearsalId);
  assert.equal(preflight.provenanceInput.receiptSha256, receiptSha256);
  assert.equal(
    preflight.provenanceInput.candidateCommit,
    receipt.candidateFreeze.commit,
  );
  assert.equal(
    preflight.provenanceInput.executorCommit,
    receipt.executorFreeze.commit,
  );
});

test('pins the reviewed metadata and artifact consumer contract', () => {
  const contract = validPreflight().consumerContract;
  assert.deepEqual(
    [
      contract.trustBundleResponseLimitBytes,
      contract.registryResponseLimitBytes,
      contract.releaseManifestResponseLimitBytes,
      contract.envelopeResponseLimitBytes,
      contract.artifactResponseLimitBytes,
    ],
    [65536, 1048576, 1048576, 65536, 33554432],
  );
  assert.deepEqual(contract.artifactContentTypes, [
    'application/vnd.agentmesh.package',
    'application/zstd',
    'application/x-zstd',
    'application/octet-stream',
  ]);
  assert.equal(contract.redirectPolicy, 'none');
  assert.equal(contract.exactOriginRequired, true);
});

test('pins the real Rust consumer limits, origins, trust state, and redirects', () => {
  const fetcher = readFileSync(
    path.join(PACKAGE_SOURCE_ROOT, 'package_registry_fetcher.rs'),
    'utf8',
  );
  const downloader = readFileSync(
    path.join(PACKAGE_SOURCE_ROOT, 'package_downloader.rs'),
    'utf8',
  );
  const release = readFileSync(
    path.join(PACKAGE_SOURCE_ROOT, 'package_release.rs'),
    'utf8',
  );
  const trust = readFileSync(
    path.join(PACKAGE_SOURCE_ROOT, 'package_trust.rs'),
    'utf8',
  );

  assert.match(
    fetcher,
    /PRODUCTION_PACKAGE_ORIGIN: &str = "https:\/\/packages\.agentmesh360\.com"/u,
  );
  assert.match(
    fetcher,
    /PRODUCTION_TRUST_BUNDLE_URL: Option<&str> = None/u,
  );
  assert.match(fetcher, /PRODUCTION_REGISTRY_URL: Option<&str> = None/u);
  assert.match(fetcher, /TRUST_BUNDLE_RESPONSE_LIMIT: usize = 64 \* 1024/u);
  assert.match(fetcher, /REGISTRY_RESPONSE_LIMIT: usize = 1024 \* 1024/u);
  assert.match(fetcher, /connect_timeout\(Duration::from_secs\(5\)\)/u);
  assert.match(fetcher, /\.timeout\(Duration::from_secs\(15\)\)/u);
  assert.match(fetcher, /redirect\(reqwest::redirect::Policy::none\(\)\)/u);

  assert.match(downloader, /ENVELOPE_LIMIT: usize = 64 \* 1024/u);
  assert.match(downloader, /ARTIFACT_LIMIT: usize = 32 \* 1024 \* 1024/u);
  assert.match(downloader, /connect_timeout\(Duration::from_secs\(10\)\)/u);
  assert.match(downloader, /\.timeout\(Duration::from_secs\(90\)\)/u);
  assert.match(downloader, /redirect\(reqwest::redirect::Policy::none\(\)\)/u);
  assert.match(downloader, /"application\/x-zstd"/u);

  assert.match(
    release,
    /MAX_RELEASE_MANIFEST_BYTES: usize = 1024 \* 1024/u,
  );
  assert.match(
    trust,
    /EMBEDDED_PUBLISHER_TRUST_BUNDLE: Option<&str> = None/u,
  );
});

test('pins immutable publication order and the complete R3 fault matrix', () => {
  const preflight = validPreflight();
  assert.deepEqual(preflight.publicationPlan.immutableObjectClasses, [
    'artifact',
    'envelope',
    'host_bundles',
    'host_projection',
    'release_manifest',
  ]);
  assert.equal(preflight.publicationPlan.overwriteAllowed, false);
  assert.equal(preflight.publicationPlan.registryPublishedLast, true);
  assert.equal(preflight.publicationPlan.registryAtomicPublishRequired, true);
  assert.equal(preflight.faultMatrix.length, 14);
  assert.deepEqual(
    preflight.faultMatrix.map((entry) => entry.scenario),
    [
      'not_found',
      'timeout',
      'truncated_response',
      'response_too_large',
      'wrong_content_type',
      'redirect',
      'digest_mismatch',
      'signature_mismatch',
      'expired_metadata',
      'registry_rollback',
      'same_revision_equivocation',
      'valid_lkg_transport_failure',
      'invalid_or_expired_lkg',
      'partial_publication_before_registry',
    ],
  );
});

test('rejects authority, approval, execution, or resource escalation', () => {
  for (const mutate of [
    (value) => {
      value.authority = 'staging_operator';
    },
    (value) => {
      value.approvalStatus = 'approved';
    },
    (value) => {
      value.executionStatus = 'completed';
    },
    (value) => {
      value.infrastructurePlan.externalResourcesAllowed = true;
    },
    (value) => {
      value.infrastructurePlan.origin = 'staging_origin';
    },
  ]) {
    const preflight = validPreflight();
    mutate(preflight);
    assert.ok(validateDistributionPreflight(preflight).length > 0);
  }
});

test('rejects reused private material or production trust mutation', () => {
  for (const mutate of [
    (value) => {
      value.trustBoundary.p2PrivateMaterialReusable = true;
    },
    (value) => {
      value.trustBoundary.p3PrivateMaterialReusable = true;
    },
    (value) => {
      value.trustBoundary.productionKeyAllowed = true;
    },
    (value) => {
      value.trustBoundary.stagingRootAuthority = 'generated';
    },
    (value) => {
      value.trustBoundary.productionConstantsMutable = true;
    },
  ]) {
    const preflight = validPreflight();
    mutate(preflight);
    assert.ok(validateDistributionPreflight(preflight).length > 0);
  }
});

test('rejects fabricated P3 retention or E1 release authority', () => {
  for (const mutate of [
    (value) => {
      value.provenanceInput.productionR2Closed = true;
    },
    (value) => {
      value.provenanceInput.p3ArtifactsRetained = true;
    },
    (value) => {
      value.provenanceInput.e1ReleaseSet = 'release_set_ready';
    },
    (value) => {
      value.provenanceInput.receiptSha256 = `sha256:${'a'.repeat(64)}`;
    },
  ]) {
    const preflight = validPreflight();
    mutate(preflight);
    assert.ok(validateDistributionPreflight(preflight).length > 0);
  }
});

test('rejects origin, redirect, size, MIME, and timeout contract drift', () => {
  for (const mutate of [
    (value) => {
      value.consumerContract.exactOriginRequired = false;
    },
    (value) => {
      value.consumerContract.redirectPolicy = 'same_origin';
    },
    (value) => {
      value.consumerContract.registryResponseLimitBytes += 1;
    },
    (value) => {
      value.consumerContract.artifactContentTypes.reverse();
    },
    (value) => {
      value.consumerContract.artifactTotalTimeoutSeconds = 0;
    },
  ]) {
    const preflight = validPreflight();
    mutate(preflight);
    assert.ok(validateDistributionPreflight(preflight).length > 0);
  }
});

test('rejects mutable objects, early Registry publication, and fault omissions', () => {
  for (const mutate of [
    (value) => {
      value.publicationPlan.overwriteAllowed = true;
    },
    (value) => {
      value.publicationPlan.registryPublishedLast = false;
    },
    (value) => {
      value.publicationPlan.byteVerificationBeforeRegistry = false;
    },
    (value) => {
      value.publicationPlan.immutableObjectClasses.reverse();
    },
    (value) => {
      value.faultMatrix.pop();
    },
    (value) => {
      value.faultMatrix[0].expectedOutcome = 'serve_valid_lkg';
    },
  ]) {
    const preflight = validPreflight();
    mutate(preflight);
    assert.ok(validateDistributionPreflight(preflight).length > 0);
  }
});

test('rejects unsafe withdrawal, logging, and retained evidence claims', () => {
  for (const mutate of [
    (value) => {
      value.publicationPlan.withdrawalDeletesUserData = true;
    },
    (value) => {
      value.publicationPlan.withdrawalAllowsUnsignedFallback = true;
    },
    (value) => {
      value.loggingBoundary.recordAccountIds = true;
    },
    (value) => {
      value.loggingBoundary.recordByok = true;
    },
    (value) => {
      value.evidencePolicy.recordEndpointUrls = true;
    },
    (value) => {
      value.evidencePolicy.recordCredentials = true;
    },
  ]) {
    const preflight = validPreflight();
    mutate(preflight);
    assert.ok(validateDistributionPreflight(preflight).length > 0);
  }
});

test('rejects approval-card network, Provider, credit, or cost escalation', () => {
  for (const mutate of [
    (value) => {
      value.approvalCard.maximumNetworkRequests = 1;
    },
    (value) => {
      value.approvalCard.maximumProviderRequests = 1;
    },
    (value) => {
      value.approvalCard.maximumCredits = 1;
    },
    (value) => {
      value.approvalCard.maximumCurrencyCost = 1;
    },
    (value) => {
      value.approvalCard.approvalReceipt = 'self_approved';
    },
  ]) {
    const preflight = validPreflight();
    mutate(preflight);
    assert.ok(validateDistributionPreflight(preflight).length > 0);
  }
});

test('rejects reordered stop conditions and unknown evidence fields', () => {
  const reordered = validPreflight();
  reordered.stopConditions.reverse();
  assert.ok(validateDistributionPreflight(reordered).length > 0);

  const unknown = validPreflight();
  unknown.rawDeploymentLog = 'synthetic-sentinel';
  assert.ok(
    validateDistributionPreflight(unknown).some((error) =>
      error.includes('unknown field')),
  );
});

test('rejects duplicate JSON object keys', async () => {
  await withTempDirectory(async (directory) => {
    const duplicate = JSON.stringify(validPreflight()).replace(
      '"schemaVersion":1',
      '"schemaVersion":1,"schemaVersion":1',
    );
    const filePath = path.join(directory, 'duplicate.json');
    await writeFile(filePath, duplicate);
    await assert.rejects(
      validateDistributionPreflightFile(filePath),
      /duplicate JSON object keys/,
    );
  });
});

test('rejects symlinks, invalid UTF-8, and oversized input', async () => {
  await withTempDirectory(async (directory) => {
    const validPath = path.join(directory, 'valid.json');
    const linkPath = path.join(directory, 'link.json');
    await writeFile(validPath, JSON.stringify(validPreflight()));
    await symlink(validPath, linkPath);
    await assert.rejects(
      validateDistributionPreflightFile(linkPath),
      /regular file/,
    );

    const invalidUtf8 = path.join(directory, 'invalid.json');
    await writeFile(invalidUtf8, Buffer.from([0xff]));
    await assert.rejects(
      validateDistributionPreflightFile(invalidUtf8),
      /valid UTF-8/,
    );

    const oversized = path.join(directory, 'oversized.json');
    await writeFile(oversized, Buffer.alloc(128 * 1024 + 1, 0x20));
    await assert.rejects(
      validateDistributionPreflightFile(oversized),
      /size is invalid/,
    );
  });
});

test('CLI keeps failures bounded and does not print absolute paths', async () => {
  await withTempDirectory(async (directory) => {
    const invalidPath = path.join(directory, 'invalid.json');
    await writeFile(invalidPath, '{}');
    const result = spawnSync(process.execPath, [VALIDATOR, invalidPath], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stderr, new RegExp(directory, 'u'));
    assert.ok(result.stderr.length < 8192);
  });
});
