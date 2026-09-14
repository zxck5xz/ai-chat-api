// Project 19: Agent-as-a-Service request pipeline.
//
// Order matters: authenticate -> authorize scope -> rate limit -> quota -> run,
// then meter. Rejecting early keeps a throttled caller from doing real work.

import type { Context, Next } from 'hono';
import type { Env } from '../types';
import type { AaasVariables, AuthContext, Scope } from '../types/aaas';
import { ApiKeyStore, hasScope } from '../services/aaas/api-keys';
import { RateLimiter, rateLimitHeaders } from '../services/aaas/rate-limiter';
import { UsageMeter, estimateTokens } from '../services/aaas/metering';
import { BillingHooks } from '../services/aaas/billing';
import { getTierLimits } from '../services/aaas/tiers';

/** Read the bearer token or X-Api-Key header. */
function extractKey(c: Context): string | null {
  const auth = c.req.header('Authorization');
  if (auth?.startsWith('Bearer ')) return auth.slice(7).trim();

  const header = c.req.header('X-Api-Key');
  if (header) return header.trim();

  return null;
}

/**
 * Authenticate a tenant key, enforce its scope, rate limit and monthly quota.
 * On success the resolved identity is available via `getAuth(c)`.
 */
export function tenantAuth(requiredScope?: Scope) {
  return async (c: Context<{ Bindings: Env; Variables: AaasVariables }>, next: Next) => {
    if (!c.env.DB) {
      return c.json({ error: 'Database not configured' }, 500);
    }

    const plaintext = extractKey(c);
    if (!plaintext) {
      return c.json(
        {
          error: 'Unauthorized',
          message: 'Missing API key. Send "Authorization: Bearer sk_live_..." or "X-Api-Key".',
        },
        401
      );
    }

    const keys = new ApiKeyStore(c.env.DB);
    const verified = await keys.verifyKey(plaintext);

    if (!verified) {
      return c.json(
        { error: 'Unauthorized', message: 'Invalid, revoked, or expired API key.' },
        401
      );
    }

    const { key, tenant } = verified;

    if (requiredScope && !hasScope(key, requiredScope)) {
      return c.json(
        {
          error: 'Forbidden',
          message: `This key lacks the "${requiredScope}" scope.`,
          granted_scopes: key.scopes,
        },
        403
      );
    }

    const limiter = new RateLimiter(c.env.DB);
    const rateLimit = await limiter.consume(tenant.id, tenant.tier);

    if (!rateLimit.allowed) {
      return c.json(
        {
          error: 'Too Many Requests',
          message: `Rate limit exceeded for tier "${tenant.tier}": ${rateLimit.limit} requests per ${rateLimit.window}.`,
          retry_after_seconds: rateLimit.retry_after_seconds,
        },
        429,
        rateLimitHeaders(rateLimit)
      );
    }

    const meter = new UsageMeter(c.env.DB);
    const quota = await meter.getQuotaStatus(tenant.id, tenant.tier);
    const limits = getTierLimits(tenant.tier);

    // Tiers without overage stop at the line; the rest keep serving and bill it
    if (quota.exceeded && !limits.overage_allowed) {
      const billing = new BillingHooks(c.env.DB);
      await billing.checkQuota(tenant, quota);

      return c.json(
        {
          error: 'Quota Exceeded',
          message: `Monthly token quota exhausted (${quota.tokens_used}/${quota.tokens_included}). Upgrade your plan to continue.`,
          quota,
        },
        402,
        rateLimitHeaders(rateLimit)
      );
    }

    const auth: AuthContext = { tenant, key, rateLimit };
    c.set('auth', auth);
    c.set('requestStart', Date.now());

    await next();

    for (const [name, value] of Object.entries(rateLimitHeaders(rateLimit))) {
      c.header(name, value);
    }
  };
}

/** Resolved identity for the current request. Throws if tenantAuth did not run. */
export function getAuth(c: Context<{ Bindings: Env; Variables: AaasVariables }>): AuthContext {
  const auth = c.get('auth') as AuthContext | undefined;
  if (!auth) throw new Error('getAuth called outside a tenantAuth-protected route');
  return auth;
}

export interface MeterOptions {
  inputText?: string;
  outputText?: string;
  inputTokens?: number;
  outputTokens?: number;
  statusCode?: number;
}

/**
 * Record usage for the request in flight and fire any quota event it triggers.
 * Call at the end of a handler, once token counts are known.
 *
 * Metering failures are logged and swallowed — a bookkeeping problem must not
 * turn a successful agent run into a 500 for the caller.
 */
export async function meterRequest(
  c: Context<{ Bindings: Env; Variables: AaasVariables }>,
  options: MeterOptions = {}
): Promise<void> {
  try {
    const auth = c.get('auth') as AuthContext | undefined;
    if (!auth || !c.env.DB) return;

    const start = (c.get('requestStart') as number | undefined) ?? Date.now();

    const inputTokens = options.inputTokens ?? estimateTokens(options.inputText ?? '');
    const outputTokens = options.outputTokens ?? estimateTokens(options.outputText ?? '');

    const meter = new UsageMeter(c.env.DB);
    await meter.record({
      tenantId: auth.tenant.id,
      apiKeyId: auth.key.id,
      endpoint: new URL(c.req.url).pathname,
      method: c.req.method,
      statusCode: options.statusCode ?? 200,
      inputTokens,
      outputTokens,
      durationMs: Date.now() - start,
      tier: auth.tenant.tier,
    });

    const keys = new ApiKeyStore(c.env.DB);
    await keys.touchKey(auth.key.id);

    const quota = await meter.getQuotaStatus(auth.tenant.id, auth.tenant.tier);
    if (quota.warning || quota.exceeded) {
      const billing = new BillingHooks(c.env.DB);
      await billing.checkQuota(auth.tenant, quota);
    }
  } catch (error) {
    console.error('meterRequest failed:', error);
  }
}
