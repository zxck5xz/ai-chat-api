import { describe, expect, it } from 'vitest';
import { formatErrors, validate, validateSchema } from './validator';
import type { JsonSchema } from '../../types/structured-output';

const personSchema: JsonSchema = {
  type: 'object',
  properties: {
    name: { type: 'string', minLength: 1 },
    age: { type: 'integer', minimum: 0, maximum: 150 },
    email: { type: 'string', format: 'email' },
    role: { type: 'string', enum: ['admin', 'user', 'guest'] },
    tags: { type: 'array', items: { type: 'string' }, maxItems: 3 },
  },
  required: ['name', 'age'],
  additionalProperties: false,
};

describe('validate', () => {
  it('accepts a conforming object', () => {
    const result = validate({ name: 'Van', age: 30, role: 'admin' }, personSchema);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('reports every missing required property', () => {
    const result = validate({}, personSchema);
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(2);
    expect(result.errors.map((e) => e.keyword)).toEqual(['required', 'required']);
    expect(result.errors.map((e) => e.path)).toEqual(['/name', '/age']);
  });

  it('rejects a wrong type and names both expected and received', () => {
    const result = validate({ name: 42, age: 30 }, personSchema);
    expect(result.valid).toBe(false);
    const error = result.errors.find((e) => e.path === '/name');
    expect(error?.keyword).toBe('type');
    expect(error?.received).toBe('integer');
  });

  it('treats an integer as a valid number but not the reverse', () => {
    expect(validate(5, { type: 'number' }).valid).toBe(true);
    expect(validate(5.5, { type: 'integer' }).valid).toBe(false);
  });

  it('enforces numeric ranges', () => {
    const result = validate({ name: 'Van', age: 200 }, personSchema);
    expect(result.valid).toBe(false);
    expect(result.errors[0].keyword).toBe('maximum');
  });

  it('enforces enum membership', () => {
    const result = validate({ name: 'Van', age: 30, role: 'superuser' }, personSchema);
    expect(result.valid).toBe(false);
    expect(result.errors[0].keyword).toBe('enum');
  });

  it('enforces string format', () => {
    const result = validate({ name: 'Van', age: 30, email: 'not-an-email' }, personSchema);
    expect(result.valid).toBe(false);
    expect(result.errors[0].keyword).toBe('format');
  });

  it('rejects unexpected properties when additionalProperties is false', () => {
    const result = validate({ name: 'Van', age: 30, hacked: true }, personSchema);
    expect(result.valid).toBe(false);
    expect(result.errors[0].keyword).toBe('additionalProperties');
  });

  it('validates nested array items with indexed paths', () => {
    const result = validate({ name: 'Van', age: 30, tags: ['a', 5, 'c'] }, personSchema);
    expect(result.valid).toBe(false);
    expect(result.errors[0].path).toBe('/tags/1');
  });

  it('enforces maxItems', () => {
    const result = validate({ name: 'Van', age: 30, tags: ['a', 'b', 'c', 'd'] }, personSchema);
    expect(result.valid).toBe(false);
    expect(result.errors[0].keyword).toBe('maxItems');
  });

  it('honours nullable for explicit nulls', () => {
    const schema: JsonSchema = { type: 'string', nullable: true };
    expect(validate(null, schema).valid).toBe(true);
    expect(validate(42, schema).valid).toBe(false);
  });

  it('accepts a value matching any anyOf branch', () => {
    const schema: JsonSchema = { anyOf: [{ type: 'string' }, { type: 'integer' }] };
    expect(validate('hello', schema).valid).toBe(true);
    expect(validate(7, schema).valid).toBe(true);
    expect(validate(true, schema).valid).toBe(false);
  });

  it('requires exactly one match for oneOf', () => {
    const schema: JsonSchema = {
      oneOf: [{ type: 'integer', minimum: 0 }, { type: 'integer', maximum: 10 }],
    };
    // 5 matches both branches, so oneOf fails
    expect(validate(5, schema).valid).toBe(false);
    // -3 matches only the second
    expect(validate(-3, schema).valid).toBe(true);
  });

  it('validates deeply nested structures', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: { price: { type: 'number', minimum: 0 } },
            required: ['price'],
          },
        },
      },
    };

    const result = validate({ items: [{ price: 10 }, { price: -5 }] }, schema);
    expect(result.valid).toBe(false);
    expect(result.errors[0].path).toBe('/items/1/price');
    expect(result.errors[0].keyword).toBe('minimum');
  });

  it('enforces multipleOf without floating point false negatives', () => {
    expect(validate(0.3, { type: 'number', multipleOf: 0.1 }).valid).toBe(true);
    expect(validate(0.35, { type: 'number', multipleOf: 0.1 }).valid).toBe(false);
  });
});

describe('formatErrors', () => {
  it('renders the root path as (root)', () => {
    const result = validate('nope', { type: 'object' });
    expect(formatErrors(result.errors)).toContain('(root)');
  });

  it('renders one line per error', () => {
    const result = validate({}, personSchema);
    expect(formatErrors(result.errors).split('\n')).toHaveLength(2);
  });
});

describe('validateSchema', () => {
  it('accepts a well-formed schema', () => {
    expect(validateSchema(personSchema).valid).toBe(true);
  });

  it('rejects a non-object schema', () => {
    expect(validateSchema('string').valid).toBe(false);
    expect(validateSchema(null).valid).toBe(false);
  });

  it('rejects an unsupported type', () => {
    const result = validateSchema({ type: 'function' });
    expect(result.valid).toBe(false);
    expect(result.errors[0].keyword).toBe('type');
  });

  it('rejects an invalid regex pattern', () => {
    const result = validateSchema({ type: 'string', pattern: '[unclosed' });
    expect(result.valid).toBe(false);
    expect(result.errors[0].keyword).toBe('pattern');
  });

  it('walks into nested properties', () => {
    const result = validateSchema({
      type: 'object',
      properties: { inner: { type: 'nonsense' } },
    });
    expect(result.valid).toBe(false);
    expect(result.errors[0].path).toBe('/inner');
  });
});
