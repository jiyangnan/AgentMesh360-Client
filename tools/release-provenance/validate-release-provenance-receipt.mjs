#!/usr/bin/env node

import { lstatSync, readFileSync } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { TextDecoder } from 'node:util';
import { fileURLToPath } from 'node:url';

const MODULE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SCHEMA_PATH = path.resolve(
  MODULE_DIRECTORY,
  '../../schemas/agentmesh360-release-provenance-receipt-v1.schema.json',
);
const MAX_RECEIPT_BYTES = 256 * 1024;
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });
const EXPECTED_OUTPUTS = Object.freeze([
  'artifact',
  'envelope',
  'finalize_receipt',
  'host_bundles',
  'host_projection',
  'package_file_manifest',
  'registry_record',
  'release_manifest',
  'signature_result',
  'signing_request',
]);
const EXPECTED_AGENTS = Object.freeze([
  ['deploy-agent', 'com.agentmesh360.deploy-agent', '0.1.1', 'first_party', 0],
  ['future-agent', 'com.agentmesh360.future-agent', '1.0.0', 'dynamic_fixture', 2],
  ['job-agent', 'com.agentmesh360.job-agent', '0.4.7', 'first_party', 2],
  [
    'lecturecast-agent',
    'com.agentmesh360.lecturecast-agent',
    '0.4.0',
    'first_party',
    3,
  ],
]);
const EXPECTED_SOURCES = Object.freeze([
  ['deploy-agent', 'first_party', 'deploy_source'],
  ['future-agent', 'dynamic_fixture', 'executor_fixture'],
  ['job-agent', 'first_party', 'job_source'],
  ['lecturecast-agent', 'first_party', 'lecturecast_source'],
]);
const DANGEROUS_FIELD_NAMES = new Set([
  'absolutepath',
  'command',
  'credential',
  'email',
  'path',
  'personname',
  'privatekey',
  'privatekeybase64',
  'privatekeypem',
  'publickey',
  'rawcommand',
  'seed',
  'secret',
  'signature',
  'signaturebase64',
  'temporarydirectory',
  'token',
  'userid',
  'username',
]);

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
    if (document[offset] === '{') return readObject();
    if (document[offset] === '[') return readArray();
    if (document[offset] === '"') return readString();
    while (
      offset < document.length
      && !/[\s,\]}]/u.test(document[offset])
    ) {
      offset += 1;
    }
    return undefined;
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

function readSchemaFile(filePath) {
  let stat;
  try {
    stat = lstatSync(filePath);
  } catch {
    throw new Error('release provenance receipt schema cannot be inspected');
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('release provenance receipt schema must be a regular file');
  }
  if (stat.size <= 0 || stat.size > MAX_RECEIPT_BYTES) {
    throw new Error('release provenance receipt schema size is invalid');
  }
  let document;
  try {
    document = UTF8_DECODER.decode(readFileSync(filePath));
  } catch {
    throw new Error(
      'release provenance receipt schema cannot be read as valid UTF-8',
    );
  }
  if (hasDuplicateJsonObjectKeys(document)) {
    throw new Error(
      'release provenance receipt schema contains duplicate JSON object keys',
    );
  }
  let schema;
  try {
    schema = JSON.parse(document);
  } catch {
    throw new Error('release provenance receipt schema is not valid JSON');
  }
  return schema;
}

export function loadReleaseProvenanceReceiptSchema(
  schemaPath = DEFAULT_SCHEMA_PATH,
) {
  const schema = readSchemaFile(schemaPath);
  if (
    schema?.type !== 'object'
    || schema?.additionalProperties !== false
    || !Array.isArray(schema?.required)
    || !schema?.properties
    || !schema?.$defs
  ) {
    throw new Error(
      'release provenance receipt schema is missing strict object constraints',
    );
  }
  return Object.freeze(schema);
}

function resolveDefinition(definition, rootSchema) {
  if (!definition?.$ref) return definition;
  const prefix = '#/$defs/';
  if (!definition.$ref.startsWith(prefix)) {
    throw new Error('release provenance receipt schema has an unsupported reference');
  }
  const resolved = rootSchema.$defs?.[definition.$ref.slice(prefix.length)];
  if (!resolved) {
    throw new Error('release provenance receipt schema has an unresolved reference');
  }
  return resolveDefinition(resolved, rootSchema);
}

