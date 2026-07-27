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
  loadKeyCeremonyPreflightSchema,
  validateKeyCeremonyPreflight,
  validateKeyCeremonyPreflightFile,
} from './validate-key-ceremony-preflight.mjs';

const TEST_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const VALIDATOR = path.join(TEST_DIRECTORY, 'validate-key-ceremony-preflight.mjs');
const TEMPLATE = path.resolve(
  TEST_DIRECTORY,
  '../../docs/templates/key-ceremony-preflight-v1.json',
);
const schema = loadKeyCeremonyPreflightSchema();

function validPreflight(overrides = {}) {
  return {
    schemaVersion: 1,
    ceremonyId: 'ceremony_e0_template_0001',
    environment: 'e0',
    ceremonyClass: 'test_key_rehearsal',
    authority: 'none',
    approvalStatus: 'not_approved',
    executionStatus: 'blocked',
    algorithm: 'ed25519',
    plannedKeyIds: {
      root: 'agentmesh360-root-e0-replace',
      publishers: [
        'agentmesh360-publisher-e0-a-replace',
        'agentmesh360-publisher-e0-b-replace',
      ],
    },
    roleAliases: [
      'build_operator',
      'incident_owner',
      'independent_witness',
      'release_owner',
      'signer_operator',
    ],
    custody: {
      rootLocationClass: 'offline_removable_media',
      publisherLocationClass: 'external_signer',
      backupCopyCount: 'requires_approval',
      backupMedia: 'requires_approval',
      backupCustodianRoles: 'requires_approval',
      recoveryWindow: 'requires_approval',
      destructionMethod: 'requires_approval',
      privateMaterialInRepository: false,
      privateMaterialInClient: false,
      privateMaterialInCi: false,
      privateMaterialInEvidence: false,
    },
    sequencePlan: {
      initialTrustSequence: 1,
      overlapTrustSequence: 2,
      retirementTrustSequence: 3,
      revocationTrustSequence: 4,
      monotonicIncreaseRequired: true,
      sameSequenceDifferentDocumentRejected: true,
    },
    approvalCard: {
      action: 'generate_e0_test_root_and_publisher_keys',
      environment: 'e0',
      releasePackageDesktopVersion: 'not_applicable_use_ceremony_id',
      externalResources: 'none',
      credentials: 'new_test_keys_only',
      providerAndModel: 'none',
      maximumRequests: 0,
      maximumCredits: 0,
      maximumCurrencyCost: 0,
      cohort: 'none',
      startStopWindow: 'requires_approval',
      rollbackTarget: 'destroy_test_material_and_restore_empty_trust',
      abortOwnerRole: 'incident_owner',
      evidenceRetentionClass: 'access_controlled',
      approvalReceipt: 'not_present',
    },
    requiredScenarios: [
      'bundle_expiry',
      'publisher_a_generation',
      'publisher_b_generation',
      'publisher_compromise',
      'publisher_expiry',
      'publisher_loss_recovery',
      'publisher_overlap_rotation',
      'publisher_retirement',
      'publisher_revocation',
      'root_compromise',
      'root_emergency_revocation',
      'root_generation',
      'root_loss_recovery',
      'root_overlap_rotation',
      'root_public_export',
      'test_material_destruction',
    ],
    stopConditions: [
      'approval_missing',
      'receipt_validation_failed',
      'role_separation_missing',
      'sequence_or_identity_mismatch',
      'storage_boundary_unverified',
      'unexpected_private_material_location',
    ],
    evidencePolicy: {
      releaseEventSchemaVersion: 1,
      receiptStorageClass: 'access_controlled',
      recordPrivateMaterial: false,
      recordPersonalIdentity: false,
      recordAbsolutePaths: false,
      recordRawCommands: false,
    },
    ...overrides,
  };
}

async function withTempDirectory(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agentmesh360-ceremony-'));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('accepts the blocked no-authority ceremony preflight template', async () => {
  assert.deepEqual(validateKeyCeremonyPreflight(validPreflight(), schema), []);
  assert.deepEqual(await validateKeyCeremonyPreflightFile(TEMPLATE, schema), []);
});

test('pins every R1 rehearsal and unresolved approval dimension', () => {
  const scenarios = schema.properties.requiredScenarios.prefixItems.map(
    (item) => item.const,
  );
  for (const scenario of [
    'bundle_expiry',
    'publisher_compromise',
    'publisher_expiry',
    'publisher_loss_recovery',
    'publisher_overlap_rotation',
    'publisher_revocation',
    'root_compromise',
    'root_emergency_revocation',
    'root_loss_recovery',
    'root_overlap_rotation',
  ]) {
    assert.ok(scenarios.includes(scenario), `missing R1 scenario: ${scenario}`);
  }

  assert.ok(
    schema.properties.approvalCard.required.includes(
      'releasePackageDesktopVersion',
    ),
  );
  for (const field of [
    'backupCopyCount',
    'backupMedia',
    'backupCustodianRoles',
    'recoveryWindow',
    'destructionMethod',
  ]) {
    assert.ok(schema.properties.custody.required.includes(field));
  }
});

