import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
  validateReleaseProvenancePreflight,
  validateReleaseProvenancePreflightFile,
} from './validate-release-provenance-preflight.mjs';

const TEST_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const VALIDATOR = path.join(
  TEST_DIRECTORY,
  'validate-release-provenance-preflight.mjs',
);
const TEMPLATE = path.resolve(
  TEST_DIRECTORY,
  '../../docs/templates/release-provenance-preflight-v1.json',
);
const AGENTS = [
  {
    agentId: 'deploy-agent',
    packageId: 'com.agentmesh360.deploy-agent',
    version: '0.1.1',
    sourceClass: 'first_party',
  },
  {
    agentId: 'future-agent',
    packageId: 'com.agentmesh360.future-agent',
    version: '1.0.0',
    sourceClass: 'dynamic_fixture',
  },
  {
    agentId: 'job-agent',
    packageId: 'com.agentmesh360.job-agent',
    version: '0.4.7',
    sourceClass: 'first_party',
  },
  {
    agentId: 'lecturecast-agent',
    packageId: 'com.agentmesh360.lecturecast-agent',
    version: '0.4.0',
    sourceClass: 'first_party',
  },
];
const OUTPUTS = [
  'artifact',
  'envelope',
  'finalize_receipt',
  'host_bundles',
  'host_projection',
  'package_file_manifest',
  'registry_record',
  'release_manifest',
  'signature_result',
  'signing_request',
];

function validPreflight(overrides = {}) {
  return {
    schemaVersion: 1,
    rehearsalId: 'release_provenance_e0_template_0001',
    environment: 'e0',
    workPackage: 'p3_r2',
    authority: 'none',
    approvalStatus: 'not_approved',
    executionStatus: 'blocked',
    sourceFreeze: {
      commit: 'requires_execution_commit',
      cleanTreeRequired: true,
      cargoLockSha256: 'requires_execution_digest',
      rustToolchain: 'requires_execution_capture',
      contractVersions: {
        authoringSchemaVersion: 1,
        signingRequestSchemaVersion: 1,
        signatureResultSchemaVersion: 1,
        publicKeySchemaVersion: 1,
        hostSkillPlanSchemaVersion: 1,
        hostProjectionSchemaVersion: 1,
        packageSignatureSchemaVersion: 1,
        fileManifestSchemaVersion: 1,
        hostSkillExportSchemaVersion: 1,
        agentReleaseSchemaVersion: 1,
        registrySnapshotSchemaVersion: 2,
        packageSignatureCanonicalPayload:
          'agentmesh360-package-signature-v1',
        registryCanonicalPayload: 'agentmesh360-package-registry-v2',
      },
    },
    executionRoles: {
      buildOperator: 'build_operator',
      signerOperator: 'test_signer_operator',
      independentReviewer: 'independent_reviewer',
    },
    buildPlan: {
      builderCount: 2,
      isolatedBuildRootsRequired: true,
      repositoryTargetForbidden: true,
      byteIdenticalRequired: true,
      digestAlgorithm: 'sha256',
      outputClasses: OUTPUTS,
    },
    agentMatrix: AGENTS.map((agent) => ({
      ...agent,
      executionStatus: 'blocked',
    })),
    signingBoundary: {
      algorithm: 'ed25519',
      signerAuthority: 'none',
      signerMode: 'requires_approval',
      testPublisherKeyId: 'requires_approval',
      p2PrivateMaterialReusable: false,
      productionKeyAllowed: false,
      privateMaterialInRepository: false,
      privateMaterialInBuilder: false,
      privateMaterialInEvidence: false,
    },
    approvalCard: {
      action: 'execute_p3_r2_e0_dual_build_and_test_signing',
      environment: 'e0',
      credentials: 'new_test_publisher_only',
      externalResources: 'none_unless_separately_approved',
      maximumRequests: 0,
      maximumCredits: 0,
      maximumCurrencyCost: 0,
      startStopWindow: 'requires_approval',
      rollbackTarget: 'destroy_test_signer_and_remove_build_roots',
      approvalReceipt: 'not_present',
    },
    stopConditions: [
      'approval_missing',
      'build_output_mismatch',
      'dirty_source_tree',
      'evidence_policy_violation',
      'private_material_boundary_violation',
      'repository_target_created',
      'source_or_toolchain_drift',
    ],
    evidencePolicy: {
      recordPrivateMaterial: false,
      recordRawPublicKeys: false,
      recordRawSignatures: false,
      recordAbsolutePaths: false,
      recordPersonalIdentity: false,
      recordRawCommands: false,
      typedDigestPrefix: 'sha256:',
    },
    ...overrides,
  };
}

async function withTempDirectory(run) {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), 'agentmesh360-p3-preflight-test-'),
  );
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('accepts the blocked no-authority P3 preflight template', async () => {
  assert.deepEqual(validateReleaseProvenancePreflight(validPreflight()), []);
  assert.deepEqual(await validateReleaseProvenancePreflightFile(TEMPLATE), []);
});

