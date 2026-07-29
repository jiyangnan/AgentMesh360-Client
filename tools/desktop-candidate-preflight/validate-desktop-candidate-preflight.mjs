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
  '../../schemas/agentmesh360-desktop-candidate-preflight-v1.schema.json',
);
const MAX_PREFLIGHT_BYTES = 128 * 1024;
const MAX_ERRORS = 64;
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

const EXPECTED_SCENARIOS = Object.freeze([
  ['reproducible_candidate_build', 'fixed_commit_version_and_bundle'],
  ['architecture_matrix', 'every_approved_architecture_passes'],
  ['nested_code_signature', 'every_nested_executable_is_valid'],
  ['hardened_runtime', 'enabled_for_all_macos_executables'],
  ['least_privilege_entitlements', 'only_reviewed_runtime_exceptions'],
  ['notarization_acceptance', 'accepted_with_reviewed_log'],
  [
    'staple_and_offline_gatekeeper',
    'ticket_attached_and_offline_accepted',
  ],
  ['clean_install_and_first_launch', 'gatekeeper_accepts_clean_install'],
  [
    'second_launch_and_single_instance',
    'existing_window_restored_without_duplicate_host',
  ],
  ['login_item_registration', 'system_state_matches_user_choice'],
  [
    'background_launch_and_window_restore',
    'background_host_then_visible_window',
  ],
  ['persistent_host_crash_and_restart', 'fixed_main_session_recovers'],
  [
    'normal_and_forced_quit',
    'host_policy_is_bounded_and_recoverable',
  ],
  [
    'signed_update_check_and_download',
    'only_approved_channel_and_artifact',
  ],
  ['tampered_or_unsigned_update', 'rejected_before_install'],
  ['interrupted_update', 'last_known_good_remains_bootable'],
  [
    'version_rollback_and_user_state',
    'approved_rollback_preserves_compatible_state',
  ],
  ['uninstall_cleanup', 'host_and_login_item_removed_by_policy'],
]);