test('rejects approval, execution, or key authority claims', () => {
  for (const preflight of [
    validPreflight({ authority: 'test_keys' }),
    validPreflight({ approvalStatus: 'approved' }),
    validPreflight({ executionStatus: 'completed' }),
  ]) {
    assert.ok(validateKeyCeremonyPreflight(preflight, schema).length > 0);
  }
});

test('rejects unknown fields that could carry key material', () => {
  const errors = validateKeyCeremonyPreflight(
    validPreflight({ privateKey: 'synthetic-sentinel' }),
    schema,
  );
  assert.ok(errors.some((error) => error.includes('unknown field')));
});

test('requires two unique sorted publisher key IDs distinct from the root', () => {
  const duplicate = validateKeyCeremonyPreflight(
    validPreflight({
      plannedKeyIds: {
        root: 'agentmesh360-root-e0-replace',
        publishers: [
          'agentmesh360-publisher-e0-a-replace',
          'agentmesh360-publisher-e0-a-replace',
        ],
      },
    }),
    schema,
  );
  assert.ok(duplicate.some((error) => error.includes('unique and sorted')));

  const sameAsRoot = validateKeyCeremonyPreflight(
    validPreflight({
      plannedKeyIds: {
        root: 'agentmesh360-root-e0-replace',
        publishers: [
          'agentmesh360-publisher-e0-a-replace',
          'agentmesh360-root-e0-replace',
        ],
      },
    }),
    schema,
  );
  assert.ok(sameAsRoot.some((error) => error.includes('must differ')));
});

test('requires monotonic initial, overlap, retirement, and revocation sequences', () => {
  const preflight = validPreflight();
  preflight.sequencePlan.retirementTrustSequence =
    preflight.sequencePlan.overlapTrustSequence;
  const errors = validateKeyCeremonyPreflight(preflight, schema);
  assert.ok(errors.some((error) => error.includes('increase monotonically')));
});

test('rejects missing ceremony scenarios and stop conditions', () => {
  const missingScenario = validPreflight();
  missingScenario.requiredScenarios = missingScenario.requiredScenarios.slice(1);
  assert.ok(validateKeyCeremonyPreflight(missingScenario, schema).length > 0);

  const missingStop = validPreflight();
  missingStop.stopConditions = missingStop.stopConditions.slice(1);
  assert.ok(validateKeyCeremonyPreflight(missingStop, schema).length > 0);
});

test('rejects duplicate JSON object keys', async () => {
  await withTempDirectory(async (directory) => {
    const target = path.join(directory, 'preflight.json');
    const document = JSON.stringify(validPreflight()).replace(
      '"authority":"none"',
      '"authority":"test_keys","authority":"none"',
    );
    await writeFile(target, `${document}\n`, 'utf8');
    const errors = await validateKeyCeremonyPreflightFile(target, schema);
    assert.ok(errors.some((error) => error.includes('duplicate JSON object keys')));
  });
});

test('rejects symlinks, invalid UTF-8, and oversized input', async () => {
  await withTempDirectory(async (directory) => {
    const target = path.join(directory, 'preflight.json');
    await writeFile(target, Buffer.from([0xff, 0xfe, 0xfd]));
    let errors = await validateKeyCeremonyPreflightFile(target, schema);
    assert.ok(errors.some((error) => error.includes('valid UTF-8')));

    await writeFile(target, Buffer.alloc((128 * 1024) + 1, 0x61));
    errors = await validateKeyCeremonyPreflightFile(target, schema);
    assert.ok(errors.some((error) => error.includes('size')));

    const link = path.join(directory, 'link.json');
    await symlink(target, link);
    errors = await validateKeyCeremonyPreflightFile(link, schema);
    assert.ok(errors.some((error) => error.includes('symbolic link')));
  });
});

test('CLI keeps failures bounded and does not print absolute input paths', async () => {
  await withTempDirectory(async (directory) => {
    const missing = path.join(directory, 'private', 'preflight.json');
    const result = spawnSync(process.execPath, [VALIDATOR, '--preflight', missing], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /key ceremony preflight validation failed/u);
    assert.equal(result.stderr.includes(directory), false);

    const usage = spawnSync(process.execPath, [VALIDATOR], { encoding: 'utf8' });
    assert.equal(usage.status, 2);
    assert.match(usage.stderr, /Usage:/u);
  });
});
