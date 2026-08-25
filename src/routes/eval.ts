import { Hono } from 'hono';
import type { Env } from '../types';

interface EvalMetricsRow {
  total_runs: number;
  total_cases: number;
  passed_cases: number;
  failed_cases: number;
  avg_latency: number | null;
  avg_cost: number | null;
}

interface FeedbackRow {
  positive: number | null;
  negative: number | null;
}

interface HallucinationRow {
  total: number | null;
  flagged: number | null;
}

interface TimeSeriesRow {
  date: string;
  accuracy: number;
  latency: number;
  cost: number;
}

interface EvalRunRow {
  id: string;
  model_version: string;
  prompt_variant: string | null;
  status: string;
  total_cases: number;
  passed_cases: number;
  failed_cases: number;
  avg_latency_ms: number | null;
  avg_cost_usd: number | null;
  started_at: string;
  completed_at: string | null;
}

interface EvalResultRow {
  id: string;
  run_id: string;
  query: string;
  expected_output: string | null;
  actual_output: string | null;
  score: number;
  passed: number;
  latency_ms: number | null;
  cost_usd: number | null;
  feedback_rating: string | null;
  feedback_comment: string | null;
  hallucination_flag: number;
  metadata: string | null;
  created_at: string;
}

const eval_ = new Hono<{ Bindings: Env }>();

// Get eval dashboard metrics
eval_.get('/metrics', async (c) => {
  try {
    const { model_version, start_date, end_date } = c.req.query();

    let whereClause = 'WHERE 1=1';
    const params: string[] = [];

    if (model_version) {
      whereClause += ' AND model_version = ?';
      params.push(model_version);
    }
    if (start_date) {
      whereClause += ' AND started_at >= ?';
      params.push(start_date);
    }
    if (end_date) {
      whereClause += ' AND started_at <= ?';
      params.push(end_date);
    }

    // Total runs and cases
    const stats = await c.env.DB.prepare(`
      SELECT 
        COUNT(*) as total_runs,
        SUM(total_cases) as total_cases,
        SUM(passed_cases) as passed_cases,
        SUM(failed_cases) as failed_cases,
        AVG(avg_latency_ms) as avg_latency,
        AVG(avg_cost_usd) as avg_cost
      FROM eval_runs
      ${whereClause}
    `).bind(...params).first() as EvalMetricsRow | null;

    // Feedback stats from eval_results
    const feedback = await c.env.DB.prepare(`
      SELECT 
        SUM(CASE WHEN feedback_rating = 'positive' THEN 1 ELSE 0 END) as positive,
        SUM(CASE WHEN feedback_rating = 'negative' THEN 1 ELSE 0 END) as negative
      FROM eval_results er
      JOIN eval_runs erun ON er.run_id = erun.id
      ${whereClause.replace('started_at', 'erun.started_at')}
    `).bind(...params).first() as FeedbackRow | null;

    // Hallucination rate
    const hallucination = await c.env.DB.prepare(`
      SELECT 
        COUNT(*) as total,
        SUM(hallucination_flag) as flagged
      FROM eval_results er
      JOIN eval_runs erun ON er.run_id = erun.id
      ${whereClause.replace('started_at', 'erun.started_at')}
    `).bind(...params).first() as HallucinationRow | null;

    const accuracy = (stats?.total_cases || 0) > 0 ? ((stats?.passed_cases || 0) / (stats?.total_cases || 1)) * 100 : 0;
    const hallucinationRate = (hallucination?.total || 0) > 0 ? ((hallucination?.flagged || 0) / (hallucination?.total || 1)) * 100 : 0;

    return c.json({
      total_runs: stats?.total_runs || 0,
      total_cases: stats?.total_cases || 0,
      avg_accuracy: Math.round(accuracy * 100) / 100,
      avg_latency: Math.round(stats?.avg_latency || 0),
      avg_cost: Math.round((stats?.avg_cost || 0) * 10000) / 10000,
      hallucination_rate: Math.round(hallucinationRate * 100) / 100,
      feedback_positive: feedback?.positive || 0,
      feedback_negative: feedback?.negative || 0,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Failed to fetch metrics', details: message }, 500);
  }
});

// Get metrics time series
eval_.get('/metrics/timeseries', async (c) => {
  try {
    const { model_version, days = '30' } = c.req.query();

    let whereClause = `WHERE started_at >= datetime('now', '-${parseInt(days)} days')`;
    const params: string[] = [];

    if (model_version) {
      whereClause += ' AND model_version = ?';
      params.push(model_version);
    }

    const results = await c.env.DB.prepare(`
      SELECT 
        date(started_at) as date,
        AVG(CASE WHEN total_cases > 0 THEN (passed_cases * 100.0 / total_cases) ELSE 0 END) as accuracy,
        AVG(avg_latency_ms) as latency,
        AVG(avg_cost_usd) as cost
      FROM eval_runs
      ${whereClause}
      GROUP BY date(started_at)
      ORDER BY date(started_at)
    `).bind(...params).all();

    return c.json({ timeseries: results.results as unknown as TimeSeriesRow[] });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Failed to fetch timeseries', details: message }, 500);
  }
});

// Get all eval runs
eval_.get('/runs', async (c) => {
  try {
    const { model_version, status, limit = '20' } = c.req.query();

    let whereClause = 'WHERE 1=1';
    const params: string[] = [];

    if (model_version) {
      whereClause += ' AND model_version = ?';
      params.push(model_version);
    }
    if (status) {
      whereClause += ' AND status = ?';
      params.push(status);
    }

    const results = await c.env.DB.prepare(`
      SELECT * FROM eval_runs
      ${whereClause}
      ORDER BY started_at DESC
      LIMIT ?
    `).bind(...params, parseInt(limit)).all();

    return c.json({ runs: results.results as unknown as EvalRunRow[] });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Failed to fetch runs', details: message }, 500);
  }
});

// Create eval run
eval_.post('/runs', async (c) => {
  try {
    const body = await c.req.json<{ model_version: string; prompt_variant?: string }>();
    const { model_version, prompt_variant } = body;

    const id = crypto.randomUUID();
    await c.env.DB.prepare(`
      INSERT INTO eval_runs (id, model_version, prompt_variant, status)
      VALUES (?, ?, ?, 'running')
    `).bind(id, model_version, prompt_variant || null).run();

    return c.json({ id, status: 'running' });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Failed to create run', details: message }, 500);
  }
});

// Complete eval run
eval_.put('/runs/:id/complete', async (c) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json<{ total_cases: number; passed_cases: number; failed_cases: number; avg_latency_ms?: number; avg_cost_usd?: number }>();

    await c.env.DB.prepare(`
      UPDATE eval_runs 
      SET status = 'completed', total_cases = ?, passed_cases = ?, failed_cases = ?, 
          avg_latency_ms = ?, avg_cost_usd = ?, completed_at = datetime('now')
      WHERE id = ?
    `).bind(
      body.total_cases,
      body.passed_cases,
      body.failed_cases,
      body.avg_latency_ms || null,
      body.avg_cost_usd || null,
      id
    ).run();

    return c.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Failed to complete run', details: message }, 500);
  }
});

