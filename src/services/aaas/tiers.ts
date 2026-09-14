// Project 19: Tier definitions — the single source of truth for limits and pricing.

import type { Scope, Tier, TierLimits } from '../../types/aaas';

export const TIERS: Record<Tier, TierLimits> = {
  free: {
    tier: 'free',
    requests_per_minute: 10,
    requests_per_day: 200,
    tokens_per_month: 100_000,
    max_keys: 2,
    monthly_base_usd: 0,
    overage_per_1k_tokens_usd: 0,
    // Free plans stop at the line rather than generating a surprise bill
    overage_allowed: false,
  },
  starter: {
    tier: 'starter',
    requests_per_minute: 60,
    requests_per_day: 5_000,
    tokens_per_month: 2_000_000,
    max_keys: 5,
    monthly_base_usd: 19,
    overage_per_1k_tokens_usd: 0.02,
    overage_allowed: true,
  },
  pro: {
    tier: 'pro',
    requests_per_minute: 300,
    requests_per_day: 50_000,
    tokens_per_month: 20_000_000,
    max_keys: 20,
    monthly_base_usd: 99,
    overage_per_1k_tokens_usd: 0.012,
    overage_allowed: true,
  },
  enterprise: {
    tier: 'enterprise',
    requests_per_minute: 2_000,
    requests_per_day: 1_000_000,
    tokens_per_month: 500_000_000,
    max_keys: 100,
    monthly_base_usd: 999,
    overage_per_1k_tokens_usd: 0.008,
    overage_allowed: true,
  },
};

export const ALL_TIERS: Tier[] = ['free', 'starter', 'pro', 'enterprise'];

export const ALL_SCOPES: Scope[] = [
  'agent:run',
  'agent:stream',
  'structured:generate',
  'schema:read',
  'schema:write',
  'usage:read',
  'admin',
];

/** Scopes granted to a new key when the caller does not specify any. */
export const DEFAULT_SCOPES: Record<Tier, Scope[]> = {
  free: ['agent:run', 'structured:generate', 'schema:read', 'usage:read'],
  starter: ['agent:run', 'agent:stream', 'structured:generate', 'schema:read', 'schema:write', 'usage:read'],
  pro: ['agent:run', 'agent:stream', 'structured:generate', 'schema:read', 'schema:write', 'usage:read'],
  enterprise: ALL_SCOPES,
};

/** Warn the tenant once monthly token usage crosses this share of the quota. */
export const QUOTA_WARNING_THRESHOLD = 0.8;

export function getTierLimits(tier: Tier): TierLimits {
  return TIERS[tier] ?? TIERS.free;
}

export function isValidTier(value: string): value is Tier {
  return ALL_TIERS.includes(value as Tier);
}

export function isValidScope(value: string): value is Scope {
  return ALL_SCOPES.includes(value as Scope);
}

/**
 * Cost of a request in USD.
 * Priced off the tenant's tier so the same token count bills differently on
 * free (0) versus enterprise (volume rate).
 */
export function calculateCost(tier: Tier, totalTokens: number): number {
  const limits = getTierLimits(tier);
  return (totalTokens / 1000) * limits.overage_per_1k_tokens_usd;
}
