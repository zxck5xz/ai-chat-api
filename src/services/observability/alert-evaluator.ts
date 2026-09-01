import { AnomalyDetector } from './anomaly-detector';
import { DriftDetector } from './drift-detector';

export interface AlertEvaluatorConfig {
  db: D1Database;
}

export interface AlertRule {
  id: string;
  name: string;
  metric: string;
  condition: 'gt' | 'lt' | 'eq';
  threshold: number;
  enabled: number;
  severity: string;
  evaluation_window_minutes: number;
  cooldown_minutes: number;
  last_evaluated_at: string | null;
  created_at: string;
}

export interface EvaluationResult {
  rule_id: string;
  rule_name: string;
  triggered: boolean;
  actual_value: number;
  threshold: number;
  severity: string;
  message: string;
}

export class AlertEvaluator {
  private db: D1Database;
  private anomalyDetector: AnomalyDetector;
  private driftDetector: DriftDetector;

  constructor(config: AlertEvaluatorConfig) {
    this.db = config.db;
    this.anomalyDetector = new AnomalyDetector(config);
    this.driftDetector = new DriftDetector(config);
  }

  async getMetricValue(metric: string, windowMinutes: number): Promise<number> {
    switch (metric) {
      case 'latency_ms': {
        const row = await this.db.prepare(`
          SELECT AVG(latency_ms) as value FROM trace_spans
          WHERE started_at >= datetime('now', '-${windowMinutes} minutes')
            AND latency_ms > 0
        `).first<{ value: number }>();
        return row?.value || 0;
      }
      case 'cost_usd': {
        const row = await this.db.prepare(`
          SELECT SUM(cost_usd) as value FROM trace_spans
          WHERE started_at >= datetime('now', '-${windowMinutes} minutes')
        `).first<{ value: number }>();
        return row?.value || 0;
      }
      case 'error_rate': {
        const row = await this.db.prepare(`
          SELECT 
            COUNT(*) as total,
            SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as errors
          FROM trace_spans
          WHERE started_at >= datetime('now', '-${windowMinutes} minutes')
        `).first<{ total: number; errors: number }>();
        if (!row || row.total === 0) return 0;
        return (row.errors / row.total) * 100;
      }
      case 'tokens': {
        const row = await this.db.prepare(`
          SELECT SUM(total_tokens) as value FROM trace_spans
          WHERE started_at >= datetime('now', '-${windowMinutes} minutes')
        `).first<{ value: number }>();
        return row?.value || 0;
      }
      case 'request_count': {
        const row = await this.db.prepare(`
          SELECT COUNT(*) as value FROM trace_spans
          WHERE started_at >= datetime('now', '-${windowMinutes} minutes')
        `).first<{ value: number }>();
        return row?.value || 0;
      }
      default:
        return 0;
    }
  }

  evaluateCondition(value: number, condition: string, threshold: number): boolean {
    switch (condition) {
      case 'gt': return value > threshold;
      case 'lt': return value < threshold;
      case 'eq': return Math.abs(value - threshold) < 0.001;
      default: return false;
    }
  }

  async evaluateRule(rule: AlertRule): Promise<EvaluationResult> {
    const actualValue = await this.getMetricValue(rule.metric, rule.evaluation_window_minutes);
    const triggered = this.evaluateCondition(actualValue, rule.condition, rule.threshold);

    const conditionStr = rule.condition === 'gt' ? '>' : rule.condition === 'lt' ? '<' : '=';
    const message = triggered
      ? `${rule.name}: ${rule.metric} = ${actualValue.toFixed(2)} ${conditionStr} ${rule.threshold} (TRIGGERED)`
      : `${rule.name}: ${rule.metric} = ${actualValue.toFixed(2)} ${conditionStr} ${rule.threshold} (OK)`;

    return {
      rule_id: rule.id,
      rule_name: rule.name,
      triggered,
      actual_value: Math.round(actualValue * 100) / 100,
      threshold: rule.threshold,
      severity: rule.severity,
      message,
    };
  }

