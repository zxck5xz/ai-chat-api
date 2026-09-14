// Project 19: Billing hooks — quota events, outbound webhooks, invoices.
//
// Events are persisted first and delivered second. A webhook endpoint that is
// down loses nothing: the row stays with delivered = 0 and can be retried.

import type {
  BillingEvent,
  BillingEventType,
  Invoice,
  QuotaStatus,
  TenantRecord,
  Tier,
} from '../../types/aaas';
import { getTierLimits } from './tiers';
import { UsageMeter, monthBounds } from './metering';

interface EventRow {
  id: string;
  tenant_id: string;
  type: BillingEventType;
  payload: string;
  delivered: number;
  created_at: string;
}

function toEvent(row: EventRow): BillingEvent {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    type: row.type,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    delivered: row.delivered === 1,
    created_at: row.created_at,
  };
}

export class BillingHooks {
  private db: D1Database;

  constructor(db: D1Database) {
    this.db = db;
  }

  /** Persist an event, then attempt delivery if the tenant has a webhook. */
  async emit(
    tenant: TenantRecord,
    type: BillingEventType,
    payload: Record<string, unknown>
  ): Promise<BillingEvent> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    await this.db
      .prepare(
        `INSERT INTO billing_events (id, tenant_id, type, payload, delivered, created_at)
         VALUES (?, ?, ?, ?, 0, ?)`
      )
      .bind(id, tenant.id, type, JSON.stringify(payload), now)
      .run();

    let delivered = false;
    if (tenant.webhook_url) {
      delivered = await this.deliver(tenant.webhook_url, { id, type, tenant_id: tenant.id, payload, created_at: now });
      if (delivered) {
        await this.db.prepare('UPDATE billing_events SET delivered = 1 WHERE id = ?').bind(id).run();
      }
    }

    return { id, tenant_id: tenant.id, type, payload, delivered, created_at: now };
  }

  private async deliver(url: string, body: unknown): Promise<boolean> {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Event-Source': 'ai-chat-api-billing' },
        body: JSON.stringify(body),
      });
      return response.ok;
    } catch (error) {
      console.error('Billing webhook delivery failed:', error);
      return false;
    }
  }

  /**
   * Emit a quota event when a threshold is newly crossed.
   * Deduplicated per calendar month, so a tenant sitting at 85% for a week
   * gets one warning, not one per request.
   */
  async checkQuota(tenant: TenantRecord, quota: QuotaStatus): Promise<BillingEvent | null> {
    const type: BillingEventType | null = quota.exceeded
      ? 'quota_exceeded'
      : quota.warning
        ? 'quota_warning'
        : null;

    if (!type) return null;

    const alreadySent = await this.db
      .prepare(
        `SELECT id FROM billing_events
         WHERE tenant_id = ? AND type = ? AND created_at >= ?
         LIMIT 1`
      )
      .bind(tenant.id, type, quota.period_start)
      .first<{ id: string }>();

    if (alreadySent) return null;

    return this.emit(tenant, type, {
      tokens_used: quota.tokens_used,
      tokens_included: quota.tokens_included,
      percent_used: quota.percent_used,
      overage_tokens: quota.overage_tokens,
      overage_cost_usd: quota.overage_cost_usd,
    });
  }

  async listEvents(tenantId: string, limit = 50): Promise<BillingEvent[]> {
    const { results } = await this.db
      .prepare('SELECT * FROM billing_events WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?')
      .bind(tenantId, limit)
      .all<EventRow>();

    return (results ?? []).map(toEvent);
  }

  /** Retry undelivered events for a tenant. Returns how many went through. */
  async retryUndelivered(tenant: TenantRecord, limit = 20): Promise<number> {
    if (!tenant.webhook_url) return 0;

    const { results } = await this.db
      .prepare(
        'SELECT * FROM billing_events WHERE tenant_id = ? AND delivered = 0 ORDER BY created_at ASC LIMIT ?'
      )
      .bind(tenant.id, limit)
      .all<EventRow>();

    let sent = 0;
    for (const row of results ?? []) {
      const event = toEvent(row);
      const ok = await this.deliver(tenant.webhook_url, event);
      if (ok) {
        await this.db.prepare('UPDATE billing_events SET delivered = 1 WHERE id = ?').bind(row.id).run();
        sent++;
      }
    }

    return sent;
  }
}

/**
 * Build an invoice for a tenant's billing month.
 * Base fee is charged in full regardless of usage; overage applies only to
 * tokens beyond the tier's included allowance.
 */
export async function generateInvoice(
  db: D1Database,
  tenantId: string,
  tier: Tier,
  at: Date = new Date()
): Promise<Invoice> {
  const limits = getTierLimits(tier);
  const { start, end } = monthBounds(at);
  const meter = new UsageMeter(db);
  const used = await meter.monthlyTokens(tenantId, at);

  const overageTokens = limits.overage_allowed ? Math.max(0, used - limits.tokens_per_month) : 0;
  const overageUsd = (overageTokens / 1000) * limits.overage_per_1k_tokens_usd;

  const lineItems: Invoice['line_items'] = [
    {
      description: `${tier} plan — monthly base`,
      quantity: 1,
      amount_usd: limits.monthly_base_usd,
    },
  ];

  if (overageTokens > 0) {
    lineItems.push({
      description: `Token overage (${overageTokens.toLocaleString()} tokens @ $${limits.overage_per_1k_tokens_usd}/1k)`,
      quantity: overageTokens,
      amount_usd: overageUsd,
    });
  }

  return {
    tenant_id: tenantId,
    tier,
    period_start: start,
    period_end: end,
    base_usd: limits.monthly_base_usd,
    included_tokens: limits.tokens_per_month,
    used_tokens: used,
    overage_tokens: overageTokens,
    overage_usd: overageUsd,
    total_usd: limits.monthly_base_usd + overageUsd,
    line_items: lineItems,
    generated_at: new Date().toISOString(),
  };
}
