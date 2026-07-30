#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  sha256File,
  verifyUnsignedInternalBuild,
} from './verify-unsigned-internal.mjs';

const MODULE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(MODULE_DIRECTORY, '../..');
const DESKTOP_ROOT = path.join(REPOSITORY_ROOT, 'desktop');
const FORBIDDEN_ENVIRONMENT_KEYS = Object.freeze([
  'APPLE_API_ISSUER',
  'APPLE_API_KEY',
  'APPLE_API_KEY_ID',
  'APPLE_APP_SPECIFIC_PASSWORD',
  'APPLE_ID',
  'APPLE_KEYCHAIN',
  'APPLE_KEYCHAIN_PROFILE',
  'APPLE_TEAM_ID',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'BITBUCKET_TOKEN',
  'CSC_KEY_PASSWORD',
  'CSC_LINK',
  'EP_DRAFT',
  'EP_PRELEASE',
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'KEYGEN_TOKEN',
  'WIN_CSC_KEY_PASSWORD',
  'WIN_CSC_LINK',
]);
const MAX_COMMAND_OUTPUT_BYTES = 4 * 1024 * 1024;
const AGENTMESH_HOST_VERSION_MAJOR_BASE = 1000;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? REPOSITORY_ROOT,
    encoding: 'utf8',
    env: options.env ?? process.env,
    maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
    stdio: options.inherit ? 'inherit' : undefined,
  });
  if (result.error || result.status !== 0) {
    throw new Error(options.errorMessage ?? `${command} failed`);
  }
  return (result.stdout ?? '').trim();
}

function runGit(args) {
  return run('git', args, {
    errorMessage: 'internal desktop build git inspection failed',
  });
}

export function assertSafeInternalEnvironment(environment = process.env) {
  const present = FORBIDDEN_ENVIRONMENT_KEYS.filter(
    (key) => typeof environment[key] === 'string'
      && environment[key].trim() !== '',
  );
  if (present.length > 0) {
    throw new Error(
      `internal desktop build refuses signing or publishing environment: ${
        present.join(',')
      }`,
    );
  }
}

export function assertFrozenInternalSource({
  head,
  originMain,
  status,
}) {
  if (
    !/^[0-9a-f]{40}$/u.test(head)
    || originMain !== head
    || status !== ''
  ) {
    throw new Error(
      'internal desktop build requires a clean commit already pushed to origin/main',
    );
  }
}

export function deriveHostRuntimeVersion({
  desktopVersion,
  commitEpochSeconds,
}) {
  const match = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u
    .exec(desktopVersion);
  const commitEpoch = Number(commitEpochSeconds);
  if (
    !match
    || !Number.isSafeInteger(commitEpoch)
    || commitEpoch < 1_000_000_000
    || commitEpoch > 9_999_999_999
  ) {
    throw new Error('internal desktop Host runtime version input is invalid');
  }
  const [desktopMajor, desktopMinor, desktopPatch] = match
    .slice(1)
    .map(Number);
  if (
    desktopMajor > 8999
    || desktopMinor > 999_999
    || desktopPatch > 999
  ) {
    throw new Error('internal desktop version exceeds the Host runtime version boundary');
  }
  const runtimeMajor = AGENTMESH_HOST_VERSION_MAJOR_BASE + desktopMajor;
  const runtimePatch = (commitEpoch * 1000) + desktopPatch;
  return `${runtimeMajor}.${desktopMinor}.${runtimePatch}`;
}

export function assertHostRuntimeVersionOutput({
  output,
  runtimeVersion,
  commit,
}) {
  if (
    output !== `grok ${runtimeVersion} (${commit.slice(0, 7)})`
  ) {
    throw new Error('internal desktop Host runtime version was not embedded');
  }
}

