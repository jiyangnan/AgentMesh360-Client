import {
  lstat,
  readFile,
} from 'node:fs/promises';
import { TextDecoder } from 'node:util';

const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

function printableType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}
export function hasDuplicateJsonObjectKeys(document) {
  let offset = 0;
  let duplicate = false;

  function assertDocument(condition) {
    if (!condition) throw new Error('invalid JSON document');
  }

  function skipWhitespace() {
    while (/\s/u.test(document[offset] ?? '')) offset += 1;
  }

  function readString() {
    const start = offset;
    assertDocument(document[offset] === '"');
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
    throw new Error('invalid JSON document');
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
      assertDocument(document[offset] === ':');
      offset += 1;
      readValue();
      skipWhitespace();
      if (document[offset] === '}') {
        offset += 1;
        return;
      }
      assertDocument(document[offset] === ',');
      offset += 1;
    }
    throw new Error('invalid JSON document');
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
      assertDocument(document[offset] === ',');
      offset += 1;
    }
    throw new Error('invalid JSON document');
  }

  readValue();
  skipWhitespace();
  assertDocument(offset === document.length);
  return duplicate;
}

export async function readStrictJsonFile(filePath, {
  label = 'JSON input',
  maximumBytes = 256 * 1024,
} = {}) {
  let direct;
  try {
    direct = await lstat(filePath);
  } catch {
    throw new Error(`${label} cannot be inspected`);
  }
  if (
    !direct.isFile()
    || direct.isSymbolicLink()
    || direct.size <= 0
    || direct.size > maximumBytes
  ) {
    throw new Error(`${label} must be a bounded regular non-symlink file`);
  }
  let document;
  try {
    document = UTF8_DECODER.decode(await readFile(filePath));
  } catch {
    throw new Error(`${label} must be valid UTF-8`);
  }
  let value;
  try {
    if (hasDuplicateJsonObjectKeys(document)) {
      throw new Error('duplicate keys');
    }
    value = JSON.parse(document);
  } catch (error) {
    if (error?.message === 'duplicate keys') {
      throw new Error(`${label} contains duplicate JSON object keys`);
    }
    throw new Error(`${label} must be strict valid JSON`);
  }
  return Object.freeze({
    bytes: Buffer.from(document, 'utf8'),
    value,
  });
}

export function validateJsonSchema(value, schema, {
  label = 'document',
  maximumErrors = 64,
} = {}) {
  const errors = [];

  function add(message) {
    if (errors.length < maximumErrors) errors.push(message);
  }

  function validate(child, definition, location) {
    if (!definition || typeof definition !== 'object') {
      add(`${location}: schema definition is invalid`);
      return;
    }
    if (Object.hasOwn(definition, 'const') && child !== definition.const) {
      add(`${location}: value does not match the fixed contract`);
      return;
    }
    if (
      Array.isArray(definition.enum)
      && !definition.enum.some((candidate) => candidate === child)
    ) {
      add(`${location}: value is outside the allowed contract`);
      return;
    }

    if (definition.type === 'object') {
      if (!child || typeof child !== 'object' || Array.isArray(child)) {
        add(`${location}: expected object, got ${printableType(child)}`);
        return;
      }
      const properties = definition.properties ?? {};
      for (const key of definition.required ?? []) {
        if (!Object.hasOwn(child, key)) {
          add(`${location}: missing required field`);
        }
      }
      if (definition.additionalProperties === false) {
        for (const key of Object.keys(child)) {
          if (!Object.hasOwn(properties, key)) {
            add(`${location}: contains unknown field`);
          }
        }
      }
      for (const [key, nested] of Object.entries(child)) {
        if (properties[key]) validate(nested, properties[key], `${location}.${key}`);
      }
      return;
    }

    if (definition.type === 'array') {
      if (!Array.isArray(child)) {
        add(`${location}: expected array, got ${printableType(child)}`);
        return;
      }
      if (definition.minItems != null && child.length < definition.minItems) {
        add(`${location}: array is too short`);
      }
      if (definition.maxItems != null && child.length > definition.maxItems) {
        add(`${location}: array is too long`);
      }
      if (definition.uniqueItems === true) {
        const projected = child.map((item) => JSON.stringify(item));
        if (new Set(projected).size !== projected.length) {
          add(`${location}: array items must be unique`);
        }
      }
      for (const [index, nested] of child.entries()) {
        const nestedDefinition =
          definition.prefixItems?.[index] ?? definition.items;
        if (nestedDefinition === false) {
          add(`${location}: array contains an extra item`);
        } else if (nestedDefinition) {
          validate(nested, nestedDefinition, `${location}[${index}]`);
        }
      }
      return;
    }

    if (definition.type === 'string') {
      if (typeof child !== 'string') {
        add(`${location}: expected string, got ${printableType(child)}`);
        return;
      }
      if (definition.minLength != null && child.length < definition.minLength) {
        add(`${location}: string is too short`);
      }
      if (definition.maxLength != null && child.length > definition.maxLength) {
        add(`${location}: string is too long`);
      }
      if (definition.pattern && !new RegExp(definition.pattern, 'u').test(child)) {
        add(`${location}: string does not match the contract`);
      }
      if (definition.format === 'date-time' && !isStrictDateTime(child)) {
        add(`${location}: date-time is invalid`);
      }
      return;
    }

    if (definition.type === 'integer') {
      if (!Number.isSafeInteger(child)) {
        add(`${location}: expected safe integer, got ${printableType(child)}`);
        return;
      }
      if (definition.minimum != null && child < definition.minimum) {
        add(`${location}: integer is below the minimum`);
      }
      if (definition.maximum != null && child > definition.maximum) {
        add(`${location}: integer is above the maximum`);
      }
      return;
    }

    if (definition.type === 'number') {
      if (typeof child !== 'number' || !Number.isFinite(child)) {
        add(`${location}: expected finite number, got ${printableType(child)}`);
        return;
      }
      if (definition.minimum != null && child < definition.minimum) {
        add(`${location}: number is below the minimum`);
      }
      if (definition.maximum != null && child > definition.maximum) {
        add(`${location}: number is above the maximum`);
      }
      return;
    }

    if (definition.type === 'boolean' && typeof child !== 'boolean') {
      add(`${location}: expected boolean, got ${printableType(child)}`);
    } else if (definition.type === 'null' && child !== null) {
      add(`${location}: expected null, got ${printableType(child)}`);
    }
  }

  validate(value, schema, label);
  return errors;
}

function isStrictDateTime(value) {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)
  ) {
    return false;
  }
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === (
    value.includes('.')
      ? value
      : value.replace(/Z$/u, '.000Z')
  );
}
