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
  '../../schemas/agentmesh360-package-canary-preflight-v1.schema.json',
);
const MAX_PREFLIGHT_BYTES = 128 * 1024;
const MAX_ERRORS = 64;
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

const EXPECTED_SCENARIOS = Object.freeze([
  ['active_subscription', 'admit_exact_account'],
  ['inactive_subscription', 'deny_before_package_or_provider'],
  ['account_switch', 'abort_before_mutation'],
  ['byok_selected_route', 'use_only_selected_provider_model'],
  ['provider_auth_failure', 'fail_without_secret_leak_or_fallback'],
  ['provider_transient_failure', 'bounded_user_retry_only'],
  ['provider_capability_mismatch', 'reject_before_request'],
  ['budget_limit_reached', 'stop_canary'],
  ['new_agent_install', 'verified_atomic_activation'],
  ['same_permission_update', 'preserve_identity_and_main_session'],
  ['permission_expansion_rejected', 'preserve_old_active'],
  ['permission_expansion_approved', 'apply_exact_one_time_plan'],
  ['artifact_or_metadata_tamper', 'reject_before_install'],
  ['registry_rollback_or_equivocation', 'reject_and_preserve_lkg'],
  [
    'trust_expiry_or_publisher_revocation',
    'reject_new_install_preserve_user_data',
  ],
  ['interrupted_install', 'reconcile_old_or_complete_new'],
  ['package_rollback', 'restore_verified_previous_and_state'],
  ['host_skill_projection', 'match_release_reference_version_digest'],
  ['root_rotation', 'accept_only_monotonic_trusted_root'],
  ['publisher_rotation_or_revocation', 'enforce_new_trust_state'],
  [
    'registry_withdrawal',
    'undiscoverable_without_deleting_local_user_data',
  ],
]);

const EXPECTED_STOP_CONDITIONS = Object.freeze([
  'approval_missing',
  'prerequisite_gate_incomplete',
  'dedicated_account_unapproved',
  'subscription_unapproved_or_inactive',
  'byok_provider_or_model_unapproved',
  'request_credit_or_cost_cap_missing',
  'cohort_or_window_unapproved',
  'rollback_target_unapproved',
  'abort_owner_unapproved',
  'evidence_retention_unapproved',
  'release_set_or_trust_unavailable',
  'production_constant_mutation',
  'cross_account_visibility_or_mutation',
  'permission_approval_mismatch',
  'duplicate_irreversible_mutation',
  'silent_provider_fallback',
  'approved_budget_exceeded',
  'secret_or_user_content_in_evidence',
  'scenario_matrix_incomplete',
  'rollback_recovery_or_cleanup_failure',
]);

function printableType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

function addError(errors, message) {
  if (errors.length < MAX_ERRORS) errors.push(message);
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
    throw new Error('package canary preflight schema cannot be inspected');
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('package canary preflight schema must be a regular file');
  }
  if (stat.size <= 0 || stat.size > MAX_PREFLIGHT_BYTES) {
    throw new Error('package canary preflight schema size is invalid');
  }
  let document;
  try {
    document = UTF8_DECODER.decode(readFileSync(filePath));
  } catch {
    throw new Error(
      'package canary preflight schema cannot be read as valid UTF-8',
    );
  }
  try {
    if (hasDuplicateJsonObjectKeys(document)) {
      throw new Error(
        'package canary preflight schema contains duplicate JSON object keys',
      );
    }
  } catch (error) {
    if (
      error instanceof Error
      && error.message.includes('duplicate JSON object keys')
    ) {
      throw error;
    }
    throw new Error('package canary preflight schema is not valid JSON');
  }
  let schema;
  try {
    schema = JSON.parse(document);
  } catch {
    throw new Error('package canary preflight schema is not valid JSON');
  }
  if (
    schema?.type !== 'object'
    || schema?.additionalProperties !== false
    || !Array.isArray(schema?.required)
    || !schema?.properties
  ) {
    throw new Error(
      'package canary preflight schema is missing strict object constraints',
    );
  }
  return Object.freeze(schema);
}

export function loadPackageCanaryPreflightSchema(
  schemaPath = DEFAULT_SCHEMA_PATH,
) {
  return readSchemaFile(schemaPath);
}