  async isInCooldown(rule: AlertRule): Promise<boolean> {
    if (!rule.last_evaluated_at) return false;

    const lastEval = new Date(rule.last_evaluated_at).getTime();
    const cooldownMs = rule.cooldown_minutes * 60 * 1000;
    return Date.now() - lastEval < cooldownMs;
  }

  async evaluateAllRules(): Promise<EvaluationResult[]> {
    const rulesRes = await this.db.prepare(
      'SELECT * FROM alert_rules WHERE enabled = 1'
    ).all<AlertRule>();

    const results: EvaluationResult[] = [];

    for (const rule of rulesRes.results) {
      const inCooldown = await this.isInCooldown(rule);
      if (inCooldown) continue;

      const result = await this.evaluateRule(rule);
      results.push(result);

      // Update last_evaluated_at
      await this.db.prepare(
        'UPDATE alert_rules SET last_evaluated_at = datetime(\'now\') WHERE id = ?'
      ).bind(rule.id).run();

      // Create alert event if triggered
      if (result.triggered) {
        const eventId = crypto.randomUUID();
        await this.db.prepare(`
          INSERT INTO alert_events (id, rule_id, rule_name, metric, actual_value, threshold, acknowledged)
          VALUES (?, ?, ?, ?, ?, ?, 0)
        `).bind(eventId, rule.id, rule.name, rule.metric, result.actual_value, rule.threshold).run();
      }
    }

    return results;
  }

  async recordMetricSnapshots(): Promise<void> {
    const metrics = [
      { metric: 'latency_ms', window: 5 },
      { metric: 'cost_usd', window: 5 },
      { metric: 'error_rate', window: 5 },
      { metric: 'tokens', window: 5 },
      { metric: 'request_count', window: 5 },
    ];

    for (const { metric, window: w } of metrics) {
      const value = await this.getMetricValue(metric, w);
      await this.anomalyDetector.recordSnapshot(metric, null, value, 0, w);
    }
  }

  async runAnomalyDetection(): Promise<void> {
    const metrics = ['latency_ms', 'cost_usd', 'error_rate', 'tokens'];

    for (const metric of metrics) {
      const result = await this.anomalyDetector.analyzeMetric(metric, null, 24);
      if (result.is_anomaly) {
        await this.anomalyDetector.saveAnomalyEvent({
          metric,
          model: null,
          anomaly_type: result.anomaly_type,
          severity: result.severity,
          actual_value: 0,
          expected_min: result.expected_min,
          expected_max: result.expected_max,
          z_score: result.z_score,
          description: result.description,
          acknowledged: 0,
        });
      }
    }
  }

  async runDriftDetection(): Promise<void> {
    const drifts = await this.driftDetector.detectAllDrifts(null, 7);

    const driftTypes: Array<'latency' | 'cost' | 'error_rate' | 'accuracy'> = [
      'latency', 'cost', 'error_rate', 'accuracy',
    ];

    for (let i = 0; i < drifts.length; i++) {
      const d = drifts[i];
      if (d.has_drift) {
        await this.driftDetector.saveDriftEvent({
          metric: driftTypes[i],
          model: null,
          drift_type: driftTypes[i] as 'accuracy' | 'cost' | 'latency' | 'quality',
          direction: d.direction as 'improving' | 'degrading',
          baseline_value: d.baseline_value,
          current_value: d.current_value,
          change_pct: d.change_pct,
          window_days: 7,
          description: d.description,
          acknowledged: 0,
        });
      }
    }
  }

  async runFullEvaluation(): Promise<{
    alertResults: EvaluationResult[];
    anomaliesDetected: number;
    driftsDetected: number;
  }> {
    await this.recordMetricSnapshots();
    const alertResults = await this.evaluateAllRules();
    await this.runAnomalyDetection();
    await this.runDriftDetection();

    const anomalies = await this.anomalyDetector.getAnomalyEvents({ limit: 100 });
    const drifts = await this.driftDetector.getDriftEvents({ limit: 100 });

    return {
      alertResults,
      anomaliesDetected: anomalies.length,
      driftsDetected: drifts.length,
    };
  }
}
