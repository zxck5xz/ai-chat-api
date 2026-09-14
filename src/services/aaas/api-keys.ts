// Project 19: Multi-tenant API key store.
//
// Keys are stored as SHA-256 hashes. The plaintext is returned exactly once at
// creation and is unrecoverable afterwards — a leaked database does not leak
// working credentials.

import type { ApiKeyRecord, CreatedApiKey, Scope, TenantRecord, Tier } from '../../types/aaas';
import { DEFAULT_SCOPES, getTierLimits } from './tiers';

const KEY_PREFIX = 'sk_live_';
const PREFIX_DISPLAY_LENGTH = 8; // characters of the random part kept visible

interface KeyRow {
  id: string;
  tenant_id: string;
  name: string;
  key_prefix: string;
  key_hash: string;
  tier: Tier;
  scopes: string;
  status: 'active' | 'revoked';
  last_used_at: string | null;
  expires_at: string | null;
  created_at: string;
  revoked_at: string | null;
}

interface TenantRow {
  id: string;
  name: string;
  email: string | null;
  tier: Tier;
  webhook_url: string | null;
  status: 'active' | 'suspended';
  created_at: string;
}

function toKeyRecord(row: KeyRow): ApiKeyRecord {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    name: row.name,
    key_prefix: row.key_prefix,
    tier: row.tier,
    scopes: JSON.parse(row.scopes) as Scope[],
    status: row.status,
    last_used_at: row.last_used_at,
    expires_at: row.expires_at,
    created_at: row.created_at,
    revoked_at: row.revoked_at,
  };
}

