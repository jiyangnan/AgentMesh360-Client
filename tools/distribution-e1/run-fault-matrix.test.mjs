import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SCENARIOS,
  curlConfig,
  curlRequest,
  parseArguments,
  splitHttpResponse,
} from './run-fault-matrix.mjs';

test('pins all 14 approved fault scenarios in exact order', () => {
  assert.deepEqual(SCENARIOS, [
    'not_found',
    'timeout',
    'truncated_response',
    'response_too_large',
    'wrong_content_type',
    'redirect',
    'digest_mismatch',
    'signature_mismatch',
    'expired_metadata',
    'registry_rollback',
    'same_revision_equivocation',
    'valid_lkg_transport_failure',
    'invalid_or_expired_lkg',
    'partial_publication_before_registry',
  ]);
});

test('fault token is provided over curl stdin, never command arguments', () => {
  const token = 'x'.repeat(43);
  let captured;
  const response = curlRequest(
    'https://packages-e1-1234abcd.agentmesh360.com/_e1/fault/not_found/registry',
    token,
    {
      curlSpawn: (command, args, options) => {
        captured = { command, args, input: options.input.toString('utf8') };
        return {
          status: 0,
          stdout: Buffer.from(
            'HTTP/1.1 404 Not Found\r\ncontent-type: application/json\r\n\r\n',
          ),
        };
      },
    },
  );
  assert.equal(response.status, 404);
  assert.equal(captured.command, 'curl');
  assert.deepEqual(captured.args, ['--config', '-']);
  assert.ok(!captured.args.join(' ').includes(token));
  assert.ok(captured.input.includes(token));
});

test('parses bounded HTTP headers and binary body', () => {
  const parsed = splitHttpResponse(Buffer.from(
    'HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n\r\n{"ok":true}',
  ));
  assert.equal(parsed.status, 200);
  assert.equal(parsed.body.toString('utf8'), '{"ok":true}');
  assert.match(parsed.headers, /application\/json/u);
});

test('curl config rejects non-E1 origins and malformed tokens', () => {
  const url =
    'https://packages-e1-1234abcd.agentmesh360.com/_e1/fault/not_found/registry';
  assert.match(curlConfig(url, 'x'.repeat(43)), /max-redirs = 0/u);
  assert.throws(() => curlConfig('https://packages.agentmesh360.com/', null));
  assert.throws(() => curlConfig(url, 'short'));
});

test('parses a frozen executor plus three absolute fault-matrix boundaries', () => {
  const parsed = parseArguments([
    '--executor-commit',
    'a'.repeat(40),
    '--origin-state',
    '/private/tmp/origin.json',
    '--publication-state',
    '/private/tmp/publication.json',
    '--output-receipt',
    '/private/tmp/faults.json',
  ]);
  assert.equal(parsed.executorCommit, 'a'.repeat(40));
  assert.equal(parsed.outputReceipt, '/private/tmp/faults.json');
  assert.throws(() => parseArguments([
    '--executor-commit',
    'a'.repeat(40),
    '--origin-state',
    'relative',
  ]));
  assert.throws(() => parseArguments([
    '--executor-commit',
    'short',
    '--origin-state',
    '/private/tmp/origin.json',
    '--publication-state',
    '/private/tmp/publication.json',
    '--output-receipt',
    '/private/tmp/faults.json',
  ]));
});
