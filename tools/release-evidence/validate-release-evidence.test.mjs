import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  REQUIRED_EVIDENCE_FILES,
  loadReleaseEventSchema,
  scanEvidenceDirectory,
  validateEventFile,
  validateReleaseEvent,
} from './validate-release-evidence.mjs';

const schema = loadReleaseEventSchema();
const TEST_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const VALIDATOR = path.join(TEST_DIRECTORY, 'validate-release-evidence.mjs');

function validEvent(overrides = {}) {
  return {
    schemaVersion: 1,
    eventId: 'evt_00000001',
    releaseId: 'rel_client_0.1.0',
    publicVersion: '0.1.0',
    environment: 'e0',
    stage: 'rehearsal_passed',
    gate: 'r6',
    eventType: 'tabletop_completed',
    outcome: 'succeeded',
    occurredAt: '2026-07-28T00:00:00Z',
    receiptId: 'rcpt_00000001',
    ...overrides,
  };
}

async function withTempDirectory(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agentmesh360-release-evidence-'));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function writeCompleteEvidence(directory) {
  for (const fileName of REQUIRED_EVIDENCE_FILES) {
    const target = path.join(directory, fileName);
    await mkdir(path.dirname(target), { recursive: true });
    if (fileName === 'events.v1.jsonl') {
      await writeFile(target, `${JSON.stringify(validEvent())}\n`, 'utf8');
    } else if (fileName.endsWith('.json')) {
      await writeFile(
        target,
        `${JSON.stringify({
          releaseId: 'rel_client_0.1.0',
          publicVersion: '0.1.0',
          sha256: 'a'.repeat(64),
          outcome: 'succeeded',
        })}\n`,
        'utf8',
      );
    } else {
      let identity = '';
      if (['00-scope-and-approval.md', '07-go-no-go.md'].includes(fileName)) {
        identity = [
          '- Release ID: `rel_client_0.1.0`',
          '- Public version: `0.1.0`',
        ].join('\n');
      } else if (fileName === '06-kimi-independent-review.md') {
        identity = '- Reviewed release: `rel_client_0.1.0`';
      }
      await writeFile(
        target,
        `# AgentMesh360 release evidence\n\n${identity}\n\nOutcome: succeeded\n`,
        'utf8',
      );
    }
  }
}

test('accepts a strict non-secret release event', () => {
  assert.deepEqual(validateReleaseEvent(validEvent(), schema), []);
});

test('rejects non-canonical semantic versions', () => {
  const errors = validateReleaseEvent(
    validEvent({ publicVersion: '1.0.0-01' }),
    schema,
  );
  assert.ok(errors.some((error) => error.includes('public identifier format')));
});

test('rejects unknown or content-bearing release event fields', () => {
  const errors = validateReleaseEvent(
    validEvent({ prompt: 'summarize private customer data' }),
    schema,
  );
  assert.ok(errors.some((error) => error.includes('unknown field `prompt`')));
});

test('requires a fixed error code for unsafe terminal outcomes', () => {
  const missing = validateReleaseEvent(
    validEvent({ outcome: 'failed' }),
    schema,
  );
  assert.ok(missing.some((error) => error.includes('requires `errorCode`')));

  const unexpected = validateReleaseEvent(
    validEvent({ errorCode: 'UNEXPECTED_ERROR' }),
    schema,
  );
  assert.ok(unexpected.some((error) => error.includes('must omit `errorCode`')));
});

test('rejects impossible environment and release-stage combinations', () => {
  const e0Canary = validateReleaseEvent(
    validEvent({ environment: 'e0', stage: 'canary_running' }),
    schema,
  );
  assert.ok(e0Canary.some((error) => error.includes('environment `e0`')));

  const e1Production = validateReleaseEvent(
    validEvent({ environment: 'e1', stage: 'production_candidate' }),
    schema,
  );
  assert.ok(e1Production.some((error) => error.includes('environment `e1`')));

  const e2Released = validateReleaseEvent(
    validEvent({ environment: 'e2', stage: 'released' }),
    schema,
  );
  assert.ok(e2Released.some((error) => error.includes('environment `e2`')));
});

test('rejects non-existent UTC calendar timestamps', () => {
  const errors = validateReleaseEvent(
    validEvent({ occurredAt: '2026-02-31T00:00:00Z' }),
    schema,
  );
  assert.ok(errors.some((error) => error.includes('valid canonical UTC timestamp')));
});

test('keeps package and agent identity paired', () => {
  const errors = validateReleaseEvent(
    validEvent({ packageId: 'com.agentmesh360.job-agent' }),
    schema,
  );
  assert.ok(errors.some((error) => error.includes('must appear together')));
});

