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
  '../../schemas/agentmesh360-distribution-authorization-v1.schema.json',
);
const MAX_AUTHORIZATION_BYTES = 256 * 1024;
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });
const HOURS_PER_MONTH_FOR_BUDGET = 720;

const RETENTION_UNSAFE_KEY = /^(?:secret|token|privateKey|endpointUrl|resourceId|ipAddress|email|accountId|username|command|localPath|absolutePath)$/u;
const RETENTION_UNSAFE_STRINGS = Object.freeze([
  /https?:\/\//iu,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
  /(?:^|[^0-9])(?:\d{1,3}\.){3}\d{1,3}(?:[^0-9]|$)/u,
  /(?:^|\s)\/(?:Users|private|tmp|var|home)\//u,
  /(?:^|\s)~\//u,
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
  let document;
  try {
    document = UTF8_DECODER.decode(readFileSync(filePath));
  } catch {
    throw new Error(`${label} cannot be read as valid UTF-8`);
  }
  if (hasDuplicateJsonObjectKeys(document)) {
    throw new Error(`${label} contains duplicate JSON object keys`);
  }
  try {
    return JSON.parse(document);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
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
  let document;
  try {
    document = UTF8_DECODER.decode(await readFile(filePath));
  } catch {
    throw new Error(`${label} cannot be read as valid UTF-8`);
  }
  if (hasDuplicateJsonObjectKeys(document)) {
    throw new Error(`${label} contains duplicate JSON object keys`);
  }
  try {
    return JSON.parse(document);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

export function loadDistributionAuthorizationSchema(
  schemaPath = DEFAULT_SCHEMA_PATH,
) {
  const schema = readStrictJsonFileSync(
    schemaPath,
    'distribution authorization schema',
  );
  if (
    schema?.type !== 'object'
    || schema?.additionalProperties !== false
    || !Array.isArray(schema?.required)
    || !schema?.properties
    || !schema?.$defs
  ) {
    throw new Error(
      'distribution authorization schema is missing strict object constraints',
    );
  }
  return Object.freeze(schema);
}

function resolveLocalReference(reference, schema) {
  if (!reference.startsWith('#/')) {
    throw new Error('distribution authorization schema has an external $ref');
  }
  let resolved = schema;
  for (const encodedSegment of reference.slice(2).split('/')) {
    const segment = encodedSegment.replaceAll('~1', '/').replaceAll('~0', '~');
    if (
      !resolved
      || typeof resolved !== 'object'
      || !Object.hasOwn(resolved, segment)
    ) {
      throw new Error('distribution authorization schema has an invalid $ref');
    }
    resolved = resolved[segment];
  }
  return resolved;
}

function mergeDefinitions(base, overlay) {
  const merged = { ...base, ...overlay };
  delete merged.$ref;
  if (base.properties || overlay.properties) {
    merged.properties = {
      ...(base.properties ?? {}),
      ...(overlay.properties ?? {}),
    };
  }
  if (base.required || overlay.required) {
    merged.required = [
      ...new Set([...(base.required ?? []), ...(overlay.required ?? [])]),
    ];
  }
  return merged;
}

function resolveDefinition(definition, schema, seen = new Set()) {
  if (!definition || typeof definition !== 'object' || !definition.$ref) {
    return definition;
  }
  if (seen.has(definition.$ref)) {
    throw new Error('distribution authorization schema has a cyclic $ref');
  }
  const nextSeen = new Set(seen);
  nextSeen.add(definition.$ref);
  const base = resolveDefinition(
    resolveLocalReference(definition.$ref, schema),
    schema,
    nextSeen,
  );
  return mergeDefinitions(base, definition);
}

function validateSchemaValue(value, rawDefinition, schema, location, errors) {
  const definition = resolveDefinition(rawDefinition, schema);
  if (definition === false) {
    errors.push(`${location} is not allowed`);
    return;
  }
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
          schema,
          `${location}.${key}`,
          errors,
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
      const childDefinition = definition.prefixItems?.[index]
        ?? definition.items;
      if (childDefinition === false) {
        errors.push(`${location}[${index}] is not allowed`);
      } else if (childDefinition) {
        validateSchemaValue(
          child,
          childDefinition,
          schema,
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
  } else if (definition.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      errors.push(`${location} must be a finite number`);
      return;
    }
  } else if (typeof value !== definition.type) {
    errors.push(
      `${location} must be ${definition.type}, received ${printableType(value)}`,
    );
    return;
  }

  if (definition.const !== undefined && value !== definition.const) {
    errors.push(`${location} must equal its approved E1 constant`);
  }
  if (definition.enum && !definition.enum.includes(value)) {
    errors.push(`${location} is not in the allowed enum`);
  }
  if (definition.pattern && typeof value === 'string') {
    if (!new RegExp(definition.pattern, 'u').test(value)) {
      errors.push(`${location} does not match its identifier format`);
    }
  }
}

function retentionSafetyErrors(value) {
  const errors = [];

  function visit(current, location) {
    if (Array.isArray(current)) {
      current.forEach((child, index) => visit(child, `${location}[${index}]`));
      return;
    }
    if (current && typeof current === 'object') {
      for (const [key, child] of Object.entries(current)) {
        if (RETENTION_UNSAFE_KEY.test(key)) {
          errors.push(`${location}.${key} uses a retention-unsafe field name`);
        }
        visit(child, `${location}.${key}`);
      }
      return;
    }
    if (
      typeof current === 'string'
      && RETENTION_UNSAFE_STRINGS.some((pattern) => pattern.test(current))
    ) {
      errors.push(`${location} contains retention-unsafe material`);
    }
  }

  visit(value, 'authorization');
  return errors;
}

export function assertDistributionAuthorizationSafeForRetention(value) {
  const errors = retentionSafetyErrors(value);
  if (errors.length > 0) {
    throw new Error(
      `distribution authorization retention safety failed:\n- ${errors.join('\n- ')}`,
    );
  }
}

export function validateDistributionAuthorization(
  value,
  schema = loadDistributionAuthorizationSchema(),
) {
  const errors = [];
  validateSchemaValue(value, schema, schema, 'authorization', errors);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return errors;

  const startsAt = Date.parse(value.authorizationWindow?.startsAt);
  const stopsAt = Date.parse(value.authorizationWindow?.stopsAt);
  const maximumHours = value.authorizationWindow?.maximumHours;
  if (
    !Number.isFinite(startsAt)
    || !Number.isFinite(stopsAt)
    || stopsAt - startsAt !== maximumHours * 60 * 60 * 1000
  ) {
    errors.push('authorizationWindow must be exactly the approved 72 hours');
  }

  const dropletCost = Number(value.budget?.dropletHourlyRate) * maximumHours;
  const spacesCost = Number(value.budget?.spacesMonthlyBase)
    * (maximumHours / HOURS_PER_MONTH_FOR_BUDGET);
  const modeledCost = dropletCost + spacesCost;
  if (
    !Number.isFinite(modeledCost)
    || modeledCost > Number(value.budget?.expectedCost) + 0.000001
  ) {
    errors.push('budget expectedCost is below the approved 72-hour model');
  }
  if (
    Number(value.budget?.expectedCost) > Number(value.budget?.hardCap)
    || Number(value.requestLimits?.maximumCurrencyCost)
      !== Number(value.budget?.hardCap)
  ) {
    errors.push('budget and request hard caps must remain aligned');
  }

  const aliases = value.infrastructurePlan?.objectStorage?.bucketAliases;
  if (Array.isArray(aliases) && new Set(aliases).size !== aliases.length) {
    errors.push('object storage bucket aliases must be unique');
  }

  errors.push(...retentionSafetyErrors(value));
  return errors;
}

export async function validateDistributionAuthorizationFile(
  filePath,
  schema = loadDistributionAuthorizationSchema(),
) {
  const value = await readStrictJsonFile(
    filePath,
    'distribution authorization',
  );
  const errors = validateDistributionAuthorization(value, schema);
  if (errors.length > 0) {
    throw new Error(
      `distribution authorization validation failed:\n- ${errors.join('\n- ')}`,
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
      'usage: node validate-distribution-authorization.mjs <authorization.json>',
    );
    process.exitCode = 2;
  } else {
    validateDistributionAuthorizationFile(filePath)
      .then(() => {
        console.log('P4 E1 distribution authorization valid');
      })
      .catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      });
  }
}
