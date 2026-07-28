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
  '../../schemas/agentmesh360-key-ceremony-receipt-v1.schema.json',
);
const MAX_RECEIPT_BYTES = 256 * 1024;
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });
const REQUIRED_SCENARIOS = Object.freeze([
  'bundle_expiry',
  'publisher_a_generation',
  'publisher_b_generation',
  'publisher_compromise',
  'publisher_expiry',
  'publisher_loss_recovery',
  'publisher_overlap_rotation',
  'publisher_retirement',
  'publisher_revocation',
  'root_compromise',
  'root_emergency_revocation',
  'root_generation',
  'root_loss_recovery',
  'root_overlap_rotation',
  'root_public_export',
  'test_material_destruction',
]);
const REQUIRED_NEGATIVE_CHECKS = Object.freeze([
  'expired_active_publisher_rejected',
  'expired_bundle_rejected',
  'revoked_publisher_not_active',
  'rollback_sequence_rejected',
  'same_sequence_equivocation_rejected',
  'unknown_root_rejected',
]);
const DANGEROUS_FIELD_NAMES = new Set([
  'absolutepath',
  'accountid',
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

function readSchemaFile(filePath) {
  let stat;
  try {
    stat = lstatSync(filePath);
  } catch {
    throw new Error('key ceremony receipt schema cannot be inspected');
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('key ceremony receipt schema must be a regular file');
  }
  if (stat.size <= 0 || stat.size > MAX_RECEIPT_BYTES) {
    throw new Error('key ceremony receipt schema size is invalid');
  }
  let document;
  try {
    document = UTF8_DECODER.decode(readFileSync(filePath));
  } catch {
    throw new Error('key ceremony receipt schema cannot be read as valid UTF-8');
  }
  let schema;
  try {
    schema = JSON.parse(document);
  } catch {
    throw new Error('key ceremony receipt schema is not valid JSON');
  }
  if (hasDuplicateJsonObjectKeys(document)) {
    throw new Error('key ceremony receipt schema contains duplicate JSON object keys');
  }
  return schema;
}

export function loadKeyCeremonyReceiptSchema(schemaPath = DEFAULT_SCHEMA_PATH) {
  const schema = readSchemaFile(schemaPath);
  if (
    schema?.type !== 'object'
    || schema?.additionalProperties !== false
    || !Array.isArray(schema?.required)
    || !schema?.properties
    || !schema?.$defs
  ) {
    throw new Error('key ceremony receipt schema is missing strict object constraints');
  }
  return Object.freeze(schema);
}

function resolveDefinition(definition, rootSchema) {
  if (!definition?.$ref) return definition;
  const prefix = '#/$defs/';
  if (!definition.$ref.startsWith(prefix)) {
    throw new Error('key ceremony receipt schema contains an unsupported reference');
  }
  const name = definition.$ref.slice(prefix.length);
  const resolved = rootSchema.$defs?.[name];
  if (!resolved) {
    throw new Error('key ceremony receipt schema contains an unresolved reference');
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
    errors.push(`${location} must equal its E0 receipt constant`);
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

function validateExactPassedResults(values, expected, field, valueField, errors) {
  if (!Array.isArray(values)) return;
  const actual = values.map((item) => item?.[valueField]);
  if (
    actual.length !== expected.length
    || actual.some((entry, index) => entry !== expected[index])
  ) {
    errors.push(`${field} must contain every required check exactly once in order`);
  }
  if (values.some((item) => item?.status !== 'passed')) {
    errors.push(`${field} entries must pass before the receipt is retained`);
  }
}

export function validateKeyCeremonyReceipt(
  value,
  schema = loadKeyCeremonyReceiptSchema(),
) {
  const errors = [];
  validateSchemaValue(value, schema, 'receipt', errors, schema);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return errors;

  const expectedInventory = [
    ['publisher_a', 'publisher', false],
    ['publisher_b', 'publisher', false],
    ['root_initial', 'root', false],
    ['root_successor_transient', 'root', true],
  ];
  if (Array.isArray(value.keyInventory)) {
    for (const [index, expected] of expectedInventory.entries()) {
      const item = value.keyInventory[index];
      if (
        !item
        || item.alias !== expected[0]
        || item.role !== expected[1]
        || item.transientSuccessor !== expected[2]
      ) {
        errors.push('keyInventory must preserve the approved role and successor order');
        break;
      }
    }
    if (
      value.keyInventory.some((item) =>
        item?.destroyed !== true || item?.privateMaterialPersisted !== false
      )
    ) {
      errors.push('keyInventory must prove all private test material was destroyed');
    }
    const ids = value.keyInventory.map((item) => item?.keyId);
    if (new Set(ids).size !== ids.length) {
      errors.push('keyInventory key IDs must be unique');
    }
  }

  if (Array.isArray(value.trustSequenceEvidence)) {
    const sequences = value.trustSequenceEvidence.map((item) => item?.sequence);
    if (sequences.some((sequence, index) => sequence !== index + 1)) {
      errors.push('trustSequenceEvidence must contain monotonic sequences 1 through 5');
    }
    if (
      value.trustSequenceEvidence.some((item, index) =>
        item?.signerRootAlias
          !== (index === 4 ? 'root_successor_transient' : 'root_initial')
      )
    ) {
      errors.push('trustSequenceEvidence must pin the approved Root rotation boundary');
    }
  }

  validateExactPassedResults(
    value.scenarioResults,
    REQUIRED_SCENARIOS,
    'scenarioResults',
    'scenario',
    errors,
  );
  validateExactPassedResults(
    value.negativeChecks,
    REQUIRED_NEGATIVE_CHECKS,
    'negativeChecks',
    'check',
    errors,
  );

  const completedAt = Date.parse(value.completedAt);
  if (!Number.isFinite(completedAt)) {
    errors.push('completedAt must be a valid UTC timestamp');
  }

  try {
    assertReceiptSafeForRetention(value);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  return errors;
}

function unsafeString(value) {
  return (
    value.includes('-----BEGIN')
    || value.includes('-----END')
    || value.startsWith('/')
    || value.startsWith('~/')
    || /^[A-Za-z]:[\\/]/u.test(value)
    || value.includes('file://')
    || value.includes('/Users/')
    || value.includes('/private/tmp/')
    || value.includes('/var/folders/')
    || /^[0-9a-f]{64}$/u.test(value)
  );
}

export function assertReceiptSafeForRetention(value) {
  const stack = [[value, 'receipt']];
  while (stack.length > 0) {
    const [current, location] = stack.pop();
    if (Array.isArray(current)) {
      current.forEach((child, index) => {
        stack.push([child, `${location}[${index}]`]);
      });
      continue;
    }
    if (current && typeof current === 'object') {
      for (const [key, child] of Object.entries(current)) {
        if (DANGEROUS_FIELD_NAMES.has(key.toLowerCase())) {
          throw new Error(`unsafe ceremony receipt field at ${location}`);
        }
        stack.push([child, `${location}.${key}`]);
      }
      continue;
    }
    if (typeof current === 'string' && unsafeString(current)) {
      throw new Error(`unsafe ceremony receipt value at ${location}`);
    }
  }
}

async function readReceiptFile(filePath) {
  let stat;
  try {
    stat = await lstat(filePath);
  } catch {
    throw new Error('key ceremony receipt cannot be inspected');
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('key ceremony receipt must be a regular file');
  }
  if (stat.size <= 0 || stat.size > MAX_RECEIPT_BYTES) {
    throw new Error('key ceremony receipt size is invalid');
  }
  let document;
  try {
    document = UTF8_DECODER.decode(await readFile(filePath));
  } catch {
    throw new Error('key ceremony receipt cannot be read as valid UTF-8');
  }
  if (hasDuplicateJsonObjectKeys(document)) {
    throw new Error('key ceremony receipt contains duplicate JSON object keys');
  }
  let value;
  try {
    value = JSON.parse(document);
  } catch {
    throw new Error('key ceremony receipt is not valid JSON');
  }
  return value;
}

export async function validateKeyCeremonyReceiptFile(
  filePath,
  schema = loadKeyCeremonyReceiptSchema(),
) {
  const receipt = await readReceiptFile(filePath);
  const errors = validateKeyCeremonyReceipt(receipt, schema);
  if (errors.length > 0) {
    throw new Error(`key ceremony receipt validation failed:\n- ${errors.join('\n- ')}`);
  }
  return receipt;
}

function isMainModule() {
  return process.argv[1]
    && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  const filePath = process.argv[2];
  if (!filePath || process.argv.length !== 3) {
    console.error(
      'usage: node validate-key-ceremony-receipt.mjs <receipt.json>',
    );
    process.exitCode = 2;
  } else {
    validateKeyCeremonyReceiptFile(filePath)
      .then(() => {
        console.log('key ceremony receipt is valid and retention-safe');
      })
      .catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      });
  }
}
