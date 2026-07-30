#!/usr/bin/env node

import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  readStrictJsonFile,
  validateJsonSchema,
} from '../shared/strict-json-schema.mjs';

const MODULE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SCHEMA_PATH = path.resolve(
  MODULE_DIRECTORY,
  '../../schemas/agentmesh360-desktop-internal-acceptance-v1.schema.json',
);
const RETAINED_ACCEPTANCE_PATH = path.resolve(
  MODULE_DIRECTORY,
  '../../docs/operations/tabletops/2026-07-30-p6-unsigned-internal-acceptance.json',
);
const EXPECTED_SCENARIOS = Object.freeze([
  'artifact_boundary',
  'dmg_verify_and_isolated_copy',
  'zip_and_dmg_payload_match',
  'bundle_and_packaged_host',
  'developer_id_absent_and_manual_gatekeeper',
  'signed_out_first_launch',
  'single_instance_window_restore',
  'login_item_enable_disable_restore',
  'signed_out_background_exit',
  'packaged_host_persistent_agent_recovery',
  'isolated_cleanup',
]);
const EXPECTED_ARTIFACT = Object.freeze({
  acceptanceId: 'desktop_internal_p6_20260730_0001',
  buildReceiptId: 'desktop_internal_p6_9db201f43a49_arm64',
  buildReceiptSha256:
    'sha256:ce1885e285c6edbb6e07241764b60d87278b7adfa07a3bd31ea847b3793e59f6',
  commit: '9db201f43a49d0cc58dd466a500d40f48c8fe933',
  executorCommit: '15507ae62a58317b8bc91b39a4f98f20e1e97dd7',
  version: '0.1.0',
  architecture: 'arm64',
  zipFile: 'AgentMesh360-0.1.0-arm64-mac.zip',
  zipSizeBytes: 181147410,
  zipSha256:
    'sha256:7409150d8b82466c28813fda6964b465054d88f30e7c9b9900bf8b4a0e4164d6',
  dmgFile: 'AgentMesh360-0.1.0-arm64.dmg',
  dmgSizeBytes: 181359004,
  dmgSha256:
    'sha256:c2cfcd1f024e39a52f253aa95e17684778afa23490ed5ed8e5d16c6702ca996f',
});

export async function loadAcceptanceSchema(
  schemaPath = DEFAULT_SCHEMA_PATH,
) {
  const { value } = await readStrictJsonFile(schemaPath, {
    label: 'desktop internal acceptance schema',
  });
  if (
    value?.type !== 'object'
    || value?.additionalProperties !== false
    || !Array.isArray(value?.required)
    || !value?.properties
  ) {
    throw new Error('desktop internal acceptance schema is not strict');
  }
  return value;
}

export function validateDesktopInternalAcceptance(value, schema) {
  const errors = validateJsonSchema(value, schema, {
    label: 'acceptance',
  });
  if (
    value?.acceptanceId !== EXPECTED_ARTIFACT.acceptanceId
    || value?.artifact?.buildReceiptId !== EXPECTED_ARTIFACT.buildReceiptId
    || value?.artifact?.buildReceiptSha256
      !== EXPECTED_ARTIFACT.buildReceiptSha256
    || value?.artifact?.commit !== EXPECTED_ARTIFACT.commit
    || value?.artifact?.executorCommit !== EXPECTED_ARTIFACT.executorCommit
    || value?.artifact?.version !== EXPECTED_ARTIFACT.version
    || value?.artifact?.architecture !== EXPECTED_ARTIFACT.architecture
    || value?.artifact?.zip?.file !== EXPECTED_ARTIFACT.zipFile
    || value?.artifact?.zip?.sizeBytes !== EXPECTED_ARTIFACT.zipSizeBytes
    || value?.artifact?.zip?.sha256 !== EXPECTED_ARTIFACT.zipSha256
    || value?.artifact?.dmg?.file !== EXPECTED_ARTIFACT.dmgFile
    || value?.artifact?.dmg?.sizeBytes !== EXPECTED_ARTIFACT.dmgSizeBytes
    || value?.artifact?.dmg?.sha256 !== EXPECTED_ARTIFACT.dmgSha256
  ) {
    errors.push('acceptance artifact provenance does not match Cycle 129-130');
  }
  if (
    value?.matrix?.scenarios?.join('\n') !== EXPECTED_SCENARIOS.join('\n')
  ) {
    errors.push('acceptance matrix must contain the exact 11 scenarios in order');
  }
  if (
    value?.gatekeeper?.manualOpenAnywayRequired !== true
    || value?.gatekeeper?.globalDisableRequired !== false
    || value?.gatekeeper?.quarantineDownloadUserFlowExecuted !== false
    || value?.productionBoundary?.productionR4Satisfied !== false
    || value?.productionBoundary?.p7Authorized !== false
    || value?.productionBoundary?.p8Authorized !== false
    || value?.productionBoundary?.seedDownloadCanaryAuthorized !== false
  ) {
    errors.push('acceptance must preserve manual Gatekeeper and closed production gates');
  }
  return errors.slice(0, 64);
}

export async function validateDesktopInternalAcceptanceFile(
  filePath = RETAINED_ACCEPTANCE_PATH,
) {
  const [{ value }, schema] = await Promise.all([
    readStrictJsonFile(filePath, {
      label: 'desktop internal acceptance',
    }),
    loadAcceptanceSchema(),
  ]);
  const errors = validateDesktopInternalAcceptance(value, schema);
  if (errors.length > 0) {
    throw new Error(`desktop internal acceptance is invalid: ${errors[0]}`);
  }
  return Object.freeze({
    status: 'passed',
    acceptanceId: value.acceptanceId,
    distributionClass: value.distributionClass,
    scenarioCount: value.matrix.scenarioCount,
    productionR4Satisfied: value.productionBoundary.productionR4Satisfied,
    seedDownloadCanaryAuthorized:
      value.productionBoundary.seedDownloadCanaryAuthorized,
  });
}

async function main() {
  if (process.argv.length > 3) {
    throw new Error(
      'usage: node validate-desktop-internal-acceptance.mjs [acceptance.json]',
    );
  }
  const result = await validateDesktopInternalAcceptanceFile(
    process.argv[2] ? path.resolve(process.argv[2]) : RETAINED_ACCEPTANCE_PATH,
  );
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'acceptance validation failed'}\n`,
    );
    process.exitCode = 1;
  });
}
