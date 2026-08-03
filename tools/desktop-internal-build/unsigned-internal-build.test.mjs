import assert from 'node:assert/strict';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  assertFrozenInternalSource,
  assertHostRuntimeVersionOutput,
  assertSafeInternalEnvironment,
  createHostVersionInspectionEnvironment,
  createUnsignedInternalReceipt,
  deriveHostRuntimeVersion,
  readDesktopManifest,
  verifyPackagedHostAndPrune,
} from './build-unsigned-internal.mjs';
import {
  sha256File,
  verifyUnsignedInternalBuild,
} from './verify-unsigned-internal.mjs';

const COMMIT = 'a'.repeat(40);
const MAIN_MICROPHONE_DISCLOSURE =
  'AgentMesh360 仅在你主动开启本机听写时使用麦克风，将语音转换为可编辑文字。';
const HELPER_MICROPHONE_DISCLOSURE =
  'AgentMesh360 仅在你主动开启听写时使用麦克风，将语音转换为可编辑文字。';
const SPEECH_RECOGNITION_DISCLOSURE =
  'AgentMesh360 仅在你主动开启听写时，使用 macOS 本机语音识别将语音转换为可编辑文字。';
const REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);

function manifest() {
  return {
    version: '0.1.0',
    build: {
      appId: 'com.agentmesh360.client',
      productName: 'AgentMesh360',
    },
  };
}

function builderManifest() {
  return {
    version: '0.1.0',
    scripts: {
      'build:mac': 'npm run build:mac:internal',
      'build:mac:internal':
        'node ../tools/desktop-internal-build/build-unsigned-internal.mjs',
    },
    build: {
      appId: 'com.agentmesh360.client',
      productName: 'AgentMesh360',
      extraFiles: [
        {
          from: '.native-build/AgentMesh360SpeechHelper.app',
          to: 'Helpers/AgentMesh360SpeechHelper.app',
        },
      ],
      mac: {
        target: ['dmg', 'zip'],
        extendInfo: {
          NSMicrophoneUsageDescription: MAIN_MICROPHONE_DISCLOSURE,
          NSSpeechRecognitionUsageDescription:
            SPEECH_RECOGNITION_DISCLOSURE,
        },
      },
    },
    devDependencies: {},
  };
}

function privacyInfoPlist({
  microphoneDisclosure,
  speechRecognitionDisclosure = SPEECH_RECOGNITION_DISCLOSURE,
}) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>NSMicrophoneUsageDescription</key>
  <string>${microphoneDisclosure}</string>
  <key>NSSpeechRecognitionUsageDescription</key>
  <string>${speechRecognitionDisclosure}</string>
