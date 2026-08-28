export interface LatencyProfilerConfig {
  db: D1Database;
}

export interface LatencyPercentile {
  model: string;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
  avg: number;
  count: number;
}

export interface LatencyTimeSeries {
  date: string;
  model: string;
  avg_latency: number;
  p50: number;
  p95: number;
  request_count: number;
}

export class LatencyProfiler {
  private db: D1Database;

  constructor(config: LatencyProfilerConfig) {
    this.db = config.db;
  }

  async getPercentiles(params: {
    days?: number;
    model?: string;
  }): Promise<LatencyPercentile[]> {
    const days = params.days || 7;
    let whereClause = `WHERE started_at >= datetime('now', '-${days} days') AND latency_ms > 0`;
    const bindParams: string[] = [];

    if (params.model) {
      whereClause += ' AND model = ?';
      bindParams.push(params.model);
    }

    // Get latency values grouped by model for percentile calculation
    const results = await this.db.prepare(`
      SELECT 
        model,
        latency_ms
      FROM trace_spans
      ${whereClause}
        AND model IS NOT NULL
      ORDER BY model, latency_ms
    `).bind(...bindParams).all();

    const byModel = new Map<string, number[]>();
    for (const row of results.results as { model: string; latency_ms: number }[]) {
      const arr = byModel.get(row.model) || [];
      arr.push(row.latency_ms);
      byModel.set(row.model, arr);
    }

    const percentiles: LatencyPercentile[] = [];
    for (const [model, values] of byModel) {
      if (values.length === 0) continue;
      values.sort((a, b) => a - b);
      percentiles.push({
        model,
        p50: this.percentile(values, 50),
        p90: this.percentile(values, 90),
        p95: this.percentile(values, 95),
        p99: this.percentile(values, 99),
        avg: Math.round(values.reduce((a, b) => a + b, 0) / values.length),
        count: values.length,
      });
    }

    return percentiles;
  }

  async getTimeSeries(params: {
    days?: number;
    model?: string;
  }): Promise<LatencyTimeSeries[]> {
    const days = params.days || 30;
    let whereClause = `WHERE started_at >= datetime('now', '-${days} days') AND latency_ms > 0`;
    const bindParams: string[] = [];

    if (params.model) {
      whereClause += ' AND model = ?';
      bindParams.push(params.model);
    }

    const results = await this.db.prepare(`
      SELECT 
        date(started_at) as date,
        model,
        AVG(latency_ms) as avg_latency,
        MIN(latency_ms) as p50,
        MAX(latency_ms) as p95,
        COUNT(*) as request_count
      FROM trace_spans
      ${whereClause}
      GROUP BY date(started_at), model
      ORDER BY date(started_at)
    `).bind(...bindParams).all();

    return results.results as unknown as LatencyTimeSeries[];
  }

  async getSlowTraces(params: {
    limit?: number;
    threshold_ms?: number;
    model?: string;
  }): Promise<unknown[]> {
    const limit = params.limit || 20;
    const threshold = params.threshold_ms || 5000;
    let whereClause = 'WHERE latency_ms > ? AND model IS NOT NULL';
    const bindParams: (string | number)[] = [threshold];

    if (params.model) {
      whereClause += ' AND model = ?';
      bindParams.push(params.model);
    }

    const results = await this.db.prepare(`
      SELECT ts.*, t.user_id, t.operation
      FROM trace_spans ts
      LEFT JOIN traces t ON ts.trace_id = t.id
      ${whereClause}
      ORDER BY latency_ms DESC
      LIMIT ?
    `).bind(...bindParams, limit).all();

    return results.results;
  }

  private percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    const index = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, index)];
  }
}
