'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  app,
  safeStorage,
} = require('electron');

const { AgentMeshCoreClient } = require('./auth/core-client');
const { SecureTokenStore } = require('./auth/secure-token-store');
const { configureP5CanaryRuntime } = require('./canary-runtime');
const { AcpHostClient } = require('./host/acp-client');
const { IdentityController } = require('./identity-controller');
const { PackageController } = require('./package-controller');

const AUTHORIZATION_ID = 'package_canary_e1_20260729_0002';
const BOUNDARY = '/private/tmp/agentmesh360-p5-e1-client';
const STATE_HOME = `${BOUNDARY}/state`;
const INPUT_PATH = `${BOUNDARY}/package-canary-e1-driver-input.json`;
const CONFIG_PATH = `${BOUNDARY}/package-canary-e1.json`;
const CONFIG_TEMP_PATH = `${BOUNDARY}/package-canary-e1.next.json`;
const OUTPUT_PATH = `${BOUNDARY}/package-canary-e1-host-receipt.json`;
const HARD_STOP = '2026-07-31T17:48:33Z';
const JOB_PACKAGE = 'com.agentmesh360.job-agent';
const FUTURE_PACKAGE = 'com.agentmesh360.future-agent';
const EXPECTED_ROOTS = new Set([
  'agentmesh360-root-e1-p5-20260729-a',
  'agentmesh360-root-e1-p5-20260729-b',
]);

if (process.env.AGENTMESH360_PACKAGE_CANARY_E1 !== '1') {
  throw new Error('P5 Agent Package canary flag is invalid');
}
configureP5CanaryRuntime({ app });

function requireCondition(value, code) {
  if (!value) {
    const error = new Error(code);
    error.code = code;
    throw error;
  }
}

