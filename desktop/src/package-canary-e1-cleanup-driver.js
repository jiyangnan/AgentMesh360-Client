'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  app,
  safeStorage,
} = require('electron');

const CLIENT_BOUNDARY = '/private/tmp/agentmesh360-p5-e1-client';
const RETAINED_SOURCE = path.join(CLIENT_BOUNDARY, 'source/desktop/src');
const RECEIPT_PATH = path.join(
  CLIENT_BOUNDARY,
  'local-provider-cleanup-receipt.json',
);
const { AgentMeshCoreClient } = require(path.join(
  RETAINED_SOURCE,
  'auth/core-client',
));
const { SecureTokenStore } = require(path.join(
  RETAINED_SOURCE,
  'auth/secure-token-store',
));
const { AcpHostClient } = require(path.join(
  RETAINED_SOURCE,
  'host/acp-client',
));
const { IdentityController } = require(path.join(
  RETAINED_SOURCE,
  'identity-controller',
));
const { ProviderController } = require(path.join(
  RETAINED_SOURCE,
  'provider-controller',
));
const { configureP5CanaryRuntime } = require(path.join(
  RETAINED_SOURCE,
  'canary-runtime',
));

configureP5CanaryRuntime({ app });

function requireCondition(value, code) {
  if (!value) {
    const error = new Error(code);
    error.code = code;
    throw error;
  }
}

function writeReceipt(receipt) {
  fs.writeFileSync(
    RECEIPT_PATH,
    `${JSON.stringify(receipt)}\n`,
    {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    },
  );
  fs.chmodSync(RECEIPT_PATH, 0o600);
}

app.whenReady().then(async () => {
  const core = new AgentMeshCoreClient();
  const tokenStore = new SecureTokenStore({
    safeStorage,
    filePath: path.join(
      app.getPath('userData'),
      'identity',
      'refresh-token.secure.json',
    ),
  });
  const host = new AcpHostClient();
  const identity = new IdentityController({ core, tokenStore, host });
  const providers = new ProviderController({ identity, host });
  let currentStep = 'startup';
  let exitCode = 0;

  try {
    currentStep = 'identity_restore';
    const state = await identity.start();
    requireCondition(state.phase === 'ready', 'subscription_not_ready');
    requireCondition(
      state.access?.canEnterClient === true,
      'client_access_denied',
    );

    currentStep = 'provider_inventory';
    const before = await providers.getSnapshot();
    requireCondition(
      before.profiles.length === 1,
      'provider_profile_inventory_invalid',
    );
    requireCondition(
      before.assignments.length === 1,
      'provider_assignment_inventory_invalid',
    );
    const profile = before.profiles[0];
    requireCondition(
      profile.presetId === 'google-gemini',
      'provider_profile_preset_invalid',
    );
    requireCondition(
      profile.credentialConfigured === true,
      'provider_credential_not_configured',
    );
    requireCondition(
      before.assignments[0]?.providerProfileId === profile.profileId,
      'provider_assignment_profile_invalid',
    );
    requireCondition(
      before.assignments[0]?.modelId === 'gemini-3.5-flash-lite',
      'provider_assignment_model_invalid',
    );

    currentStep = 'provider_delete';
    const deleted = await providers.deleteProfile(profile.profileId);
    requireCondition(deleted.deleted === true, 'provider_delete_failed');

    currentStep = 'provider_postflight';
    const after = await providers.getSnapshot();
    requireCondition(
      after.profiles.length === 0,
      'provider_profile_remains',
    );
    requireCondition(
      after.assignments.length === 0,
      'provider_assignment_remains',
    );
    writeReceipt({
      schemaVersion: 1,
      authorizationId: 'package_canary_e1_20260729_0002',
      environment: 'e1',
      executionStatus: 'temporary_provider_deleted',
      providerProfileDeletedCount: 1,
      providerAssignmentDeletedCount: 1,
      providerInferenceOperationsAdded: 0,
      agentMeshCreditsUsed: 0,
      productionMutationCount: 0,
      accountIdentifierRecorded: false,
      credentialMaterialRecorded: false,
      promptOrResponseRecorded: false,
      completedAt: new Date().toISOString(),
    });
    process.stdout.write(
      'P5_LOCAL_PROVIDER_CLEANUP_RESULT '
      + '{"executionStatus":"temporary_provider_deleted",'
      + '"providerProfileDeletedCount":1,'
      + '"providerAssignmentDeletedCount":1,'
      + '"providerInferenceOperationsAdded":0,'
      + '"agentMeshCreditsUsed":0,'
      + '"accountIdentifierPrinted":false,'
      + '"credentialMaterialPrinted":false}\n',
    );
  } catch (error) {
    exitCode = 2;
    process.stdout.write(
      `P5_LOCAL_PROVIDER_CLEANUP_ERROR ${JSON.stringify({
        step: currentStep,
        code: String(error?.code || 'cleanup_step_failed'),
        accountIdentifierPrinted: false,
        credentialMaterialPrinted: false,
      })}\n`,
    );
  } finally {
    await identity.shutdown().catch(() => {});
    app.exit(exitCode);
  }
}).catch(() => {
  process.stdout.write(
    'P5_LOCAL_PROVIDER_CLEANUP_ERROR '
    + '{"step":"startup","code":"startup_failed",'
    + '"accountIdentifierPrinted":false,'
    + '"credentialMaterialPrinted":false}\n',
  );
  app.exit(2);
});
