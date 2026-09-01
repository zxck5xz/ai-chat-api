export interface DriftDetectorConfig {
  db: D1Database;
}

export interface DriftEvent {
  id: string;
  metric: string;
  model: string | null;
  drift_type: 'accuracy' | 'cost' | 'latency' | 'quality';
  direction: 'improving' | 'degrading';
  baseline_value: number;
  current_value: number;
  change_pct: number;
  window_days: number;
  description: string;
  acknowledged: number;
  created_at: string;
}

export interface DriftResult {
  has_drift: boolean;
  direction: 'improving' | 'degrading' | 'stable';
  baseline_value: number;
  current_value: number;
  change_pct: number;
  description: string;
}

export class DriftDetector {
  private db: D1Database;

  constructor(config: DriftDetectorConfig) {
    this.db = config.db;
  }

  async detectLatencyDrift(model: string | null, baselineDays = 7, currentDays = 7): Promise<DriftResult> {
    const modelFilter = model ? 'AND model = ?' : '';
    const modelParam = model ? [model] : [];

    const baseline = await this.db.prepare(`
      SELECT AVG(latency_ms) as avg_latency
      FROM trace_spans
      WHERE started_at >= datetime('now', '-${baselineDays + currentDays} days')
        AND started_at < datetime('now', '-${currentDays} days')
        AND latency_ms > 0
        ${modelFilter}
    `).bind(...modelParam).first<{ avg_latency: number }>();

    const current = await this.db.prepare(`
      SELECT AVG(latency_ms) as avg_latency
      FROM trace_spans
      WHERE started_at >= datetime('now', '-${currentDays} days')
        AND latency_ms > 0
        ${modelFilter}
    `).bind(...modelParam).first<{ avg_latency: number }>();

    const baseVal = baseline?.avg_latency || 0;
    const currVal = current?.avg_latency || 0;
    const changePct = baseVal > 0 ? ((currVal - baseVal) / baseVal) * 100 : 0;

    let direction: 'improving' | 'degrading' | 'stable' = 'stable';
    if (Math.abs(changePct) > 10) {
      direction = changePct > 0 ? 'degrading' : 'improving';
    }

    return {
      has_drift: direction !== 'stable',
      direction,
      baseline_value: Math.round(baseVal * 100) / 100,
      current_value: Math.round(currVal * 100) / 100,
      change_pct: Math.round(changePct * 100) / 100,
      description: `Latency ${direction}: ${baseVal.toFixed(0)}ms → ${currVal.toFixed(0)}ms (${changePct > 0 ? '+' : ''}${changePct.toFixed(1)}%)`,
    };
  }

  async detectCostDrift(model: string | null, baselineDays = 7, currentDays = 7): Promise<DriftResult> {
    const modelFilter = model ? 'AND model = ?' : '';
    const modelParam = model ? [model] : [];

    const baseline = await this.db.prepare(`
      SELECT AVG(cost_usd) as avg_cost
      FROM trace_spans
      WHERE started_at >= datetime('now', '-${baselineDays + currentDays} days')
        AND started_at < datetime('now', '-${currentDays} days')
        AND cost_usd > 0
        ${modelFilter}
    `).bind(...modelParam).first<{ avg_cost: number }>();

    const current = await this.db.prepare(`
      SELECT AVG(cost_usd) as avg_cost
      FROM trace_spans
      WHERE started_at >= datetime('now', '-${currentDays} days')
        AND cost_usd > 0
        ${modelFilter}
    `).bind(...modelParam).first<{ avg_cost: number }>();

    const baseVal = baseline?.avg_cost || 0;
    const currVal = current?.avg_cost || 0;
    const changePct = baseVal > 0 ? ((currVal - baseVal) / baseVal) * 100 : 0;

    let direction: 'improving' | 'degrading' | 'stable' = 'stable';
    if (Math.abs(changePct) > 15) {
      direction = changePct > 0 ? 'degrading' : 'improving';
    }

    return {
      has_drift: direction !== 'stable',
      direction,
      baseline_value: Math.round(baseVal * 1000000) / 1000000,
      current_value: Math.round(currVal * 1000000) / 1000000,
      change_pct: Math.round(changePct * 100) / 100,
      description: `Cost ${direction}: $${baseVal.toFixed(6)} → $${currVal.toFixed(6)} (${changePct > 0 ? '+' : ''}${changePct.toFixed(1)}%)`,
    };
  }

