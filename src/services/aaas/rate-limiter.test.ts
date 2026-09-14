import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RateLimiter, rateLimitHeaders } from './rate-limiter';
import { TIERS } from './tiers';

/**
 * Minimal in-memory stand-in for the subset of D1 the rate limiter uses:
 * a keyed SELECT, and an INSERT ... ON CONFLICT DO UPDATE counter bump.
 */
function fakeDb() {
  const buckets = new Map<string, { tenant_id: string; count: number; expires_at: number }>();

  const db = {
    buckets,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>(): Promise<T | null> {
              if (sql.includes('SELECT count FROM rate_limit_buckets')) {
                const row = buckets.get(args[0] as string);
                return (row ? { count: row.count } : null) as T | null;
              }
              return null;
            },
            async run() {
              if (sql.includes('INSERT INTO rate_limit_buckets')) {
                const [id, tenantId, , , expiresAt] = args as [string, string, string, number, number];
                const existing = buckets.get(id);
                if (existing) existing.count += 1;
                else buckets.set(id, { tenant_id: tenantId, count: 1, expires_at: expiresAt });
                return { meta: { changes: 1 } };
              }
              if (sql.includes('DELETE FROM rate_limit_buckets WHERE expires_at')) {
                const cutoff = args[0] as number;
                let removed = 0;
                for (const [key, row] of buckets) {
                  if (row.expires_at < cutoff) {
                    buckets.delete(key);
                    removed++;
                  }
                }
                return { meta: { changes: removed } };
              }
              if (sql.includes('DELETE FROM rate_limit_buckets WHERE tenant_id')) {
                const tenantId = args[0] as string;
                let removed = 0;
                for (const [key, row] of buckets) {
                  if (row.tenant_id === tenantId) {
                    buckets.delete(key);
                    removed++;
                  }
                }
                return { meta: { changes: removed } };
              }
              return { meta: { changes: 0 } };
            },
          };
        },
      };
    },
  };

  return db as unknown as D1Database & { buckets: typeof buckets };
}

describe('RateLimiter', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('allows requests under the limit', async () => {
    const db = fakeDb();
    const limiter = new RateLimiter(db);

    const result = await limiter.consume('t1', 'free');
    expect(result.allowed).toBe(true);
    expect(result.limit).toBe(TIERS.free.requests_per_minute);
    expect(result.remaining).toBe(TIERS.free.requests_per_minute - 1);
  });

  it('blocks once the per-minute limit is reached', async () => {
    const db = fakeDb();
    const limiter = new RateLimiter(db);
    const limit = TIERS.free.requests_per_minute;

    for (let i = 0; i < limit; i++) {
      const result = await limiter.consume('t1', 'free');
      expect(result.allowed).toBe(true);
    }

    const blocked = await limiter.consume('t1', 'free');
    expect(blocked.allowed).toBe(false);
    expect(blocked.window).toBe('minute');
    expect(blocked.remaining).toBe(0);
    expect(blocked.retry_after_seconds).toBeGreaterThan(0);
  });

  it('counts tenants independently', async () => {
    const db = fakeDb();
    const limiter = new RateLimiter(db);

    for (let i = 0; i < TIERS.free.requests_per_minute; i++) {
      await limiter.consume('t1', 'free');
    }

    expect((await limiter.consume('t1', 'free')).allowed).toBe(false);
    expect((await limiter.consume('t2', 'free')).allowed).toBe(true);
  });

  it('gives a higher tier more headroom', async () => {
    const db = fakeDb();
    const limiter = new RateLimiter(db);

    for (let i = 0; i < TIERS.free.requests_per_minute + 5; i++) {
      await limiter.consume('t1', 'starter');
    }

    const result = await limiter.consume('t1', 'starter');
    expect(result.allowed).toBe(true);
  });

  it('carries a prorated share of the previous window', async () => {
    vi.useFakeTimers();
    const db = fakeDb();
    const limiter = new RateLimiter(db);

    // Sit at the very end of a minute window and spend the whole budget
    vi.setSystemTime(new Date(Date.now() - (Date.now() % 60_000) + 59_000));
    for (let i = 0; i < TIERS.free.requests_per_minute; i++) {
      await limiter.consume('t1', 'free');
    }
    expect((await limiter.consume('t1', 'free')).allowed).toBe(false);

    // Crossing into the next window must NOT hand back a full fresh budget
    vi.advanceTimersByTime(2_000);
    const justAfter = await limiter.peek('t1', 'free', 'minute');
    expect(justAfter.remaining).toBeLessThan(TIERS.free.requests_per_minute);

    // Once the old window has fully aged out, the budget is back
    vi.advanceTimersByTime(60_000);
    const later = await limiter.peek('t1', 'free', 'minute');
    expect(later.remaining).toBe(TIERS.free.requests_per_minute);

    vi.useRealTimers();
  });

  it('peek does not consume quota', async () => {
    const db = fakeDb();
    const limiter = new RateLimiter(db);

    const before = await limiter.peek('t1', 'free', 'minute');
    await limiter.peek('t1', 'free', 'minute');
    const after = await limiter.peek('t1', 'free', 'minute');

    expect(after.remaining).toBe(before.remaining);
  });

  it('reset clears a tenant counter', async () => {
    const db = fakeDb();
    const limiter = new RateLimiter(db);

    for (let i = 0; i < TIERS.free.requests_per_minute; i++) {
      await limiter.consume('t1', 'free');
    }
    expect((await limiter.consume('t1', 'free')).allowed).toBe(false);

    await limiter.reset('t1');
    expect((await limiter.consume('t1', 'free')).allowed).toBe(true);
  });
});

describe('rateLimitHeaders', () => {
  it('omits Retry-After while allowed', () => {
    const headers = rateLimitHeaders({
      allowed: true,
      window: 'minute',
      limit: 10,
      remaining: 4,
      reset_at: 1_800_000_000_000,
      retry_after_seconds: 0,
    });

    expect(headers['X-RateLimit-Limit']).toBe('10');
    expect(headers['X-RateLimit-Remaining']).toBe('4');
    expect(headers['Retry-After']).toBeUndefined();
  });

  it('sets Retry-After when blocked', () => {
    const headers = rateLimitHeaders({
      allowed: false,
      window: 'day',
      limit: 200,
      remaining: 0,
      reset_at: 1_800_000_000_000,
      retry_after_seconds: 42,
    });

    expect(headers['Retry-After']).toBe('42');
    expect(headers['X-RateLimit-Window']).toBe('day');
  });
});
