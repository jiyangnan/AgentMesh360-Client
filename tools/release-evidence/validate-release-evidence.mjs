#!/usr/bin/env node

import { lstatSync, readFileSync } from 'node:fs';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { TextDecoder } from 'node:util';
import { fileURLToPath } from 'node:url';

const MODULE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SCHEMA_PATH = path.resolve(
  MODULE_DIRECTORY,
  '../../schemas/agentmesh360-release-event-v1.schema.json',
);

const MAX_EVENT_FILE_BYTES = 1024 * 1024;
const MAX_EVENT_COUNT = 2000;
const MAX_EVIDENCE_FILE_BYTES = 1024 * 1024;
const MAX_EVIDENCE_TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_EVIDENCE_FILES = 16;
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

export const REQUIRED_EVIDENCE_FILES = Object.freeze([
  '00-scope-and-approval.md',
  '01-source-and-build.json',
  '02-signing-receipts.json',
  '03-distribution-checks.json',
  '04-canary-scenarios.json',
  '05-rollback-and-recovery.json',
  '06-kimi-independent-review.md',
  '07-go-no-go.md',
  'events.v1.jsonl',
]);

const REQUIRED_EVIDENCE_FILE_SET = new Set(REQUIRED_EVIDENCE_FILES);
const JSON_IDENTITY_FILES = new Set([
  '01-source-and-build.json',
  '02-signing-receipts.json',
  '03-distribution-checks.json',
  '04-canary-scenarios.json',
  '05-rollback-and-recovery.json',
]);
const MARKDOWN_IDENTITY_FIELDS = Object.freeze({
  '00-scope-and-approval.md': Object.freeze({
    releaseId: 'Release ID',
    publicVersion: 'Public version',
  }),
  '06-kimi-independent-review.md': Object.freeze({
    releaseId: 'Reviewed release',
  }),
  '07-go-no-go.md': Object.freeze({
    releaseId: 'Release ID',
    publicVersion: 'Public version',
  }),
});
const FAILURE_OUTCOMES = new Set(['failed', 'blocked', 'aborted', 'withdrawn']);
const ALLOWED_STAGES_BY_ENVIRONMENT = Object.freeze({
  e0: new Set(['planned', 'rehearsal_ready', 'rehearsal_passed', 'aborted']),
  e1: new Set([
    'planned',
    'rehearsal_ready',
    'rehearsal_passed',
    'canary_authorized',
    'canary_running',
    'canary_passed',
    'aborted',
  ]),
  e2: new Set([
    'planned',
    'canary_authorized',
    'canary_running',
    'canary_passed',
    'production_candidate',
    'aborted',
  ]),
  e3: new Set(['production_candidate', 'released', 'withdrawn', 'aborted']),
});
const BUILD_EVENT_TYPES = new Set(['build_started', 'build_completed']);
const REGISTRY_EVENT_TYPES = new Set(['registry_published', 'registry_frozen']);
const RECEIPT_EVENT_TYPES = new Set([
  'scope_approved',
  'tabletop_completed',
  'technical_drill_completed',
  'signing_requested',
  'signing_completed',
  'canary_authorized',
  'canary_completed',
  'cohort_expansion_approved',
  'go_decision_recorded',
]);

const FORBIDDEN_FIELD_NAMES = new Set([
  'apikey',
  'accesstoken',
  'refreshtoken',
  'authorization',
  'cookie',
  'password',
  'privatekey',
  'prompt',
  'response',
  'modelresponse',
  'toolinput',
  'tooloutput',
  'usercontent',
  'userfilecontent',
  'email',
  'accountid',
  'path',
  'absolutepath',
  'url',
  'header',
  'headers',
  'registrydocument',
  'trustdocument',
  'signature',
]);