test('pins the four-agent matrix and all provenance output classes', () => {
  const preflight = validPreflight();
  assert.deepEqual(
    preflight.agentMatrix.map((entry) => entry.agentId),
    AGENTS.map((entry) => entry.agentId),
  );
  assert.deepEqual(preflight.buildPlan.outputClasses, OUTPUTS);
});

test('pins real Rust contract versions, canonical payloads, and split roles', () => {
  const preflight = validPreflight();
  assert.equal(preflight.sourceFreeze.contractVersions.authoringSchemaVersion, 1);
  assert.equal(
    preflight.sourceFreeze.contractVersions.registrySnapshotSchemaVersion,
    2,
  );
  assert.equal(
    preflight.sourceFreeze.contractVersions.packageSignatureCanonicalPayload,
    'agentmesh360-package-signature-v1',
  );
  assert.equal(
    preflight.sourceFreeze.contractVersions.registryCanonicalPayload,
    'agentmesh360-package-registry-v2',
  );
  assert.deepEqual(preflight.executionRoles, {
    buildOperator: 'build_operator',
    signerOperator: 'test_signer_operator',
    independentReviewer: 'independent_reviewer',
  });
});

test('rejects contract drift and substituted execution roles', () => {
  const contractDrift = validPreflight();
  contractDrift.sourceFreeze.contractVersions.registrySnapshotSchemaVersion = 1;
  assert.ok(validateReleaseProvenancePreflight(contractDrift).length > 0);

  const payloadDrift = validPreflight();
  payloadDrift.sourceFreeze.contractVersions.registryCanonicalPayload =
    'agentmesh360-agent-release-registry-v2';
  assert.ok(validateReleaseProvenancePreflight(payloadDrift).length > 0);

  const roleDrift = validPreflight();
  roleDrift.executionRoles.independentReviewer = 'build_operator';
  assert.ok(validateReleaseProvenancePreflight(roleDrift).length > 0);
});

test('rejects authority, approval, or execution escalation', () => {
  for (const preflight of [
    validPreflight({ authority: 'test_publisher' }),
    validPreflight({ approvalStatus: 'approved' }),
    validPreflight({ executionStatus: 'completed' }),
  ]) {
    assert.ok(validateReleaseProvenancePreflight(preflight).length > 0);
  }
});

test('rejects fabricated execution commit, lock digest, and signer values', () => {
  const preflight = validPreflight();
  preflight.sourceFreeze.commit = 'a'.repeat(40);
  preflight.sourceFreeze.cargoLockSha256 = `sha256:${'b'.repeat(64)}`;
  preflight.signingBoundary.signerMode = 'local_isolated_signer';
  preflight.signingBoundary.testPublisherKeyId = 'publisher-e0-a';
  const errors = validateReleaseProvenancePreflight(preflight);
  assert.ok(errors.length >= 4);
});

test('rejects P2 material reuse, production keys, and private material claims', () => {
  for (const mutate of [
    (value) => {
      value.signingBoundary.p2PrivateMaterialReusable = true;
    },
    (value) => {
      value.signingBoundary.productionKeyAllowed = true;
    },
    (value) => {
      value.signingBoundary.privateMaterialInRepository = true;
    },
  ]) {
    const preflight = validPreflight();
    mutate(preflight);
    assert.ok(validateReleaseProvenancePreflight(preflight).length > 0);
  }
});

test('rejects missing, duplicate, or reordered agents and outputs', () => {
  const missingAgent = validPreflight();
  missingAgent.agentMatrix.pop();
  assert.ok(validateReleaseProvenancePreflight(missingAgent).length > 0);

  const reorderedOutput = validPreflight();
  reorderedOutput.buildPlan.outputClasses.reverse();
  assert.ok(validateReleaseProvenancePreflight(reorderedOutput).length > 0);
});

test('rejects unknown fields that could carry unreviewed evidence', () => {
  const errors = validateReleaseProvenancePreflight({
    ...validPreflight(),
    buildLog: 'synthetic-sentinel',
  });
  assert.ok(errors.some((error) => error.includes('unknown field')));
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
      validateReleaseProvenancePreflightFile(filePath),
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
      validateReleaseProvenancePreflightFile(linkPath),
      /regular file/,
    );

    const invalidUtf8 = path.join(directory, 'invalid.json');
    await writeFile(invalidUtf8, Buffer.from([0xff]));
    await assert.rejects(
      validateReleaseProvenancePreflightFile(invalidUtf8),
      /valid UTF-8/,
    );

    const oversized = path.join(directory, 'oversized.json');
    await writeFile(oversized, Buffer.alloc(128 * 1024 + 1, 0x20));
    await assert.rejects(
      validateReleaseProvenancePreflightFile(oversized),
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
    assert.ok(result.stderr.length < 4096);
  });
});
