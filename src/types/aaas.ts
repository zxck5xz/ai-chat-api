// Project 19: Agent-as-a-Service — Types

export type Tier = 'free' | 'starter' | 'pro' | 'enterprise';

export type Scope =
  | 'agent:run'
  | 'agent:stream'
  | 'structured:generate'
  | 'schema:read'
  | 'schema:write'
  | 'usage:read'
  | 'admin';

export interface TierLimits {
  tier: Tier;
  requests_per_minute: number;
  requests_per_day: number;
  tokens_per_month: number;
  max_keys: number;
  monthly_base_usd: number;
  /** Charged only on tokens beyond the included monthly allowance */
  overage_per_1k_tokens_usd: number;
  /** false = hard stop at quota; true = keep serving and bill the excess */
  overage_allowed: boolean;
}

export interface ApiKeyRecord {
  id: string;
  tenant_id: string;
  name: string;
  /** Non-secret display prefix, e.g. "sk_live_a1b2c3d4" */
  key_prefix: string;
  tier: Tier;
  scopes: Scope[];
  status: 'active' | 'revoked';
  last_used_at: string | null;
  expires_at: string | null;
  created_at: string;
  revoked_at: string | null;
}

export interface CreatedApiKey {
  record: ApiKeyRecord;
  /** Full secret — returned exactly once, at creation, and never stored */
  plaintext_key: string;
}

export interface UsageRecord {
  id: string;
  tenant_id: string;
  api_key_id: string;
  endpoint: string;
  method: string;
  status_code: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cost_usd: number;
  duration_ms: number;
  created_at: string;
}

export interface UsageSummary {
  tenant_id: string;
  period_start: string;
  period_end: string;
  total_requests: number;
  successful_requests: number;
  failed_requests: number;
  total_tokens: number;
  input_tokens: number;
  output_tokens: number;
  total_cost_usd: number;
  avg_duration_ms: number;
  by_endpoint: Array<{
    endpoint: string;
    requests: number;
    tokens: number;
    cost_usd: number;
  }>;
  by_day: Array<{
    day: string;
    requests: number;
    tokens: number;
    cost_usd: number;
  }>;
}

export type RateLimitWindow = 'minute' | 'day';

export interface RateLimitResult {
  allowed: boolean;
  window: RateLimitWindow;
  limit: number;
  remaining: number;
  /** Epoch milliseconds at which the current window rolls over */
  reset_at: number;
  retry_after_seconds: number;
}

export interface QuotaStatus {
  tenant_id: string;
  tier: Tier;
  tokens_used: number;
  tokens_included: number;
  tokens_remaining: number;
  percent_used: number;
  /** true once usage crosses the warning threshold (80%) */
  warning: boolean;
  exceeded: boolean;
  overage_tokens: number;
  overage_cost_usd: number;
  period_start: string;
  period_end: string;
}

export type BillingEventType =
  | 'quota_warning'
  | 'quota_exceeded'
  | 'tier_changed'
  | 'key_created'
  | 'key_revoked'
  | 'invoice_generated';

export interface BillingEvent {
  id: string;
  tenant_id: string;
  type: BillingEventType;
  payload: Record<string, unknown>;
  /** Whether the outbound webhook for this event was delivered */
  delivered: boolean;
  created_at: string;
}

export interface Invoice {
  tenant_id: string;
  tier: Tier;
  period_start: string;
  period_end: string;
  base_usd: number;
  included_tokens: number;
  used_tokens: number;
  overage_tokens: number;
  overage_usd: number;
  total_usd: number;
  line_items: Array<{ description: string; quantity: number; amount_usd: number }>;
  generated_at: string;
}

export interface TenantRecord {
  id: string;
  name: string;
  email: string | null;
  tier: Tier;
  /** Optional outbound URL for billing events */
  webhook_url: string | null;
  status: 'active' | 'suspended';
  created_at: string;
}

/** Resolved identity attached to a request by the tenant-auth middleware. */
export interface AuthContext {
  tenant: TenantRecord;
  key: ApiKeyRecord;
  rateLimit: RateLimitResult;
}

/**
 * Hono context variables set by the tenantAuth middleware.
 * Routers that use tenantAuth must be typed with these so `c.get`/`c.set`
 * resolve instead of widening to `never`.
 */
export interface AaasVariables {
  auth: AuthContext;
  /** Epoch ms when the request entered the middleware, for duration metering */
  requestStart: number;
}
