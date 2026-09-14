// Project 19: Sliding-window rate limiter backed by D1.
//
// Fixed windows let a caller fire 2x the limit across a window boundary. This
// uses a two-bucket sliding approximation: the current bucket's count plus a
// prorated share of the previous one, which smooths that edge without storing
// a timestamp per request.

import type { RateLimitResult, RateLimitWindow, Tier } from '../../types/aaas';
import { getTierLimits } from './tiers';

const WINDOW_MS: Record<RateLimitWindow, number> = {
  minute: 60_000,
  day: 86_400_000,
};

interface BucketRow {
  count: number;
}

export class RateLimiter {
  private db: D1Database;

  constructor(db: D1Database) {
    this.db = db;
  }

  /** Bucket key: one row per tenant + window kind + window index. */
  private bucketId(tenantId: string, window: RateLimitWindow, index: number): string {
    return `${tenantId}:${window}:${index}`;
  }

  /**
   * Weighted count across the current and previous buckets.
   * At 25% into the current window, 75% of the previous bucket still counts.
   */
  private async slidingCount(
    tenantId: string,
    window: RateLimitWindow,
    now: number
  ): Promise<{ count: number; index: number; elapsedRatio: number }> {
    const size = WINDOW_MS[window];
    const index = Math.floor(now / size);
    const elapsedRatio = (now % size) / size;

    const current = await this.db
      .prepare('SELECT count FROM rate_limit_buckets WHERE id = ?')
      .bind(this.bucketId(tenantId, window, index))
      .first<BucketRow>();

    const previous = await this.db
      .prepare('SELECT count FROM rate_limit_buckets WHERE id = ?')
      .bind(this.bucketId(tenantId, window, index - 1))
      .first<BucketRow>();

    const weighted = (current?.count ?? 0) + (previous?.count ?? 0) * (1 - elapsedRatio);

    return { count: weighted, index, elapsedRatio };
  }

  /** Check one window without consuming quota. */
  async peek(tenantId: string, tier: Tier, window: RateLimitWindow): Promise<RateLimitResult> {
    const limits = getTierLimits(tier);
    const limit = window === 'minute' ? limits.requests_per_minute : limits.requests_per_day;
    const now = Date.now();
    const size = WINDOW_MS[window];

    const { count, index } = await this.slidingCount(tenantId, window, now);
    const resetAt = (index + 1) * size;

    return {
      allowed: count < limit,
      window,
      limit,
      remaining: Math.max(0, Math.floor(limit - count)),
      reset_at: resetAt,
      retry_after_seconds: count < limit ? 0 : Math.ceil((resetAt - now) / 1000),
    };
  }

  /**
   * Check both windows and consume one unit when allowed.
   * Returns the window that is closest to its limit, so response headers always
   * describe the binding constraint.
   */
  async consume(tenantId: string, tier: Tier): Promise<RateLimitResult> {
    const now = Date.now();

    const minute = await this.peek(tenantId, tier, 'minute');
    if (!minute.allowed) return minute;

    const day = await this.peek(tenantId, tier, 'day');
    if (!day.allowed) return day;

    await this.increment(tenantId, 'minute', now);
    await this.increment(tenantId, 'day', now);

    // Report whichever window has the least headroom, as a fraction of its limit
    const minuteHeadroom = (minute.remaining - 1) / minute.limit;
    const dayHeadroom = (day.remaining - 1) / day.limit;
    const binding = minuteHeadroom <= dayHeadroom ? minute : day;

    return { ...binding, remaining: Math.max(0, binding.remaining - 1) };
  }

  private async increment(tenantId: string, window: RateLimitWindow, now: number): Promise<void> {
    const size = WINDOW_MS[window];
    const index = Math.floor(now / size);
    const id = this.bucketId(tenantId, window, index);

    await this.db
      .prepare(
        `INSERT INTO rate_limit_buckets (id, tenant_id, window_kind, window_index, count, expires_at)
         VALUES (?, ?, ?, ?, 1, ?)
         ON CONFLICT(id) DO UPDATE SET count = count + 1`
      )
      .bind(id, tenantId, window, index, (index + 2) * size)
      .run();
  }

  /** Drop buckets that can no longer influence a sliding calculation. */
  async cleanup(): Promise<number> {
    const result = await this.db
      .prepare('DELETE FROM rate_limit_buckets WHERE expires_at < ?')
      .bind(Date.now())
      .run();

    return result.meta?.changes ?? 0;
  }

  /** Admin escape hatch: clear a tenant's counters immediately. */
  async reset(tenantId: string): Promise<void> {
    await this.db.prepare('DELETE FROM rate_limit_buckets WHERE tenant_id = ?').bind(tenantId).run();
  }
}

/** Standard rate-limit headers for a response. */
export function rateLimitHeaders(result: RateLimitResult): Record<string, string> {
  const headers: Record<string, string> = {
    'X-RateLimit-Limit': String(result.limit),
    'X-RateLimit-Remaining': String(result.remaining),
    'X-RateLimit-Reset': String(Math.floor(result.reset_at / 1000)),
    'X-RateLimit-Window': result.window,
  };

  if (!result.allowed) {
    headers['Retry-After'] = String(result.retry_after_seconds);
  }

  return headers;
}
