import { Hono } from 'hono';
import type { Env } from '../types';
import { Tracer } from '../services/observability/tracer';
import { CostTracker } from '../services/observability/cost-tracker';
import { LatencyProfiler } from '../services/observability/latency-profiler';

const observability = new Hono<{ Bindings: Env }>();

// ============ Metrics ============

observability.get('/metrics', async (c) => {
  try {
    const db = c.env.DB;
    const days = parseInt(c.req.query('days') || '30');

    const traces = await db.prepare(`
      SELECT COUNT(*) as total FROM traces
      WHERE started_at >= datetime('now', '-${days} days')
    `).first() as { total: number } | null;

    const spans = await db.prepare(`
      SELECT 
        COUNT(*) as total,
        COALESCE(SUM(total_tokens), 0) as tokens,
        COALESCE(SUM(cost_usd), 0) as cost,
        COALESCE(AVG(latency_ms), 0) as avg_latency,
        SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as errors
      FROM trace_spans
      WHERE started_at >= datetime('now', '-${days} days')
    `).first() as {
      total: number;
      tokens: number;
      cost: number;
      avg_latency: number;
      errors: number;
    } | null;

    const alerts = await db.prepare(`
      SELECT COUNT(*) as active FROM alert_events WHERE acknowledged = 0
    `).first() as { active: number } | null;

    const errorRate = (spans?.total || 0) > 0
      ? ((spans?.errors || 0) / (spans?.total || 1)) * 100
      : 0;

    return c.json({
      total_traces: traces?.total || 0,
      total_spans: spans?.total || 0,
      total_tokens: spans?.tokens || 0,
      total_cost_usd: Math.round((spans?.cost || 0) * 10000) / 10000,
      avg_latency_ms: Math.round(spans?.avg_latency || 0),
      error_rate: Math.round(errorRate * 100) / 100,
      active_alerts: alerts?.active || 0,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Failed to fetch metrics', details: message }, 500);
  }
});

// ============ Traces ============

observability.get('/traces', async (c) => {
  try {
    const db = c.env.DB;
    const limit = parseInt(c.req.query('limit') || '50');
    const offset = parseInt(c.req.query('offset') || '0');
    const user_id = c.req.query('user_id');
    const operation = c.req.query('operation');
    const start_date = c.req.query('start_date');
    const end_date = c.req.query('end_date');

    const tracer = new Tracer({ db });
    const traces = await tracer.getTraces({ limit, offset, user_id, operation, start_date, end_date });

    return c.json({ traces, limit, offset });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Failed to fetch traces', details: message }, 500);
  }
});

observability.get('/traces/:id', async (c) => {
  try {
    const db = c.env.DB;
    const traceId = c.req.param('id');

    const tracer = new Tracer({ db });
    const trace = await tracer.getTraceById(traceId);
    if (!trace) return c.json({ error: 'Trace not found' }, 404);

    const spans = await tracer.getTraceSpans(traceId);
    return c.json({ trace, spans });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Failed to fetch trace', details: message }, 500);
  }
});

// Create trace (for recording new requests)
observability.post('/traces', async (c) => {
  try {
    const db = c.env.DB;
    const body = await c.req.json<{ user_id?: string; operation?: string }>();

    const tracer = new Tracer({ db });
    const traceId = await tracer.createTrace(body.user_id, body.operation);
    return c.json({ id: traceId });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Failed to create trace', details: message }, 500);
  }
});

// Create span
observability.post('/traces/:traceId/spans', async (c) => {
  try {
    const db = c.env.DB;
    const traceId = c.req.param('traceId');
    const body = await c.req.json<{
      parent_span_id?: string;
      operation: string;
      service: string;
      model?: string;
      metadata?: Record<string, unknown>;
    }>();

    const tracer = new Tracer({ db });
    const spanId = await tracer.startSpan({
      trace_id: traceId,
      parent_span_id: body.parent_span_id,
      operation: body.operation,
      service: body.service,
      model: body.model,
      metadata: body.metadata,
    });
    return c.json({ id: spanId });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Failed to create span', details: message }, 500);
  }
});

// End span
observability.put('/spans/:id/end', async (c) => {
  try {
    const db = c.env.DB;
    const spanId = c.req.param('id');
    const body = await c.req.json<{
      status: 'ok' | 'error' | 'timeout';
      input_tokens: number;
      output_tokens: number;
      total_tokens: number;
      cost_usd: number;
      latency_ms: number;
    }>();

    const tracer = new Tracer({ db });
    await tracer.endSpan({ id: spanId, ...body });
    return c.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Failed to end span', details: message }, 500);
  }
});

// Complete trace
observability.put('/traces/:id/complete', async (c) => {
  try {
    const db = c.env.DB;
    const traceId = c.req.param('id');
    const body = await c.req.json<{ status?: 'ok' | 'error' | 'partial' }>();

    const tracer = new Tracer({ db });
    await tracer.completeTrace(traceId, body.status);
    return c.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Failed to complete trace', details: message }, 500);
  }
});

// ============ Cost Tracking ============

observability.get('/cost/summary', async (c) => {
  try {
    const db = c.env.DB;
    const days = parseInt(c.req.query('days') || '30');
    const model = c.req.query('model');

    const tracker = new CostTracker({ db });
    const summary = await tracker.getCostSummary({ days, model: model || undefined });
    return c.json({ summary });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Failed to fetch cost summary', details: message }, 500);
  }
});

observability.get('/cost/total', async (c) => {
  try {
    const db = c.env.DB;
    const days = parseInt(c.req.query('days') || '30');
    const model = c.req.query('model');

    const tracker = new CostTracker({ db });
    const total = await tracker.getTotalCost({ days, model: model || undefined });
    return c.json(total);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Failed to fetch total cost', details: message }, 500);
  }
});

observability.get('/cost/by-model', async (c) => {
  try {
    const db = c.env.DB;
    const days = parseInt(c.req.query('days') || '30');

    const tracker = new CostTracker({ db });
    const byModel = await tracker.getCostByModel({ days });
    return c.json({ models: byModel });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Failed to fetch cost by model', details: message }, 500);
  }
});

// ============ Latency Profiling ============

observability.get('/latency/percentiles', async (c) => {
  try {
    const db = c.env.DB;
    const days = parseInt(c.req.query('days') || '7');
    const model = c.req.query('model');

    const profiler = new LatencyProfiler({ db });
    const percentiles = await profiler.getPercentiles({ days, model: model || undefined });
    return c.json({ percentiles });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Failed to fetch latency percentiles', details: message }, 500);
  }
});

observability.get('/latency/timeseries', async (c) => {
  try {
    const db = c.env.DB;
    const days = parseInt(c.req.query('days') || '30');
    const model = c.req.query('model');

    const profiler = new LatencyProfiler({ db });
    const timeseries = await profiler.getTimeSeries({ days, model: model || undefined });
    return c.json({ timeseries });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Failed to fetch latency timeseries', details: message }, 500);
  }
});

observability.get('/latency/slow', async (c) => {
  try {
    const db = c.env.DB;
    const limit = parseInt(c.req.query('limit') || '20');
    const threshold = parseInt(c.req.query('threshold_ms') || '5000');
    const model = c.req.query('model');

    const profiler = new LatencyProfiler({ db });
    const slow = await profiler.getSlowTraces({ limit, threshold_ms: threshold, model: model || undefined });
    return c.json({ traces: slow });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Failed to fetch slow traces', details: message }, 500);
  }
});

// ============ Alerts ============

observability.get('/alerts/rules', async (c) => {
  try {
    const db = c.env.DB;
    const results = await db.prepare('SELECT * FROM alert_rules ORDER BY created_at DESC').all();
    return c.json({ rules: results.results });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Failed to fetch alert rules', details: message }, 500);
  }
});

observability.post('/alerts/rules', async (c) => {
  try {
    const db = c.env.DB;
    const body = await c.req.json<{
      name: string;
      metric: string;
      condition: 'gt' | 'lt' | 'eq';
      threshold: number;
    }>();

    const id = crypto.randomUUID();
    await db.prepare(`
      INSERT INTO alert_rules (id, name, metric, condition, threshold, enabled)
      VALUES (?, ?, ?, ?, ?, 1)
    `).bind(id, body.name, body.metric, body.condition, body.threshold).run();

    return c.json({ id });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Failed to create alert rule', details: message }, 500);
  }
});

observability.put('/alerts/rules/:id/toggle', async (c) => {
  try {
    const db = c.env.DB;
    const ruleId = c.req.param('id');
    await db.prepare('UPDATE alert_rules SET enabled = CASE WHEN enabled = 1 THEN 0 ELSE 1 END WHERE id = ?').bind(ruleId).run();
    return c.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Failed to toggle alert rule', details: message }, 500);
  }
});

observability.get('/alerts/events', async (c) => {
  try {
    const db = c.env.DB;
    const limit = parseInt(c.req.query('limit') || '50');
    const results = await db.prepare(`
      SELECT * FROM alert_events ORDER BY created_at DESC LIMIT ?
    `).bind(limit).all();
    return c.json({ events: results.results });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Failed to fetch alert events', details: message }, 500);
  }
});

observability.put('/alerts/events/:id/acknowledge', async (c) => {
  try {
    const db = c.env.DB;
    const eventId = c.req.param('id');
    await db.prepare('UPDATE alert_events SET acknowledged = 1 WHERE id = ?').bind(eventId).run();
    return c.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Failed to acknowledge alert', details: message }, 500);
  }
});

export default observability;