const EXPECTED_STOP_CONDITIONS = Object.freeze([
  'approval_missing',
  'apple_program_membership_unverified',
  'developer_id_certificate_unapproved',
  'notarization_credential_unapproved',
  'candidate_version_or_commit_unfrozen',
  'bundle_architecture_or_macos_floor_unapproved',
  'signing_or_entitlement_plan_unreviewed',
  'update_provider_or_channel_unapproved',
  'rollback_target_unapproved',
  'test_device_or_cohort_unapproved',
  'start_stop_window_unapproved',
  'abort_owner_unapproved',
  'evidence_retention_unapproved',
  'secret_or_identity_in_repository_or_log',
  'unsigned_or_invalid_nested_code',
  'hardened_runtime_or_entitlement_failure',
  'notarization_or_stapling_failure',
  'gatekeeper_assessment_failure',
  'update_authenticity_or_replay_failure',
  'host_or_login_item_recovery_failure',
  'uninstall_or_user_state_policy_unapproved',
  'production_upload_or_external_visibility',
  'scenario_matrix_incomplete',
  'cleanup_failure',
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

function decodeJson(bytes, label) {
  let document;
  try {
    document = UTF8_DECODER.decode(bytes);
  } catch {
    throw new Error(`${label} cannot be read as valid UTF-8`);
  }
  try {
    if (hasDuplicateJsonObjectKeys(document)) {
      throw new Error(`${label} contains duplicate JSON object keys`);
    }
  } catch (error) {
    if (
      error instanceof Error
      && error.message.includes('duplicate JSON object keys')
    ) {
      throw error;
    }
    throw new Error(`${label} is not valid JSON`);
  }
  try {
    return JSON.parse(document);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

function readSchemaFile(filePath) {
  let stat;
  try {
    stat = lstatSync(filePath);
  } catch {
    throw new Error('desktop candidate preflight schema cannot be inspected');
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(
      'desktop candidate preflight schema must be a regular file',
    );
  }
  if (stat.size <= 0 || stat.size > MAX_PREFLIGHT_BYTES) {
    throw new Error('desktop candidate preflight schema size is invalid');
  }
  const schema = decodeJson(
    readFileSync(filePath),
    'desktop candidate preflight schema',
  );
  if (
    schema?.type !== 'object'
    || schema?.additionalProperties !== false
    || !Array.isArray(schema?.required)
    || !schema?.properties
  ) {
    throw new Error(
      'desktop candidate preflight schema is missing strict object constraints',
    );
  }
  return Object.freeze(schema);
}

export function loadDesktopCandidatePreflightSchema(
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
        validateSchemaValue(
          child,
          properties[key],
          `${location}.${key}`,
          errors,
        );
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
      const childDefinition =
        definition.prefixItems?.[index] ?? definition.items;
      if (childDefinition && childDefinition !== false) {
        validateSchemaValue(
          child,
          childDefinition,
          `${location}[${index}]`,
          errors,
        );
      } else if (childDefinition === false) {
        addError(errors, `${location} contains an unexpected item`);
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
  if (definition.pattern && typeof value === 'string') {
    if (!new RegExp(definition.pattern, 'u').test(value)) {
      addError(
        errors,
        `${location} does not match its public identifier format`,
      );
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

function validateRetentionSafety(value, errors, location = 'preflight') {
  if (errors.length >= MAX_ERRORS) return;
  if (Array.isArray(value)) {
    for (const [index, child] of value.entries()) {
      validateRetentionSafety(child, errors, `${location}[${index}]`);
    }
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      validateRetentionSafety(child, errors, `${location}.${key}`);
    }
    return;
  }
  if (typeof value !== 'string') return;
  if (
    /-----BEGIN [A-Z0-9 ]+PRIVATE KEY-----/u.test(value)
    || /https?:\/\//iu.test(value)
    || /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu.test(value)
    || /^(?:\/(?:Users|private|var|tmp)\/|[A-Za-z]:\\)/u.test(value)
    || /^(?!sha256:)[0-9a-f]{64}$/u.test(value)
  ) {
    addError(errors, `${location} contains retention-unsafe content`);
  }
}

export function validateDesktopCandidatePreflight(
  value,
  schema = loadDesktopCandidatePreflightSchema(),
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
        'scenarioMatrix must contain every P6 build, signing, notarization, lifecycle, update, rollback, and uninstall scenario exactly once in order',
      );
    }
  }
  if (!exactArray(value.stopConditions, EXPECTED_STOP_CONDITIONS)) {
    addError(
      errors,
      'stopConditions must preserve every P6 no-authority abort condition in order',
    );
  }
  validateRetentionSafety(value, errors);
  return errors;
}

async function readPreflightFile(filePath) {
  let stat;
  try {
    stat = await lstat(filePath);
  } catch {
    throw new Error('desktop candidate preflight cannot be inspected');
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('desktop candidate preflight must be a regular file');
  }
  if (stat.size <= 0 || stat.size > MAX_PREFLIGHT_BYTES) {
    throw new Error('desktop candidate preflight size is invalid');
  }
  return decodeJson(
    await readFile(filePath),
    'desktop candidate preflight',
  );
}

export async function validateDesktopCandidatePreflightFile(
  filePath,
  schema = loadDesktopCandidatePreflightSchema(),
) {
  const value = await readPreflightFile(filePath);
  const errors = validateDesktopCandidatePreflight(value, schema);
  if (errors.length > 0) {
    throw new Error(
      `desktop candidate preflight validation failed:\n- ${errors.join('\n- ')}`,
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
      'usage: node validate-desktop-candidate-preflight.mjs <preflight.json>',
    );
    process.exitCode = 2;
  } else {
    validateDesktopCandidatePreflightFile(filePath)
      .then(() => {
        console.log('desktop candidate preflight validation passed');
      })
      .catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      });
  }
}