/** SHA-256 hex digest — available in Workers without a crypto dependency. */
export async function hashKey(plaintext: string): Promise<string> {
  const data = new TextEncoder().encode(plaintext);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function generateKey(): { plaintext: string; prefix: string } {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const random = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return {
    plaintext: `${KEY_PREFIX}${random}`,
    prefix: `${KEY_PREFIX}${random.slice(0, PREFIX_DISPLAY_LENGTH)}`,
  };
}

export class ApiKeyStore {
  private db: D1Database;

  constructor(db: D1Database) {
    this.db = db;
  }

  // ---- Tenants ----

  async createTenant(name: string, email?: string, tier: Tier = 'free'): Promise<TenantRecord> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    await this.db
      .prepare(
        `INSERT INTO tenants (id, name, email, tier, webhook_url, status, created_at)
         VALUES (?, ?, ?, ?, NULL, 'active', ?)`
      )
      .bind(id, name, email ?? null, tier, now)
      .run();

    return { id, name, email: email ?? null, tier, webhook_url: null, status: 'active', created_at: now };
  }

  async getTenant(id: string): Promise<TenantRecord | null> {
    const row = await this.db.prepare('SELECT * FROM tenants WHERE id = ?').bind(id).first<TenantRow>();
    return row ?? null;
  }

  async listTenants(): Promise<TenantRecord[]> {
    const { results } = await this.db
      .prepare('SELECT * FROM tenants ORDER BY created_at DESC')
      .all<TenantRow>();
    return results ?? [];
  }

  async updateTenant(
    id: string,
    updates: { tier?: Tier; webhook_url?: string | null; status?: 'active' | 'suspended' }
  ): Promise<TenantRecord | null> {
    const tenant = await this.getTenant(id);
    if (!tenant) return null;

    const tier = updates.tier ?? tenant.tier;
    const webhook = updates.webhook_url !== undefined ? updates.webhook_url : tenant.webhook_url;
    const status = updates.status ?? tenant.status;

    await this.db
      .prepare('UPDATE tenants SET tier = ?, webhook_url = ?, status = ? WHERE id = ?')
      .bind(tier, webhook, status, id)
      .run();

    // Keys inherit the tenant tier, otherwise an upgrade would not raise limits
    if (updates.tier && updates.tier !== tenant.tier) {
      await this.db
        .prepare("UPDATE api_keys SET tier = ? WHERE tenant_id = ? AND status = 'active'")
        .bind(tier, id)
        .run();
    }

    return { ...tenant, tier, webhook_url: webhook, status };
  }

  // ---- Keys ----

  /**
   * Mint a new key for a tenant.
   * Fails when the tenant is at its tier's key cap — an upgrade is the fix.
   */
  async createKey(
    tenantId: string,
    name: string,
    options: { scopes?: Scope[]; expiresInDays?: number } = {}
  ): Promise<CreatedApiKey> {
    const tenant = await this.getTenant(tenantId);
    if (!tenant) throw new Error(`Tenant not found: ${tenantId}`);

    const limits = getTierLimits(tenant.tier);
    const active = await this.listKeys(tenantId, 'active');
    if (active.length >= limits.max_keys) {
      throw new Error(
        `Key limit reached for tier "${tenant.tier}" (${limits.max_keys}). Revoke a key or upgrade.`
      );
    }

    const { plaintext, prefix } = generateKey();
    const keyHash = await hashKey(plaintext);
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const scopes = options.scopes ?? DEFAULT_SCOPES[tenant.tier];

    const expiresAt = options.expiresInDays
      ? new Date(Date.now() + options.expiresInDays * 86_400_000).toISOString()
      : null;

    await this.db
      .prepare(
        `INSERT INTO api_keys
         (id, tenant_id, name, key_prefix, key_hash, tier, scopes, status, last_used_at, expires_at, created_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', NULL, ?, ?, NULL)`
      )
      .bind(id, tenantId, name, prefix, keyHash, tenant.tier, JSON.stringify(scopes), expiresAt, now)
      .run();

    return {
      record: {
        id,
        tenant_id: tenantId,
        name,
        key_prefix: prefix,
        tier: tenant.tier,
        scopes,
        status: 'active',
        last_used_at: null,
        expires_at: expiresAt,
        created_at: now,
        revoked_at: null,
      },
      plaintext_key: plaintext,
    };
  }

  /**
   * Resolve a plaintext key to its record + tenant.
   * Returns null for unknown, revoked, expired keys and suspended tenants —
   * the caller cannot tell these apart, which is deliberate.
   */
  async verifyKey(plaintext: string): Promise<{ key: ApiKeyRecord; tenant: TenantRecord } | null> {
    if (!plaintext || !plaintext.startsWith(KEY_PREFIX)) return null;

    const keyHash = await hashKey(plaintext);
    const row = await this.db
      .prepare("SELECT * FROM api_keys WHERE key_hash = ? AND status = 'active'")
      .bind(keyHash)
      .first<KeyRow>();

    if (!row) return null;

    if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) return null;

    const tenant = await this.getTenant(row.tenant_id);
    if (!tenant || tenant.status !== 'active') return null;

    return { key: toKeyRecord(row), tenant };
  }

  /**
   * Stamp last_used_at. Called from the request path, so failures are swallowed:
   * a bookkeeping write must never fail an otherwise valid request.
   */
  async touchKey(keyId: string): Promise<void> {
    try {
      await this.db
        .prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?')
        .bind(new Date().toISOString(), keyId)
        .run();
    } catch (error) {
      console.error('touchKey failed:', error);
    }
  }

  async listKeys(tenantId: string, status?: 'active' | 'revoked'): Promise<ApiKeyRecord[]> {
    const query = status
      ? 'SELECT * FROM api_keys WHERE tenant_id = ? AND status = ? ORDER BY created_at DESC'
      : 'SELECT * FROM api_keys WHERE tenant_id = ? ORDER BY created_at DESC';

    const stmt = status
      ? this.db.prepare(query).bind(tenantId, status)
      : this.db.prepare(query).bind(tenantId);

    const { results } = await stmt.all<KeyRow>();
    return (results ?? []).map(toKeyRecord);
  }

  async getKey(id: string): Promise<ApiKeyRecord | null> {
    const row = await this.db.prepare('SELECT * FROM api_keys WHERE id = ?').bind(id).first<KeyRow>();
    return row ? toKeyRecord(row) : null;
  }

  async revokeKey(id: string): Promise<boolean> {
    const result = await this.db
      .prepare("UPDATE api_keys SET status = 'revoked', revoked_at = ? WHERE id = ? AND status = 'active'")
      .bind(new Date().toISOString(), id)
      .run();

    return (result.meta?.changes ?? 0) > 0;
  }

  /** Rotate: revoke the old key and mint a replacement with the same settings. */
  async rotateKey(id: string): Promise<CreatedApiKey | null> {
    const existing = await this.getKey(id);
    if (!existing || existing.status !== 'active') return null;

    await this.revokeKey(id);

    return this.createKey(existing.tenant_id, `${existing.name} (rotated)`, {
      scopes: existing.scopes,
    });
  }
}

export function hasScope(key: ApiKeyRecord, scope: Scope): boolean {
  return key.scopes.includes('admin') || key.scopes.includes(scope);
}
