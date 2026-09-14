// Project 19: Usage metering — per-request records and rollups.

import type { QuotaStatus, Tier, UsageRecord, UsageSummary } from '../../types/aaas';
import { QUOTA_WARNING_THRESHOLD, calculateCost, getTierLimits } from './tiers';

export interface MeterInput {
  tenantId: string;
  apiKeyId: string;
  endpoint: string;
  method: string;
  statusCode: number;
  inputTokens?: number;
  outputTokens?: number;
  durationMs: number;
  tier: Tier;
}

/** First and last instant of the calendar month containing `at` (UTC). */
export function monthBounds(at: Date = new Date()): { start: string; end: string } {
  const start = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
  const end = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1) - 1);
  return { start: start.toISOString(), end: end.toISOString() };
}

export class UsageMeter {
  private db: D1Database;

  constructor(db: D1Database) {
    this.db = db;
  }

  /** Record one billable request. Returns the record id. */
  async record(input: MeterInput): Promise<string> {
    const id = crypto.randomUUID();
    const inputTokens = input.inputTokens ?? 0;
    const outputTokens = input.outputTokens ?? 0;
    const totalTokens = inputTokens + outputTokens;
    const cost = calculateCost(input.tier, totalTokens);

    await this.db
      .prepare(
        `INSERT INTO usage_records
         (id, tenant_id, api_key_id, endpoint, method, status_code,
          input_tokens, output_tokens, total_tokens, cost_usd, duration_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        id,
        input.tenantId,
        input.apiKeyId,
        input.endpoint,
        input.method,
        input.statusCode,
        inputTokens,
        outputTokens,
        totalTokens,
        cost,
        input.durationMs,
        new Date().toISOString()
      )
      .run();

    return id;
  }

  /** Tokens consumed by a tenant in the current calendar month. */
  async monthlyTokens(tenantId: string, at: Date = new Date()): Promise<number> {
    const { start, end } = monthBounds(at);

    const row = await this.db
      .prepare(
        `SELECT COALESCE(SUM(total_tokens), 0) AS tokens
         FROM usage_records
         WHERE tenant_id = ? AND created_at >= ? AND created_at <= ?`
      )
      .bind(tenantId, start, end)
      .first<{ tokens: number }>();

    return row?.tokens ?? 0;
  }

  async getQuotaStatus(tenantId: string, tier: Tier, at: Date = new Date()): Promise<QuotaStatus> {
    const limits = getTierLimits(tier);
    const { start, end } = monthBounds(at);
    const used = await this.monthlyTokens(tenantId, at);
    const included = limits.tokens_per_month;
    const overage = Math.max(0, used - included);

    return {
      tenant_id: tenantId,
      tier,
      tokens_used: used,
      tokens_included: included,
      tokens_remaining: Math.max(0, included - used),
      percent_used: included > 0 ? used / included : 0,
      warning: included > 0 && used / included >= QUOTA_WARNING_THRESHOLD,
      exceeded: used >= included,
      overage_tokens: overage,
      overage_cost_usd: (overage / 1000) * limits.overage_per_1k_tokens_usd,
      period_start: start,
      period_end: end,
    };
  }

  /** Full usage breakdown for a window, for the developer portal. */
  async getSummary(tenantId: string, periodStart: string, periodEnd: string): Promise<UsageSummary> {
    const totals = await this.db
      .prepare(
        `SELECT
           COUNT(*) AS total_requests,
           SUM(CASE WHEN status_code < 400 THEN 1 ELSE 0 END) AS successful,
           SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) AS failed,
           COALESCE(SUM(total_tokens), 0) AS total_tokens,
           COALESCE(SUM(input_tokens), 0) AS input_tokens,
           COALESCE(SUM(output_tokens), 0) AS output_tokens,
           COALESCE(SUM(cost_usd), 0) AS total_cost,
           COALESCE(AVG(duration_ms), 0) AS avg_duration
         FROM usage_records
         WHERE tenant_id = ? AND created_at >= ? AND created_at <= ?`
      )
      .bind(tenantId, periodStart, periodEnd)
      .first<{
        total_requests: number;
        successful: number | null;
        failed: number | null;
        total_tokens: number;
        input_tokens: number;
        output_tokens: number;
        total_cost: number;
        avg_duration: number;
      }>();

    const byEndpoint = await this.db
      .prepare(
        `SELECT endpoint,
                COUNT(*) AS requests,
                COALESCE(SUM(total_tokens), 0) AS tokens,
                COALESCE(SUM(cost_usd), 0) AS cost_usd
         FROM usage_records
         WHERE tenant_id = ? AND created_at >= ? AND created_at <= ?
         GROUP BY endpoint
         ORDER BY requests DESC
         LIMIT 20`
      )
      .bind(tenantId, periodStart, periodEnd)
      .all<{ endpoint: string; requests: number; tokens: number; cost_usd: number }>();

    const byDay = await this.db
      .prepare(
        `SELECT substr(created_at, 1, 10) AS day,
                COUNT(*) AS requests,
                COALESCE(SUM(total_tokens), 0) AS tokens,
                COALESCE(SUM(cost_usd), 0) AS cost_usd
         FROM usage_records
         WHERE tenant_id = ? AND created_at >= ? AND created_at <= ?
         GROUP BY day
         ORDER BY day ASC`
      )
      .bind(tenantId, periodStart, periodEnd)
      .all<{ day: string; requests: number; tokens: number; cost_usd: number }>();

    return {
      tenant_id: tenantId,
      period_start: periodStart,
      period_end: periodEnd,
      total_requests: totals?.total_requests ?? 0,
      successful_requests: totals?.successful ?? 0,
      failed_requests: totals?.failed ?? 0,
      total_tokens: totals?.total_tokens ?? 0,
      input_tokens: totals?.input_tokens ?? 0,
      output_tokens: totals?.output_tokens ?? 0,
      total_cost_usd: totals?.total_cost ?? 0,
      avg_duration_ms: totals?.avg_duration ?? 0,
      by_endpoint: byEndpoint.results ?? [],
      by_day: byDay.results ?? [],
    };
  }

  async listRecords(
    tenantId: string,
    limit = 50,
    offset = 0
  ): Promise<{ records: UsageRecord[]; total: number }> {
    const { results } = await this.db
      .prepare(
        'SELECT * FROM usage_records WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?'
      )
      .bind(tenantId, limit, offset)
      .all<UsageRecord>();

    const countRow = await this.db
      .prepare('SELECT COUNT(*) AS total FROM usage_records WHERE tenant_id = ?')
      .bind(tenantId)
      .first<{ total: number }>();

    return { records: results ?? [], total: countRow?.total ?? 0 };
  }
}

/**
 * Rough token estimate for requests where the provider returns no usage block.
 * ~4 characters per token is the common English approximation; it is used for
 * metering only, never for prompt-window budgeting.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}
