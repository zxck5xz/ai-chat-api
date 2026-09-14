import { describe, expect, it } from 'vitest';
import { ALL_TIERS, TIERS, calculateCost, getTierLimits, isValidScope, isValidTier } from './tiers';
import { monthBounds, estimateTokens } from './metering';

describe('tiers', () => {
  it('defines limits for every tier', () => {
    for (const tier of ALL_TIERS) {
      expect(TIERS[tier]).toBeDefined();
      expect(TIERS[tier].tier).toBe(tier);
    }
  });

  it('increases limits monotonically up the tiers', () => {
    const rpm = ALL_TIERS.map((t) => TIERS[t].requests_per_minute);
    const tokens = ALL_TIERS.map((t) => TIERS[t].tokens_per_month);

    expect(rpm).toEqual([...rpm].sort((a, b) => a - b));
    expect(tokens).toEqual([...tokens].sort((a, b) => a - b));
  });

  it('falls back to free for an unknown tier', () => {
    expect(getTierLimits('nonsense' as never)).toBe(TIERS.free);
  });

  it('never allows overage on the free tier', () => {
    expect(TIERS.free.overage_allowed).toBe(false);
    expect(TIERS.free.monthly_base_usd).toBe(0);
  });

  it('charges a lower per-token rate at higher volume', () => {
    expect(TIERS.pro.overage_per_1k_tokens_usd).toBeLessThan(TIERS.starter.overage_per_1k_tokens_usd);
    expect(TIERS.enterprise.overage_per_1k_tokens_usd).toBeLessThan(TIERS.pro.overage_per_1k_tokens_usd);
  });

  it('validates tier and scope names', () => {
    expect(isValidTier('pro')).toBe(true);
    expect(isValidTier('platinum')).toBe(false);
    expect(isValidScope('agent:run')).toBe(true);
    expect(isValidScope('agent:destroy')).toBe(false);
  });
});

describe('calculateCost', () => {
  it('costs nothing on the free tier', () => {
    expect(calculateCost('free', 1_000_000)).toBe(0);
  });

  it('prices per 1k tokens', () => {
    expect(calculateCost('starter', 1000)).toBeCloseTo(0.02, 6);
    expect(calculateCost('starter', 500)).toBeCloseTo(0.01, 6);
  });

  it('returns zero for zero tokens', () => {
    expect(calculateCost('pro', 0)).toBe(0);
  });
});

describe('monthBounds', () => {
  it('spans the full calendar month in UTC', () => {
    const { start, end } = monthBounds(new Date('2026-09-14T10:30:00Z'));
    expect(start).toBe('2026-09-01T00:00:00.000Z');
    expect(end.startsWith('2026-09-30T23:59:59')).toBe(true);
  });

  it('handles February in a leap year', () => {
    const { end } = monthBounds(new Date('2028-02-10T00:00:00Z'));
    expect(end.startsWith('2028-02-29')).toBe(true);
  });

  it('handles December without rolling the year wrong', () => {
    const { start, end } = monthBounds(new Date('2026-12-31T23:00:00Z'));
    expect(start).toBe('2026-12-01T00:00:00.000Z');
    expect(end.startsWith('2026-12-31')).toBe(true);
  });
});

describe('estimateTokens', () => {
  it('returns zero for empty input', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('approximates four characters per token', () => {
    expect(estimateTokens('a'.repeat(400))).toBe(100);
  });

  it('rounds partial tokens up', () => {
    expect(estimateTokens('abc')).toBe(1);
  });
});