function digest(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

export function readDesktopManifest(bytes) {
  let manifest;
  try {
    manifest = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('desktop package manifest is invalid JSON');
  }
  const targets = manifest.build?.mac?.target;
  const executableBuilderHooks = [
    'afterAllArtifactBuild',
    'afterPack',
    'afterSign',
    'artifactBuildCompleted',
    'artifactBuildStarted',
    'beforeBuild',
    'beforePack',
  ];
  if (
    manifest.version == null
    || manifest.build?.appId !== 'com.agentmesh360.client'
    || manifest.build?.productName !== 'AgentMesh360'
    || !Array.isArray(targets)
    || targets.join(',') !== 'dmg,zip'
    || manifest.build?.publish !== undefined
    || manifest.build?.mac?.identity !== undefined
    || manifest.build?.mac?.notarize !== undefined
    || executableBuilderHooks.some(
      (key) => manifest.build?.[key] !== undefined,
    )
    || manifest.dependencies?.['electron-updater'] !== undefined
    || manifest.devDependencies?.['electron-updater'] !== undefined
    || manifest.scripts?.['build:mac'] !== 'npm run build:mac:internal'
    || manifest.scripts?.['build:mac:internal']
      !== 'node ../tools/desktop-internal-build/build-unsigned-internal.mjs'
  ) {
    throw new Error('desktop package manifest is not the internal build baseline');
  }
  return manifest;
}

export function createUnsignedInternalReceipt({
  commit,
  manifest,
  packageJsonSha256,
  packageLockSha256,
  architecture,
  artifacts,
  createdAt,
}) {
  return {
    schemaVersion: 1,
    receiptId:
      `desktop_internal_p6_${commit.slice(0, 12)}_${architecture}`,
    distributionClass: 'unsigned_internal_only',
    buildStatus: 'passed',
    source: {
      commit,
      desktopVersion: manifest.version,
      bundleId: manifest.build.appId,
      productName: manifest.build.productName,
      architecture,
      minimumMacOSVersion: 'not_frozen_for_internal',
      desktopPackageJsonSha256: packageJsonSha256,
      desktopPackageLockSha256: packageLockSha256,
    },
    artifactPolicy: {
      developerIdSigned: false,
      notarized: false,
      appleCredentialsRead: false,
      externalUploadPerformed: false,
      publishProviderConfigured: false,
      automaticUpdateEnabled: false,
      packagedHostVerified: true,
      manualGatekeeperReviewRequired: true,
      sha256Required: true,
      productionR4Satisfied: false,
    },
    artifacts,
    instructions: {
      document: 'docs/operations/P6_UNSIGNED_INTERNAL_DISTRIBUTION.md',
      gatekeeperAction: 'privacy_and_security_open_anyway',
      globalGatekeeperDisableRequired: false,
    },
    evidence: {
      buildNetworkScope: 'dependency_and_build_tooling_only',
      providerRequests: 0,
      agentMeshCredits: 0,
      appleServiceRequests: 0,
      currencyCostUsd: 0,
    },
    createdAt,
  };
}

async function collectArtifacts(outputDirectory) {
  const names = await readdir(outputDirectory);
  const selected = names
    .filter((name) => /\.(dmg|zip)$/u.test(name))
    .sort();
  if (
    selected.length !== 2
    || selected.filter((name) => name.endsWith('.dmg')).length !== 1
    || selected.filter((name) => name.endsWith('.zip')).length !== 1
  ) {
    throw new Error('internal desktop build did not produce one DMG and one ZIP');
  }
  const artifacts = [];
  for (const file of selected) {
    const direct = await lstat(path.join(outputDirectory, file));
    if (
      !direct.isFile()
      || direct.isSymbolicLink()
      || direct.size <= 0
      || direct.size > 2 * 1024 * 1024 * 1024
    ) {
      throw new Error('internal desktop artifact boundary is invalid');
    }
    artifacts.push({
      kind: file.endsWith('.dmg') ? 'dmg' : 'zip',
      file,
      sizeBytes: direct.size,
      sha256: await sha256File(path.join(outputDirectory, file)),
    });
  }
  return artifacts;
}

export async function verifyPackagedHostAndPrune({
  outputDirectory,
  hostBinary,
  architecture,
  productName,
}) {
  const expectedDirectory =
    architecture === 'arm64' ? 'mac-arm64' : 'mac';
  const allowedAuxiliaryFiles = new Set([
    'builder-debug.yml',
    'builder-effective-config.yaml',
  ]);
  const allowedAuxiliaryDirectories = new Set(['.icon-icns']);
  const entries = await readdir(outputDirectory, { withFileTypes: true });
  const artifactNames = entries
    .filter((entry) => entry.isFile() && /\.(dmg|zip)$/u.test(entry.name))
    .map((entry) => entry.name);
  const allowedBlockmaps = new Set(
    artifactNames.map((name) => `${name}.blockmap`),
  );
  const unpacked = entries.filter(
    (entry) =>
      entry.isDirectory()
      && !allowedAuxiliaryDirectories.has(entry.name),
  );
  const unexpected = entries.filter(
    (entry) =>
      (
        entry.isDirectory()
        && !allowedAuxiliaryDirectories.has(entry.name)
        && entry.name !== expectedDirectory
      )
      || (
        !entry.isDirectory()
        && !/\.(dmg|zip)$/u.test(entry.name)
        && (
          (
            !allowedAuxiliaryFiles.has(entry.name)
            && !allowedBlockmaps.has(entry.name)
          )
          || !entry.isFile()
        )
      ),
  );
  if (
    unpacked.length !== 1
    || unpacked[0].name !== expectedDirectory
    || unexpected.length !== 0
  ) {
    throw new Error('internal Electron output inventory is invalid');
  }
  const packagedHost = path.join(
    outputDirectory,
    expectedDirectory,
    `${productName}.app`,
    'Contents/Resources/bin/agentmesh360-host',
  );
  const direct = await lstat(packagedHost);
  const source = await lstat(hostBinary);
  if (
    !direct.isFile()
    || direct.isSymbolicLink()
    || (direct.mode & 0o111) === 0
    || !source.isFile()
    || source.isSymbolicLink()
    || (source.mode & 0o111) === 0
  ) {
    throw new Error('packaged internal Host is invalid');
  }
  if (await sha256File(packagedHost) !== await sha256File(hostBinary)) {
    throw new Error('packaged internal Host does not match the release Host');
  }

  await rm(path.join(outputDirectory, expectedDirectory), {
    recursive: true,
    force: false,
  });
  for (const entry of entries) {
    if (
      allowedAuxiliaryFiles.has(entry.name)
      || allowedBlockmaps.has(entry.name)
      || allowedAuxiliaryDirectories.has(entry.name)
    ) {
      await rm(path.join(outputDirectory, entry.name), {
        recursive: allowedAuxiliaryDirectories.has(entry.name),
        force: true,
      });
    }
  }
}

async function build() {
  if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(process.arch)) {
    throw new Error('internal desktop build supports macOS arm64 or x64 only');
  }
  assertSafeInternalEnvironment();
  const head = runGit(['rev-parse', 'HEAD']);
  assertFrozenInternalSource({
    head,
    originMain: runGit(['rev-parse', 'origin/main']),
    status: runGit(['status', '--porcelain=v1', '--untracked-files=all']),
  });

  const packageJsonPath = path.join(DESKTOP_ROOT, 'package.json');
  const packageLockPath = path.join(DESKTOP_ROOT, 'package-lock.json');
  const packageJsonBytes = await readFile(packageJsonPath);
  const packageLockBytes = await readFile(packageLockPath);
  const manifest = readDesktopManifest(packageJsonBytes);
  const hostRuntimeVersion = deriveHostRuntimeVersion({
    desktopVersion: manifest.version,
    commitEpochSeconds: runGit(['show', '-s', '--format=%ct', 'HEAD']),
  });
  const outputDirectory = path.join(
    DESKTOP_ROOT,
    'dist',
    'internal',
    `${manifest.version}-${head.slice(0, 12)}-${process.arch}`,
  );
  try {
    await lstat(outputDirectory);
    throw new Error('internal desktop output already exists');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  await mkdir(path.dirname(outputDirectory), { recursive: true });

  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), 'agentmesh360-desktop-internal-'),
  );
  try {
    const cargoTarget = path.join(temporaryRoot, 'cargo-target');
    run(
      'cargo',
      [
        'build',
        '--manifest-path',
        path.join(
          REPOSITORY_ROOT,
          'crates/codegen/xai-grok-pager-bin/Cargo.toml',
        ),
        '--release',
        '--target-dir',
        cargoTarget,
      ],
      {
        env: {
          ...process.env,
          AGENTMESH360_HOST_RUNTIME_VERSION: hostRuntimeVersion,
        },
        inherit: true,
        errorMessage: 'internal desktop Host build failed',
      },
    );
    const hostBinary = path.join(cargoTarget, 'release', 'xai-grok-pager');
    const hostInfo = await lstat(hostBinary);
    if (!hostInfo.isFile() || hostInfo.isSymbolicLink()) {
      throw new Error('internal desktop Host artifact is invalid');
    }
    assertHostRuntimeVersionOutput({
      output: run(hostBinary, ['--version'], {
        errorMessage: 'internal desktop Host version inspection failed',
      }),
      runtimeVersion: hostRuntimeVersion,
      commit: head,
    });

    const builderConfig = {
      ...manifest.build,
      directories: {
        ...(manifest.build.directories ?? {}),
        output: outputDirectory,
      },
      extraResources: [
        {
          from: hostBinary,
          to: 'bin/agentmesh360-host',
        },
      ],
      mac: {
        ...manifest.build.mac,
        identity: null,
        target: [
          { target: 'dmg', arch: [process.arch] },
          { target: 'zip', arch: [process.arch] },
        ],
      },
      dmg: {
        ...(manifest.build.dmg ?? {}),
        writeUpdateInfo: false,
      },
    };
    const configPath = path.join(temporaryRoot, 'electron-builder.json');
    await writeFile(
      configPath,
      `${JSON.stringify(builderConfig, null, 2)}\n`,
      { mode: 0o600 },
    );

    const buildEnvironment = { ...process.env };
    buildEnvironment.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
    run(
      path.join(DESKTOP_ROOT, 'node_modules/.bin/electron-builder'),
      ['--config', configPath, '--mac', '--publish', 'never'],
      {
        cwd: DESKTOP_ROOT,
        env: buildEnvironment,
        inherit: true,
        errorMessage: 'internal Electron desktop build failed',
      },
    );

    await verifyPackagedHostAndPrune({
      outputDirectory,
      hostBinary,
      architecture: process.arch,
      productName: manifest.build.productName,
    });
    const artifacts = await collectArtifacts(outputDirectory);
    const receipt = createUnsignedInternalReceipt({
      commit: head,
      manifest,
      packageJsonSha256: digest(packageJsonBytes),
      packageLockSha256: digest(packageLockBytes),
      architecture: process.arch,
      artifacts,
      createdAt: new Date().toISOString(),
    });
    const receiptPath = path.join(
      outputDirectory,
      'unsigned-internal-build-v1.json',
    );
    await writeFile(
      receiptPath,
      `${JSON.stringify(receipt, null, 2)}\n`,
      { mode: 0o644 },
    );
    const checksumLines = artifacts
      .map(
        (artifact) =>
          `${artifact.sha256.slice('sha256:'.length)}  ${artifact.file}`,
      )
      .sort();
    await writeFile(
      path.join(outputDirectory, 'SHA256SUMS'),
      `${checksumLines.join('\n')}\n`,
      { mode: 0o644 },
    );

    const verified = await verifyUnsignedInternalBuild(
      await realpath(receiptPath),
    );
    process.stdout.write(
      `${JSON.stringify({
        ...verified,
        hostRuntimeVersion,
        output: path.relative(REPOSITORY_ROOT, outputDirectory),
      })}\n`,
    );
  } catch (error) {
    await rm(outputDirectory, { recursive: true, force: true });
    throw error;
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  if (process.argv.length !== 2) {
    process.stderr.write(
      'usage: node build-unsigned-internal.mjs\n',
    );
    process.exitCode = 1;
  } else {
    build().catch((error) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : 'build failed'}\n`,
      );
      process.exitCode = 1;
    });
  }
}