// Get eval results for a run
eval_.get('/runs/:id/results', async (c) => {
  try {
    const runId = c.req.param('id');
    const { passed, limit = '50' } = c.req.query();

    let whereClause = 'WHERE run_id = ?';
    const params: string[] = [runId];

    if (passed !== undefined) {
      whereClause += ' AND passed = ?';
      params.push(passed === 'true' ? '1' : '0');
    }

    const results = await c.env.DB.prepare(`
      SELECT * FROM eval_results
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT ?
    `).bind(...params, parseInt(limit)).all();

    return c.json({ results: results.results as unknown as EvalResultRow[] });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Failed to fetch results', details: message }, 500);
  }
});

// Add eval result
eval_.post('/runs/:id/results', async (c) => {
  try {
    const runId = c.req.param('id');
    const body = await c.req.json<{
      query: string;
      expected_output?: string;
      actual_output: string;
      score: number;
      latency_ms?: number;
      cost_usd?: number;
      feedback_rating?: 'positive' | 'negative';
      feedback_comment?: string;
      hallucination_flag?: number;
      metadata?: Record<string, unknown>;
    }>();

    const resultId = crypto.randomUUID();
    await c.env.DB.prepare(`
      INSERT INTO eval_results (id, run_id, query, expected_output, actual_output, score, passed, latency_ms, cost_usd, feedback_rating, feedback_comment, hallucination_flag, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      resultId,
      runId,
      body.query,
      body.expected_output || null,
      body.actual_output,
      body.score,
      body.score >= 0.7 ? 1 : 0,
      body.latency_ms || null,
      body.cost_usd || null,
      body.feedback_rating || null,
      body.feedback_comment || null,
      body.hallucination_flag || 0,
      body.metadata ? JSON.stringify(body.metadata) : null
    ).run();

    return c.json({ id: resultId });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Failed to add result', details: message }, 500);
  }
});

// Get failure cases
eval_.get('/failures', async (c) => {
  try {
    const { model_version, limit = '20' } = c.req.query();

    let whereClause = "WHERE (er.feedback_rating = 'negative' OR er.hallucination_flag = 1 OR er.passed = 0)";
    const params: string[] = [];

    if (model_version) {
      whereClause += ' AND erun.model_version = ?';
      params.push(model_version);
    }

    const results = await c.env.DB.prepare(`
      SELECT 
        er.*,
        erun.model_version,
        erun.prompt_variant
      FROM eval_results er
      JOIN eval_runs erun ON er.run_id = erun.id
      ${whereClause}
      ORDER BY er.created_at DESC
      LIMIT ?
    `).bind(...params, parseInt(limit)).all();

    return c.json({ failures: results.results });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Failed to fetch failures', details: message }, 500);
  }
});

// Get unique model versions
eval_.get('/models', async (c) => {
  try {
    const results = await c.env.DB.prepare(`
      SELECT DISTINCT model_version FROM eval_runs ORDER BY model_version
    `).all();

    return c.json({ models: results.results.map((r) => String(r.model_version)) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Failed to fetch models', details: message }, 500);
  }
});

export default eval_;
