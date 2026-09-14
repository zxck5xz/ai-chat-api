// Project 19: JSON Schema validator — dependency-free subset of draft 2020-12
//
// Why hand-rolled: the Worker bundle stays small, and every error carries the
// keyword + path + expected/received triple that the repair prompt needs.

import type { JsonSchema, JsonSchemaType, ValidationError, ValidationResult } from '../../types/structured-output';

const FORMAT_PATTERNS: Record<string, RegExp> = {
  email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
  uri: /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s]+$/,
  uuid: /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/,
  date: /^\d{4}-\d{2}-\d{2}$/,
  'date-time': /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}/,
};

function typeOf(value: unknown): JsonSchemaType {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  if (typeof value === 'string') return 'string';
  if (typeof value === 'boolean') return 'boolean';
  return 'object';
}

function matchesType(value: unknown, expected: JsonSchemaType): boolean {
  const actual = typeOf(value);
  // An integer is a valid number, but not the reverse.
  if (expected === 'number') return actual === 'number' || actual === 'integer';
  return actual === expected;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a as object);
    const kb = Object.keys(b as object);
    if (ka.length !== kb.length) return false;
    return ka.every((k) =>
      deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])
    );
  }
  return false;
}

function err(
  path: string,
  keyword: string,
  message: string,
  expected?: unknown,
  received?: unknown
): ValidationError {
  return { path, keyword, message, expected, received };
}

function truncate(value: unknown): unknown {
  if (typeof value === 'string' && value.length > 120) return `${value.slice(0, 117)}...`;
  if (Array.isArray(value)) return `[array of ${value.length}]`;
  if (value !== null && typeof value === 'object') return `{object with ${Object.keys(value).length} keys}`;
  return value;
}

function validateNode(value: unknown, schema: JsonSchema, path: string): ValidationError[] {
  const errors: ValidationError[] = [];

  // nullable is a convenience shorthand — treat null as always acceptable
  if (schema.nullable && value === null) return errors;

  // const / enum short-circuit the rest: they pin the value exactly
  if ('const' in schema && schema.const !== undefined) {
    if (!deepEqual(value, schema.const)) {
      errors.push(err(path, 'const', `must equal ${JSON.stringify(schema.const)}`, schema.const, truncate(value)));
    }
    return errors;
  }

  if (schema.enum) {
    if (!schema.enum.some((allowed) => deepEqual(value, allowed))) {
      errors.push(
        err(path, 'enum', `must be one of ${JSON.stringify(schema.enum)}`, schema.enum, truncate(value))
      );
      return errors;
    }
  }

  if (schema.anyOf) {
    const branchErrors = schema.anyOf.map((sub) => validateNode(value, sub, path));
    if (branchErrors.every((e) => e.length > 0)) {
      errors.push(
        err(path, 'anyOf', `does not match any of the ${schema.anyOf.length} allowed shapes`, undefined, truncate(value))
      );
      // Surface the closest branch so the repair prompt stays actionable
      const closest = branchErrors.reduce((best, e) => (e.length < best.length ? e : best));
      errors.push(...closest);
    }
    return errors;
  }

  if (schema.oneOf) {
    const passing = schema.oneOf.filter((sub) => validateNode(value, sub, path).length === 0);
    if (passing.length !== 1) {
      errors.push(
        err(
          path,
          'oneOf',
          `must match exactly one allowed shape (matched ${passing.length})`,
          undefined,
          truncate(value)
        )
      );
    }
    return errors;
  }

  if (schema.type) {
    const allowed = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!allowed.some((t) => matchesType(value, t))) {
      errors.push(
        err(path, 'type', `must be ${allowed.join(' or ')}, got ${typeOf(value)}`, allowed.join('|'), typeOf(value))
      );
      // Type is wrong — deeper keyword checks would only produce noise
      return errors;
    }
  }

  const actual = typeOf(value);

  if (actual === 'object') {
    errors.push(...validateObject(value as Record<string, unknown>, schema, path));
  } else if (actual === 'array') {
    errors.push(...validateArray(value as unknown[], schema, path));
  } else if (actual === 'string') {
    errors.push(...validateString(value as string, schema, path));
  } else if (actual === 'number' || actual === 'integer') {
    errors.push(...validateNumber(value as number, schema, path));
  }

  return errors;
}

function validateObject(
  value: Record<string, unknown>,
  schema: JsonSchema,
  path: string
): ValidationError[] {
  const errors: ValidationError[] = [];

  for (const key of schema.required ?? []) {
    if (!(key in value) || value[key] === undefined) {
      errors.push(err(`${path}/${key}`, 'required', `missing required property "${key}"`, key, undefined));
    }
  }

  if (schema.properties) {
    for (const [key, subSchema] of Object.entries(schema.properties)) {
      if (key in value && value[key] !== undefined) {
        errors.push(...validateNode(value[key], subSchema, `${path}/${key}`));
      }
    }
  }

  if (schema.additionalProperties !== undefined && schema.properties) {
    const known = new Set(Object.keys(schema.properties));
    const extras = Object.keys(value).filter((k) => !known.has(k));

    if (schema.additionalProperties === false) {
      for (const extra of extras) {
        errors.push(
          err(`${path}/${extra}`, 'additionalProperties', `unexpected property "${extra}"`, undefined, extra)
        );
      }
    } else if (typeof schema.additionalProperties === 'object') {
      for (const extra of extras) {
        errors.push(...validateNode(value[extra], schema.additionalProperties, `${path}/${extra}`));
      }
    }
  }

  return errors;
}

