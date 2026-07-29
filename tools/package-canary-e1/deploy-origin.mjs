#!/usr/bin/env node

import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  deployOrigin,
} from '../distribution-e1/deploy-origin.mjs';
import {
  BOUNDARY,
  CREDENTIAL_PATH,
  assertP5ExecutionAuthority,
} from './infrastructure-boundary.mjs';

function parseArguments(argv) {
  if (
    argv.length !== 2
    || argv[0] !== '--executor-commit'
    || !/^[0-9a-f]{40}$/u.test(argv[1] ?? '')
  ) {
    throw new Error(
      'usage: deploy-origin.mjs --executor-commit <commit>',
    );
  }
  return { executorCommit: argv[1] };
}

async function deployP5Origin(executorCommit) {
  await assertP5ExecutionAuthority(executorCommit);
  return deployOrigin(
    BOUNDARY,
    CREDENTIAL_PATH,
    executorCommit,
    'p5',
  );
}

function isMainModule() {
  return process.argv[1]
    && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
  if (options) {
    deployP5Origin(options.executorCommit)
      .then(() => {
        process.stdout.write(
          'P5 E1 Spaces-backed HTTPS origin passed\n',
        );
      })
      .catch(() => {
        process.stderr.write('P5 E1 origin deployment failed\n');
        process.exitCode = 1;
      });
  }
}

export {
  deployP5Origin,
  parseArguments,
};
