#!/usr/bin/env node

import { createHash } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  readStrictJsonFile,
  validateJsonSchema,
} from '../shared/strict-json-schema.mjs';
import {
  loadAcceptanceSchema,
  validateDesktopInternalAcceptance,
} from '../desktop-internal-acceptance/validate-desktop-internal-acceptance.mjs';

const MODULE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SCHEMA_PATH = path.resolve(
  MODULE_DIRECTORY,
  '../../schemas/agentmesh360-desktop-seed-download-preflight-v1.schema.json',
);
const DEFAULT_PREFLIGHT_PATH = path.resolve(
  MODULE_DIRECTORY,
  '../../docs/templates/desktop-seed-download-preflight-v1.json',
);
const RETAINED_ACCEPTANCE_PATH = path.resolve(
  MODULE_DIRECTORY,
  '../../docs/operations/tabletops/2026-07-30-p6-unsigned-internal-acceptance.json',
);

const EXPECTED_EVIDENCE = Object.freeze({
  acceptanceId: 'desktop_internal_p6_20260730_0001',
  acceptanceSha256:
    'sha256:958791ad8e6cbfadb6d2dc4bd202c16309cfac80c977b6a23ee254fd1b29b81a',
  artifactCommit: '9db201f43a49d0cc58dd466a500d40f48c8fe933',
  buildReceiptId: 'desktop_internal_p6_9db201f43a49_arm64',
  buildReceiptSha256:
    'sha256:ce1885e285c6edbb6e07241764b60d87278b7adfa07a3bd31ea847b3793e59f6',
  zipSha256:
    'sha256:7409150d8b82466c28813fda6964b465054d88f30e7c9b9900bf8b4a0e4164d6',
  dmgSha256:
    'sha256:c2cfcd1f024e39a52f253aa95e17684778afa23490ed5ed8e5d16c6702ca996f',
});
const EXPECTED_SCENARIOS = Object.freeze([
  'independent_checksum_publication',
  'artifact_upload_and_readback',
  'browser_download_quarantine',
  'gatekeeper_initial_block',
  'privacy_security_open_anyway',
  'first_launch_subscription_gate',
  'login_item_user_choice',
  'uninstall_and_local_cleanup',
  'channel_withdrawal',
]);
const EXPECTED_RETAINED_FIELDS = Object.freeze([
  'approval_reference',
  'artifact_digests',
  'channel_identifier',
  'quarantine_presence',
  'gatekeeper_result',
  'cleanup_counts',
  'withdrawal_result',
  'request_and_cost_totals',
]);
const EXPECTED_STOP_CONDITIONS = Object.freeze([
  'approval_missing',
  'channel_unapproved',
  'upload_credential_unapproved',
  'artifact_or_checksum_drift',
  'cohort_or_device_unapproved',
  'execution_window_unapproved',
  'abort_owner_missing',
  'evidence_retention_unapproved',
  'production_visibility_or_mutation',
  'provider_or_credit_use',
  'global_gatekeeper_disable',
  'cleanup_or_withdrawal_unproven',
]);

function sameOrderedStrings(actual, expected) {
  return Array.isArray(actual) && actual.join('\n') === expected.join('\n');
}

export async function loadSeedDownloadPreflightSchema(
  schemaPath = DEFAULT_SCHEMA_PATH,
) {
  const { value } = await readStrictJsonFile(schemaPath, {
    label: 'desktop seed download preflight schema',
  });
  if (
    value?.type !== 'object'
    || value?.additionalProperties !== false
    || !Array.isArray(value?.required)
    || !value?.properties
  ) {
    throw new Error('desktop seed download preflight schema is not strict');
  }
  return value;
}

