import { Hono } from 'hono';
import type { Env } from '../types';

interface SafetyGateRow {
  id: string;
  name: string;
  metric: string;
  threshold: number;
  enabled: number;
  created_at: string;
}

interface EvalRunRow {
  id: string;
  model_version: string;
  total_cases: number;
  passed_cases: number;
  avg_latency_ms: number | null;
}

interface HallucinationRow {
  total: number | null;
  flagged: number | null;
}

const safety = new Hono<{ Bindings: Env }>();

// Get all safety gates
safety.get('/gates', async (c) => {
  try {
    const results = await c.env.DB.prepare(`
      SELECT * FROM safety_gates ORDER BY created_at
    `).all();

    return c.json({ gates: results.results as unknown as SafetyGateRow[] });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Failed to fetch gates', details: message }, 500);
  }
});

// Create safety gate
safety.post('/gates', async (c) => {
  try {
    const body = await c.req.json<{ name: string; metric: string; threshold: number }>();
    const { name, metric, threshold } = body;

    const id = crypto.randomUUID();
    await c.env.DB.prepare(`
      INSERT INTO safety_gates (id, name, metric, threshold)
      VALUES (?, ?, ?, ?)
    `).bind(id, name, metric, threshold).run();

    return c.json({ id });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Failed to create gate', details: message }, 500);
  }
});

// Update safety gate
safety.put('/gates/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json<{ enabled?: number; threshold?: number }>();

    const updates: string[] = [];
    const params: (string | number)[] = [];

    if (body.enabled !== undefined) {
      updates.push('enabled = ?');
      params.push(body.enabled);
    }
    if (body.threshold !== undefined) {
      updates.push('threshold = ?');
      params.push(body.threshold);
    }

    if (updates.length === 0) {
      return c.json({ error: 'No updates provided' }, 400);
    }

    params.push(id);
    await c.env.DB.prepare(`
      UPDATE safety_gates SET ${updates.join(', ')} WHERE id = ?
    `).bind(...params).run();

    return c.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Failed to update gate', details: message }, 500);
  }
});

// Check safety gates for an eval run
safety.get('/check/:runId', async (c) => {
  try {
    const runId = c.req.param('runId');

    // Get the eval run
    const run = await c.env.DB.prepare(`
      SELECT * FROM eval_runs WHERE id = ?
    `).bind(runId).first() as EvalRunRow | null;

    if (!run) {
      return c.json({ error: 'Eval run not found' }, 404);
    }

    // Get enabled gates
    const gates = await c.env.DB.prepare(`
      SELECT * FROM safety_gates WHERE enabled = 1
    `).all();

    const violations: { gate: string; metric: string; threshold: number; actual: number }[] = [];

    // Calculate metrics
    const accuracy = run.total_cases > 0 ? (run.passed_cases / run.total_cases) * 100 : 0;
    const latency = run.avg_latency_ms || 0;

    // Get hallucination rate
    const hallucination = await c.env.DB.prepare(`
      SELECT 
        COUNT(*) as total,
        SUM(hallucination_flag) as flagged
      FROM eval_results WHERE run_id = ?
    `).bind(runId).first() as HallucinationRow | null;

    const hallucinationRate = (hallucination?.total || 0) > 0 ? ((hallucination?.flagged || 0) / (hallucination?.total || 1)) * 100 : 0;

    // Check each gate
    for (const gate of gates.results as unknown as SafetyGateRow[]) {
      let actual = 0;
      let violated = false;

      switch (gate.metric) {
        case 'min_accuracy':
          actual = accuracy;
          violated = actual < gate.threshold;
          break;
        case 'max_latency':
          actual = latency;
          violated = actual > gate.threshold;
          break;
        case 'max_hallucination_rate':
          actual = hallucinationRate;
          violated = actual > gate.threshold;
          break;
      }

      if (violated) {
        violations.push({
          gate: gate.name,
          metric: gate.metric,
          threshold: gate.threshold,
          actual,
        });
      }
    }

    const passed = violations.length === 0;

    return c.json({ passed, violations });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Failed to check gates', details: message }, 500);
  }
});

// Get pending deploy approvals
safety.get('/approvals', async (c) => {
  try {
    const results = await c.env.DB.prepare(`
      SELECT 
        da.*,
        er.model_version,
        er.total_cases,
        er.passed_cases,
        er.failed_cases,
        er.avg_latency_ms
      FROM deploy_approvals da
      JOIN eval_runs er ON da.eval_run_id = er.id
      ORDER BY da.created_at DESC
    `).all();

    return c.json({ approvals: results.results });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Failed to fetch approvals', details: message }, 500);
  }
});

// Create deploy approval request
safety.post('/approvals', async (c) => {
  try {
    const body = await c.req.json<{ eval_run_id: string }>();
    const { eval_run_id } = body;

    const id = crypto.randomUUID();
    await c.env.DB.prepare(`
      INSERT INTO deploy_approvals (id, eval_run_id, status)
      VALUES (?, ?, 'pending')
    `).bind(id, eval_run_id).run();

    return c.json({ id, status: 'pending' });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Failed to create approval', details: message }, 500);
  }
});

// Approve/Reject deploy
safety.put('/approvals/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json<{ status: 'approved' | 'rejected'; comment?: string }>();
    const { status, comment } = body;

    await c.env.DB.prepare(`
      UPDATE deploy_approvals 
      SET status = ?, comment = ?, resolved_at = datetime('now')
      WHERE id = ?
    `).bind(status, comment || null, id).run();

    return c.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Failed to update approval', details: message }, 500);
  }
});

export default safety;