function validateSchemaValue(value, rawDefinition, location, errors, rootSchema) {
  const definition = resolveDefinition(rawDefinition, rootSchema);
  if (definition.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      errors.push(`${location} must be an object`);
      return;
    }
    const properties = definition.properties ?? {};
    if (definition.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(properties, key)) {
          errors.push(`${location}: contains an unknown field`);
        }
      }
    }
    for (const key of definition.required ?? []) {
      if (!Object.hasOwn(value, key)) {
        errors.push(`${location}: missing required field \`${key}\``);
      }
    }
    for (const [key, child] of Object.entries(value)) {
      if (properties[key]) {
        validateSchemaValue(
          child,
          properties[key],
          `${location}.${key}`,
          errors,
          rootSchema,
        );
      }
    }
  } else if (definition.type === 'array') {
    if (!Array.isArray(value)) {
      errors.push(`${location} must be an array`);
      return;
    }
    if (definition.minItems != null && value.length < definition.minItems) {
      errors.push(`${location} must contain at least ${definition.minItems} items`);
    }
    if (definition.maxItems != null && value.length > definition.maxItems) {
      errors.push(`${location} must contain at most ${definition.maxItems} items`);
    }
    for (const [index, child] of value.entries()) {
      const childDefinition = definition.prefixItems?.[index] ?? definition.items;
      if (childDefinition && childDefinition !== false) {
        validateSchemaValue(
          child,
          childDefinition,
          `${location}[${index}]`,
          errors,
          rootSchema,
        );
      }
    }
  } else if (definition.type === 'integer') {
    if (!Number.isSafeInteger(value)) {
      errors.push(`${location} must be a safe integer`);
      return;
    }
    if (definition.minimum != null && value < definition.minimum) {
      errors.push(`${location} must be at least ${definition.minimum}`);
    }
    if (definition.maximum != null && value > definition.maximum) {
      errors.push(`${location} must be at most ${definition.maximum}`);
    }
  } else if (typeof value !== definition.type) {
    errors.push(
      `${location} must be ${definition.type}, received ${printableType(value)}`,
    );
    return;
  }

  if (definition.const !== undefined && value !== definition.const) {
    errors.push(`${location} must equal its approved E0 receipt constant`);
  }
  if (definition.enum && !definition.enum.includes(value)) {
    errors.push(`${location} is not in the allowed enum`);
  }
  if (definition.pattern && typeof value === 'string') {
    if (!new RegExp(definition.pattern, 'u').test(value)) {
      errors.push(`${location} does not match its non-secret evidence format`);
    }
  }
}

function exactArray(values, expected) {
  return (
    Array.isArray(values)
    && values.length === expected.length
    && values.every((value, index) => value === expected[index])
  );
}

export function validateReleaseProvenanceReceipt(
  value,
  schema = loadReleaseProvenanceReceiptSchema(),
) {
  const errors = [];
  validateSchemaValue(value, schema, 'receipt', errors, schema);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return errors;

  if (Array.isArray(value.sourceInputs)) {
    const sources = value.sourceInputs.map((source) => [
      source?.agentId,
      source?.sourceClass,
      source?.sourceAlias,
    ]);
    if (
      sources.length !== EXPECTED_SOURCES.length
      || sources.some(
        (source, index) => !exactArray(source, EXPECTED_SOURCES[index]),
      )
    ) {
      errors.push('sourceInputs must contain the four frozen sources exactly once');
    }
    if (
      value.sourceInputs[1]?.commit
      && value.sourceInputs[1]?.commit !== value.executorFreeze?.commit
    ) {
      errors.push('dynamic fixture commit must equal executorFreeze.commit');
    }
  }

  if (Array.isArray(value.agentResults)) {
    for (const [index, result] of value.agentResults.entries()) {
      const expected = EXPECTED_AGENTS[index];
      if (
        !expected
        || result?.agentId !== expected[0]
        || result?.packageId !== expected[1]
        || result?.version !== expected[2]
        || result?.sourceClass !== expected[3]
        || result?.hostBundleCount !== expected[4]
      ) {
        errors.push('agentResults must contain the exact approved four-Agent matrix');
        break;
      }
      if (
        !exactArray(
          result?.outputComparisons?.map((entry) => entry?.outputClass),
          EXPECTED_OUTPUTS,
        )
      ) {
        errors.push(
          `${expected[0]} outputComparisons must contain all ten classes in order`,
        );
      }
      if (
        result?.outputComparisons?.some(
          (entry) => entry?.byteIdentical !== true,
        )
      ) {
        errors.push(`${expected[0]} outputs must be byte-identical`);
      }
      for (const comparison of result?.outputComparisons ?? []) {
        const expectedFileCount = comparison.outputClass === 'host_bundles'
          ? expected[4]
          : 1;
        if (comparison.fileCount !== expectedFileCount) {
          errors.push(
            `${expected[0]} ${comparison.outputClass} fileCount is invalid`,
          );
        }
      }
    }
  }
  return errors;
}

