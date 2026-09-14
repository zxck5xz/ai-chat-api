// Project 19: Agent-as-a-Service — management + metered agent endpoints.
//
// Management routes (/tenants, /keys) sit behind the platform's own admin key.
// Metered routes (/v1/*) are the product surface: they authenticate a tenant
// API key, enforce rate limit and quota, then bill the request.

import { Hono } from 'hono';
import type { Env } from '../types';
import type { JsonSchema } from '../types/structured-output';
import type { AaasVariables, Scope, Tier } from '../types/aaas';
import { ApiKeyStore } from '../services/aaas/api-keys';
import { RateLimiter } from '../services/aaas/rate-limiter';
import { UsageMeter, monthBounds } from '../services/aaas/metering';
import { BillingHooks, generateInvoice } from '../services/aaas/billing';
import { ALL_SCOPES, TIERS, getTierLimits, isValidScope, isValidTier } from '../services/aaas/tiers';
import { SchemaStore, StructuredClient, validateSchema } from '../services/structured-output';
import { getAuth, meterRequest, tenantAuth } from '../middleware/tenant-auth';

const router = new Hono<{ Bindings: Env; Variables: AaasVariables }>();

// ---- Public catalog ----

router.get('/tiers', (c) => {
  return c.json({ tiers: Object.values(TIERS), scopes: ALL_SCOPES });
});

router.get('/health', (c) => {
  return c.json({ status: 'ok', service: 'aaas' });
});

// ---- Tenant management ----

router.post('/tenants', async (c) => {
  if (!c.env.DB) return c.json({ error: 'Database not configured' }, 500);

  const body = await c.req.json<{ name: string; email?: string; tier?: string }>();

  if (!body.name || body.name.trim().length === 0) {
    return c.json({ error: 'Tenant name is required' }, 400);
  }
  if (body.tier && !isValidTier(body.tier)) {
    return c.json({ error: `Invalid tier: ${body.tier}` }, 400);
  }

  const store = new ApiKeyStore(c.env.DB);
  const tenant = await store.createTenant(body.name.trim(), body.email, (body.tier as Tier) ?? 'free');

  return c.json({ tenant, limits: getTierLimits(tenant.tier) }, 201);
});

router.get('/tenants', async (c) => {
  if (!c.env.DB) return c.json({ error: 'Database not configured' }, 500);

  const store = new ApiKeyStore(c.env.DB);
  const tenants = await store.listTenants();

  return c.json({ tenants, total: tenants.length });
});

router.get('/tenants/:id', async (c) => {
  if (!c.env.DB) return c.json({ error: 'Database not configured' }, 500);

  const store = new ApiKeyStore(c.env.DB);
  const tenant = await store.getTenant(c.req.param('id'));

  if (!tenant) return c.json({ error: 'Tenant not found' }, 404);

  const meter = new UsageMeter(c.env.DB);
  const quota = await meter.getQuotaStatus(tenant.id, tenant.tier);

  return c.json({ tenant, limits: getTierLimits(tenant.tier), quota });
});

router.patch('/tenants/:id', async (c) => {
  if (!c.env.DB) return c.json({ error: 'Database not configured' }, 500);

  const id = c.req.param('id');
  const body = await c.req.json<{ tier?: string; webhook_url?: string | null; status?: string }>();

  if (body.tier && !isValidTier(body.tier)) {
    return c.json({ error: `Invalid tier: ${body.tier}` }, 400);
  }
  if (body.status && !['active', 'suspended'].includes(body.status)) {
    return c.json({ error: `Invalid status: ${body.status}` }, 400);
  }

  const store = new ApiKeyStore(c.env.DB);
  const before = await store.getTenant(id);
  if (!before) return c.json({ error: 'Tenant not found' }, 404);

  const tenant = await store.updateTenant(id, {
    tier: body.tier as Tier | undefined,
    webhook_url: body.webhook_url,
    status: body.status as 'active' | 'suspended' | undefined,
  });

  if (!tenant) return c.json({ error: 'Tenant not found' }, 404);

  if (body.tier && body.tier !== before.tier) {
    const billing = new BillingHooks(c.env.DB);
    await billing.emit(tenant, 'tier_changed', { from: before.tier, to: tenant.tier });
  }

  return c.json({ tenant, limits: getTierLimits(tenant.tier) });
});

// ---- Key management ----

