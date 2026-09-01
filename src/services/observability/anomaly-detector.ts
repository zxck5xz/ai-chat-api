export interface AnomalyDetectorConfig {
  db: D1Database;
}

export interface AnomalyEvent {
  id: string;
  metric: string;
  model: string | null;
  anomaly_type: 'spike' | 'drop' | 'drift' | 'outlier';
  severity: 'info' | 'warning' | 'critical';
  actual_value: number;
  expected_min: number | null;
  expected_max: number | null;
  z_score: number | null;
  description: string;
  acknowledged: number;
  created_at: string;
}

export interface DataPoint {
  value: number;
  timestamp: string;
}

export interface AnomalyResult {
  is_anomaly: boolean;
  z_score: number;
  severity: 'info' | 'warning' | 'critical';
  anomaly_type: 'spike' | 'drop' | 'drift' | 'outlier';
  expected_min: number;
  expected_max: number;
  description: string;
}

export class AnomalyDetector {
  private db: D1Database;

  constructor(config: AnomalyDetectorConfig) {
    this.db = config.db;
  }

  mean(values: number[]): number {
    if (values.length === 0) return 0;
    return values.reduce((sum, v) => sum + v, 0) / values.length;
  }

  stddev(values: number[]): number {
    if (values.length < 2) return 0;
    const m = this.mean(values);
    const variance = values.reduce((sum, v) => sum + (v - m) ** 2, 0) / (values.length - 1);
    return Math.sqrt(variance);
  }

  median(values: number[]): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  movingAverage(values: number[], windowSize: number): number[] {
    const result: number[] = [];
    for (let i = 0; i < values.length; i++) {
      const start = Math.max(0, i - windowSize + 1);
      const window = values.slice(start, i + 1);
      result.push(this.mean(window));
    }
    return result;
  }

  detectZScore(value: number, values: number[]): AnomalyResult {
    const m = this.mean(values);
    const sd = this.stddev(values);
    if (sd === 0) {
      return { is_anomaly: false, z_score: 0, severity: 'info', anomaly_type: 'outlier', expected_min: m, expected_max: m, description: 'No variance in data' };
    }
    const z = (value - m) / sd;
    const absZ = Math.abs(z);

    const iqr = this.computeIQR(values);
    const expectedMin = m - 2 * sd;
    const expectedMax = m + 2 * sd;

    let isAnomaly = false;
    let severity: 'info' | 'warning' | 'critical' = 'info';
    let anomalyType: 'spike' | 'drop' | 'drift' | 'outlier' = 'outlier';

    if (absZ > 3) {
      isAnomaly = true;
      severity = 'critical';
      anomalyType = z > 0 ? 'spike' : 'drop';
    } else if (absZ > 2) {
      isAnomaly = true;
      severity = 'warning';
      anomalyType = z > 0 ? 'spike' : 'drop';
    } else if (absZ > 1.5) {
      isAnomaly = true;
      severity = 'info';
      anomalyType = 'outlier';
    }

    const desc = isAnomaly
      ? `Value ${value.toFixed(2)} is ${absZ.toFixed(1)} std devs from mean (${m.toFixed(2)})`
      : `Value ${value.toFixed(2)} within normal range (mean: ${m.toFixed(2)}, z: ${z.toFixed(2)})`;

    return {
      is_anomaly: isAnomaly,
      z_score: Math.round(z * 100) / 100,
      severity,
      anomaly_type: anomalyType,
      expected_min: Math.round(expectedMin * 100) / 100,
      expected_max: Math.round(expectedMax * 100) / 100,
      description: desc,
    };
  }

  private computeIQR(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    const q1 = sorted[Math.floor(sorted.length * 0.25)] || 0;
    const q3 = sorted[Math.floor(sorted.length * 0.75)] || 0;
    return q3 - q1;
  }

  detectSpike(currentValue: number, previousValues: number[]): AnomalyResult {
    if (previousValues.length < 3) {
      return { is_anomaly: false, z_score: 0, severity: 'info', anomaly_type: 'spike', expected_min: 0, expected_max: 0, description: 'Insufficient data for spike detection' };
    }
    const recentAvg = this.mean(previousValues.slice(-5));
    const changePct = recentAvg > 0 ? ((currentValue - recentAvg) / recentAvg) * 100 : 0;

    const sd = this.stddev(previousValues);
    const z = sd > 0 ? (currentValue - recentAvg) / sd : 0;

    let isAnomaly = false;
    let severity: 'info' | 'warning' | 'critical' = 'info';
    let anomalyType: 'spike' | 'drop' = 'spike';

    if (Math.abs(changePct) > 100 || Math.abs(z) > 3) {
      isAnomaly = true;
      severity = 'critical';
      anomalyType = changePct > 0 ? 'spike' : 'drop';
    } else if (Math.abs(changePct) > 50 || Math.abs(z) > 2) {
      isAnomaly = true;
      severity = 'warning';
      anomalyType = changePct > 0 ? 'spike' : 'drop';
    } else if (Math.abs(changePct) > 25 || Math.abs(z) > 1.5) {
      isAnomaly = true;
      severity = 'info';
      anomalyType = changePct > 0 ? 'spike' : 'drop';
    }

    return {
      is_anomaly: isAnomaly,
      z_score: Math.round(z * 100) / 100,
      severity,
      anomaly_type: anomalyType,
      expected_min: Math.round((recentAvg - 2 * sd) * 100) / 100,
      expected_max: Math.round((recentAvg + 2 * sd) * 100) / 100,
      description: `${anomalyType === 'spike' ? 'Spike' : 'Drop'}: ${changePct > 0 ? '+' : ''}${changePct.toFixed(1)}% from recent average`,
    };
  }