function validateSchemaValue(value, definition, location, errors) {
  if (errors.length >= MAX_ERRORS) return;
  if (definition.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      addError(errors, `${location} must be an object`);
      return;
    }
    const properties = definition.properties ?? {};
    if (definition.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(properties, key)) {
          addError(errors, `${location}: contains an unknown field`);
        }
      }
    }
    for (const key of definition.required ?? []) {
      if (!Object.hasOwn(value, key)) {
        addError(errors, `${location}: missing required field \`${key}\``);
      }
    }
    for (const [key, child] of Object.entries(value)) {
      if (properties[key]) {
        validateSchemaValue(child, properties[key], `${location}.${key}`, errors);
      }
    }
  } else if (definition.type === 'array') {
    if (!Array.isArray(value)) {
      addError(errors, `${location} must be an array`);
      return;
    }
    if (definition.minItems != null && value.length < definition.minItems) {
      addError(
        errors,
        `${location} must contain at least ${definition.minItems} items`,
      );
    }
    if (definition.maxItems != null && value.length > definition.maxItems) {
      addError(
        errors,
        `${location} must contain at most ${definition.maxItems} items`,
      );
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
      addError(errors, `${location} must be a safe integer`);
      return;
    }
  } else if (typeof value !== definition.type) {
    addError(
      errors,
      `${location} must be ${definition.type}, received ${printableType(value)}`,
    );
    return;
  }

  if (definition.const !== undefined && value !== definition.const) {
    addError(errors, `${location} must equal its blocked preflight constant`);
  }
  if (definition.enum && !definition.enum.includes(value)) {
    addError(errors, `${location} is not in the allowed enum`);
  }
  if (definition.pattern && typeof value === 'string') {
    if (!new RegExp(definition.pattern, 'u').test(value)) {
      addError(errors, `${location} does not match its public identifier format`);
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

export function validatePackageCanaryPreflight(
  value,
  schema = loadPackageCanaryPreflightSchema(),
) {
  const errors = [];
  validateSchemaValue(value, schema, 'preflight', errors);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return errors;

  if (Array.isArray(value.scenarioMatrix)) {
    const scenarios = value.scenarioMatrix.map((entry) => [
      entry?.scenario,
      entry?.expectedOutcome,
      entry?.executionStatus,
    ]);
    if (
      scenarios.length !== EXPECTED_SCENARIOS.length
      || scenarios.some(
        (entry, index) =>
          entry[0] !== EXPECTED_SCENARIOS[index][0]
          || entry[1] !== EXPECTED_SCENARIOS[index][1]
          || entry[2] !== 'blocked',
      )
    ) {
      addError(
        errors,
        'scenarioMatrix must contain every P5 admission, Provider, Package, trust, and recovery scenario exactly once in order',
      );
    }
  }
  if (!exactArray(value.stopConditions, EXPECTED_STOP_CONDITIONS)) {
    addError(
      errors,
      'stopConditions must preserve every P5 no-authority abort condition in order',
    );
  }
  return errors;
}

async function readPreflightFile(filePath) {
  let stat;
  try {
    stat = await lstat(filePath);
  } catch {
    throw new Error('package canary preflight cannot be inspected');
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('package canary preflight must be a regular file');
  }
  if (stat.size <= 0 || stat.size > MAX_PREFLIGHT_BYTES) {
    throw new Error('package canary preflight size is invalid');
  }
  let document;
  try {
    document = UTF8_DECODER.decode(await readFile(filePath));
  } catch {
    throw new Error(
      'package canary preflight cannot be read as valid UTF-8',
    );
  }
  try {
    if (hasDuplicateJsonObjectKeys(document)) {
      throw new Error(
        'package canary preflight contains duplicate JSON object keys',
      );
    }
  } catch (error) {
    if (
      error instanceof Error
      && error.message.includes('duplicate JSON object keys')
    ) {
      throw error;
    }
    throw new Error('package canary preflight is not valid JSON');
  }
  let value;
  try {
    value = JSON.parse(document);
  } catch {
    throw new Error('package canary preflight is not valid JSON');
  }
  return value;
}

export async function validatePackageCanaryPreflightFile(
  filePath,
  schema = loadPackageCanaryPreflightSchema(),
) {
  const value = await readPreflightFile(filePath);
  const errors = validatePackageCanaryPreflight(value, schema);
  if (errors.length > 0) {
    throw new Error(
      `package canary preflight validation failed:\n- ${errors.join('\n- ')}`,
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
      'usage: node validate-package-canary-preflight.mjs <preflight.json>',
    );
    process.exitCode = 2;
  } else {
    validatePackageCanaryPreflightFile(filePath)
      .then(() => {
        console.log('package canary preflight validation passed');
      })
      .catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      });
  }
}
