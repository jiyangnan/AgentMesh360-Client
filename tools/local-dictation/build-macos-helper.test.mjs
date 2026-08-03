import assert from 'node:assert/strict';
import {
  lstat,
  mkdtemp,
  readFile,
  rm,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildMacOSLocalDictationHelper } from './build-macos-helper.mjs';

const MICROPHONE_DISCLOSURE =
  'AgentMesh360 仅在你主动开启听写时使用麦克风，将语音转换为可编辑文字。';
const SPEECH_RECOGNITION_DISCLOSURE =
  'AgentMesh360 仅在你主动开启听写时，使用 macOS 本机语音识别将语音转换为可编辑文字。';

test('builds a nested macOS helper app with local capability and privacy metadata', {
  skip: process.platform !== 'darwin',
}, async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), 'am360-local-dictation-helper-test-'),
  );
  try {
    const outputPath = path.join(root, 'AgentMesh360SpeechHelper.app');
    const result = await buildMacOSLocalDictationHelper({
      outputPath,
      architecture: process.arch,
    });
    assert.equal(result.outputPath, outputPath);
    assert.equal(
      result.executablePath,
      path.join(
        outputPath,
        'Contents/MacOS/agentmesh360-speech-helper',
      ),
    );
    assert.deepEqual(
      {
        schemaVersion: result.capabilities.schemaVersion,
        type: result.capabilities.type,
        engine: result.capabilities.engine,
      },
      {
        schemaVersion: 1,
        type: 'capabilities',
        engine: 'macos_on_device_speech',
      },
    );
    assert.equal(typeof result.capabilities.onDevice, 'boolean');
    assert.equal(result.architecture, process.arch === 'x64' ? 'x86_64' : process.arch);
    assert.equal(result.linkedLibraries.length > 0, true);
    assert.equal(result.linkedLibraries.every((library) => (
      library.startsWith('/System/Library/') || library.startsWith('/usr/lib/')
    )), true);

    const executable = await lstat(result.executablePath);
    assert.equal(executable.isFile(), true);
    assert.equal(executable.isSymbolicLink(), false);
    assert.notEqual(executable.mode & 0o111, 0);

    const infoPlist = await readFile(
      path.join(outputPath, 'Contents/Info.plist'),
      'utf8',
    );
    assert.equal(infoPlist, result.infoPlist);
    assert.equal(infoPlist.includes(MICROPHONE_DISCLOSURE), true);
    assert.equal(infoPlist.includes(SPEECH_RECOGNITION_DISCLOSURE), true);

    const recordedCapabilities = JSON.parse(await readFile(
      path.join(outputPath, 'Contents/Resources/capabilities.json'),
      'utf8',
    ));
    assert.deepEqual(recordedCapabilities, result.capabilities);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects a non-app output path before compiling', async () => {
  await assert.rejects(
    buildMacOSLocalDictationHelper({
      outputPath: path.join(os.tmpdir(), 'agentmesh360-speech-helper'),
      architecture: process.arch,
    }),
    process.platform === 'darwin'
      ? /must be an app bundle/u
      : /only be built on macOS/u,
  );
});

test('rejects unsupported architectures before compiling', {
  skip: process.platform !== 'darwin',
}, async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), 'am360-local-dictation-helper-arch-test-'),
  );
  try {
    await assert.rejects(
      buildMacOSLocalDictationHelper({
        outputPath: path.join(root, 'AgentMesh360SpeechHelper.app'),
        architecture: 'ppc64',
      }),
      /supports macOS arm64 or x64 only/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