export function validateSeedDownloadPreflight(value, schema) {
  const errors = validateJsonSchema(value, schema, {
    label: 'preflight',
  });
  const evidence = value?.evidenceInput;
  for (const [key, expected] of Object.entries(EXPECTED_EVIDENCE)) {
    if (evidence?.[key] !== expected) {
      errors.push(`preflight evidence ${key} does not match retained P6 acceptance`);
    }
  }
  if (
    !sameOrderedStrings(
      value?.scenarioMatrix?.map((entry) => entry?.scenario),
      EXPECTED_SCENARIOS,
    )
    || value?.scenarioMatrix?.some(
      (entry) => entry?.status !== 'blocked'
        || entry?.reason !== 'approval_missing',
    )
  ) {
    errors.push('preflight must retain the exact blocked scenario matrix');
  }
  if (
    !sameOrderedStrings(
      value?.evidencePolicy?.retainedFields,
      EXPECTED_RETAINED_FIELDS,
    )
    || !sameOrderedStrings(value?.stopConditions, EXPECTED_STOP_CONDITIONS)
  ) {
    errors.push('preflight evidence or stop-condition contract has drifted');
  }
  if (
    value?.authority !== 'none'
    || value?.approvalStatus !== 'not_approved'
    || value?.executionStatus !== 'blocked'
    || value?.channel?.configured !== false
    || value?.channel?.artifactUploaded !== false
    || value?.channel?.publicVisible !== false
    || value?.cohort?.accountCount !== 0
    || value?.cohort?.deviceCount !== 0
    || value?.networkBoundary?.preflightNetworkRequests !== 0
    || value?.networkBoundary?.uploadAuthorized !== false
    || value?.networkBoundary?.externalVisibilityAuthorized !== false
    || value?.networkBoundary?.productionMutationAuthorized !== false
    || value?.budget?.providerRequests !== 0
    || value?.budget?.agentMeshCredits !== 0
    || value?.budget?.appleServiceRequests !== 0
    || value?.budget?.uploadRequests !== 0
    || value?.budget?.currencyCostUsd !== 0
  ) {
    errors.push('preflight must remain a zero-authority zero-external-use record');
  }
  if (
    value?.safetyPolicy?.unsignedInternalOnly !== true
    || value?.safetyPolicy?.globalGatekeeperDisableForbidden !== true
    || value?.safetyPolicy?.developerIdClaimForbidden !== true
    || value?.safetyPolicy?.notarizationClaimForbidden !== true
    || value?.safetyPolicy?.automaticUpdaterForbidden !== true
    || value?.safetyPolicy?.realAccountLoginForbiddenBeforeApproval !== true
    || value?.safetyPolicy?.providerUseForbidden !== true
    || value?.safetyPolicy?.creditsUseForbidden !== true
  ) {
    errors.push('preflight safety policy cannot weaken unsigned internal boundaries');
  }
  return errors.slice(0, 64);
}

export async function validateSeedDownloadPreflightFile(
  filePath = DEFAULT_PREFLIGHT_PATH,
  {
    acceptancePath = RETAINED_ACCEPTANCE_PATH,
  } = {},
) {
  const [
    { value },
    schema,
    { bytes: acceptanceBytes, value: acceptanceValue },
    acceptanceSchema,
  ] = await Promise.all([
    readStrictJsonFile(filePath, {
      label: 'desktop seed download preflight',
    }),
    loadSeedDownloadPreflightSchema(),
    readStrictJsonFile(acceptancePath, {
      label: 'retained desktop internal acceptance',
    }),
    loadAcceptanceSchema(),
  ]);
  const errors = validateSeedDownloadPreflight(value, schema);
  const acceptanceErrors = validateDesktopInternalAcceptance(
    acceptanceValue,
    acceptanceSchema,
  );
  if (acceptanceErrors.length > 0) {
    errors.push(`retained acceptance is invalid: ${acceptanceErrors[0]}`);
  }
  const acceptanceSha256 =
    `sha256:${createHash('sha256').update(acceptanceBytes).digest('hex')}`;
  if (
    acceptanceValue.acceptanceId !== value?.evidenceInput?.acceptanceId
    || acceptanceSha256 !== value?.evidenceInput?.acceptanceSha256
  ) {
    errors.push('preflight is not bound to the retained acceptance bytes');
  }
  if (errors.length > 0) {
    throw new Error(`desktop seed download preflight is invalid: ${errors[0]}`);
  }
  return Object.freeze({
    status: 'passed',
    preflightId: value.preflightId,
    authority: value.authority,
    approvalStatus: value.approvalStatus,
    executionStatus: value.executionStatus,
    scenarioCount: value.scenarioMatrix.length,
    networkRequests: value.networkBoundary.preflightNetworkRequests,
    nextAction: value.nextAction,
  });
}

async function main() {
  if (process.argv.length > 3) {
    throw new Error(
      'usage: node validate-desktop-seed-download-preflight.mjs [preflight.json]',
    );
  }
  const result = await validateSeedDownloadPreflightFile(
    process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_PREFLIGHT_PATH,
  );
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'preflight validation failed'}\n`,
    );
    process.exitCode = 1;
  });
}