const FORBIDDEN_CONTENT_PATTERNS = Object.freeze([
  ['URL', /\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"')\]]+/iu],
  ['email address', /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu],
  ['Bearer credential', /\bBearer\s+[A-Za-z0-9._~+/=-]{4,}/iu],
  ['Vault credential reference', /\bcredential:\/\/vault\/[^\s<>"')\]]+/iu],
  [
    'POSIX absolute path',
    /(?<![A-Za-z0-9._~/-])\/(?!\/)[A-Za-z0-9._~-][^\s<>"'`)\]}]*/u,
  ],
  ['Windows user path', /\b[A-Za-z]:\\(?:Users|Documents and Settings)\\/iu],
  ['PEM private key', /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/u],
  ['JWT-like token', /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u],
  ['OpenAI-style secret', /\bsk-[A-Za-z0-9_-]{8,}\b/u],
  ['Google-style secret', /\bAIza[A-Za-z0-9_-]{20,}\b/u],
]);

function normalizedFieldName(value) {
  return value.toLowerCase().replace(/[^a-z0-9]/gu, '');
}

function printableType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

function hasDuplicateJsonObjectKeys(document) {
  let offset = 0;
  let duplicate = false;

  function skipWhitespace() {
    while (/\s/u.test(document[offset] ?? '')) offset += 1;
  }

  function readString() {
    const start = offset;
    offset += 1;
    while (offset < document.length) {
      if (document[offset] === '\\') {
        offset += 2;
      } else if (document[offset] === '"') {
        offset += 1;
        return JSON.parse(document.slice(start, offset));
      } else {
        offset += 1;
      }
    }
    return '';
  }

  function readValue() {
    skipWhitespace();
    if (document[offset] === '{') {
      readObject();
      return;
    }
    if (document[offset] === '[') {
      readArray();
      return;
    }
    if (document[offset] === '"') {
      readString();
      return;
    }
    while (
      offset < document.length
      && !/[\s,\]}]/u.test(document[offset])
    ) {
      offset += 1;
    }
  }

  function readObject() {
    offset += 1;
    skipWhitespace();
    const keys = new Set();
    if (document[offset] === '}') {
      offset += 1;
      return;
    }
    while (offset < document.length) {
      skipWhitespace();
      const key = readString();
      if (keys.has(key)) duplicate = true;
      keys.add(key);
      skipWhitespace();
      offset += 1;
      readValue();
      skipWhitespace();
      if (document[offset] === '}') {
        offset += 1;
        return;
      }
      offset += 1;
    }
  }

  function readArray() {
    offset += 1;
    skipWhitespace();
    if (document[offset] === ']') {
      offset += 1;
      return;
    }
    while (offset < document.length) {
      readValue();
      skipWhitespace();
      if (document[offset] === ']') {
        offset += 1;
        return;
      }
      offset += 1;
    }
  }

  readValue();
  return duplicate;
}

function validateProperty(name, value, definition) {
  const errors = [];
  if (definition.type === 'integer') {
    if (!Number.isSafeInteger(value)) {
      return [`field \`${name}\` must be a safe integer`];
    }
    if (definition.minimum != null && value < definition.minimum) {
      errors.push(`field \`${name}\` must be at least ${definition.minimum}`);
    }
    if (definition.maximum != null && value > definition.maximum) {
      errors.push(`field \`${name}\` must be at most ${definition.maximum}`);
    }
  } else if (typeof value !== definition.type) {
    return [
      `field \`${name}\` must be ${definition.type}, received ${printableType(value)}`,
    ];
  }

  if (definition.const !== undefined && value !== definition.const) {
    errors.push(`field \`${name}\` must equal ${JSON.stringify(definition.const)}`);
  }
  if (definition.enum && !definition.enum.includes(value)) {
    errors.push(`field \`${name}\` is not in the allowed enum`);
  }
  if (definition.pattern && typeof value === 'string') {
    const expression = new RegExp(definition.pattern, 'u');
    if (!expression.test(value)) {
      errors.push(`field \`${name}\` does not match its public identifier format`);
    }
  }
  return errors;
}

export function loadReleaseEventSchema(schemaPath = DEFAULT_SCHEMA_PATH) {
  const document = readFileSyncBounded(schemaPath, MAX_EVENT_FILE_BYTES);
  let schema;
  try {
    schema = JSON.parse(document);
  } catch {
    throw new Error('release event schema is not valid JSON');
  }
  if (hasDuplicateJsonObjectKeys(document)) {
    throw new Error('release event schema contains duplicate JSON object keys');
  }
  if (
    schema?.type !== 'object'
    || schema?.additionalProperties !== false
    || !Array.isArray(schema?.required)
    || !schema?.properties
  ) {
    throw new Error('release event schema is missing strict object constraints');
  }
  return Object.freeze(schema);
}

function readFileSyncBounded(filePath, maximumBytes) {
  let stat;
  try {
    stat = lstatSync(filePath);
  } catch {
    throw new Error('release event schema cannot be inspected');
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('release event schema must be a regular file');
  }
  if (stat.size <= 0 || stat.size > maximumBytes) {
    throw new Error('release event schema size is invalid');
  }
  try {
    return UTF8_DECODER.decode(readFileSync(filePath));
  } catch {
    throw new Error('release event schema cannot be read as valid UTF-8');
  }
}

export function validateReleaseEvent(value, schema = loadReleaseEventSchema()) {
  const errors = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return ['release event must be an object'];
  }

  const allowedFields = new Set(Object.keys(schema.properties));
  for (const name of Object.keys(value)) {
    if (!allowedFields.has(name)) {
      errors.push(`unknown field \`${name}\``);
    }
  }
  for (const name of schema.required) {
    if (!Object.hasOwn(value, name)) {
      errors.push(`missing required field \`${name}\``);
    }
  }
  for (const [name, fieldValue] of Object.entries(value)) {
    const definition = schema.properties[name];
    if (definition) {
      errors.push(...validateProperty(name, fieldValue, definition));
    }
  }

  if (value.environment && value.stage) {
    const allowedStages = ALLOWED_STAGES_BY_ENVIRONMENT[value.environment];
    if (allowedStages && !allowedStages.has(value.stage)) {
      errors.push(
        `environment \`${value.environment}\` cannot record stage \`${value.stage}\``,
      );
    }
  }

  if (typeof value.occurredAt === 'string') {
    const parsed = new Date(value.occurredAt);
    const expected = value.occurredAt.replace(/Z$/u, '.000Z');
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== expected) {
      errors.push('field `occurredAt` must be a valid canonical UTC timestamp');
    }
  }

  const hasPackage = Object.hasOwn(value, 'packageId');
  const hasAgent = Object.hasOwn(value, 'agentId');
  if (hasPackage !== hasAgent) {
    errors.push('`packageId` and `agentId` must appear together');
  }

  if (
    value.deviceAlias !== undefined
    && !['e1', 'e2'].includes(value.environment)
  ) {
    errors.push('`deviceAlias` is only allowed for e1/e2 internal canary evidence');
  }

  if (FAILURE_OUTCOMES.has(value.outcome) && value.errorCode === undefined) {
    errors.push(`outcome \`${value.outcome}\` requires \`errorCode\``);
  }
  if (
    value.errorCode !== undefined
    && value.outcome !== undefined
    && !FAILURE_OUTCOMES.has(value.outcome)
  ) {
    errors.push(`outcome \`${value.outcome}\` must omit \`errorCode\``);
  }

  if (
    BUILD_EVENT_TYPES.has(value.eventType)
    && value.buildRevision === undefined
  ) {
    errors.push(`event type \`${value.eventType}\` requires \`buildRevision\``);
  }
  if (
    REGISTRY_EVENT_TYPES.has(value.eventType)
    && value.registryRevision === undefined
  ) {
    errors.push(`event type \`${value.eventType}\` requires \`registryRevision\``);
  }
  if (
    RECEIPT_EVENT_TYPES.has(value.eventType)
    && value.receiptId === undefined
  ) {
    errors.push(`event type \`${value.eventType}\` requires \`receiptId\``);
  }

  return errors;
}

