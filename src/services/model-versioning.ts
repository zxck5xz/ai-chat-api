import type {
  ModelVersion,
  ModelDeployment,
  RollbackRecord,
  ModelComparison,
  ModelMetrics,
} from '../types/model-versioning';

interface ModelVersioningConfig {
  db: D1Database;
}

export class ModelVersioningService {
  private db: D1Database;

  constructor(config: ModelVersioningConfig) {
    this.db = config.db;
  }

  // === Model Versions ===

  async createVersion(data: {
    name: string;
    version: string;
    provider: ModelVersion['provider'];
    modelId: string;
    config?: ModelVersion['config'];
    notes?: string;
  }): Promise<ModelVersion> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    await this.db
      .prepare(
        `INSERT INTO model_versions (id, name, version, provider, model_id, status, config, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'inactive', ?, ?, ?, ?)`
      )
      .bind(
        id,
        data.name,
        data.version,
        data.provider,
        data.modelId,
        JSON.stringify(data.config || {}),
        data.notes || null,
        now,
        now
      )
      .run();

    const version = await this.getVersion(id);
    if (!version) throw new Error('Failed to create version');
    return version;
  }

  async getVersion(id: string): Promise<ModelVersion | undefined> {
    const result = await this.db
      .prepare('SELECT * FROM model_versions WHERE id = ?')
      .bind(id)
      .first();

    if (!result) return undefined;

    return this.mapVersion(result);
  }

  async listVersions(filters?: {
    provider?: string;
    status?: string;
  }): Promise<ModelVersion[]> {
    let query = 'SELECT * FROM model_versions WHERE 1=1';
    const params: unknown[] = [];

    if (filters?.provider) {
      query += ' AND provider = ?';
      params.push(filters.provider);
    }
    if (filters?.status) {
      query += ' AND status = ?';
      params.push(filters.status);
    }

    query += ' ORDER BY created_at DESC';

    const { results } = await this.db.prepare(query).bind(...params).all();
    return results.map((r) => this.mapVersion(r));
  }

  async updateVersion(
    id: string,
    data: Partial<Pick<ModelVersion, 'name' | 'status' | 'config' | 'notes'>>
  ): Promise<ModelVersion | undefined> {
    const updates: string[] = [];
    const params: unknown[] = [];

    if (data.name !== undefined) {
      updates.push('name = ?');
      params.push(data.name);
    }
    if (data.status !== undefined) {
      updates.push('status = ?');
      params.push(data.status);
    }
    if (data.config !== undefined) {
      updates.push('config = ?');
      params.push(JSON.stringify(data.config));
    }
    if (data.notes !== undefined) {
      updates.push('notes = ?');
      params.push(data.notes);
    }

    if (updates.length === 0) return this.getVersion(id);

    updates.push('updated_at = ?');
    params.push(new Date().toISOString());
    params.push(id);

    await this.db
      .prepare(`UPDATE model_versions SET ${updates.join(', ')} WHERE id = ?`)
      .bind(...params)
      .run();

    return this.getVersion(id);
  }

  async deleteVersion(id: string): Promise<void> {
    await this.db.prepare('DELETE FROM model_versions WHERE id = ?').bind(id).run();
  }

  // === Deployments ===

  async createDeployment(data: {
    versionId: string;
    environment: ModelDeployment['environment'];
    strategy: ModelDeployment['strategy'];
    trafficPercent?: number;
    deployedBy?: string;
  }): Promise<ModelDeployment> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    await this.db
      .prepare(
        `INSERT INTO model_deployments (id, version_id, environment, status, traffic_percent, strategy, deployed_at, deployed_by, created_at)
         VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?)`
      )
      .bind(
        id,
        data.versionId,
        data.environment,
        data.trafficPercent || 100,
        data.strategy,
        now,
        data.deployedBy || null,
        now
      )
      .run();

    // Update version status to active
    await this.updateVersion(data.versionId, { status: 'active' });

    const deployment = await this.getDeployment(id);
    if (!deployment) throw new Error('Failed to create deployment');
    return deployment;
  }

  async getDeployment(id: string): Promise<ModelDeployment | undefined> {
    const result = await this.db
      .prepare('SELECT * FROM model_deployments WHERE id = ?')
      .bind(id)
      .first();

    if (!result) return undefined;

    return this.mapDeployment(result);
  }

  async listDeployments(filters?: {
    environment?: string;
    versionId?: string;
    status?: string;
  }): Promise<ModelDeployment[]> {
    let query = 'SELECT * FROM model_deployments WHERE 1=1';
    const params: unknown[] = [];

    if (filters?.environment) {
      query += ' AND environment = ?';
      params.push(filters.environment);
    }
    if (filters?.versionId) {
      query += ' AND version_id = ?';
      params.push(filters.versionId);
    }
    if (filters?.status) {
      query += ' AND status = ?';
      params.push(filters.status);
    }

    query += ' ORDER BY created_at DESC';

    const { results } = await this.db.prepare(query).bind(...params).all();
    return results.map((r) => this.mapDeployment(r));
  }

  async getActiveDeployment(
    environment: string
  ): Promise<ModelDeployment | undefined> {
    const result = await this.db
      .prepare(
        `SELECT * FROM model_deployments
         WHERE environment = ? AND status = 'active'
         ORDER BY created_at DESC LIMIT 1`
      )
      .bind(environment)
      .first();

    if (!result) return undefined;

    return this.mapDeployment(result);
  }

  // === Rollback ===

  async rollback(
    deploymentId: string,
    reason: string,
    triggeredBy: string
  ): Promise<RollbackRecord> {
    const deployment = await this.getDeployment(deploymentId);
    if (!deployment) {
      throw new Error('Deployment not found');
    }

    // Find the previous active deployment
    const previousDeployment = await this.db
      .prepare(
        `SELECT * FROM model_deployments
         WHERE environment = ? AND status = 'active' AND id != ?
         ORDER BY created_at DESC LIMIT 1`
      )
      .bind(deployment.environment, deploymentId)
      .first();

    if (!previousDeployment) {
      throw new Error('No previous deployment found for rollback');
    }

    const rollbackId = crypto.randomUUID();
    const now = new Date().toISOString();

    // Create rollback record
    await this.db
      .prepare(
        `INSERT INTO model_rollbacks (id, deployment_id, from_version_id, to_version_id, reason, triggered_by, status, rolled_back_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'completed', ?, ?)`
      )
      .bind(
        rollbackId,
        deploymentId,
        deployment.versionId,
        previousDeployment.version_id,
        reason,
        triggeredBy,
        now,
        now
      )
      .run();

    // Update deployment status
    await this.db
      .prepare(
        `UPDATE model_deployments
         SET status = 'rolled_back', rolled_back_at = ?, rollback_reason = ?
         WHERE id = ?`
      )
      .bind(now, reason, deploymentId)
      .run();

    // Activate previous deployment
    await this.db
      .prepare(
        `UPDATE model_deployments
         SET status = 'active', traffic_percent = 100
         WHERE id = ?`
      )
      .bind(previousDeployment.id)
      .run();

    // Update version statuses
    await this.updateVersion(deployment.versionId, { status: 'inactive' });
    await this.updateVersion(previousDeployment.version_id as string, { status: 'active' });

    const rollback = await this.getRollback(rollbackId);
    if (!rollback) throw new Error('Failed to create rollback record');
    return rollback;
  }

  async getRollback(id: string): Promise<RollbackRecord | undefined> {
    const result = await this.db
      .prepare('SELECT * FROM model_rollbacks WHERE id = ?')
      .bind(id)
      .first();

    if (!result) return undefined;

    return this.mapRollback(result);
  }

  async listRollbacks(deploymentId?: string): Promise<RollbackRecord[]> {
    let query = 'SELECT * FROM model_rollbacks';
    const params: unknown[] = [];

    if (deploymentId) {
      query += ' WHERE deployment_id = ?';
      params.push(deploymentId);
    }

    query += ' ORDER BY created_at DESC';

    const { results } = await this.db.prepare(query).bind(...params).all();
    return results.map((r) => this.mapRollback(r));
  }

  // === Comparison ===

  async compareVersions(versionAId: string, versionBId: string): Promise<ModelComparison> {
    const versionA = await this.getVersion(versionAId);
    const versionB = await this.getVersion(versionBId);

    if (!versionA || !versionB) {
      throw new Error('Version not found');
    }

    const metricsA = await this.getVersionMetrics(versionAId);
    const metricsB = await this.getVersionMetrics(versionBId);

    const latencyChange = metricsA.avgLatencyMs
      ? ((metricsB.avgLatencyMs - metricsA.avgLatencyMs) / metricsA.avgLatencyMs) * 100
      : 0;
    const costChange = metricsA.avgCostUsd
      ? ((metricsB.avgCostUsd - metricsA.avgCostUsd) / metricsA.avgCostUsd) * 100
      : 0;
    const errorRateChange = metricsA.errorRate
      ? ((metricsB.errorRate - metricsA.errorRate) / metricsA.errorRate) * 100
      : 0;
    const successRateChange = metricsA.successRate
      ? ((metricsB.successRate - metricsA.successRate) / metricsA.successRate) * 100
      : 0;

    let recommendation: ModelComparison['recommendation'] = 'keep_current';
    if (metricsB.errorRate > metricsA.errorRate * 1.2) {
      recommendation = 'rollback';
    } else if (metricsB.avgLatencyMs > metricsA.avgLatencyMs * 1.5) {
      recommendation = 'investigate';
    }

    return {
      versionA,
      versionB,
      metricsDiff: {
        latencyChange,
        costChange,
        errorRateChange,
        successRateChange,
      },
      recommendation,
    };
  }

  async getVersionMetrics(versionId: string): Promise<ModelMetrics> {
    const result = await this.db
      .prepare(
        `SELECT
           COUNT(*) as total_requests,
           AVG(latency_ms) as avg_latency_ms,
           AVG(cost_usd) as avg_cost_usd,
           SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) * 100.0 / COUNT(*) as error_rate,
           SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) * 100.0 / COUNT(*) as success_rate
         FROM model_requests
         WHERE version_id = ?`
      )
      .bind(versionId)
      .first();

    return {
      totalRequests: (result?.total_requests as number) || 0,
      avgLatencyMs: (result?.avg_latency_ms as number) || 0,
      avgCostUsd: (result?.avg_cost_usd as number) || 0,
      errorRate: (result?.error_rate as number) || 0,
      successRate: (result?.success_rate as number) || 100,
      p50LatencyMs: 0,
      p95LatencyMs: 0,
      p99LatencyMs: 0,
    };
  }

  // === Stats ===

  async getStats(): Promise<{
    totalVersions: number;
    activeVersions: number;
    totalDeployments: number;
    activeDeployments: number;
    totalRollbacks: number;
    versionsByProvider: { provider: string; count: number }[];
    recentDeployments: ModelDeployment[];
    recentRollbacks: RollbackRecord[];
  }> {
    const [versions, activeVersions, deployments, activeDeployments, rollbacks, byProvider] =
      await Promise.all([
        this.db.prepare('SELECT COUNT(*) as count FROM model_versions').first(),
        this.db
          .prepare("SELECT COUNT(*) as count FROM model_versions WHERE status = 'active'")
          .first(),
        this.db.prepare('SELECT COUNT(*) as count FROM model_deployments').first(),
        this.db
          .prepare("SELECT COUNT(*) as count FROM model_deployments WHERE status = 'active'")
          .first(),
        this.db.prepare('SELECT COUNT(*) as count FROM model_rollbacks').first(),
        this.db
          .prepare(
            `SELECT provider, COUNT(*) as count
             FROM model_versions
             GROUP BY provider
             ORDER BY count DESC`
          )
          .all<{ provider: string; count: number }>(),
      ]);

    const recentDeployments = await this.db
      .prepare('SELECT * FROM model_deployments ORDER BY created_at DESC LIMIT 5')
      .all();
    const recentRollbacks = await this.db
      .prepare('SELECT * FROM model_rollbacks ORDER BY created_at DESC LIMIT 5')
      .all();

    return {
      totalVersions: (versions?.count as number) || 0,
      activeVersions: (activeVersions?.count as number) || 0,
      totalDeployments: (deployments?.count as number) || 0,
      activeDeployments: (activeDeployments?.count as number) || 0,
      totalRollbacks: (rollbacks?.count as number) || 0,
      versionsByProvider: byProvider.results || [],
      recentDeployments: recentDeployments.results.map((r) => this.mapDeployment(r)),
      recentRollbacks: recentRollbacks.results.map((r) => this.mapRollback(r)),
    };
  }

  // === Helpers ===

  private mapVersion(row: Record<string, unknown>): ModelVersion {
    return {
      id: row.id as string,
      name: row.name as string,
      version: row.version as string,
      provider: row.provider as ModelVersion['provider'],
      modelId: row.model_id as string,
      status: row.status as ModelVersion['status'],
      config: row.config ? JSON.parse(row.config as string) : {},
      metrics: {
        totalRequests: 0,
        avgLatencyMs: 0,
        avgCostUsd: 0,
        errorRate: 0,
        successRate: 100,
        p50LatencyMs: 0,
        p95LatencyMs: 0,
        p99LatencyMs: 0,
      },
      notes: row.notes as string | undefined,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }

  private mapDeployment(row: Record<string, unknown>): ModelDeployment {
    return {
      id: row.id as string,
      versionId: row.version_id as string,
      environment: row.environment as ModelDeployment['environment'],
      status: row.status as ModelDeployment['status'],
      trafficPercent: row.traffic_percent as number,
      strategy: row.strategy as ModelDeployment['strategy'],
      deployedAt: row.deployed_at as string | undefined,
      rolledBackAt: row.rolled_back_at as string | undefined,
      rollbackReason: row.rollback_reason as string | undefined,
      deployedBy: row.deployed_by as string | undefined,
      createdAt: row.created_at as string,
    };
  }

  private mapRollback(row: Record<string, unknown>): RollbackRecord {
    return {
      id: row.id as string,
      deploymentId: row.deployment_id as string,
      fromVersionId: row.from_version_id as string,
      toVersionId: row.to_version_id as string,
      reason: row.reason as string,
      triggeredBy: row.triggered_by as string,
      status: row.status as RollbackRecord['status'],
      rolledBackAt: row.rolled_back_at as string | undefined,
      createdAt: row.created_at as string,
    };
  }
}