function readMode0600Json(filePath, label, maximum = 64 * 1024) {
  const info = fs.lstatSync(filePath);
  requireCondition(
    info.isFile()
      && !info.isSymbolicLink()
      && info.size > 0
      && info.size <= maximum
      && (info.mode & 0o777) === 0o600,
    `${label}_invalid`,
  );
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function validateInput(value) {
  requireCondition(value?.schemaVersion === 1, 'input_schema_invalid');
  requireCondition(value.authorizationId === AUTHORIZATION_ID, 'authorization_invalid');
  requireCondition(
    /^[0-9a-f]{40}$/u.test(value.executorCommit || ''),
    'executor_invalid',
  );
  requireCondition(
    /^https:\/\/packages-p5-e1-[0-9a-f]{8}\.agentmesh360\.com$/u.test(
      value.origin || '',
    ),
    'origin_invalid',
  );
  requireCondition(
    typeof value.faultToken === 'string'
      && /^[A-Za-z0-9_-]{43}$/u.test(value.faultToken),
    'fault_authority_invalid',
  );
  requireCondition(
    value.stopsAt === HARD_STOP && Date.now() < Date.parse(value.stopsAt),
    'authorization_expired',
  );
  requireCondition(
    Array.isArray(value.rootKeys)
      && value.rootKeys.length === 2
      && value.rootKeys.every((root) => (
        EXPECTED_ROOTS.has(root?.keyId)
        && typeof root.publicKeyBase64 === 'string'
        && Buffer.from(root.publicKeyBase64, 'base64').length === 32
      ))
      && new Set(value.rootKeys.map((root) => root.keyId)).size === 2,
    'root_boundary_invalid',
  );
  requireCondition(value.productionAuthorityGranted === false, 'production_authority_invalid');
  return value;
}

function writeScenarioConfig(input, scenario) {
  try {
    const target = fs.lstatSync(CONFIG_PATH);
    requireCondition(target.isFile() && !target.isSymbolicLink(), 'config_target_invalid');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  try {
    fs.unlinkSync(CONFIG_TEMP_PATH);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const config = {
    schemaVersion: 1,
    authorizationId: AUTHORIZATION_ID,
    environment: 'e1',
    executorCommit: input.executorCommit,
    stateHome: STATE_HOME,
    origin: input.origin,
    scenario,
    faultToken: input.faultToken,
    rootKeys: input.rootKeys,
    stopsAt: input.stopsAt,
    productionAuthorityGranted: false,
  };
  fs.writeFileSync(CONFIG_TEMP_PATH, `${JSON.stringify(config)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  fs.chmodSync(CONFIG_TEMP_PATH, 0o600);
  fs.renameSync(CONFIG_TEMP_PATH, CONFIG_PATH);
}

function activeVersion(snapshot, packageId) {
  return snapshot?.status?.packages?.find((item) => (
    item.packageId === packageId
      && item.kind === 'installed_active'
      && item.slot === 'active'
  ))?.version || null;
}

function registryAudit(value) {
  return value?.registry?.cache || value?.snapshot?.status?.remoteRegistry?.cache || null;
}

async function withScenario(input, scenario, action) {
  writeScenarioConfig(input, scenario);
  const core = new AgentMeshCoreClient();
  const tokenStore = new SecureTokenStore({
    safeStorage,
    filePath: path.join(app.getPath('userData'), 'identity', 'refresh-token.secure.json'),
  });
  const host = new AcpHostClient();
  const identity = new IdentityController({ core, tokenStore, host });
  const packages = new PackageController({ identity, host });
  try {
    const state = await identity.start();
    requireCondition(state.phase === 'ready', 'subscription_not_ready');
    requireCondition(state.access?.canEnterClient === true, 'client_access_denied');
    requireCondition(state.subscription?.status === 'active', 'subscription_not_active');
    return await action({ host, identity, packages, state });
  } finally {
    await identity.shutdown().catch(() => {});
  }
}

function completedDelivery(result, packageId) {
  requireCondition(result?.outcome === 'completed', 'package_outcome_unknown');
  requireCondition(result.operation === 'download', 'package_operation_invalid');
  requireCondition(
    result.value?.receipt?.packageId === packageId
      || result.value?.approval?.packageId === packageId,
    'package_identity_invalid',
  );
  return result.value;
}

async function installDelivery(packages, packageId, {
  expectedAddedPermissions = null,
} = {}) {
  const delivery = completedDelivery(await packages.download(packageId), packageId);
  if (delivery.status === 'installed') return delivery.receipt;
  requireCondition(delivery.status === 'approval_required', 'approval_status_invalid');
  if (expectedAddedPermissions) {
    requireCondition(
      JSON.stringify(delivery.approval.addedPermissions)
        === JSON.stringify(expectedAddedPermissions),
      'approval_permissions_invalid',
    );
  }
  const approved = await packages.approve(delivery.approval.approvalId);
  requireCondition(approved?.outcome === 'completed', 'approval_outcome_unknown');
  requireCondition(approved.value?.packageId === packageId, 'approval_identity_invalid');
  return approved.value;
}

async function runHostScenarios(input) {
  const results = [];
  const pass = (scenario, evidenceCode) => {
    results.push({ scenario, evidenceCode, status: 'passed' });
  };

  await withScenario(input, 'baseline', async ({ packages }) => {
    const refreshed = await packages.refreshRegistry();
    const audit = registryAudit(refreshed);
    requireCondition(audit?.trustSequence === 1, 'baseline_trust_invalid');
    requireCondition(audit?.registryRevision === 1, 'baseline_registry_invalid');
    const future = refreshed.snapshot?.discovery?.packages?.find(
      (item) => item.packageId === FUTURE_PACKAGE,
    );
    requireCondition(future?.availability === 'new_agent', 'new_agent_not_discovered');
    const installed = await installDelivery(packages, FUTURE_PACKAGE);
    requireCondition(installed.version === '1.0.0', 'new_agent_version_invalid');
    const jobBaseline = await installDelivery(packages, JOB_PACKAGE, {
      expectedAddedPermissions: [
        'browser_control',
        'external_actions',
        'local_files',
        'network_access',
      ],
    });
    requireCondition(jobBaseline.version === '0.4.7', 'job_baseline_version_invalid');
  });
  pass('active_subscription', 'owner_oauth_core_host_active');
  pass('new_agent_install', 'future_agent_live_host_installed');

  await withScenario(input, 'same_permission_update', async ({ packages }) => {
    const refreshed = await packages.refreshRegistry();
    const audit = registryAudit(refreshed);
    requireCondition(audit?.trustSequence === 2, 'same_permission_trust_invalid');
    requireCondition(audit?.registryRevision === 2, 'same_permission_registry_invalid');
    const delivery = completedDelivery(await packages.download(JOB_PACKAGE), JOB_PACKAGE);
    requireCondition(delivery.status === 'installed', 'same_permission_requested_approval');
    requireCondition(
      delivery.receipt?.version === '0.4.8-e1.1',
      'same_permission_version_invalid',
    );
  });
  pass('same_permission_update', 'job_same_permissions_updated_without_expansion');

  await withScenario(input, 'publisher_rotation', async ({ packages }) => {
    const refreshed = await packages.refreshRegistry();
    const audit = registryAudit(refreshed);
    requireCondition(audit?.trustSequence === 2, 'publisher_overlap_trust_invalid');
    requireCondition(audit?.registryRevision === 2, 'publisher_overlap_registry_invalid');
  });

  await withScenario(input, 'permission_expansion_rejected', async ({ packages }) => {
    const refreshed = await packages.refreshRegistry();
    requireCondition(
      registryAudit(refreshed)?.registryRevision === 3,
      'expansion_registry_invalid',
    );
    const delivery = completedDelivery(await packages.download(JOB_PACKAGE), JOB_PACKAGE);
    requireCondition(delivery.status === 'approval_required', 'expansion_approval_missing');
    requireCondition(
      JSON.stringify(delivery.approval.addedPermissions) === '["process_execution"]',
      'expansion_permission_invalid',
    );
    requireCondition(
      activeVersion(refreshed.snapshot, JOB_PACKAGE) === '0.4.8-e1.1',
      'rejected_expansion_changed_active',
    );
  });
  pass('permission_expansion_rejected', 'approval_withheld_active_version_unchanged');

  await withScenario(input, 'permission_expansion_approved', async ({ packages }) => {
    const before = await packages.getSnapshot();
    requireCondition(
      activeVersion(before, JOB_PACKAGE) === '0.4.8-e1.1',
      'rejected_expansion_was_not_discarded',
    );
    const installed = await installDelivery(packages, JOB_PACKAGE, {
      expectedAddedPermissions: ['process_execution'],
    });
    requireCondition(installed.version === '0.4.9-e1.1', 'approved_expansion_version_invalid');
  });
  pass('permission_expansion_approved', 'explicit_permission_approval_installed');

  await withScenario(input, 'interrupted_install', async ({ packages }) => {
    let code = null;
    try {
      await packages.download(JOB_PACKAGE);
    } catch (error) {
      code = error?.code;
    }
    requireCondition(code === 'package_delivery_failed', 'interrupted_install_not_rejected');
    const snapshot = await packages.getSnapshot();
    requireCondition(
      activeVersion(snapshot, JOB_PACKAGE) === '0.4.9-e1.1',
      'interrupted_install_changed_active',
    );
  });
  pass('interrupted_install', 'truncated_release_transport_left_active_unchanged');

  await withScenario(input, 'digest_mismatch', async ({ packages }) => {
    const refreshed = await packages.refreshRegistry();
    requireCondition(
      refreshed.registry?.outcome === 'last_known_good',
      'metadata_tamper_not_rejected',
    );
    requireCondition(
      activeVersion(refreshed.snapshot, JOB_PACKAGE) === '0.4.9-e1.1',
      'metadata_tamper_changed_active',
    );
  });
  pass('artifact_or_metadata_tamper', 'signed_metadata_digest_tamper_rejected_lkg');

  await withScenario(input, 'registry_rollback', async ({ packages }) => {
    const refreshed = await packages.refreshRegistry();
    requireCondition(
      refreshed.registry?.outcome === 'last_known_good',
      'registry_rollback_not_rejected',
    );
    requireCondition(
      refreshed.registry?.cache?.registryRevision === 3,
      'registry_rollback_replaced_lkg',
    );
  });
  pass('registry_rollback_or_equivocation', 'rollback_rejected_without_lkg_replacement');

  await withScenario(input, 'expired_metadata', async ({ packages }) => {
    const refreshed = await packages.refreshRegistry();
    requireCondition(
      refreshed.registry?.outcome === 'last_known_good',
      'expired_trust_not_rejected',
    );
  });
  pass('trust_expiry_or_publisher_revocation', 'expired_trust_rejected_lkg_retained');

  await withScenario(input, 'baseline', async ({ packages }) => {
    const rolledBack = await packages.rollback(JOB_PACKAGE);
    requireCondition(rolledBack?.outcome === 'completed', 'package_rollback_unknown');
    requireCondition(rolledBack.value?.version === '0.4.8-e1.1', 'package_rollback_version_invalid');
    const snapshot = await packages.getSnapshot();
    requireCondition(
      activeVersion(snapshot, JOB_PACKAGE) === '0.4.8-e1.1',
      'package_rollback_not_active',
    );
  });
  pass('package_rollback', 'verified_previous_version_restored');

  await withScenario(input, 'baseline', async ({ host }) => {
    const [agents, catalog] = await Promise.all([
      host.listAgents(),
      host.getAgentPackageCatalog(),
    ]);
    requireCondition(
      agents?.agents?.some((agent) => agent.agentId === 'future-agent'),
      'projected_agent_not_visible',
    );
    requireCondition(
      catalog?.catalog?.packages?.some((item) => (
        item.packageId === FUTURE_PACKAGE
          && item.agent?.agentId === 'future-agent'
          && item.version === '1.0.0'
      )),
      'projected_package_not_visible',
    );
    const activation = await host.activateAgent('future-agent');
    requireCondition(
      activation?.agent?.agentId === 'future-agent'
        || activation?.agentId === 'future-agent',
      'projected_agent_not_activatable',
    );
  });
  pass('host_skill_projection', 'installed_projection_visible_and_activatable');

  await withScenario(input, 'publisher_revocation', async ({ packages }) => {
    const refreshed = await packages.refreshRegistry();
    const audit = registryAudit(refreshed);
    requireCondition(audit?.trustSequence === 3, 'publisher_revocation_trust_invalid');
    requireCondition(audit?.registryRevision === 4, 'publisher_revocation_registry_invalid');
  });
  pass(
    'publisher_rotation_or_revocation',
    'publisher_overlap_then_revocation_advanced_monotonically',
  );

  await withScenario(input, 'root_rotation', async ({ packages }) => {
    const refreshed = await packages.refreshRegistry();
    const audit = registryAudit(refreshed);
    requireCondition(audit?.trustSequence === 4, 'root_rotation_trust_invalid');
    requireCondition(audit?.registryRevision === 5, 'root_rotation_registry_invalid');
  });
  pass('root_rotation', 'root_b_trust_and_registry_accepted');

  await withScenario(input, 'registry_withdrawal', async ({ packages }) => {
    const refreshed = await packages.refreshRegistry();
    requireCondition(
      refreshed.registry?.outcome === 'last_known_good',
      'registry_withdrawal_not_closed',
    );
    requireCondition(
      refreshed.registry?.cache?.trustSequence === 4
        && refreshed.registry?.cache?.registryRevision === 5,
      'registry_withdrawal_lkg_invalid',
    );
  });
  pass('registry_withdrawal', 'public_registry_404_retained_verified_lkg');

  return results;
}

function writeReceipt(input, results) {
  requireCondition(results.length === 14, 'host_scenario_count_invalid');
  requireCondition(
    new Set(results.map((result) => result.scenario)).size === results.length,
    'host_scenario_duplicate',
  );
  const receipt = {
    schemaVersion: 1,
    receiptId: 'package_canary_e1_live_host_scenarios_20260729_0001',
    authorizationId: AUTHORIZATION_ID,
    environment: 'e1',
    executorCommit: input.executorCommit,
    executionStatus: 'live_host_scenarios_passed',
    scenarioCount: results.length,
    results,
    packageMutationsPerformed: 5,
    subscriptionMutationCount: 0,
    providerInferenceOperationsAdded: 0,
    agentMeshCreditsUsed: 0,
    productionAuthorityGranted: false,
    accountIdentifierRecorded: false,
    credentialMaterialRecorded: false,
    promptOrResponseRecorded: false,
    completedAt: new Date().toISOString(),
  };
  fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(receipt)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  fs.chmodSync(OUTPUT_PATH, 0o600);
  return receipt;
}

app.whenReady().then(async () => {
  let currentStep = 'input';
  let exitCode = 0;
  try {
    const input = validateInput(readMode0600Json(INPUT_PATH, 'driver_input'));
    currentStep = 'live_host_scenarios';
    const results = await runHostScenarios(input);
    currentStep = 'receipt';
    const receipt = writeReceipt(input, results);
    process.stdout.write(`P5_PACKAGE_HOST_RESULT ${JSON.stringify({
      executionStatus: receipt.executionStatus,
      scenarioCount: receipt.scenarioCount,
      providerInferenceOperationsAdded: 0,
      agentMeshCreditsUsed: 0,
      accountIdentifierPrinted: false,
      credentialMaterialPrinted: false,
    })}\n`);
  } catch (error) {
    exitCode = 2;
    process.stdout.write(`P5_PACKAGE_HOST_ERROR ${JSON.stringify({
      step: currentStep,
      code: String(error?.code || 'package_canary_failed'),
      accountIdentifierPrinted: false,
      credentialMaterialPrinted: false,
    })}\n`);
  } finally {
    app.exit(exitCode);
  }
}).catch(() => {
  process.stdout.write(
    'P5_PACKAGE_HOST_ERROR {"step":"startup","code":"startup_failed","accountIdentifierPrinted":false,"credentialMaterialPrinted":false}\n',
  );
  app.exit(2);
});