async function readBoundedRegularFile(filePath, maximumBytes) {
  let stat;
  try {
    stat = await lstat(filePath);
  } catch {
    throw new Error('cannot be inspected');
  }
  if (stat.isSymbolicLink()) {
    throw new Error('is a symbolic link');
  }
  if (!stat.isFile()) {
    throw new Error('is not a regular file');
  }
  if (stat.size <= 0 || stat.size > maximumBytes) {
    throw new Error(`size must be between 1 and ${maximumBytes} bytes`);
  }
  let bytes;
  try {
    bytes = await readFile(filePath);
  } catch {
    throw new Error('cannot be read');
  }
  let text;
  try {
    text = UTF8_DECODER.decode(bytes);
  } catch {
    throw new Error('is not valid UTF-8');
  }
  return { bytes: stat.size, text };
}

function validateEventText(text, fileName, schema) {
  const lines = text.split(/\r?\n/u);
  const errors = [];
  let eventCount = 0;
  const eventIds = new Set();
  let releaseId = null;
  let publicVersion = null;
  let previousOccurredAt = null;
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    eventCount += 1;
    if (eventCount > MAX_EVENT_COUNT) {
      errors.push(`${fileName}: event count exceeds ${MAX_EVENT_COUNT}`);
      break;
    }
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      errors.push(`${fileName}:${index + 1}: event is not valid JSON`);
      continue;
    }
    if (hasDuplicateJsonObjectKeys(line)) {
      errors.push(`${fileName}:${index + 1}: duplicate JSON object keys`);
      continue;
    }
    if (typeof event?.eventId === 'string') {
      if (eventIds.has(event.eventId)) {
        errors.push(`${fileName}:${index + 1}: duplicate event ID \`${event.eventId}\``);
      }
      eventIds.add(event.eventId);
    }
    if (typeof event?.releaseId === 'string') {
      if (releaseId === null) {
        releaseId = event.releaseId;
      } else if (releaseId !== event.releaseId) {
        errors.push(`${fileName}:${index + 1}: contains multiple release IDs`);
      }
    }
    if (typeof event?.publicVersion === 'string') {
      if (publicVersion === null) {
        publicVersion = event.publicVersion;
      } else if (publicVersion !== event.publicVersion) {
        errors.push(`${fileName}:${index + 1}: contains multiple public versions`);
      }
    }
    if (typeof event?.occurredAt === 'string') {
      if (previousOccurredAt !== null && event.occurredAt < previousOccurredAt) {
        errors.push(`${fileName}:${index + 1}: events are not ordered by occurredAt`);
      }
      previousOccurredAt = event.occurredAt;
    }
    for (const error of validateReleaseEvent(event, schema)) {
      errors.push(`${fileName}:${index + 1}: ${error}`);
    }
  }
  if (eventCount === 0) {
    errors.push(`${fileName}: must contain at least one event`);
  }
  return {
    errors,
    identity: { releaseId, publicVersion },
  };
}

