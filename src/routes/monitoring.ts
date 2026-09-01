import { Hono } from 'hono';
import type { Env } from '../types';
import { AnomalyDetector } from '../services/observability/anomaly-detector';
import { DriftDetector } from '../services/observability/drift-detector';
import { AlertEvaluator } from '../services/observability/alert-evaluator';

const monitoring = new Hono<{ Bindings: Env }>();

// ============ Overview ============

monitoring.get('/overview', async (c) => {
  try {
    const db = c.env.DB;
    const days = parseInt(c.req.query('days') || '7');
    const anomalyDetector = new AnomalyDetector({ db });
    const driftDetector = new DriftDetector({ db });

    const [anomalyStats, driftStats, recentAnomalies, recentDrifts] = await Promise.all([
      anomalyDetector.getAnomalyStats(days),
      driftDetector.getDriftStats(days),
      anomalyDetector.getAnomalyEvents({ limit: 10 }),
      driftDetector.getDriftEvents({ limit: 10 }),
    ]);

    let systemHealth: 'healthy' | 'degraded' | 'critical' = 'healthy';
    if (anomalyStats.bySeverity?.critical || driftStats.degrading > 3) {
      systemHealth = 'critical';
    } else if (anomalyStats.bySeverity?.warning || driftStats.degrading > 0) {
      systemHealth = 'degraded';
    }

    return c.json({
      anomalyStats,
      driftStats,
      recentAnomalies,
      recentDrifts,
      systemHealth,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Failed to fetch monitoring overview', details: message }, 500);
  }
});

// ============ Run Full Evaluation ============

monitoring.post('/evaluate', async (c) => {
  try {
    const db = c.env.DB;
    const evaluator = new AlertEvaluator({ db });
    const result = await evaluator.runFullEvaluation();
    return c.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Failed to run evaluation', details: message }, 500);
  }
});

// ============ Anomalies ============

monitoring.get('/anomalies', async (c) => {
  try {
    const db = c.env.DB;
    const limit = parseInt(c.req.query('limit') || '50');
    const metric = c.req.query('metric') || undefined;
    const acknowledged = c.req.query('acknowledged') !== undefined
      ? parseInt(c.req.query('acknowledged')!)
      : undefined;

    const detector = new AnomalyDetector({ db });
    const events = await detector.getAnomalyEvents({ limit, metric, acknowledged });
    return c.json({ events });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Failed to fetch anomalies', details: message }, 500);
  }
});

monitoring.get('/anomalies/stats', async (c) => {
  try {
    const db = c.env.DB;
    const days = parseInt(c.req.query('days') || '7');
    const detector = new AnomalyDetector({ db });
    const stats = await detector.getAnomalyStats(days);
    return c.json(stats);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Failed to fetch anomaly stats', details: message }, 500);
  }
});

monitoring.put('/anomalies/:id/acknowledge', async (c) => {
  try {
    const db = c.env.DB;
    const id = c.req.param('id');
    const detector = new AnomalyDetector({ db });
    await detector.acknowledgeAnomaly(id);
    return c.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Failed to acknowledge anomaly', details: message }, 500);
  }
});

monitoring.post('/anomalies/detect', async (c) => {
  try {
    const db = c.env.DB;
    const body = await c.req.json<{ metric?: string; model?: string; hours?: number }>();
    const detector = new AnomalyDetector({ db });
    const result = await detector.analyzeMetric(
      body.metric || 'latency_ms',
      body.model || null,
      body.hours || 24
    );
    return c.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Failed to detect anomalies', details: message }, 500);
  }
});

// ============ Drift ============

monitoring.get('/drifts', async (c) => {
  try {
    const db = c.env.DB;
    const limit = parseInt(c.req.query('limit') || '50');
    const metric = c.req.query('metric') || undefined;
    const driftType = c.req.query('drift_type') || undefined;
    const acknowledged = c.req.query('acknowledged') !== undefined
      ? parseInt(c.req.query('acknowledged')!)
      : undefined;

    const detector = new DriftDetector({ db });
    const events = await detector.getDriftEvents({ limit, metric, drift_type: driftType, acknowledged });
    return c.json({ events });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Failed to fetch drifts', details: message }, 500);
  }
});

monitoring.get('/drifts/stats', async (c) => {
  try {
    const db = c.env.DB;
    const days = parseInt(c.req.query('days') || '30');
    const detector = new DriftDetector({ db });
    const stats = await detector.getDriftStats(days);
    return c.json(stats);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Failed to fetch drift stats', details: message }, 500);
  }
});

monitoring.put('/drifts/:id/acknowledge', async (c) => {
  try {
    const db = c.env.DB;
    const id = c.req.param('id');
    const detector = new DriftDetector({ db });
    await detector.acknowledgeDrift(id);
    return c.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Failed to acknowledge drift', details: message }, 500);
  }
});

monitoring.post('/drifts/detect', async (c) => {
  try {
    const db = c.env.DB;
    const body = await c.req.json<{ model?: string; window_days?: number }>();
    const detector = new DriftDetector({ db });
    const drifts = await detector.detectAllDrifts(body.model || null, body.window_days || 7);
    return c.json({ drifts });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Failed to detect drifts', details: message }, 500);
  }
});

// ============ Alert Rules (enhanced) ============

monitoring.get('/rules', async (c) => {
  try {
    const db = c.env.DB;
    const results = await db.prepare('SELECT * FROM alert_rules ORDER BY created_at DESC').all();
    return c.json({ rules: results.results });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Failed to fetch rules', details: message }, 500);
  }
});

monitoring.post('/rules', async (c) => {
  try {
    const db = c.env.DB;
    const body = await c.req.json<{
      name: string;
      metric: string;
      condition: 'gt' | 'lt' | 'eq';
      threshold: number;
      severity?: string;
      evaluation_window_minutes?: number;
      cooldown_minutes?: number;
    }>();

    const id = crypto.randomUUID();
    await db.prepare(`
      INSERT INTO alert_rules (id, name, metric, condition, threshold, enabled, severity, evaluation_window_minutes, cooldown_minutes)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)
    `).bind(
      id, body.name, body.metric, body.condition, body.threshold,
      body.severity || 'warning',
      body.evaluation_window_minutes || 5,
      body.cooldown_minutes || 15
    ).run();

    return c.json({ id });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Failed to create rule', details: message }, 500);
  }
});

monitoring.put('/rules/:id/toggle', async (c) => {
  try {
    const db = c.env.DB;
    const id = c.req.param('id');
    await db.prepare('UPDATE alert_rules SET enabled = CASE WHEN enabled = 1 THEN 0 ELSE 1 END WHERE id = ?').bind(id).run();
    return c.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Failed to toggle rule', details: message }, 500);
  }
});

monitoring.delete('/rules/:id', async (c) => {
  try {
    const db = c.env.DB;
    const id = c.req.param('id');
    await db.prepare('DELETE FROM alert_rules WHERE id = ?').bind(id).run();
    return c.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Failed to delete rule', details: message }, 500);
  }
});

// ============ Snapshots ============

monitoring.get('/snapshots', async (c) => {
  try {
    const db = c.env.DB;
    const metric = c.req.query('metric') || 'latency_ms';
    const hours = parseInt(c.req.query('hours') || '24');

    const results = await db.prepare(`
      SELECT * FROM metric_snapshots
      WHERE metric = ? AND created_at >= datetime('now', '-${hours} hours')
      ORDER BY created_at ASC
    `).bind(metric).all();

    return c.json({ snapshots: results.results });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Failed to fetch snapshots', details: message }, 500);
  }
});

// ============ Alert Events ============

monitoring.get('/events', async (c) => {
  try {
    const db = c.env.DB;
    const limit = parseInt(c.req.query('limit') || '50');
    const results = await db.prepare(`
      SELECT * FROM alert_events ORDER BY created_at DESC LIMIT ?
    `).bind(limit).all();
    return c.json({ events: results.results });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Failed to fetch events', details: message }, 500);
  }
});

monitoring.put('/events/:id/acknowledge', async (c) => {
  try {
    const db = c.env.DB;
    const id = c.req.param('id');
    await db.prepare('UPDATE alert_events SET acknowledged = 1 WHERE id = ?').bind(id).run();
    return c.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Failed to acknowledge event', details: message }, 500);
  }
});

export default monitoring;