function unsafeRetentionReason(value, field = 'receipt') {
  if (Array.isArray(value)) {
    for (const [index, child] of value.entries()) {
      const reason = unsafeRetentionReason(child, `${field}[${index}]`);
      if (reason) return reason;
    }
    return null;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      const normalized = key.replace(/[^a-z0-9]/giu, '').toLowerCase();
      if (DANGEROUS_FIELD_NAMES.has(normalized)) {
        return `${field} contains a forbidden field`;
      }
      const reason = unsafeRetentionReason(child, `${field}.${key}`);
      if (reason) return reason;
    }
    return null;
  }
  if (typeof value !== 'string') return null;
  if (
    value.startsWith('/')
    || /^[A-Za-z]:[\\/]/u.test(value)
    || value.includes('-----BEGIN')
  ) {
    return `${field} contains path or private-material text`;
  }
  if (/^[0-9a-f]{64}$/u.test(value)) {
    return `${field} contains an untyped digest`;
  }
  if (
    /^(?:[A-Za-z0-9+/]{43}=|[A-Za-z0-9+/]{86}==)$/u.test(value)
  ) {
    return `${field} contains raw public-key or signature bytes`;
  }
  return null;
}

export function assertReleaseProvenanceReceiptSafeForRetention(value) {
  const reason = unsafeRetentionReason(value);
  if (reason) throw new Error(`unsafe release provenance receipt: ${reason}`);
}

async function readReceiptFile(filePath) {
  let stat;
  try {
    stat = await lstat(filePath);
  } catch {
    throw new Error('release provenance receipt cannot be inspected');
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('release provenance receipt must be a regular file');
  }
  if (stat.size <= 0 || stat.size > MAX_RECEIPT_BYTES) {
    throw new Error('release provenance receipt size is invalid');
  }
  let document;
  try {
    document = UTF8_DECODER.decode(await readFile(filePath));
  } catch {
    throw new Error(
      'release provenance receipt cannot be read as valid UTF-8',
    );
  }
  if (hasDuplicateJsonObjectKeys(document)) {
    throw new Error(
      'release provenance receipt contains duplicate JSON object keys',
    );
  }
  let value;
  try {
    value = JSON.parse(document);
  } catch {
    throw new Error('release provenance receipt is not valid JSON');
  }
  return value;
}

export async function validateReleaseProvenanceReceiptFile(
  filePath,
  schema = loadReleaseProvenanceReceiptSchema(),
) {
  const value = await readReceiptFile(filePath);
  const errors = validateReleaseProvenanceReceipt(value, schema);
  if (errors.length > 0) {
    throw new Error(
      `release provenance receipt validation failed:\n- ${errors.join('\n- ')}`,
    );
  }
  assertReleaseProvenanceReceiptSafeForRetention(value);
  return errors;
}

function isMainModule() {
  return process.argv[1]
    && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  const receiptPath = process.argv[2];
  if (!receiptPath || process.argv.length !== 3) {
    console.error(
      'usage: node validate-release-provenance-receipt.mjs <receipt.json>',
    );
    process.exitCode = 1;
  } else {
    validateReleaseProvenanceReceiptFile(receiptPath)
      .then(() => {
        console.log('release provenance receipt is valid and retention-safe');
      })
      .catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      });
  }
}