export async function validateEventFile(
  filePath,
  schema = loadReleaseEventSchema(),
) {
  const fileName = path.basename(filePath);
  let text;
  try {
    ({ text } = await readBoundedRegularFile(filePath, MAX_EVENT_FILE_BYTES));
  } catch (error) {
    return [`${fileName}: ${error.message}`];
  }
  return validateEventText(text, fileName, schema).errors;
}

function forbiddenContent(value) {
  for (const [label, pattern] of FORBIDDEN_CONTENT_PATTERNS) {
    if (pattern.test(value)) {
      return label;
    }
  }
  return null;
}

function scanJsonValue(value, location, errors) {
  if (Array.isArray(value)) {
    for (const [index, child] of value.entries()) {
      scanJsonValue(child, `${location}[${index}]`, errors);
    }
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (FORBIDDEN_FIELD_NAMES.has(normalizedFieldName(key))) {
        errors.push(`${location}: forbidden field \`${key}\``);
      }
      const keyContent = forbiddenContent(key);
      if (keyContent) {
        errors.push(`${location}: forbidden content in field name (${keyContent})`);
      }
      scanJsonValue(child, `${location}.${key}`, errors);
    }
    return;
  }
  if (typeof value === 'string') {
    const label = forbiddenContent(value);
    if (label) {
      errors.push(`${location}: forbidden content (${label})`);
    }
  }
}

function scanText(value, fileName, errors) {
  const label = forbiddenContent(value);
  if (label) {
    errors.push(`${fileName}: forbidden content (${label})`);
  }
}

function readMarkdownIdentity(text, fileName, errors) {
  const fields = MARKDOWN_IDENTITY_FIELDS[fileName];
  if (!fields) return null;
  const identity = {};
  for (const [property, label] of Object.entries(fields)) {
    const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    const matches = [
      ...text.matchAll(
        new RegExp(`^- ${escapedLabel}: \`([^\`\\r\\n]+)\`$`, 'gmu'),
      ),
    ];
    if (matches.length !== 1) {
      errors.push(
        `${fileName}: identity field \`${label}\` must appear exactly once`,
      );
    } else {
      identity[property] = matches[0][1];
    }
  }
  return identity;
}

function readJsonIdentity(value, fileName, errors) {
  if (!JSON_IDENTITY_FILES.has(fileName)) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push(`${fileName}: evidence must be a JSON object`);
    return null;
  }
  const identity = {};
  for (const property of ['releaseId', 'publicVersion']) {
    if (typeof value[property] !== 'string') {
      errors.push(`${fileName}: missing required identity field \`${property}\``);
    } else {
      identity[property] = value[property];
    }
  }
  return identity;
}

function registerEvidenceIdentity(
  identity,
  fileName,
  canonicalIdentity,
  schema,
  errors,
) {
  if (!identity) return;
  let valid = true;
  for (const property of ['releaseId', 'publicVersion']) {
    if (identity[property] === undefined) continue;
    const fieldErrors = validateProperty(
      property,
      identity[property],
      schema.properties[property],
    );
    for (const error of fieldErrors) errors.push(`${fileName}: ${error}`);
    if (fieldErrors.length) valid = false;
  }
  if (!valid) return;

  let mismatch = false;
  for (const property of ['releaseId', 'publicVersion']) {
    if (identity[property] === undefined) continue;
    if (canonicalIdentity[property] === null) {
      canonicalIdentity[property] = identity[property];
    } else if (canonicalIdentity[property] !== identity[property]) {
      mismatch = true;
    }
  }
  if (mismatch) {
    errors.push(`${fileName}: release identity does not match other evidence files`);
  }
}

