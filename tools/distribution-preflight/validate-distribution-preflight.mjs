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
  '../../schemas/agentmesh360-distribution-preflight-v1.schema.json',
);
const MAX_PREFLIGHT_BYTES = 128 * 1024;
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

const EXPECTED_ARTIFACT_CONTENT_TYPES = Object.freeze([
  'application/vnd.agentmesh.package',
  'application/zstd',
  'application/x-zstd',
  'application/octet-stream',
]);
const EXPECTED_IMMUTABLE_OBJECTS = Object.freeze([
  'artifact',
  'envelope',
  'host_bundles',
  'host_projection',
  'release_manifest',
]);
const EXPECTED_FAULTS = Object.freeze([
  ['not_found', 'lkg_or_unavailable'],
  ['timeout', 'lkg_or_unavailable'],
  ['truncated_response', 'reject_and_preserve_lkg'],
  ['response_too_large', 'reject_and_preserve_lkg'],
  ['wrong_content_type', 'reject_and_preserve_lkg'],
  ['redirect', 'reject_and_preserve_lkg'],
  ['digest_mismatch', 'reject_and_preserve_lkg'],
  ['signature_mismatch', 'reject_and_preserve_lkg'],
  ['expired_metadata', 'reject_and_preserve_lkg'],
  ['registry_rollback', 'reject_and_preserve_newer_lkg'],
  ['same_revision_equivocation', 'reject_and_preserve_lkg'],
  ['valid_lkg_transport_failure', 'serve_valid_lkg'],
  ['invalid_or_expired_lkg', 'unavailable_fail_closed'],
  ['partial_publication_before_registry', 'undiscoverable'],
]);
const EXPECTED_STOP_CONDITIONS = Object.freeze([
  'approval_missing',
  'p4_release_set_unapproved',
  'staging_trust_unapproved',
  'external_resource_unapproved',
  'credential_scope_unapproved',
  'origin_or_tls_drift',
  'immutable_object_mismatch',
  'object_overwrite_possible',
  'registry_publish_order_violation',
  'fault_matrix_incomplete',
  'lkg_semantics_violation',
  'evidence_policy_violation',
  'cleanup_failure',
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
    throw new Error('distribution preflight schema cannot be inspected');
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('distribution preflight schema must be a regular file');
  }
  if (stat.size <= 0 || stat.size > MAX_PREFLIGHT_BYTES) {
    throw new Error('distribution preflight schema size is invalid');
  }
  let document;
  try {
    document = UTF8_DECODER.decode(readFileSync(filePath));
  } catch {
    throw new Error(
      'distribution preflight schema cannot be read as valid UTF-8',
    );
  }
  if (hasDuplicateJsonObjectKeys(document)) {
    throw new Error(
      'distribution preflight schema contains duplicate JSON object keys',
    );
  }
  let schema;
  try {
    schema = JSON.parse(document);
  } catch {
    throw new Error('distribution preflight schema is not valid JSON');
  }
  if (
    schema?.type !== 'object'
    || schema?.additionalProperties !== false
    || !Array.isArray(schema?.required)
    || !schema?.properties
  ) {
    throw new Error(
      'distribution preflight schema is missing strict object constraints',
    );
  }
  return Object.freeze(schema);
}

export function loadDistributionPreflightSchema(
  schemaPath = DEFAULT_SCHEMA_PATH,
) {
  return readSchemaFile(schemaPath);
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

export function validateDistributionPreflight(
  value,
  schema = loadDistributionPreflightSchema(),
) {
  const errors = [];
  validateSchemaValue(value, schema, 'preflight', errors);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return errors;

  if (
    !exactArray(
      value.consumerContract?.artifactContentTypes,
      EXPECTED_ARTIFACT_CONTENT_TYPES,
    )
  ) {
    errors.push(
      'consumerContract.artifactContentTypes must preserve the reviewed downloader allowlist',
    );
  }
  if (
    !exactArray(
      value.publicationPlan?.immutableObjectClasses,
      EXPECTED_IMMUTABLE_OBJECTS,
    )
  ) {
    errors.push(
      'publicationPlan.immutableObjectClasses must contain every immutable release object in order',
    );
  }
  if (Array.isArray(value.faultMatrix)) {
    const faults = value.faultMatrix.map((entry) => [
      entry?.scenario,
      entry?.expectedOutcome,
      entry?.executionStatus,
    ]);
    if (
      faults.length !== EXPECTED_FAULTS.length
      || faults.some(
        (entry, index) =>
          entry[0] !== EXPECTED_FAULTS[index][0]
          || entry[1] !== EXPECTED_FAULTS[index][1]
          || entry[2] !== 'blocked',
      )
    ) {
      errors.push(
        'faultMatrix must contain every R3 failure and LKG scenario exactly once in order',
      );
    }
  }
  if (!exactArray(value.stopConditions, EXPECTED_STOP_CONDITIONS)) {
    errors.push(
      'stopConditions must preserve every P4 no-authority abort condition in order',
    );
  }
  return errors;
}

async function readPreflightFile(filePath) {
  let stat;
  try {
    stat = await lstat(filePath);
  } catch {
    throw new Error('distribution preflight cannot be inspected');
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('distribution preflight must be a regular file');
  }
  if (stat.size <= 0 || stat.size > MAX_PREFLIGHT_BYTES) {
    throw new Error('distribution preflight size is invalid');
  }
  let document;
  try {
    document = UTF8_DECODER.decode(await readFile(filePath));
  } catch {
    throw new Error('distribution preflight cannot be read as valid UTF-8');
  }
  if (hasDuplicateJsonObjectKeys(document)) {
    throw new Error('distribution preflight contains duplicate JSON object keys');
  }
  let value;
  try {
    value = JSON.parse(document);
  } catch {
    throw new Error('distribution preflight is not valid JSON');
  }
  return value;
}

export async function validateDistributionPreflightFile(
  filePath,
  schema = loadDistributionPreflightSchema(),
) {
  const value = await readPreflightFile(filePath);
  const errors = validateDistributionPreflight(value, schema);
  if (errors.length > 0) {
    throw new Error(
      `distribution preflight validation failed:\n- ${errors.join('\n- ')}`,
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
      'usage: node validate-distribution-preflight.mjs <preflight.json>',
    );
    process.exitCode = 2;
  } else {
    validateDistributionPreflightFile(filePath)
      .then(() => {
        console.log('distribution preflight validation passed');
      })
      .catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      });
  }
}
