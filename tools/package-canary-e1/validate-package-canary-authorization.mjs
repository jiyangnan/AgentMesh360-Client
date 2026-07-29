#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { TextDecoder } from 'node:util';
import { fileURLToPath } from 'node:url';

const MODULE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(MODULE_DIRECTORY, '../..');
const V1_SCHEMA_PATH = path.join(
  REPOSITORY_ROOT,
  'schemas/agentmesh360-package-canary-authorization-v1.schema.json',
);
const V2_SCHEMA_PATH = path.join(
  REPOSITORY_ROOT,
  'schemas/agentmesh360-package-canary-authorization-v2.schema.json',
);
const PREFLIGHT_PATH = path.join(
  REPOSITORY_ROOT,
  'docs/templates/package-canary-preflight-v1.json',
);
const P4_AUTHORIZATION_PATH = path.join(
  REPOSITORY_ROOT,
  'docs/operations/tabletops/2026-07-28-p4-distribution-e1-authorization.json',
);
const P4_ACCEPTANCE_PATH = path.join(
  REPOSITORY_ROOT,
  'docs/operations/tabletops/2026-07-28-p4-distribution-e1-acceptance.json',
);
const PRIOR_AUTHORIZATION_PATH = path.join(
  REPOSITORY_ROOT,
  'docs/operations/tabletops/2026-07-29-p5-package-canary-e1-authorization.json',
);
const PRIOR_ABORT_PATH = path.join(
  REPOSITORY_ROOT,
  'docs/operations/tabletops/2026-07-29-p5-e1-abort.json',
);
const MAX_AUTHORIZATION_BYTES = 256 * 1024;
const MAX_ERRORS = 64;
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });
const EXPECTED_ROLES = Object.freeze([
  'release_owner',
  'canary_operator',
  'abort_owner',
]);
const RETENTION_UNSAFE_KEY =
  /^(?:secret|token|privateKey|endpointUrl|resourceId|ipAddress|email|accountId|username|command|localPath|absolutePath)$/u;
const RETENTION_UNSAFE_STRINGS = Object.freeze([
  /https?:\/\//iu,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
  /(?:^|[^0-9])(?:\d{1,3}\.){3}\d{1,3}(?:[^0-9]|$)/u,
  /(?:^|\s)\/(?:Users|private|tmp|var|home)\//u,
  /(?:^|\s)~\//u,
]);

function addError(errors, message) {
  if (errors.length < MAX_ERRORS) errors.push(message);
}

function printableType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

function typedSha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
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