export async function scanEvidenceDirectory(
  directory,
  {
    requireComplete = true,
    schema = loadReleaseEventSchema(),
  } = {},
) {
  const errors = [];
  let rootStat;
  try {
    rootStat = await lstat(directory);
  } catch {
    return ['evidence directory does not exist'];
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    return ['evidence directory must be a real directory, not a symbolic link'];
  }

  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return ['evidence directory cannot be read'];
  }
  if (entries.length > MAX_EVIDENCE_FILES) {
    errors.push(`evidence file count exceeds ${MAX_EVIDENCE_FILES}`);
  }
  const present = new Set(entries.map((entry) => entry.name));
  if (requireComplete) {
    for (const fileName of REQUIRED_EVIDENCE_FILES) {
      if (!present.has(fileName)) {
        errors.push(`missing required evidence file \`${fileName}\``);
      }
    }
  }

  let totalBytes = 0;
  const canonicalIdentity = { releaseId: null, publicVersion: null };
  for (const entry of entries) {
    const fileName = entry.name;
    if (!REQUIRED_EVIDENCE_FILE_SET.has(fileName)) {
      errors.push(`unexpected evidence file \`${fileName}\``);
      continue;
    }
    const filePath = path.join(directory, fileName);
    let file;
    try {
      file = await readBoundedRegularFile(filePath, MAX_EVIDENCE_FILE_BYTES);
    } catch (error) {
      errors.push(`${fileName}: ${error.message}`);
      continue;
    }
    totalBytes += file.bytes;
    if (totalBytes > MAX_EVIDENCE_TOTAL_BYTES) {
      errors.push(`evidence total size exceeds ${MAX_EVIDENCE_TOTAL_BYTES} bytes`);
      break;
    }

    if (fileName === 'events.v1.jsonl') {
      const eventResult = validateEventText(file.text, fileName, schema);
      errors.push(...eventResult.errors);
      registerEvidenceIdentity(
        eventResult.identity,
        fileName,
        canonicalIdentity,
        schema,
        errors,
      );
      continue;
    }
    if (fileName.endsWith('.json')) {
      let value;
      try {
        value = JSON.parse(file.text);
      } catch {
        errors.push(`${fileName}: evidence is not valid JSON`);
        continue;
      }
      const duplicateKeys = hasDuplicateJsonObjectKeys(file.text);
      if (duplicateKeys) {
        errors.push(`${fileName}: duplicate JSON object keys`);
      }
      scanJsonValue(value, fileName, errors);
      if (!duplicateKeys) {
        registerEvidenceIdentity(
          readJsonIdentity(value, fileName, errors),
          fileName,
          canonicalIdentity,
          schema,
          errors,
        );
      }
    } else {
      scanText(file.text, fileName, errors);
      registerEvidenceIdentity(
        readMarkdownIdentity(file.text, fileName, errors),
        fileName,
        canonicalIdentity,
        schema,
        errors,
      );
    }
  }
  return errors;
}

function usage() {
  return [
    'Usage:',
    '  node tools/release-evidence/validate-release-evidence.mjs --events <events.v1.jsonl>',
    '  node tools/release-evidence/validate-release-evidence.mjs --evidence-dir <directory> [--allow-partial]',
  ].join('\n');
}

async function main(argv) {
  const args = [...argv];
  const allowPartialIndex = args.indexOf('--allow-partial');
  const allowPartial = allowPartialIndex >= 0;
  if (allowPartial) args.splice(allowPartialIndex, 1);

  let errors;
  if (args.length === 2 && args[0] === '--events') {
    errors = await validateEventFile(args[1]);
  } else if (args.length === 2 && args[0] === '--evidence-dir') {
    errors = await scanEvidenceDirectory(args[1], {
      requireComplete: !allowPartial,
    });
  } else {
    process.stderr.write(`${usage()}\n`);
    return 2;
  }

  if (errors.length) {
    process.stderr.write('release evidence validation failed:\n');
    for (const error of errors) {
      process.stderr.write(`- ${error}\n`);
    }
    return 1;
  }
  process.stdout.write('release evidence validation passed\n');
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch {
    process.stderr.write('release evidence validation unavailable\n');
    process.exitCode = 1;
  }
}