router.post('/tenants/:id/keys', async (c) => {
  if (!c.env.DB) return c.json({ error: 'Database not configured' }, 500);

  const tenantId = c.req.param('id');
  const body = await c.req.json<{ name: string; scopes?: string[]; expiresInDays?: number }>();

  if (!body.name || body.name.trim().length === 0) {
    return c.json({ error: 'Key name is required' }, 400);
  }

  if (body.scopes) {
    const invalid = body.scopes.filter((s) => !isValidScope(s));
    if (invalid.length > 0) {
      return c.json({ error: `Invalid scopes: ${invalid.join(', ')}`, valid_scopes: ALL_SCOPES }, 400);
    }
  }

  const store = new ApiKeyStore(c.env.DB);

  try {
    const created = await store.createKey(tenantId, body.name.trim(), {
      scopes: body.scopes as Scope[] | undefined,
      expiresInDays: body.expiresInDays,
    });

    const tenant = await store.getTenant(tenantId);
    if (tenant) {
      const billing = new BillingHooks(c.env.DB);
      await billing.emit(tenant, 'key_created', { key_id: created.record.id, name: created.record.name });
    }

    return c.json(
      {
        key: created.record,
        plaintext_key: created.plaintext_key,
        warning: 'Store this key now — it is shown once and cannot be recovered.',
      },
      201
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to create key';
    const status = message.includes('Tenant not found') ? 404 : 400;
    return c.json({ error: message }, status);
  }
});

router.get('/tenants/:id/keys', async (c) => {
  if (!c.env.DB) return c.json({ error: 'Database not configured' }, 500);

  const status = c.req.query('status') as 'active' | 'revoked' | undefined;
  const store = new ApiKeyStore(c.env.DB);
  const keys = await store.listKeys(c.req.param('id'), status);

  return c.json({ keys, total: keys.length });
});

router.delete('/keys/:keyId', async (c) => {
  if (!c.env.DB) return c.json({ error: 'Database not configured' }, 500);

  const keyId = c.req.param('keyId');
  const store = new ApiKeyStore(c.env.DB);
  const key = await store.getKey(keyId);

  if (!key) return c.json({ error: 'Key not found' }, 404);

  const revoked = await store.revokeKey(keyId);
  if (!revoked) return c.json({ error: 'Key is already revoked' }, 409);

  const tenant = await store.getTenant(key.tenant_id);
  if (tenant) {
    const billing = new BillingHooks(c.env.DB);
    await billing.emit(tenant, 'key_revoked', { key_id: keyId, name: key.name });
  }

  return c.json({ revoked: true, key_id: keyId });
});

router.post('/keys/:keyId/rotate', async (c) => {
  if (!c.env.DB) return c.json({ error: 'Database not configured' }, 500);

  const store = new ApiKeyStore(c.env.DB);
  const rotated = await store.rotateKey(c.req.param('keyId'));

  if (!rotated) return c.json({ error: 'Key not found or already revoked' }, 404);

  return c.json(
    {
      key: rotated.record,
      plaintext_key: rotated.plaintext_key,
      warning: 'Store this key now — it is shown once and cannot be recovered.',
    },
    201
  );
});

// ---- Usage, quota, billing ----

router.get('/tenants/:id/usage', async (c) => {
  if (!c.env.DB) return c.json({ error: 'Database not configured' }, 500);

  const tenantId = c.req.param('id');
  const bounds = monthBounds();
  const start = c.req.query('start') || bounds.start;
  const end = c.req.query('end') || bounds.end;

  const meter = new UsageMeter(c.env.DB);
  const summary = await meter.getSummary(tenantId, start, end);

  return c.json({ summary });
});

router.get('/tenants/:id/usage/records', async (c) => {
  if (!c.env.DB) return c.json({ error: 'Database not configured' }, 500);

  const limit = parseInt(c.req.query('limit') || '50');
  const offset = parseInt(c.req.query('offset') || '0');

  const meter = new UsageMeter(c.env.DB);
  const { records, total } = await meter.listRecords(c.req.param('id'), limit, offset);

  return c.json({ records, total, limit, offset });
});

router.get('/tenants/:id/quota', async (c) => {
  if (!c.env.DB) return c.json({ error: 'Database not configured' }, 500);

  const store = new ApiKeyStore(c.env.DB);
  const tenant = await store.getTenant(c.req.param('id'));
  if (!tenant) return c.json({ error: 'Tenant not found' }, 404);

  const meter = new UsageMeter(c.env.DB);
  const quota = await meter.getQuotaStatus(tenant.id, tenant.tier);

  const limiter = new RateLimiter(c.env.DB);
  const minute = await limiter.peek(tenant.id, tenant.tier, 'minute');
  const day = await limiter.peek(tenant.id, tenant.tier, 'day');

  return c.json({ quota, rate_limits: { minute, day } });
});

router.get('/tenants/:id/invoice', async (c) => {
  if (!c.env.DB) return c.json({ error: 'Database not configured' }, 500);

  const store = new ApiKeyStore(c.env.DB);
  const tenant = await store.getTenant(c.req.param('id'));
  if (!tenant) return c.json({ error: 'Tenant not found' }, 404);

  const invoice = await generateInvoice(c.env.DB, tenant.id, tenant.tier);

  return c.json({ invoice });
});

router.get('/tenants/:id/billing-events', async (c) => {
  if (!c.env.DB) return c.json({ error: 'Database not configured' }, 500);

  const limit = parseInt(c.req.query('limit') || '50');
  const billing = new BillingHooks(c.env.DB);
  const events = await billing.listEvents(c.req.param('id'), limit);

  return c.json({ events, total: events.length });
});

router.post('/tenants/:id/billing-events/retry', async (c) => {
  if (!c.env.DB) return c.json({ error: 'Database not configured' }, 500);

  const store = new ApiKeyStore(c.env.DB);
  const tenant = await store.getTenant(c.req.param('id'));
  if (!tenant) return c.json({ error: 'Tenant not found' }, 404);
  if (!tenant.webhook_url) return c.json({ error: 'Tenant has no webhook_url configured' }, 400);

  const billing = new BillingHooks(c.env.DB);
  const delivered = await billing.retryUndelivered(tenant);

  return c.json({ delivered });
});

// ---- Metered product surface ----

// Identify the calling key
router.get('/v1/me', tenantAuth(), async (c) => {
  const auth = getAuth(c);

  const meter = new UsageMeter(c.env.DB);
  const quota = await meter.getQuotaStatus(auth.tenant.id, auth.tenant.tier);

  await meterRequest(c, { statusCode: 200 });

  return c.json({
    tenant: { id: auth.tenant.id, name: auth.tenant.name, tier: auth.tenant.tier },
    key: { id: auth.key.id, name: auth.key.name, prefix: auth.key.key_prefix, scopes: auth.key.scopes },
    quota,
    rate_limit: auth.rateLimit,
  });
});

// Metered structured generation — the flagship billable endpoint
router.post('/v1/structured', tenantAuth('structured:generate'), async (c) => {
  if (!c.env.GEMINI_API_KEY) {
    await meterRequest(c, { statusCode: 500 });
    return c.json({ error: 'Gemini API key not configured' }, 500);
  }

  const body = await c.req.json<{
    prompt: string;
    schema?: JsonSchema;
    schemaName?: string;
    maxAttempts?: number;
  }>();

  if (!body.prompt || body.prompt.trim().length === 0) {
    await meterRequest(c, { statusCode: 400 });
    return c.json({ error: 'Prompt is required' }, 400);
  }

  let schema = body.schema;
  if (!schema && body.schemaName) {
    const store = new SchemaStore(c.env.DB);
    const record = await store.getLatest(body.schemaName);
    if (!record) {
      await meterRequest(c, { statusCode: 404 });
      return c.json({ error: `Schema not found: ${body.schemaName}` }, 404);
    }
    schema = record.schema;
  }

  if (!schema) {
    await meterRequest(c, { statusCode: 400 });
    return c.json({ error: 'Either "schema" or "schemaName" is required' }, 400);
  }

  const schemaCheck = validateSchema(schema);
  if (!schemaCheck.valid) {
    await meterRequest(c, { statusCode: 400 });
    return c.json({ error: 'Invalid schema', errors: schemaCheck.errors }, 400);
  }

  const client = new StructuredClient(c.env.GEMINI_API_KEY);
  const result = await client.generate(body.prompt, schema, {
    maxAttempts: body.maxAttempts,
    schemaName: body.schemaName,
  });

  // Every attempt burned tokens, including the failed ones — bill them all
  const outputText = result.attempts.map((a) => a.raw_output).join('');
  const inputText = body.prompt + JSON.stringify(schema).repeat(result.total_attempts);

  await meterRequest(c, {
    inputText,
    outputText,
    statusCode: result.success ? 200 : 422,
  });

  try {
    const store = new SchemaStore(c.env.DB);
    await store.logGeneration(body.prompt, result);
  } catch (error) {
    console.error('Failed to log generation:', error);
  }

  return c.json({ result }, result.success ? 200 : 422);
});

// Admin-only: clear a tenant's rate limit counters
router.post('/v1/admin/reset-rate-limit/:tenantId', tenantAuth('admin'), async (c) => {
  const tenantId = c.req.param('tenantId');
  if (!tenantId) return c.json({ error: 'tenantId is required' }, 400);

  const limiter = new RateLimiter(c.env.DB);
  await limiter.reset(tenantId);

  await meterRequest(c, { statusCode: 200 });

  return c.json({ reset: true, tenant_id: tenantId });
});

// Admin-only: drop expired rate limit buckets
router.post('/v1/admin/cleanup', tenantAuth('admin'), async (c) => {
  const limiter = new RateLimiter(c.env.DB);
  const removed = await limiter.cleanup();

  await meterRequest(c, { statusCode: 200 });

  return c.json({ removed_buckets: removed });
});

export default router;