  async analyzeMetric(metric: string, model: string | null, hours = 24): Promise<AnomalyResult> {
    const modelFilter = model ? 'AND model = ?' : '';
    const params = model ? [metric, model] : [metric];

    const rows = await this.db.prepare(`
      SELECT value FROM metric_snapshots
      WHERE metric = ? ${modelFilter}
        AND created_at >= datetime('now', '-${hours} hours')
      ORDER BY created_at ASC
    `).bind(...params).all<{ value: number }>();

    const values = rows.results.map((r) => r.value);
    if (values.length < 3) {
      return { is_anomaly: false, z_score: 0, severity: 'info', anomaly_type: 'outlier', expected_min: 0, expected_max: 0, description: 'Insufficient data points' };
    }

    const currentValue = values[values.length - 1];
    const historical = values.slice(0, -1);

    const zResult = this.detectZScore(currentValue, historical);
    const spikeResult = this.detectSpike(currentValue, historical);

    if (spikeResult.is_anomaly && spikeResult.severity === 'critical') return spikeResult;
    if (zResult.is_anomaly && zResult.severity === 'critical') return zResult;
    if (spikeResult.is_anomaly) return spikeResult;
    return zResult;
  }

  async recordSnapshot(metric: string, model: string | null, value: number, sampleCount: number, windowMinutes: number): Promise<void> {
    const id = crypto.randomUUID();
    await this.db.prepare(`
      INSERT INTO metric_snapshots (id, metric, model, value, sample_count, window_minutes)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(id, metric, model, value, sampleCount, windowMinutes).run();
  }

  async saveAnomalyEvent(event: Omit<AnomalyEvent, 'id' | 'created_at'>): Promise<string> {
    const id = crypto.randomUUID();
    await this.db.prepare(`
      INSERT INTO anomaly_events (id, metric, model, anomaly_type, severity, actual_value, expected_min, expected_max, z_score, description, acknowledged)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `).bind(
      id, event.metric, event.model, event.anomaly_type, event.severity,
      event.actual_value, event.expected_min, event.expected_max,
      event.z_score, event.description
    ).run();
    return id;
  }

  async getAnomalyEvents(params: { limit?: number; metric?: string; acknowledged?: number } = {}): Promise<AnomalyEvent[]> {
    const conditions: string[] = [];
    const binds: (string | number)[] = [];

    if (params.metric) { conditions.push('metric = ?'); binds.push(params.metric); }
    if (params.acknowledged !== undefined) { conditions.push('acknowledged = ?'); binds.push(params.acknowledged); }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = params.limit || 50;

    const results = await this.db.prepare(`
      SELECT * FROM anomaly_events ${where} ORDER BY created_at DESC LIMIT ?
    `).bind(...binds, limit).all<AnomalyEvent>();

    return results.results;
  }

  async acknowledgeAnomaly(id: string): Promise<void> {
    await this.db.prepare('UPDATE anomaly_events SET acknowledged = 1 WHERE id = ?').bind(id).run();
  }

  async getAnomalyStats(days = 7): Promise<{
    total: number;
    bySeverity: Record<string, number>;
    byType: Record<string, number>;
    byMetric: Record<string, number>;
    unacknowledged: number;
  }> {
    const rows = await this.db.prepare(`
      SELECT * FROM anomaly_events WHERE created_at >= datetime('now', '-${days} days')
    `).all<AnomalyEvent>();

    const events = rows.results;
    const bySeverity: Record<string, number> = {};
    const byType: Record<string, number> = {};
    const byMetric: Record<string, number> = {};

    for (const e of events) {
      bySeverity[e.severity] = (bySeverity[e.severity] || 0) + 1;
      byType[e.anomaly_type] = (byType[e.anomaly_type] || 0) + 1;
      byMetric[e.metric] = (byMetric[e.metric] || 0) + 1;
    }

    return {
      total: events.length,
      bySeverity,
      byType,
      byMetric,
      unacknowledged: events.filter((e) => !e.acknowledged).length,
    };
  }
}
