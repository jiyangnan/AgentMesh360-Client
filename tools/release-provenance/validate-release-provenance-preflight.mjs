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
  '../../schemas/agentmesh360-release-provenance-preflight-v1.schema.json',
);
const MAX_PREFLIGHT_BYTES = 128 * 1024;
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });
const EXPECTED_AGENTS = Object.freeze([
  ['deploy-agent', 'com.agentmesh360.deploy-agent', '0.1.1', 'first_party'],
  ['future-agent', 'com.agentmesh360.future-agent', '1.0.0', 'dynamic_fixture'],
  ['job-agent', 'com.agentmesh360.job-agent', '0.4.7', 'first_party'],
  [
    'lecturecast-agent',
    'com.agentmesh360.lecturecast-agent',
    '0.4.0',
    'first_party',
  ],
]);
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
    throw new Error('release provenance preflight schema cannot be inspected');
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('release provenance preflight schema must be a regular file');
  }
  if (stat.size <= 0 || stat.size > MAX_PREFLIGHT_BYTES) {
    throw new Error('release provenance preflight schema size is invalid');
  }
  let document;
  try {
    document = UTF8_DECODER.decode(readFileSync(filePath));
  } catch {
    throw new Error(
      'release provenance preflight schema cannot be read as valid UTF-8',
    );
  }
  if (hasDuplicateJsonObjectKeys(document)) {
    throw new Error(
      'release provenance preflight schema contains duplicate JSON object keys',
    );
  }
  let schema;
  try {
    schema = JSON.parse(document);
  } catch {
    throw new Error('release provenance preflight schema is not valid JSON');
  }
  return schema;
}

export function loadReleaseProvenancePreflightSchema(
  schemaPath = DEFAULT_SCHEMA_PATH,
) {
  const schema = readSchemaFile(schemaPath);
  if (
    schema?.type !== 'object'
    || schema?.additionalProperties !== false
    || !Array.isArray(schema?.required)
    || !schema?.properties
  ) {
    throw new Error(
      'release provenance preflight schema is missing strict object constraints',
    );
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
    for (const [index, child] of value.entries()) {
      const childDefinition = definition.prefixItems?.[index] ?? definition.items;
      if (childDefinition && childDefinition !== false) {
        validateSchemaValue(
          child,
          childDefinition,
          `${location}[${index}]`,
          errors,
        );
      }
    }
  } else if (definition.type === 'integer') {
    if (!Number.isSafeInteger(value)) {
      errors.push(`${location} must be a safe integer`);
      return;
    }
  } else if (typeof value !== definition.type) {
    errors.push(
      `${location} must be ${definition.type}, received ${printableType(value)}`,
    );
    return;
  }

  if (definition.const !== undefined && value !== definition.const) {
    errors.push(`${location} must equal its blocked preflight constant`);
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

function exactArray(values, expected) {
  return (
    Array.isArray(values)
    && values.length === expected.length
    && values.every((value, index) => value === expected[index])
  );
}

export function validateReleaseProvenancePreflight(
  value,
  schema = loadReleaseProvenancePreflightSchema(),
) {
  const errors = [];
  validateSchemaValue(value, schema, 'preflight', errors);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return errors;

  if (!exactArray(value.buildPlan?.outputClasses, EXPECTED_OUTPUTS)) {
    errors.push(
      'buildPlan.outputClasses must contain every provenance output exactly once in order',
    );
  }
  if (Array.isArray(value.agentMatrix)) {
    const agents = value.agentMatrix.map((entry) => [
      entry?.agentId,
      entry?.packageId,
      entry?.version,
      entry?.sourceClass,
    ]);
    if (
      agents.length !== EXPECTED_AGENTS.length
      || agents.some(
        (entry, index) =>
          entry[0] !== EXPECTED_AGENTS[index][0]
          || entry[1] !== EXPECTED_AGENTS[index][1]
          || entry[2] !== EXPECTED_AGENTS[index][2]
          || entry[3] !== EXPECTED_AGENTS[index][3],
      )
    ) {
      errors.push(
        'agentMatrix must contain the three first-party Agents and one dynamic fixture in order',
      );
    }
  }
  return errors;
}

async function readPreflightFile(filePath) {
  let stat;
  try {
    stat = await lstat(filePath);
  } catch {
    throw new Error('release provenance preflight cannot be inspected');
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('release provenance preflight must be a regular file');
  }
  if (stat.size <= 0 || stat.size > MAX_PREFLIGHT_BYTES) {
    throw new Error('release provenance preflight size is invalid');
  }
  let document;
  try {
    document = UTF8_DECODER.decode(await readFile(filePath));
  } catch {
    throw new Error(
      'release provenance preflight cannot be read as valid UTF-8',
    );
  }
  if (hasDuplicateJsonObjectKeys(document)) {
    throw new Error(
      'release provenance preflight contains duplicate JSON object keys',
    );
  }
  let value;
  try {
    value = JSON.parse(document);
  } catch {
    throw new Error('release provenance preflight is not valid JSON');
  }
  return value;
}

export async function validateReleaseProvenancePreflightFile(
  filePath,
  schema = loadReleaseProvenancePreflightSchema(),
) {
  const value = await readPreflightFile(filePath);
  const errors = validateReleaseProvenancePreflight(value, schema);
  if (errors.length > 0) {
    throw new Error(
      `release provenance preflight validation failed:\n- ${errors.join('\n- ')}`,
    );
  }
  return errors;
}

function isMainModule() {
  return process.argv[1]
    && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  const filePath = process.argv[2];
  if (!filePath || process.argv.length !== 3) {
    console.error(
      'usage: node validate-release-provenance-preflight.mjs <preflight.json>',
    );
    process.exitCode = 2;
  } else {
    validateReleaseProvenancePreflightFile(filePath)
      .then(() => {
        console.log('release provenance preflight validation passed');
      })
      .catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      });
  }
}
