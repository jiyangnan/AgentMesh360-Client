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
  '../../schemas/agentmesh360-key-ceremony-preflight-v1.schema.json',
);
const MAX_PREFLIGHT_BYTES = 128 * 1024;
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

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
    throw new Error('key ceremony preflight schema cannot be inspected');
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('key ceremony preflight schema must be a regular file');
  }
  if (stat.size <= 0 || stat.size > MAX_PREFLIGHT_BYTES) {
    throw new Error('key ceremony preflight schema size is invalid');
  }
  let document;
  try {
    document = UTF8_DECODER.decode(readFileSync(filePath));
  } catch {
    throw new Error('key ceremony preflight schema cannot be read as valid UTF-8');
  }
  let schema;
  try {
    schema = JSON.parse(document);
  } catch {
    throw new Error('key ceremony preflight schema is not valid JSON');
  }
  if (hasDuplicateJsonObjectKeys(document)) {
    throw new Error('key ceremony preflight schema contains duplicate JSON object keys');
  }
  return schema;
}

export function loadKeyCeremonyPreflightSchema(schemaPath = DEFAULT_SCHEMA_PATH) {
  const schema = readSchemaFile(schemaPath);
  if (
    schema?.type !== 'object'
    || schema?.additionalProperties !== false
    || !Array.isArray(schema?.required)
    || !schema?.properties
  ) {
    throw new Error('key ceremony preflight schema is missing strict object constraints');
  }
  return Object.freeze(schema);
}

function validateSchemaValue(value, definition, location, errors) {
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
        validateSchemaValue(child, properties[key], `${location}.${key}`, errors);
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
    if (
      definition.uniqueItems
      && new Set(value.map((item) => JSON.stringify(item))).size !== value.length
    ) {
      errors.push(`${location} must contain unique items`);
    }
    for (const [index, child] of value.entries()) {
      const childDefinition = definition.prefixItems?.[index] ?? definition.items;
      if (childDefinition && childDefinition !== false) {
        validateSchemaValue(child, childDefinition, `${location}[${index}]`, errors);
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
    errors.push(`${location} must equal its no-authority preflight constant`);
  }
  if (definition.enum && !definition.enum.includes(value)) {
    errors.push(`${location} is not in the allowed enum`);
  }
  if (definition.pattern && typeof value === 'string') {
    if (!new RegExp(definition.pattern, 'u').test(value)) {
      errors.push(`${location} does not match its public identifier format`);
    }
  }
}

export function validateKeyCeremonyPreflight(
  value,
  schema = loadKeyCeremonyPreflightSchema(),
) {
  const errors = [];
  validateSchemaValue(value, schema, 'preflight', errors);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return errors;

  const root = value.plannedKeyIds?.root;
  const publishers = value.plannedKeyIds?.publishers;
  if (
    Array.isArray(publishers)
    && publishers.length === 2
    && publishers.every((entry) => typeof entry === 'string')
    && !(publishers[0] < publishers[1])
  ) {
    errors.push('planned publisher key IDs must be unique and sorted');
  }
  if (
    typeof root === 'string'
    && Array.isArray(publishers)
    && publishers.includes(root)
  ) {
    errors.push('planned Root and Publisher key IDs must differ');
  }
  const sequences = [
    value.sequencePlan?.initialTrustSequence,
    value.sequencePlan?.overlapTrustSequence,
    value.sequencePlan?.retirementTrustSequence,
    value.sequencePlan?.revocationTrustSequence,
  ];
  if (
    sequences.every((sequence) => Number.isSafeInteger(sequence))
    && sequences.some((sequence, index) => index > 0 && sequence <= sequences[index - 1])
  ) {
    errors.push('trust sequences must increase monotonically');
  }
  return errors;
}

async function readPreflightFile(filePath) {
  let stat;
  try {
    stat = await lstat(filePath);
  } catch {
    throw new Error('cannot be inspected');
  }
  if (stat.isSymbolicLink()) throw new Error('is a symbolic link');
  if (!stat.isFile()) throw new Error('is not a regular file');
  if (stat.size <= 0 || stat.size > MAX_PREFLIGHT_BYTES) {
    throw new Error(`size must be between 1 and ${MAX_PREFLIGHT_BYTES} bytes`);
  }
  let bytes;
  try {
    bytes = await readFile(filePath);
  } catch {
    throw new Error('cannot be read');
  }
  try {
    return UTF8_DECODER.decode(bytes);
  } catch {
    throw new Error('is not valid UTF-8');
  }
}

export async function validateKeyCeremonyPreflightFile(
  filePath,
  schema = loadKeyCeremonyPreflightSchema(),
) {
  let document;
  try {
    document = await readPreflightFile(filePath);
  } catch (error) {
    return [`preflight input: ${error.message}`];
  }
  let value;
  try {
    value = JSON.parse(document);
  } catch {
    return ['preflight input: preflight is not valid JSON'];
  }
  if (hasDuplicateJsonObjectKeys(document)) {
    return ['preflight input: duplicate JSON object keys'];
  }
  return validateKeyCeremonyPreflight(value, schema).map(
    (error) => `preflight input: ${error}`,
  );
}

function usage() {
  return [
    'Usage:',
    '  node tools/key-ceremony/validate-key-ceremony-preflight.mjs',
    '    --preflight <key-ceremony-preflight-v1.json>',
  ].join('\n');
}

async function main(argv) {
  if (argv.length !== 2 || argv[0] !== '--preflight') {
    process.stderr.write(`${usage()}\n`);
    return 2;
  }
  const errors = await validateKeyCeremonyPreflightFile(argv[1]);
  if (errors.length) {
    process.stderr.write('key ceremony preflight validation failed:\n');
    for (const error of errors) process.stderr.write(`- ${error}\n`);
    return 1;
  }
  process.stdout.write('key ceremony preflight validation passed\n');
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch {
    process.stderr.write('key ceremony preflight validation unavailable\n');
    process.exitCode = 1;
  }
}
