import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createP5JobVariantDefinitions,
} from '../release-provenance/run-e0-release-provenance.mjs';
import {
  AUTHORIZATION_ID,
  EXPECTED_GENERATIONS,
  ORIGIN_STATE_PATH,
  OUTPUT_STATE_PATH,
  PUBLISHER_KEY_IDS,
  assertGeneration,
  parseArguments,
  releaseOriginFromState,
  validatePreflight,
} from './build-release-chain.mjs';

const COMMIT = 'a'.repeat(40);

function preflight() {
  return {
    authorizationId: AUTHORIZATION_ID,
    executionStatus: 'release_chain_preflight_passed',
    executorCommit: COMMIT,
    authority: {
      productionAuthorityGranted: false,
      productionConstantsMutable: false,
    },
    releaseChain: {
      candidateCommit: 'e1ef8db19dc58a2c9cec19ac34f7e1966d741b7c',
      dualBuildRequired: true,
      generations: [
        {
          generation: 'a',
          publisherKeyAlias: 'p5-e1-publisher-a',
          releases: [...EXPECTED_GENERATIONS.a],
        },
        {
          generation: 'b',
          publisherKeyAlias: 'p5-e1-publisher-b',
          releases: [...EXPECTED_GENERATIONS.b],
        },
      ],
    },
    infrastructure: { hardCapUsd: 3 },
    gates: {
      releaseBuildAllowed: true,
      p6Allowed: false,
    },
  };
}

function result(generation) {
  return {
    agentPlan: generation === 'a'
      ? 'baseline-four-agent'
      : 'p5-job-variants',
    agentResults: EXPECTED_GENERATIONS[generation].map((identity) => {
      const [agentId, version] = identity.split('@');
      return {
        agentId,
        version,
        status: 'passed',
        buildCount: 2,
        signatureVerificationCount: 2,
        outputComparisons: Array.from(
          { length: 10 },
          () => ({ byteIdentical: true }),
        ),
      };
    }),
  };
}

test('parses only the complete absolute P5 Release Chain boundary', () => {
  const parsed = parseArguments([
    '--executor-commit',
    COMMIT,
    '--origin-state',
    ORIGIN_STATE_PATH,
    '--output-state',
    OUTPUT_STATE_PATH,
    '--deploy-source',
    '/tmp/deploy',
    '--job-source',
    '/tmp/job',
    '--lecturecast-source',
    '/tmp/lecturecast',
  ]);
  assert.equal(parsed.executorCommit, COMMIT);
  assert.throws(() => parseArguments([
    '--executor-commit',
    COMMIT,
    '--origin-state',
    'relative',
  ]));
});

test('accepts only the dedicated P5 DNS-only HTTPS origin', () => {
  const state = {
    authorizationId: AUTHORIZATION_ID,
    dns: {
      hostname: 'packages-p5-e1-1234abcd.agentmesh360.com',
      proxied: false,
    },
    origin: {
      deployed: true,
      executorCommit: COMMIT,
      tls: 'caddy_managed_lets_encrypt',
    },
    infrastructure: {
      dropletCount: 1,
      spacesBucketCount: 2,
    },
  };
  assert.equal(
    releaseOriginFromState(state),
    'https://packages-p5-e1-1234abcd.agentmesh360.com',
  );
  for (const mutate of [
    (value) => { value.authorizationId = 'distribution_service_e1_20260728_0001'; },
    (value) => { value.dns.proxied = true; },
    (value) => { value.dns.hostname = 'packages-e1-1234abcd.agentmesh360.com'; },
    (value) => { value.infrastructure.dropletCount = 2; },
  ]) {
    const value = structuredClone(state);
    mutate(value);
    assert.throws(() => releaseOriginFromState(value));
  }
});

test('binds the exact two-generation preflight', () => {
  assert.equal(validatePreflight(preflight()), COMMIT);
  const mutations = [
    (value) => { value.authority.productionAuthorityGranted = true; },
    (value) => { value.infrastructure.hardCapUsd = 4; },
    (value) => { value.gates.p6Allowed = true; },
    (value) => { value.releaseChain.generations[1].releases.pop(); },
    (value) => {
      value.releaseChain.generations[1].publisherKeyAlias =
        'p5-e1-publisher-a';
    },
  ];
  for (const mutate of mutations) {
    const value = structuredClone(preflight());
    mutate(value);
    assert.throws(() => validatePreflight(value));
  }
});

test('requires byte-identical dual builds for every baseline and variant', () => {
  assert.doesNotThrow(() => assertGeneration(result('a'), 'a'));
  assert.doesNotThrow(() => assertGeneration(result('b'), 'b'));
  const missing = result('b');
  missing.agentResults.pop();
  assert.throws(() => assertGeneration(missing, 'b'));
  const mismatch = result('a');
  mismatch.agentResults[0].outputComparisons[0].byteIdentical = false;
  assert.throws(() => assertGeneration(mismatch, 'a'));
});

test('creates exact same-permission and permission-expansion definitions', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'am360-p5-variant-test-'));
  const candidate = path.join(root, 'candidate');
  const boundary = path.join(root, 'boundary');
  const definition = path.join(
    candidate,
    'crates/codegen/xai-grok-shell/src/agentmesh360/packages/job-agent',
  );
  try {
    await mkdir(definition, { recursive: true });
    await mkdir(boundary);
    await writeFile(
      path.join(definition, 'agentmesh-agent.toml'),
      [
        'schemaVersion = 1',
        'version = "0.4.7"',
        'requestedPermissions = [',
        '  "browser_control",',
        '  "external_actions",',
        '  "local_files",',
        '  "network_access",',
        ']',
        '',
      ].join('\n'),
    );
    await writeFile(
      path.join(definition, 'agentmesh-authoring.toml'),
      'schemaVersion = 1\npackageFiles = []\n',
    );
    const variants = await createP5JobVariantDefinitions(
      candidate,
      boundary,
    );
    assert.deepEqual(
      variants.map((variant) => ({
        version: variant.version,
        permissionExpansion: variant.permissionExpansion,
      })),
      [
        { version: '0.4.8-e1.1', permissionExpansion: false },
        { version: '0.4.9-e1.1', permissionExpansion: true },
      ],
    );
    const samePermission = await readFile(
      path.join(variants[0].definition, 'agentmesh-agent.toml'),
      'utf8',
    );
    const expansion = await readFile(
      path.join(variants[1].definition, 'agentmesh-agent.toml'),
      'utf8',
    );
    assert.match(samePermission, /version = "0\.4\.8-e1\.1"/u);
    assert.doesNotMatch(samePermission, /process_execution/u);
    assert.match(expansion, /version = "0\.4\.9-e1\.1"/u);
    assert.match(expansion, /"process_execution"/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('pins distinct Publisher keys and has no cloud creation capability', async () => {
  assert.notEqual(PUBLISHER_KEY_IDS.a, PUBLISHER_KEY_IDS.b);
  const source = await readFile(
    new URL('./build-release-chain.mjs', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(
    source,
    /spawnSync\(['"]doctl|api\.cloudflare\.com|from ['"]node:https|fetch\s*\(/u,
  );
});