function validateArray(value: unknown[], schema: JsonSchema, path: string): ValidationError[] {
  const errors: ValidationError[] = [];

  if (schema.minItems !== undefined && value.length < schema.minItems) {
    errors.push(err(path, 'minItems', `must have at least ${schema.minItems} items, got ${value.length}`, schema.minItems, value.length));
  }
  if (schema.maxItems !== undefined && value.length > schema.maxItems) {
    errors.push(err(path, 'maxItems', `must have at most ${schema.maxItems} items, got ${value.length}`, schema.maxItems, value.length));
  }
  if (schema.uniqueItems) {
    const seen: unknown[] = [];
    for (const item of value) {
      if (seen.some((s) => deepEqual(s, item))) {
        errors.push(err(path, 'uniqueItems', 'items must be unique', undefined, truncate(item)));
        break;
      }
      seen.push(item);
    }
  }
  if (schema.items) {
    value.forEach((item, i) => {
      errors.push(...validateNode(item, schema.items as JsonSchema, `${path}/${i}`));
    });
  }

  return errors;
}

function validateString(value: string, schema: JsonSchema, path: string): ValidationError[] {
  const errors: ValidationError[] = [];

  if (schema.minLength !== undefined && value.length < schema.minLength) {
    errors.push(err(path, 'minLength', `must be at least ${schema.minLength} characters, got ${value.length}`, schema.minLength, value.length));
  }
  if (schema.maxLength !== undefined && value.length > schema.maxLength) {
    errors.push(err(path, 'maxLength', `must be at most ${schema.maxLength} characters, got ${value.length}`, schema.maxLength, value.length));
  }
  if (schema.pattern) {
    try {
      if (!new RegExp(schema.pattern).test(value)) {
        errors.push(err(path, 'pattern', `must match pattern ${schema.pattern}`, schema.pattern, truncate(value)));
      }
    } catch {
      // An unparseable pattern is a schema authoring bug, not a data problem
      errors.push(err(path, 'pattern', `schema has invalid regex: ${schema.pattern}`, schema.pattern, undefined));
    }
  }
  if (schema.format) {
    const re = FORMAT_PATTERNS[schema.format];
    if (re && !re.test(value)) {
      errors.push(err(path, 'format', `must be a valid ${schema.format}`, schema.format, truncate(value)));
    }
  }

  return errors;
}

function validateNumber(value: number, schema: JsonSchema, path: string): ValidationError[] {
  const errors: ValidationError[] = [];

  if (schema.minimum !== undefined && value < schema.minimum) {
    errors.push(err(path, 'minimum', `must be >= ${schema.minimum}, got ${value}`, schema.minimum, value));
  }
  if (schema.maximum !== undefined && value > schema.maximum) {
    errors.push(err(path, 'maximum', `must be <= ${schema.maximum}, got ${value}`, schema.maximum, value));
  }
  if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) {
    errors.push(err(path, 'exclusiveMinimum', `must be > ${schema.exclusiveMinimum}, got ${value}`, schema.exclusiveMinimum, value));
  }
  if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) {
    errors.push(err(path, 'exclusiveMaximum', `must be < ${schema.exclusiveMaximum}, got ${value}`, schema.exclusiveMaximum, value));
  }
  if (schema.multipleOf !== undefined && schema.multipleOf > 0) {
    const ratio = value / schema.multipleOf;
    if (Math.abs(ratio - Math.round(ratio)) > 1e-9) {
      errors.push(err(path, 'multipleOf', `must be a multiple of ${schema.multipleOf}, got ${value}`, schema.multipleOf, value));
    }
  }

  return errors;
}

/** Validate a parsed value against a schema. */
export function validate<T = unknown>(value: unknown, schema: JsonSchema): ValidationResult<T> {
  const errors = validateNode(value, schema, '');
  return errors.length === 0
    ? { valid: true, errors: [], value: value as T }
    : { valid: false, errors };
}

/**
 * Human-readable error list for logs and repair prompts.
 * One line per error, root path rendered as "(root)".
 */
export function formatErrors(errors: ValidationError[]): string {
  return errors
    .map((e) => `- ${e.path || '(root)'}: ${e.message} [${e.keyword}]`)
    .join('\n');
}

/** Reject schemas the validator cannot enforce, before they reach the LLM. */
export function validateSchema(schema: unknown): ValidationResult<JsonSchema> {
  const errors: ValidationError[] = [];

  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    return { valid: false, errors: [err('', 'type', 'schema must be an object', 'object', typeOf(schema))] };
  }

  const s = schema as JsonSchema;
  const KNOWN_TYPES: JsonSchemaType[] = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'];

  const walk = (node: JsonSchema, path: string) => {
    if (node.type) {
      const types = Array.isArray(node.type) ? node.type : [node.type];
      for (const t of types) {
        if (!KNOWN_TYPES.includes(t)) {
          errors.push(err(path, 'type', `unsupported type "${t}"`, KNOWN_TYPES.join('|'), t));
        }
      }
    }
    if (node.pattern) {
      try {
        new RegExp(node.pattern);
      } catch {
        errors.push(err(path, 'pattern', `invalid regex: ${node.pattern}`, undefined, node.pattern));
      }
    }
    if (node.properties) {
      for (const [key, sub] of Object.entries(node.properties)) walk(sub, `${path}/${key}`);
    }
    if (node.items) walk(node.items, `${path}/items`);
    for (const sub of node.anyOf ?? []) walk(sub, `${path}/anyOf`);
    for (const sub of node.oneOf ?? []) walk(sub, `${path}/oneOf`);
  };

  walk(s, '');

  return errors.length === 0 ? { valid: true, errors: [], value: s } : { valid: false, errors };
}