test('validates every JSONL event and reports line numbers', async () => {
  await withTempDirectory(async (directory) => {
    const events = path.join(directory, 'events.v1.jsonl');
    await writeFile(
      events,
      [
        JSON.stringify(validEvent()),
        JSON.stringify(validEvent({ eventId: 'evt_00000002', authorization: 'redacted' })),
      ].join('\n'),
      'utf8',
    );
    const errors = await validateEventFile(events, schema);
    assert.ok(errors.some((error) => error.includes('events.v1.jsonl:2')));
    assert.ok(errors.some((error) => error.includes('unknown field `authorization`')));
  });
});

test('rejects duplicate JSON object keys', async () => {
  await withTempDirectory(async (directory) => {
    const events = path.join(directory, 'events.v1.jsonl');
    const duplicateOutcome = JSON.stringify(validEvent()).replace(
      '"outcome":"succeeded"',
      '"outcome":"failed","outcome":"succeeded"',
    );
    await writeFile(events, `${duplicateOutcome}\n`, 'utf8');
    let errors = await validateEventFile(events, schema);
    assert.ok(errors.some((error) => error.includes('duplicate JSON object keys')));

    await writeCompleteEvidence(directory);
    await writeFile(
      path.join(directory, '01-source-and-build.json'),
      '{"releaseId":"rel_client_0.1.0","releaseId":"rel_other_0.1.0","publicVersion":"0.1.0"}\n',
      'utf8',
    );
    errors = await scanEvidenceDirectory(directory, {
      requireComplete: true,
      schema,
    });
    assert.ok(errors.some((error) => error.includes('duplicate JSON object keys')));
  });
});

test('rejects duplicate, cross-release, and out-of-order JSONL events', async () => {
  await withTempDirectory(async (directory) => {
    const events = path.join(directory, 'events.v1.jsonl');
    await writeFile(
      events,
      [
        JSON.stringify(validEvent({
          eventId: 'evt_00000001',
          occurredAt: '2026-07-28T00:00:02Z',
        })),
        JSON.stringify(validEvent({
          eventId: 'evt_00000001',
          releaseId: 'rel_other_0.1.0',
          publicVersion: '0.1.1',
          occurredAt: '2026-07-28T00:00:01Z',
        })),
      ].join('\n'),
      'utf8',
    );
    const errors = await validateEventFile(events, schema);
    assert.ok(errors.some((error) => error.includes('duplicate event ID')));
    assert.ok(errors.some((error) => error.includes('multiple release IDs')));
    assert.ok(errors.some((error) => error.includes('multiple public versions')));
    assert.ok(errors.some((error) => error.includes('not ordered')));
  });
});

test('accepts a complete bounded evidence directory', async () => {
  await withTempDirectory(async (directory) => {
    await writeCompleteEvidence(directory);
    assert.deepEqual(
      await scanEvidenceDirectory(directory, { requireComplete: true, schema }),
      [],
    );
  });
});

test('binds every structured evidence file to one release identity', async () => {
  await withTempDirectory(async (directory) => {
    await writeCompleteEvidence(directory);
    await writeFile(
      path.join(directory, '03-distribution-checks.json'),
      `${JSON.stringify({
        releaseId: 'rel_other_0.1.0',
        publicVersion: '0.1.0',
        outcome: 'blocked',
      })}\n`,
      'utf8',
    );
    const errors = await scanEvidenceDirectory(directory, {
      requireComplete: true,
      schema,
    });
    assert.ok(errors.some((error) => error.includes('release identity does not match')));

    await writeCompleteEvidence(directory);
    await writeFile(
      path.join(directory, '07-go-no-go.md'),
      [
        '# Go / No-Go Decision',
        '',
        '- Release ID: `rel_client_0.1.0`',
        '- Public version: `0.2.0`',
      ].join('\n'),
      'utf8',
    );
    const markdownErrors = await scanEvidenceDirectory(directory, {
      requireComplete: true,
      schema,
    });
    assert.ok(
      markdownErrors.some((error) => error.includes('release identity does not match')),
    );

    await writeCompleteEvidence(directory);
    await writeFile(
      path.join(directory, '00-scope-and-approval.md'),
      [
        '# Scope and Approval',
        '',
        '- Release ID: `rel_client_0.1.0`',
        '- Release ID: `rel_other_0.1.0`',
        '- Public version: `0.1.0`',
      ].join('\n'),
      'utf8',
    );
    const duplicateIdentityErrors = await scanEvidenceDirectory(directory, {
      requireComplete: true,
      schema,
    });
    assert.ok(
      duplicateIdentityErrors.some(
        (error) => error.includes('identity field `Release ID` must appear exactly once'),
      ),
    );
  });
});

test('rejects incomplete evidence directories', async () => {
  await withTempDirectory(async (directory) => {
    await writeFile(path.join(directory, '00-scope-and-approval.md'), '# Scope\n', 'utf8');
    const errors = await scanEvidenceDirectory(directory, {
      requireComplete: true,
      schema,
    });
    assert.ok(errors.some((error) => error.includes('missing required evidence file')));
  });
});

