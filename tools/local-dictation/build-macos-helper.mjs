#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MODULE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(MODULE_DIRECTORY, '../..');
const SOURCE_ROOT = path.join(REPOSITORY_ROOT, 'desktop/native/local-dictation');
const DEFAULT_OUTPUT = path.join(
  REPOSITORY_ROOT,
  'desktop/.native-build/AgentMesh360SpeechHelper.app',
);
const MAX_OUTPUT_BYTES = 1024 * 1024;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? REPOSITORY_ROOT,
    encoding: 'utf8',
    env: options.env ?? process.env,
    maxBuffer: MAX_OUTPUT_BYTES,
  });
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim();
    throw new Error(`${options.label || command} failed${detail ? `: ${detail}` : ''}`);
  }
  return String(result.stdout || '').trim();
}

function architectureTarget(architecture) {
  if (architecture === 'arm64') return 'arm64-apple-macosx12.0';
  if (architecture === 'x64') return 'x86_64-apple-macosx12.0';
  throw new Error('local dictation helper supports macOS arm64 or x64 only');
}

function machOArchitecture(architecture) {
  return architecture === 'x64' ? 'x86_64' : architecture;
}

export async function buildMacOSLocalDictationHelper({
  outputPath = DEFAULT_OUTPUT,
  architecture = process.arch,
} = {}) {
  if (process.platform !== 'darwin') {
    throw new Error('local dictation helper can only be built on macOS');
  }
  if (!path.isAbsolute(outputPath)) {
    throw new Error('local dictation helper output must be absolute');
  }
  const sourcePath = path.join(SOURCE_ROOT, 'main.swift');
  const infoPlistPath = path.join(SOURCE_ROOT, 'Info.plist');
  await Promise.all([realpath(sourcePath), realpath(infoPlistPath)]);
  if (path.extname(outputPath) !== '.app') {
    throw new Error('local dictation helper output must be an app bundle');
  }
  await rm(outputPath, { recursive: true, force: true });
  const executablePath = path.join(
    outputPath,
    'Contents/MacOS/agentmesh360-speech-helper',
  );
  await mkdir(path.dirname(executablePath), { recursive: true });
  await mkdir(path.join(outputPath, 'Contents/Resources'), { recursive: true });
  await copyFile(infoPlistPath, path.join(outputPath, 'Contents/Info.plist'));
  run('xcrun', [
    'swiftc',
    '-parse-as-library',
    '-O',
    '-target',
    architectureTarget(architecture),
    '-framework',
    'AVFoundation',
    '-framework',
    'Speech',
    '-Xlinker',
    '-sectcreate',
    '-Xlinker',
    '__TEXT',
    '-Xlinker',
    '__info_plist',
    '-Xlinker',
    infoPlistPath,
    sourcePath,
    '-o',
    executablePath,
  ], { label: 'local dictation Swift compilation' });
  await chmod(executablePath, 0o755);
  const compiledArchitectures = run('xcrun', [
    'lipo',
    '-archs',
    executablePath,
  ], { label: 'local dictation Mach-O architecture inspection' }).split(/\s+/u);
  const expectedArchitecture = machOArchitecture(architecture);
  if (
    compiledArchitectures.length !== 1
    || compiledArchitectures[0] !== expectedArchitecture
  ) {
    throw new Error('local dictation helper architecture changed');
  }
  const linkedLibraries = run('xcrun', [
    'otool',
    '-L',
    executablePath,
  ], { label: 'local dictation linked library inspection' })
    .split('\n')
    .slice(1)
    .map((line) => line.trim().split(/\s+/u)[0])
    .filter(Boolean);
  if (
    linkedLibraries.length === 0
    || linkedLibraries.some((library) => (
      !library.startsWith('/System/Library/')
      && !library.startsWith('/usr/lib/')
    ))
  ) {
    throw new Error('local dictation helper links a non-system library');
  }
  const capabilities = JSON.parse(run(executablePath, ['--capabilities'], {
    label: 'local dictation capability probe',
  }));
  if (
    capabilities?.schemaVersion !== 1
    || capabilities?.type !== 'capabilities'
    || capabilities?.engine !== 'macos_on_device_speech'
    || typeof capabilities?.onDevice !== 'boolean'
  ) {
    throw new Error('local dictation helper returned an invalid capability contract');
  }
  const embeddedInfo = run('xcrun', [
    'otool',
    '-s',
    '__TEXT',
    '__info_plist',
    executablePath,
  ], { label: 'local dictation embedded Info.plist inspection' });
  if (!embeddedInfo.includes('__info_plist')) {
    throw new Error('local dictation helper is missing its embedded privacy metadata');
  }
  await writeFile(
    path.join(outputPath, 'Contents/Resources/capabilities.json'),
    `${JSON.stringify(capabilities, null, 2)}\n`,
    { mode: 0o644 },
  );
  return {
    outputPath,
    executablePath,
    capabilities,
    architecture: expectedArchitecture,
    linkedLibraries,
    infoPlist: await readFile(infoPlistPath, 'utf8'),
  };
}

async function main() {
  const requested = process.argv[2];
  const outputPath = requested ? path.resolve(requested) : DEFAULT_OUTPUT;
  await buildMacOSLocalDictationHelper({ outputPath });
  process.stdout.write(`${outputPath}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