function decodeStrictJson(bytes, label) {
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

function readStrictJsonFileSync(filePath, label) {
  let stat;
  try {
    stat = lstatSync(filePath);
  } catch {
    throw new Error(`${label} cannot be inspected`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a regular file`);
  }
  if (stat.size <= 0 || stat.size > MAX_AUTHORIZATION_BYTES) {
    throw new Error(`${label} size is invalid`);
  }
  return decodeStrictJson(readFileSync(filePath), label);
}

async function readStrictJsonFile(filePath, label) {
  let stat;
  try {
    stat = await lstat(filePath);
  } catch {
    throw new Error(`${label} cannot be inspected`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a regular file`);
  }
  if (stat.size <= 0 || stat.size > MAX_AUTHORIZATION_BYTES) {
    throw new Error(`${label} size is invalid`);
  }
  return decodeStrictJson(await readFile(filePath), label);
}

export function loadPackageCanaryAuthorizationSchema(
  schemaPath = V1_SCHEMA_PATH,
) {
  const schema = readStrictJsonFileSync(
    schemaPath,
    'package canary authorization schema',
  );
  if (
    schema?.type !== 'object'
    || schema?.additionalProperties !== false
    || !Array.isArray(schema?.required)
    || !schema?.properties
  ) {
    throw new Error(
      'package canary authorization schema is missing strict object constraints',
    );
  }
  return Object.freeze(schema);
}

function schemaForAuthorization(value) {
  if (value?.schemaVersion === 1) {
    return loadPackageCanaryAuthorizationSchema(V1_SCHEMA_PATH);
  }
  if (value?.schemaVersion === 2) {
    return loadPackageCanaryAuthorizationSchema(V2_SCHEMA_PATH);
  }
  throw new Error('package canary authorization schema version is unsupported');
}

function validateSchemaValue(value, definition, location, errors) {
  if (errors.length >= MAX_ERRORS) return;
  if (definition === false) {
    addError(errors, `${location} is not allowed`);
    return;
  }
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
      if (childDefinition !== undefined) {
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
  } else if (definition.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      addError(errors, `${location} must be a finite number`);
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
    addError(errors, `${location} must equal its approved E1 constant`);
  }
}

function retentionSafetyErrors(value) {
  const errors = [];

  function visit(current, location) {
    if (errors.length >= MAX_ERRORS) return;
    if (Array.isArray(current)) {
      current.forEach((child, index) => visit(child, `${location}[${index}]`));
      return;
    }
    if (current && typeof current === 'object') {
      for (const [key, child] of Object.entries(current)) {
        if (RETENTION_UNSAFE_KEY.test(key)) {
          addError(errors, `${location} contains a retention-unsafe field`);
        }
        visit(child, `${location}.${key}`);
      }
      return;
    }
    if (typeof current !== 'string') return;
    if (RETENTION_UNSAFE_STRINGS.some((pattern) => pattern.test(current))) {
      addError(errors, `${location} contains retention-unsafe content`);
    }
  }

  visit(value, 'authorization');
  return errors;
}

function exactArray(values, expected) {
  return (
    Array.isArray(values)
    && values.length === expected.length
    && values.every((value, index) => value === expected[index])
  );
}

function inputBindingErrors(value) {
  const errors = [];
  const bindings = [
    [
      value.executionFreeze?.preflightSha256,
      typedSha256(readFileSync(PREFLIGHT_PATH)),
      'executionFreeze.preflightSha256',
    ],
    [
      value.executionFreeze?.p4AcceptanceSha256,
      typedSha256(readFileSync(P4_ACCEPTANCE_PATH)),
      'executionFreeze.p4AcceptanceSha256',
    ],
    [
      value.releaseChain?.p4AuthorizationSha256,
      typedSha256(readFileSync(P4_AUTHORIZATION_PATH)),
      'releaseChain.p4AuthorizationSha256',
    ],
  ];
  if (value.schemaVersion === 2) {
    bindings.push(
      [
        value.authorizationHistory?.supersedesAuthorizationSha256,
        typedSha256(readFileSync(PRIOR_AUTHORIZATION_PATH)),
        'authorizationHistory.supersedesAuthorizationSha256',
      ],
      [
        value.authorizationHistory?.supersedesAbortSha256,
        typedSha256(readFileSync(PRIOR_ABORT_PATH)),
        'authorizationHistory.supersedesAbortSha256',
      ],
    );
  }
  for (const [actual, expected, field] of bindings) {
    if (actual !== expected) {
      addError(errors, `${field} does not bind the retained evidence bytes`);
    }
  }
  return errors;
}

export function validatePackageCanaryAuthorization(
  value,
  schema,
) {
  const errors = [];
  let effectiveSchema = schema;
  if (!effectiveSchema) {
    try {
      effectiveSchema = schemaForAuthorization(value);
    } catch (error) {
      addError(
        errors,
        error instanceof Error ? error.message : String(error),
      );
      return errors;
    }
  }
  validateSchemaValue(value, effectiveSchema, 'authorization', errors);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return errors;

  const startsAt = Date.parse(value.authorizationWindow?.startsAt);
  const stopsAt = Date.parse(value.authorizationWindow?.stopsAt);
  if (
    !Number.isFinite(startsAt)
    || !Number.isFinite(stopsAt)
    || stopsAt - startsAt !== 72 * 60 * 60 * 1000
  ) {
    addError(errors, 'authorizationWindow must be exactly 72 hours');
  }
  if (
    value.providerPlan?.maximumInferenceRequests
      !== value.requestLimits?.maximumProviderInferenceRequests
    || value.providerPlan?.maximumProviderCostUsd
      !== value.requestLimits?.maximumProviderCostUsd
    || value.providerPlan?.maximumAgentMeshCredits !== 0
    || value.subscriptionPlan?.maximumAgentMeshCredits !== 0
    || value.requestLimits?.maximumAgentMeshCredits !== 0
  ) {
    addError(errors, 'Provider request, cost, and zero-credit limits must agree');
  }
  if (
    value.infrastructurePlan?.hardCapUsd
      !== value.requestLimits?.maximumInfrastructureCostUsd
    || value.requestLimits?.maximumCombinedCostUsd
      !== value.requestLimits?.maximumProviderCostUsd
        + value.requestLimits?.maximumInfrastructureCostUsd
  ) {
    addError(errors, 'infrastructure and combined budget caps must agree');
  }
  if (!exactArray(value.roleAliases, EXPECTED_ROLES)) {
    addError(errors, 'roleAliases must contain the three approved aliases in order');
  }
  errors.push(...inputBindingErrors(value).slice(0, MAX_ERRORS - errors.length));
  errors.push(
    ...retentionSafetyErrors(value).slice(0, MAX_ERRORS - errors.length),
  );
  return errors;
}

export async function validatePackageCanaryAuthorizationFile(
  filePath,
  schema,
) {
  const value = await readStrictJsonFile(
    filePath,
    'package canary authorization',
  );
  const errors = validatePackageCanaryAuthorization(value, schema);
  if (errors.length > 0) {
    throw new Error(
      `package canary authorization validation failed:\n- ${errors.join('\n- ')}`,
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
      'usage: node validate-package-canary-authorization.mjs <authorization.json>',
    );
    process.exitCode = 2;
  } else {
    validatePackageCanaryAuthorizationFile(filePath)
      .then(() => {
        console.log('package canary authorization validation passed');
      })
      .catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      });
  }
}