test('rejects unexpected, oversized, and invalid UTF-8 evidence files', async () => {
  await withTempDirectory(async (directory) => {
    await writeCompleteEvidence(directory);
    await writeFile(path.join(directory, 'unexpected.log'), 'safe-looking text\n', 'utf8');
    let errors = await scanEvidenceDirectory(directory, {
      requireComplete: true,
      schema,
    });
    assert.ok(errors.some((error) => error.includes('unexpected evidence file')));

    await rm(path.join(directory, 'unexpected.log'));
    await writeFile(
      path.join(directory, '07-go-no-go.md'),
      Buffer.alloc((1024 * 1024) + 1, 0x61),
    );
    errors = await scanEvidenceDirectory(directory, {
      requireComplete: true,
      schema,
    });
    assert.ok(errors.some((error) => error.includes('size must be between')));

    await writeFile(path.join(directory, '07-go-no-go.md'), Buffer.from([0xff, 0xfe, 0xfd]));
    errors = await scanEvidenceDirectory(directory, {
      requireComplete: true,
      schema,
    });
    assert.ok(errors.some((error) => error.includes('valid UTF-8')));
  });
});

test('rejects secret keys and content-bearing values in JSON evidence', async () => {
  await withTempDirectory(async (directory) => {
    await writeCompleteEvidence(directory);
    await writeFile(
      path.join(directory, '01-source-and-build.json'),
      `${JSON.stringify({
        releaseId: 'rel_client_0.1.0',
        nested: { apiKey: 'sentinel-private-value' },
      })}\n`,
      'utf8',
    );
    const errors = await scanEvidenceDirectory(directory, {
      requireComplete: true,
      schema,
    });
    assert.ok(errors.some((error) => error.includes('forbidden field `apiKey`')));

    await writeFile(
      path.join(directory, '01-source-and-build.json'),
      `${JSON.stringify({
        releaseId: 'rel_client_0.1.0',
        publicVersion: '0.1.0',
        'https://private.example.test/evidence': true,
      })}\n`,
      'utf8',
    );
    const keyErrors = await scanEvidenceDirectory(directory, {
      requireComplete: true,
      schema,
    });
    assert.ok(keyErrors.some((error) => error.includes('field name')));
  });
});

test('rejects URLs, email addresses, credentials, and absolute paths', async () => {
  const unsafeValues = [
    'https://packages.example.test/private?token=value',
    'ftp://packages.example.test/private',
    'file:///Users/example/private/release.json',
    'owner@example.test',
    'Bearer sentinel-token',
    'credential://vault/h_00000000000000000000000000000001',
    '/Users/example/private/release.json',
    'see (/Users/example/private/release.json)',
    'path=/var/folders/private/release.json',
    'see;/etc/private/release.json',
    'see,/opt/private/release.json',
    '-----BEGIN PRIVATE KEY-----',
  ];
  for (const [index, unsafe] of unsafeValues.entries()) {
    await withTempDirectory(async (directory) => {
      await writeCompleteEvidence(directory);
      await writeFile(
        path.join(directory, '07-go-no-go.md'),
        `# Decision\n\nunsafe-${index}: ${unsafe}\n`,
        'utf8',
      );
      const errors = await scanEvidenceDirectory(directory, {
        requireComplete: true,
        schema,
      });
      assert.ok(
        errors.some((error) => error.includes('forbidden content')),
        `expected unsafe value to fail: ${unsafe}`,
      );
    });
  }
});

test('rejects symbolic links in evidence', async () => {
  await withTempDirectory(async (directory) => {
    await writeCompleteEvidence(directory);
    const target = path.join(directory, 'outside.md');
    await writeFile(target, '# Outside\n', 'utf8');
    const evidence = path.join(directory, '07-go-no-go.md');
    await rm(evidence);
    await symlink(target, evidence);
    const errors = await scanEvidenceDirectory(directory, {
      requireComplete: true,
      schema,
    });
    assert.ok(errors.some((error) => error.includes('symbolic link')));
  });
});

test('CLI uses stable exit codes without printing absolute input paths', async () => {
  await withTempDirectory(async (directory) => {
    const events = path.join(directory, 'events.v1.jsonl');
    await writeFile(
      events,
      `${JSON.stringify(validEvent({ prompt: 'private content' }))}\n`,
      'utf8',
    );
    const result = spawnSync(process.execPath, [VALIDATOR, '--events', events], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /release evidence validation failed/u);
    assert.match(result.stderr, /events\.v1\.jsonl:1/u);
    assert.equal(result.stderr.includes(directory), false);

    const missing = path.join(directory, 'private', 'missing-events.v1.jsonl');
    const missingResult = spawnSync(
      process.execPath,
      [VALIDATOR, '--events', missing],
      { encoding: 'utf8' },
    );
    assert.equal(missingResult.status, 1);
    assert.match(missingResult.stderr, /release evidence validation failed/u);
    assert.equal(missingResult.stderr.includes(directory), false);

    const usage = spawnSync(process.execPath, [VALIDATOR], { encoding: 'utf8' });
    assert.equal(usage.status, 2);
    assert.match(usage.stderr, /Usage:/u);
  });
});
