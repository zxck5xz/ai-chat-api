// Project 19: Structured Output Validation — API Routes

import { Hono } from 'hono';
import type { Env } from '../types';
import type { JsonSchema } from '../types/structured-output';
import { SchemaStore, StructuredClient, validate, validateSchema, extractJson } from '../services/structured-output';

const router = new Hono<{ Bindings: Env }>();

// ---- Schema registry ----

// List latest version of every schema
router.get('/schemas', async (c) => {
  if (!c.env.DB) return c.json({ error: 'Database not configured' }, 500);

  const store = new SchemaStore(c.env.DB);
  const schemas = await store.list();

  return c.json({ schemas, total: schemas.length });
});

// Register a schema (bumps version when the name exists)
router.post('/schemas', async (c) => {
  if (!c.env.DB) return c.json({ error: 'Database not configured' }, 500);

  const body = await c.req.json<{ name: string; schema: JsonSchema; description?: string }>();
  const { name, schema, description } = body;

  if (!name || name.trim().length === 0) {
    return c.json({ error: 'Schema name is required' }, 400);
  }
  if (!schema) {
    return c.json({ error: 'Schema body is required' }, 400);
  }

  // Reject unenforceable schemas here rather than at generation time
  const check = validateSchema(schema);
  if (!check.valid) {
    return c.json({ error: 'Invalid schema', errors: check.errors }, 400);
  }

  const store = new SchemaStore(c.env.DB);
  const record = await store.save(name.trim(), schema, description);

  return c.json({ schema: record }, 201);
});

// Latest version of one schema
router.get('/schemas/:name', async (c) => {
  if (!c.env.DB) return c.json({ error: 'Database not configured' }, 500);

  const store = new SchemaStore(c.env.DB);
  const record = await store.getLatest(c.req.param('name'));

  if (!record) return c.json({ error: 'Schema not found' }, 404);
  return c.json({ schema: record });
});

// All versions of one schema
router.get('/schemas/:name/versions', async (c) => {
  if (!c.env.DB) return c.json({ error: 'Database not configured' }, 500);

  const store = new SchemaStore(c.env.DB);
  const versions = await store.listVersions(c.req.param('name'));

  if (versions.length === 0) return c.json({ error: 'Schema not found' }, 404);
  return c.json({ versions, total: versions.length });
});

router.delete('/schemas/:name', async (c) => {
  if (!c.env.DB) return c.json({ error: 'Database not configured' }, 500);

  const store = new SchemaStore(c.env.DB);
  const deleted = await store.remove(c.req.param('name'));

  if (deleted === 0) return c.json({ error: 'Schema not found' }, 404);
  return c.json({ deleted });
});

// ---- Validation (no LLM call) ----

// Validate a value against an inline schema or a registered one
router.post('/validate', async (c) => {
  const body = await c.req.json<{ value: unknown; schema?: JsonSchema; schemaName?: string }>();
  const { value, schemaName } = body;
  let schema = body.schema;

  if (!schema && schemaName) {
    if (!c.env.DB) return c.json({ error: 'Database not configured' }, 500);
    const store = new SchemaStore(c.env.DB);
    const record = await store.getLatest(schemaName);
    if (!record) return c.json({ error: `Schema not found: ${schemaName}` }, 404);
    schema = record.schema;
  }

  if (!schema) {
    return c.json({ error: 'Either "schema" or "schemaName" is required' }, 400);
  }

  const result = validate(value, schema);
  return c.json({ valid: result.valid, errors: result.errors });
});

// Extract JSON from raw text — useful for debugging a model's output
router.post('/extract', async (c) => {
  const body = await c.req.json<{ text: string }>();

  if (typeof body.text !== 'string') {
    return c.json({ error: 'Field "text" is required' }, 400);
  }

  const result = extractJson(body.text);
  return c.json({
    found: result.value !== null,
    strategy: result.strategy,
    repairs: result.repairs,
    raw: result.raw,
    value: result.value,
  });
});

// Check that a schema itself is well-formed
router.post('/validate-schema', async (c) => {
  const body = await c.req.json<{ schema: unknown }>();
  const result = validateSchema(body.schema);

  return c.json({ valid: result.valid, errors: result.errors });
});

// ---- Generation with auto-retry ----

router.post('/generate', async (c) => {
  if (!c.env.GEMINI_API_KEY) return c.json({ error: 'Gemini API key not configured' }, 500);

  const body = await c.req.json<{
    prompt: string;
    schema?: JsonSchema;
    schemaName?: string;
    maxAttempts?: number;
    temperature?: number;
    systemPrompt?: string;
    model?: string;
  }>();

  const { prompt, schemaName, maxAttempts, temperature, systemPrompt, model } = body;
  let schema = body.schema;

  if (!prompt || prompt.trim().length === 0) {
    return c.json({ error: 'Prompt is required' }, 400);
  }

  if (!schema && schemaName) {
    if (!c.env.DB) return c.json({ error: 'Database not configured' }, 500);
    const store = new SchemaStore(c.env.DB);
    const record = await store.getLatest(schemaName);
    if (!record) return c.json({ error: `Schema not found: ${schemaName}` }, 404);
    schema = record.schema;
  }

  if (!schema) {
    return c.json({ error: 'Either "schema" or "schemaName" is required' }, 400);
  }

  const schemaCheck = validateSchema(schema);
  if (!schemaCheck.valid) {
    return c.json({ error: 'Invalid schema', errors: schemaCheck.errors }, 400);
  }

  const client = new StructuredClient(c.env.GEMINI_API_KEY);
  const result = await client.generate(prompt, schema, {
    maxAttempts,
    temperature,
    systemPrompt,
    model,
    schemaName,
  });

  // Logging is best-effort: a metrics write must not fail the generation
  if (c.env.DB) {
    try {
      const store = new SchemaStore(c.env.DB);
      await store.logGeneration(prompt, result);
    } catch (error) {
      console.error('Failed to log generation:', error);
    }
  }

  return c.json({ result }, result.success ? 200 : 422);
});

// ---- Metrics ----

router.get('/generations', async (c) => {
  if (!c.env.DB) return c.json({ error: 'Database not configured' }, 500);

  const limit = parseInt(c.req.query('limit') || '20');
  const offset = parseInt(c.req.query('offset') || '0');

  const store = new SchemaStore(c.env.DB);
  const { generations, total } = await store.listGenerations(limit, offset);

  return c.json({ generations, total, limit, offset });
});

router.get('/metrics', async (c) => {
  if (!c.env.DB) return c.json({ error: 'Database not configured' }, 500);

  const store = new SchemaStore(c.env.DB);
  const metrics = await store.getMetrics();

  return c.json({ metrics });
});

router.get('/health', (c) => {
  return c.json({ status: 'ok', service: 'structured-output' });
});

export default router;