</dict>
</plist>
`;
}

async function packagedHostFixture(root, {
  packagedHostBody = 'same-host',
  packagedHelperBody = 'same-helper',
  packagedHelperInfo,
  mainMicrophoneDisclosure = MAIN_MICROPHONE_DISCLOSURE,
} = {}) {
  const host = path.join(root, 'release-host');
  const helperBundle = path.join(root, 'AgentMesh360SpeechHelper.app');
  const output = path.join(root, 'output');
  const app = path.join(output, 'mac-arm64/AgentMesh360.app');
  const packagedHost = path.join(
    app,
    'Contents/Resources/bin/agentmesh360-host',
  );
  const sourceHelper = path.join(
    helperBundle,
    'Contents/MacOS/agentmesh360-speech-helper',
  );
  const sourceHelperInfo = path.join(helperBundle, 'Contents/Info.plist');
  const packagedHelper = path.join(
    app,
    'Contents/Helpers/AgentMesh360SpeechHelper.app/Contents/MacOS/agentmesh360-speech-helper',
  );
  const packagedHelperInfoPath = path.join(
    app,
    'Contents/Helpers/AgentMesh360SpeechHelper.app/Contents/Info.plist',
  );
  const helperInfo = privacyInfoPlist({
    microphoneDisclosure: HELPER_MICROPHONE_DISCLOSURE,
  });

  await Promise.all([
    mkdir(path.dirname(packagedHost), { recursive: true }),
    mkdir(path.dirname(sourceHelper), { recursive: true }),
    mkdir(path.dirname(packagedHelper), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(host, 'same-host'),
    writeFile(packagedHost, packagedHostBody),
    writeFile(sourceHelper, 'same-helper'),
    writeFile(packagedHelper, packagedHelperBody),
    writeFile(sourceHelperInfo, helperInfo),
    writeFile(packagedHelperInfoPath, packagedHelperInfo ?? helperInfo),
    writeFile(
      path.join(app, 'Contents/Info.plist'),
      privacyInfoPlist({
        microphoneDisclosure: mainMicrophoneDisclosure,
      }),
    ),
    writeFile(path.join(output, 'AgentMesh360.dmg'), 'dmg'),
    writeFile(path.join(output, 'AgentMesh360.zip'), 'zip'),
  ]);
  await Promise.all([
    chmod(host, 0o755),
    chmod(packagedHost, 0o755),
    chmod(sourceHelper, 0o755),
    chmod(packagedHelper, 0o755),
  ]);
  return { helperBundle, host, output };
}

async function fixture() {
  const root = await mkdtemp(
    path.join(os.tmpdir(), 'am360-desktop-internal-test-'),
  );
  const artifacts = [];
  for (const [kind, body] of [
    ['dmg', 'dmg-fixture'],
    ['zip', 'zip-fixture'],
  ]) {
    const file = `AgentMesh360-0.1.0-arm64.${kind}`;
    const artifactPath = path.join(root, file);
    await writeFile(artifactPath, body);
    artifacts.push({
      kind,
      file,
      sizeBytes: Buffer.byteLength(body),
      sha256: await sha256File(artifactPath),
    });
  }
  const receipt = createUnsignedInternalReceipt({
    commit: COMMIT,
    manifest: manifest(),
    packageJsonSha256: `sha256:${'b'.repeat(64)}`,
    packageLockSha256: `sha256:${'c'.repeat(64)}`,
    architecture: 'arm64',
    artifacts,
    createdAt: '2026-07-30T00:00:00.000Z',
  });
  const receiptPath = path.join(root, 'unsigned-internal-build-v1.json');
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  const checksum = artifacts
    .map(
      (artifact) =>
        `${artifact.sha256.slice('sha256:'.length)}  ${artifact.file}`,
    )
    .sort()
    .join('\n');
  await writeFile(path.join(root, 'SHA256SUMS'), `${checksum}\n`);
  return { root, receipt, receiptPath };
}

async function rewriteReceipt(target, receipt) {
  await writeFile(target, `${JSON.stringify(receipt, null, 2)}\n`);
}

test('requires a clean commit already pushed to origin/main', () => {
  assert.doesNotThrow(() => assertFrozenInternalSource({
    head: COMMIT,
    originMain: COMMIT,
    status: '',
  }));
  assert.throws(() => assertFrozenInternalSource({
    head: COMMIT,
    originMain: 'b'.repeat(40),
    status: '',
  }));
  assert.throws(() => assertFrozenInternalSource({
    head: COMMIT,
    originMain: COMMIT,
    status: ' M desktop/package.json',
  }));
});

test('derives a monotonic AgentMesh Host runtime version from the desktop release and commit', () => {
  const older = deriveHostRuntimeVersion({
    desktopVersion: '0.1.0',
    commitEpochSeconds: 1_785_400_000,
  });
  const newerCommit = deriveHostRuntimeVersion({
    desktopVersion: '0.1.0',
    commitEpochSeconds: 1_785_400_001,
  });
  const newerDesktopPatch = deriveHostRuntimeVersion({
    desktopVersion: '0.1.1',
    commitEpochSeconds: 1_785_400_001,
  });
  assert.equal(older, '1000.1.1785400000000');
  assert.equal(newerCommit, '1000.1.1785400001000');
  assert.equal(newerDesktopPatch, '1000.1.1785400001001');
  assert.ok(BigInt(newerCommit.split('.')[2]) > BigInt(older.split('.')[2]));
  assert.ok(BigInt(newerDesktopPatch.split('.')[2]) > BigInt(newerCommit.split('.')[2]));
  assert.throws(
    () => deriveHostRuntimeVersion({
      desktopVersion: '0.1.1000',
      commitEpochSeconds: 1_785_400_001,
    }),
    /version boundary/u,
  );
});

test('requires the compiled Host to expose the exact runtime version and commit', () => {
  assert.doesNotThrow(() => assertHostRuntimeVersionOutput({
    output: 'grok 1000.1.1785400001001 (abcdef0)',
    runtimeVersion: '1000.1.1785400001001',
    commit: 'abcdef0123456789abcdef0123456789abcdef01',
  }));
  assert.throws(
    () => assertHostRuntimeVersionOutput({
      output: 'grok 0.2.106 (abcdef0)',
      runtimeVersion: '1000.1.1785400001001',
      commit: 'abcdef0123456789abcdef0123456789abcdef01',
    }),
    /was not embedded/u,
  );
});

test('inspects the compiled Host without reading the user Grok version cache', () => {
  const environment = createHostVersionInspectionEnvironment({
    environment: {
      PATH: '/usr/bin:/bin',
      HOME: '/Users/real-user',
      GROK_HOME: '/Users/real-user/.grok',
    },
    homeDirectory: '/private/tmp/agentmesh360-host-version',
  });
  assert.equal(environment.PATH, '/usr/bin:/bin');
  assert.equal(environment.HOME, '/private/tmp/agentmesh360-host-version');
  assert.equal(
    environment.GROK_HOME,
    '/private/tmp/agentmesh360-host-version/.grok',
  );
  assert.equal(
    environment.XDG_CACHE_HOME,
    '/private/tmp/agentmesh360-host-version/.cache',
  );
  assert.throws(
    () => createHostVersionInspectionEnvironment({
      environment: {},
      homeDirectory: 'relative',
    }),
    /inspection home is invalid/u,
  );
});

test('refuses signing and publishing credentials in internal mode', () => {
  assert.doesNotThrow(() => assertSafeInternalEnvironment({ PATH: '/bin' }));
  for (const key of ['APPLE_ID', 'CSC_LINK', 'GH_TOKEN']) {
    assert.throws(
      () => assertSafeInternalEnvironment({ [key]: 'present' }),
      new RegExp(key, 'u'),
    );
  }
});

test('refuses notarization, publishing, updater, and executable build hooks', () => {
  assert.equal(
    readDesktopManifest(
      Buffer.from(JSON.stringify(builderManifest())),
    ).version,
    '0.1.0',
  );
  const mutations = [
    (value) => { value.build.publish = { provider: 'github' }; },
    (value) => { value.build.mac.identity = 'Developer ID Application'; },
    (value) => { value.build.mac.notarize = true; },
    (value) => { value.build.afterSign = './sign.js'; },
    (value) => { value.build.extraFiles[0].to = 'Resources/helper'; },
    (value) => {
      value.build.mac.extendInfo.NSMicrophoneUsageDescription = 'changed';
    },
    (value) => {
      value.build.mac.extendInfo.NSSpeechRecognitionUsageDescription =
        'changed';
    },
    (value) => { value.devDependencies['electron-updater'] = '1.0.0'; },
    (value) => { value.scripts['build:mac'] = 'electron-builder --mac'; },
  ];
  for (const mutate of mutations) {
    const value = builderManifest();
    mutate(value);
    assert.throws(
      () => readDesktopManifest(Buffer.from(JSON.stringify(value))),
      /internal build baseline/u,
    );
  }
});

test('ships a strict schema for the same unsigned internal boundary', async () => {
  const schema = JSON.parse(await readFile(
    path.join(
      REPOSITORY_ROOT,
      'schemas/agentmesh360-desktop-internal-build-v1.schema.json',
    ),
    'utf8',
  ));
  assert.equal(schema.type, 'object');
  assert.equal(schema.additionalProperties, false);
  assert.equal(
    schema.properties.distributionClass.const,
    'unsigned_internal_only',
  );
  assert.equal(
    schema.properties.artifactPolicy.properties.productionR4Satisfied.const,
    false,
  );
  assert.equal(
    schema.properties.artifactPolicy.properties.packagedHostVerified.const,
    true,
  );
  assert.equal(
    schema.properties.instructions.properties
      .globalGatekeeperDisableRequired.const,
    false,
  );
});

test('verifies the packaged Host bytes and removes unpacked build output', async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), 'am360-desktop-host-output-test-'),
  );
  try {
    const { helperBundle, host, output } = await packagedHostFixture(root);
    await writeFile(path.join(output, 'AgentMesh360.zip.blockmap'), 'blockmap');
    await writeFile(path.join(output, 'builder-debug.yml'), 'debug');
    await mkdir(path.join(output, '.icon-icns'));
    await writeFile(path.join(output, '.icon-icns/icon.icns'), 'icon');
    await verifyPackagedHostAndPrune({
      outputDirectory: output,
      hostBinary: host,
      helperBundle,
      architecture: 'arm64',
      productName: 'AgentMesh360',
    });
    await assert.rejects(
      readFile(path.join(output, 'mac-arm64/AgentMesh360.app')),
    );
    await assert.rejects(
      readFile(path.join(output, 'builder-debug.yml')),
    );
    await assert.rejects(
      readFile(path.join(output, 'AgentMesh360.zip.blockmap')),
    );
    await assert.rejects(
      readFile(path.join(output, '.icon-icns/icon.icns')),
    );
    assert.equal(await readFile(path.join(output, 'AgentMesh360.dmg'), 'utf8'), 'dmg');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects mismatched Host, helper, privacy metadata, or update metadata', async () => {
  for (const mutation of [
    'host',
    'helper',
    'helper-privacy',
    'main-privacy',
    'update',
  ]) {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'am360-desktop-host-reject-test-'),
    );
    try {
      const packagedHelperInfo = mutation === 'helper-privacy'
        ? privacyInfoPlist({
          microphoneDisclosure: 'tampered helper disclosure',
        })
        : undefined;
      const { helperBundle, host, output } = await packagedHostFixture(root, {
        packagedHostBody: mutation === 'host'
          ? 'different-host'
          : 'same-host',
        packagedHelperBody: mutation === 'helper'
          ? 'different-helper'
          : 'same-helper',
        packagedHelperInfo,
        mainMicrophoneDisclosure: mutation === 'main-privacy'
          ? 'tampered main disclosure'
          : MAIN_MICROPHONE_DISCLOSURE,
      });
      if (mutation === 'update') {
        await writeFile(path.join(output, 'latest-mac.yml'), 'unsafe-update');
      }
      await assert.rejects(
        verifyPackagedHostAndPrune({
          outputDirectory: output,
          hostBinary: host,
          helperBundle,
          architecture: 'arm64',
          productName: 'AgentMesh360',
        }),
        {
          host: /Host does not match/u,
          helper: /helper does not match/u,
          'helper-privacy': /privacy metadata changed/u,
          'main-privacy': /NSMicrophoneUsageDescription changed/u,
          update: /inventory is invalid/u,
        }[mutation],
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test('verifies a complete unsigned internal DMG and ZIP boundary', async () => {
  const value = await fixture();
  try {
    const result = await verifyUnsignedInternalBuild(value.receiptPath);
    assert.deepEqual(result, {
      status: 'passed',
      receiptId: `desktop_internal_p6_${COMMIT.slice(0, 12)}_arm64`,
      distributionClass: 'unsigned_internal_only',
      commit: COMMIT,
      architecture: 'arm64',
      artifactCount: 2,
    });
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test('rejects a tampered artifact and stale checksum evidence', async () => {
  const value = await fixture();
  try {
    await writeFile(
      path.join(value.root, value.receipt.artifacts[0].file),
      'tampered-dmg',
    );
    await assert.rejects(
      verifyUnsignedInternalBuild(value.receiptPath),
      /digest or size mismatch/u,
    );
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test('rejects a symlink artifact even when the target bytes match', async () => {
  const value = await fixture();
  try {
    const artifact = value.receipt.artifacts[0];
    const original = path.join(value.root, artifact.file);
    const target = path.join(value.root, 'outside.dmg');
    const bytes = await readFile(original);
    await writeFile(target, bytes);
    await rm(original);
    await symlink(target, original);
    await assert.rejects(
      verifyUnsignedInternalBuild(value.receiptPath),
      /regular non-symlink/u,
    );
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test('rejects path traversal and absolute artifact paths', async () => {
  const value = await fixture();
  try {
    value.receipt.artifacts[0].file = '../AgentMesh360.dmg';
    await rewriteReceipt(value.receiptPath, value.receipt);
    await assert.rejects(
      verifyUnsignedInternalBuild(value.receiptPath),
      /artifact boundary/u,
    );
    value.receipt.artifacts[0].file = '/tmp/AgentMesh360.dmg';
    await rewriteReceipt(value.receiptPath, value.receipt);
    await assert.rejects(
      verifyUnsignedInternalBuild(value.receiptPath),
      /artifact boundary/u,
    );
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test('rejects any production, signing, notarization, upload, or updater claim', async () => {
  const mutations = [
    (value) => { value.artifactPolicy.developerIdSigned = true; },
    (value) => { value.artifactPolicy.notarized = true; },
    (value) => { value.artifactPolicy.appleCredentialsRead = true; },
    (value) => { value.artifactPolicy.externalUploadPerformed = true; },
    (value) => { value.artifactPolicy.automaticUpdateEnabled = true; },
    (value) => { value.artifactPolicy.packagedHostVerified = false; },
    (value) => { value.artifactPolicy.productionR4Satisfied = true; },
  ];
  for (const mutate of mutations) {
    const value = await fixture();
    try {
      mutate(value.receipt);
      await rewriteReceipt(value.receiptPath, value.receipt);
      await assert.rejects(
        verifyUnsignedInternalBuild(value.receiptPath),
        /artifact policy/u,
      );
    } finally {
      await rm(value.root, { recursive: true, force: true });
    }
  }
});

test('rejects a global Gatekeeper-disable instruction', async () => {
  const value = await fixture();
  try {
    value.receipt.instructions.globalGatekeeperDisableRequired = true;
    await rewriteReceipt(value.receiptPath, value.receipt);
    await assert.rejects(
      verifyUnsignedInternalBuild(value.receiptPath),
      /Gatekeeper instructions/u,
    );
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test('rejects duplicate receipt keys before JSON projection', async () => {
  const value = await fixture();
  try {
    const document = await readFile(value.receiptPath, 'utf8');
    await writeFile(
      value.receiptPath,
      document.replace(
        '"schemaVersion": 1,',
        '"schemaVersion": 1, "schemaVersion": 1,',
      ),
    );
    await assert.rejects(
      verifyUnsignedInternalBuild(value.receiptPath),
      /duplicate JSON object keys/u,
    );
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test('rejects a symlink receipt and missing checksum file', async () => {
  const value = await fixture();
  try {
    const linked = path.join(value.root, 'linked-receipt.json');
    await symlink(value.receiptPath, linked);
    await assert.rejects(
      verifyUnsignedInternalBuild(linked),
      /regular non-symlink/u,
    );
    await rm(path.join(value.root, 'SHA256SUMS'));
    await assert.rejects(
      verifyUnsignedInternalBuild(value.receiptPath),
    );
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test('receipt helper emits no absolute path or identity material', async () => {
  const value = await fixture();
  try {
    const serialized = JSON.stringify(value.receipt);
    for (const forbidden of [
      value.root,
      'Developer ID Application',
      'APPLE_ID',
      'TeamIdentifier',
      'authorization',
    ]) {
      assert.equal(serialized.includes(forbidden), false);
    }
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test('receipt boundary cannot be replaced by a directory', async () => {
  const value = await fixture();
  try {
    await rm(value.receiptPath);
    await mkdir(value.receiptPath);
    await assert.rejects(
      verifyUnsignedInternalBuild(value.receiptPath),
      /regular non-symlink/u,
    );
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});