  async detectErrorRateDrift(model: string | null, baselineDays = 7, currentDays = 7): Promise<DriftResult> {
    const modelFilter = model ? 'AND model = ?' : '';
    const modelParam = model ? [model] : [];

    const baseline = await this.db.prepare(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as errors
      FROM trace_spans
      WHERE started_at >= datetime('now', '-${baselineDays + currentDays} days')
        AND started_at < datetime('now', '-${currentDays} days')
        ${modelFilter}
    `).bind(...modelParam).first<{ total: number; errors: number }>();

    const current = await this.db.prepare(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as errors
      FROM trace_spans
      WHERE started_at >= datetime('now', '-${currentDays} days')
        ${modelFilter}
    `).bind(...modelParam).first<{ total: number; errors: number }>();

    const baseTotal = baseline?.total || 0;
    const baseErrors = baseline?.errors || 0;
    const currTotal = current?.total || 0;
    const currErrors = current?.errors || 0;
    const baseRate = baseTotal > 0 ? (baseErrors / baseTotal) * 100 : 0;
    const currRate = currTotal > 0 ? (currErrors / currTotal) * 100 : 0;
    const changePct = baseRate > 0 ? ((currRate - baseRate) / baseRate) * 100 : 0;

    let direction: 'improving' | 'degrading' | 'stable' = 'stable';
    if (Math.abs(currRate - baseRate) > 2) {
      direction = currRate > baseRate ? 'degrading' : 'improving';
    }

    return {
      has_drift: direction !== 'stable',
      direction,
      baseline_value: Math.round(baseRate * 100) / 100,
      current_value: Math.round(currRate * 100) / 100,
      change_pct: Math.round(changePct * 100) / 100,
      description: `Error rate ${direction}: ${baseRate.toFixed(1)}% → ${currRate.toFixed(1)}%`,
    };
  }

  async detectAccuracyDrift(baselineDays = 7, currentDays = 7): Promise<DriftResult> {
    const baseline = await this.db.prepare(`
      SELECT AVG(score) as avg_score
      FROM eval_results
      WHERE created_at >= datetime('now', '-${baselineDays + currentDays} days')
        AND created_at < datetime('now', '-${currentDays} days')
    `).first<{ avg_score: number }>();

    const current = await this.db.prepare(`
      SELECT AVG(score) as avg_score
      FROM eval_results
      WHERE created_at >= datetime('now', '-${currentDays} days')
    `).first<{ avg_score: number }>();

    const baseVal = (baseline?.avg_score || 0) * 100;
    const currVal = (current?.avg_score || 0) * 100;
    const changePct = baseVal > 0 ? ((currVal - baseVal) / baseVal) * 100 : 0;

    let direction: 'improving' | 'degrading' | 'stable' = 'stable';
    if (Math.abs(changePct) > 5) {
      direction = changePct > 0 ? 'improving' : 'degrading';
    }

    return {
      has_drift: direction !== 'stable',
      direction,
      baseline_value: Math.round(baseVal * 100) / 100,
      current_value: Math.round(currVal * 100) / 100,
      change_pct: Math.round(changePct * 100) / 100,
      description: `Accuracy ${direction}: ${baseVal.toFixed(1)}% → ${currVal.toFixed(1)}%`,
    };
  }

  async detectAllDrifts(model: string | null, windowDays = 7): Promise<DriftResult[]> {
    return Promise.all([
      this.detectLatencyDrift(model, windowDays, windowDays),
      this.detectCostDrift(model, windowDays, windowDays),
      this.detectErrorRateDrift(model, windowDays, windowDays),
      this.detectAccuracyDrift(windowDays, windowDays),
    ]);
  }

  async saveDriftEvent(event: Omit<DriftEvent, 'id' | 'created_at'>): Promise<string> {
    const id = crypto.randomUUID();
    await this.db.prepare(`
      INSERT INTO drift_events (id, metric, model, drift_type, direction, baseline_value, current_value, change_pct, window_days, description, acknowledged)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `).bind(
      id, event.metric, event.model, event.drift_type, event.direction,
      event.baseline_value, event.current_value, event.change_pct,
      event.window_days, event.description
    ).run();
    return id;
  }

  async getDriftEvents(params: { limit?: number; metric?: string; drift_type?: string; acknowledged?: number } = {}): Promise<DriftEvent[]> {
    const conditions: string[] = [];
    const binds: (string | number)[] = [];

    if (params.metric) { conditions.push('metric = ?'); binds.push(params.metric); }
    if (params.drift_type) { conditions.push('drift_type = ?'); binds.push(params.drift_type); }
    if (params.acknowledged !== undefined) { conditions.push('acknowledged = ?'); binds.push(params.acknowledged); }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = params.limit || 50;

    const results = await this.db.prepare(`
      SELECT * FROM drift_events ${where} ORDER BY created_at DESC LIMIT ?
    `).bind(...binds, limit).all<DriftEvent>();

    return results.results;
  }

  async acknowledgeDrift(id: string): Promise<void> {
    await this.db.prepare('UPDATE drift_events SET acknowledged = 1 WHERE id = ?').bind(id).run();
  }

  async getDriftStats(days = 30): Promise<{
    total: number;
    degrading: number;
    improving: number;
    byType: Record<string, number>;
    unacknowledged: number;
  }> {
    const rows = await this.db.prepare(`
      SELECT * FROM drift_events WHERE created_at >= datetime('now', '-${days} days')
    `).all<DriftEvent>();

    const events = rows.results;
    const byType: Record<string, number> = {};

    for (const e of events) {
      byType[e.drift_type] = (byType[e.drift_type] || 0) + 1;
    }

    return {
      total: events.length,
      degrading: events.filter((e) => e.direction === 'degrading').length,
      improving: events.filter((e) => e.direction === 'improving').length,
      byType,
      unacknowledged: events.filter((e) => !e.acknowledged).length,
    };
  }
}
