import { Hono } from 'hono';
import type { Env } from '../types';
import { Dataset } from '../services/fine-tuning/dataset';
import { Trainer } from '../services/fine-tuning/trainer';
import { Evaluator } from '../services/fine-tuning/evaluator';
import { ABTester } from '../services/fine-tuning/ab-tester';

const fineTuning = new Hono<{ Bindings: Env }>();

// ============ Metrics ============

fineTuning.get('/metrics', async (c) => {
  try {
    const db = c.env.DB;
    const dataset = new Dataset({ db });
    const trainer = new Trainer({ db });
    const evaluator = new Evaluator({ db });
    const abTester = new ABTester({ db });

    const [dsStats, trStats, evals, activeTests] = await Promise.all([
      dataset.getStats(),
      trainer.getStats(),
      evaluator.getEvals(),
      abTester.getActiveTests(),
    ]);

    const latestEval = evals[0] as { improvement_pct?: number } | undefined;

    return c.json({
      total_datasets: dsStats.total_datasets,
      total_entries: dsStats.total_entries,
      total_jobs: trStats.total_jobs,
      completed_jobs: trStats.completed,
      running_jobs: trStats.running,
      avg_improvement: latestEval?.improvement_pct || 0,
      active_ab_tests: activeTests.length,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Failed to fetch metrics', details: message }, 500);
  }
});

// ============ Datasets ============

fineTuning.get('/datasets', async (c) => {
  try {
    const ds = new Dataset({ db: c.env.DB });
    return c.json({ datasets: await ds.list() });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Failed to fetch datasets', details: message }, 500);
  }
});

fineTuning.get('/datasets/:id', async (c) => {
  try {
    const ds = new Dataset({ db: c.env.DB });
    const dataset = await ds.getById(c.req.param('id'));
    if (!dataset) return c.json({ error: 'Dataset not found' }, 404);
    return c.json(dataset);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Failed to fetch dataset', details: message }, 500);
  }
});

fineTuning.post('/datasets', async (c) => {
  try {
    const ds = new Dataset({ db: c.env.DB });
    const body = await c.req.json<{ name: string; description?: string; source: string; format: string }>();
    const id = await ds.create({
      name: body.name,
      description: body.description,
      source: body.source as 'manual' | 'import' | 'generated' | 'curated',
      format: body.format as 'chat' | 'instruction' | 'completion',
    });
    return c.json({ id });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Failed to create dataset', details: message }, 500);
  }
});

fineTuning.post('/datasets/:id/entries', async (c) => {
  try {
    const ds = new Dataset({ db: c.env.DB });
    const body = await c.req.json<{ entries: { prompt: string; completion: string; system_prompt?: string }[] }>();
    const added = await ds.addEntries(c.req.param('id'), body.entries);
    return c.json({ added });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Failed to add entries', details: message }, 500);
  }
});

fineTuning.get('/datasets/:id/entries', async (c) => {
  try {
    const ds = new Dataset({ db: c.env.DB });
    const limit = parseInt(c.req.query('limit') || '100');
    const entries = await ds.getEntries(c.req.param('id'), limit);
    return c.json({ entries });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Failed to fetch entries', details: message }, 500);
  }
});

fineTuning.post('/datasets/:id/validate', async (c) => {
  try {
    const ds = new Dataset({ db: c.env.DB });
    const result = await ds.validate(c.req.param('id'));
    return c.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Failed to validate dataset', details: message }, 500);
  }
});

fineTuning.delete('/datasets/:id', async (c) => {
  try {
    const ds = new Dataset({ db: c.env.DB });
    await ds.delete(c.req.param('id'));
    return c.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Failed to delete dataset', details: message }, 500);
  }
});

// ============ Training Jobs ============

fineTuning.get('/jobs', async (c) => {
  try {
    const trainer = new Trainer({ db: c.env.DB });
    return c.json({ jobs: await trainer.list() });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Failed to fetch jobs', details: message }, 500);
  }
});

fineTuning.get('/jobs/:id', async (c) => {
  try {
    const trainer = new Trainer({ db: c.env.DB });
    const job = await trainer.getById(c.req.param('id'));
    if (!job) return c.json({ error: 'Job not found' }, 404);
    return c.json(job);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Failed to fetch job', details: message }, 500);
  }
});

fineTuning.post('/jobs', async (c) => {
  try {
    const trainer = new Trainer({ db: c.env.DB });
    const body = await c.req.json<{
      name: string;
      dataset_id: string;
      base_model: string;
      method: 'lora' | 'qlora' | 'full';
      hyperparameters?: Record<string, number>;
    }>();
    const id = await trainer.create({
      name: body.name,
      dataset_id: body.dataset_id,
      base_model: body.base_model,
      method: body.method,
      hyperparameters: body.hyperparameters,
    });
    return c.json({ id });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Failed to create job', details: message }, 500);
  }
});

fineTuning.post('/jobs/:id/start', async (c) => {
  try {
    const trainer = new Trainer({ db: c.env.DB });
    await trainer.startJob(c.req.param('id'));
    return c.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Failed to start job', details: message }, 500);
  }
});

fineTuning.put('/jobs/:id/progress', async (c) => {
  try {
    const trainer = new Trainer({ db: c.env.DB });
    const body = await c.req.json<{
      completed_steps: number;
      total_steps: number;
      current_loss: number;
      best_loss: number;
      epoch: number;
      loss_history: { step: number; loss: number; epoch: number }[];
    }>();
    await trainer.updateProgress(c.req.param('id'), body);
    return c.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Failed to update progress', details: message }, 500);
  }
});

fineTuning.post('/jobs/:id/complete', async (c) => {
  try {
    const trainer = new Trainer({ db: c.env.DB });
    const body = await c.req.json<{ output_model: string }>();
    await trainer.completeJob(c.req.param('id'), body.output_model);
    return c.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Failed to complete job', details: message }, 500);
  }
});

fineTuning.delete('/jobs/:id', async (c) => {
  try {
    const trainer = new Trainer({ db: c.env.DB });
    await trainer.deleteJob(c.req.param('id'));
    return c.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Failed to delete job', details: message }, 500);
  }
});

// ============ Model Evaluation ============

fineTuning.get('/evals', async (c) => {
  try {
    const evaluator = new Evaluator({ db: c.env.DB });
    const jobId = c.req.query('job_id');
    const evals = await evaluator.getEvals(jobId || undefined);
    return c.json({ evals });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Failed to fetch evals', details: message }, 500);
  }
});

fineTuning.get('/evals/latest', async (c) => {
  try {
    const evaluator = new Evaluator({ db: c.env.DB });
    const eval_ = await evaluator.getLatestEval();
    return c.json({ eval: eval_ });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Failed to fetch latest eval', details: message }, 500);
  }
});

fineTuning.post('/evals', async (c) => {
  try {
    const evaluator = new Evaluator({ db: c.env.DB });
    const body = await c.req.json<{
      job_id: string;
      base_model: string;
      fine_tuned_model: string;
      eval_set: string;
    }>();
    const id = await evaluator.createEval(body);
    return c.json({ id });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Failed to create eval', details: message }, 500);
  }
});

fineTuning.put('/evals/:id/complete', async (c) => {
  try {
    const evaluator = new Evaluator({ db: c.env.DB });
    const body = await c.req.json<{
      total_cases: number;
      base_pass_rate: number;
      ft_pass_rate: number;
      base_avg_latency: number;
      ft_avg_latency: number;
      base_avg_cost: number;
      ft_avg_cost: number;
    }>();
    await evaluator.completeEval(c.req.param('id'), body);
    return c.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Failed to complete eval', details: message }, 500);
  }
});

// ============ A/B Testing ============

fineTuning.get('/ab-tests', async (c) => {
  try {
    const ab = new ABTester({ db: c.env.DB });
    return c.json({ tests: await ab.list() });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Failed to fetch A/B tests', details: message }, 500);
  }
});

fineTuning.get('/ab-tests/active', async (c) => {
  try {
    const ab = new ABTester({ db: c.env.DB });
    return c.json({ tests: await ab.getActiveTests() });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Failed to fetch active tests', details: message }, 500);
  }
});

fineTuning.post('/ab-tests', async (c) => {
  try {
    const ab = new ABTester({ db: c.env.DB });
    const body = await c.req.json<{
      name: string;
      base_model: string;
      variant_model: string;
      traffic_split: number;
    }>();
    const id = await ab.create(body);
    return c.json({ id });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Failed to create A/B test', details: message }, 500);
  }
});

fineTuning.post('/ab-tests/:id/route', async (c) => {
  try {
    const ab = new ABTester({ db: c.env.DB });
    const route = await ab.routeRequest(c.req.param('id'));
    return c.json({ model: route });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Failed to route request', details: message }, 500);
  }
});

fineTuning.post('/ab-tests/:id/result', async (c) => {
  try {
    const ab = new ABTester({ db: c.env.DB });
    const body = await c.req.json<{ model: 'base' | 'variant'; latency: number; passed: boolean }>();
    await ab.recordResult(c.req.param('id'), body.model, body.latency, body.passed);
    return c.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Failed to record result', details: message }, 500);
  }
});

fineTuning.post('/ab-tests/:id/stop', async (c) => {
  try {
    const ab = new ABTester({ db: c.env.DB });
    await ab.stopTest(c.req.param('id'));
    return c.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Failed to stop test', details: message }, 500);
  }
});

fineTuning.delete('/ab-tests/:id', async (c) => {
  try {
    const ab = new ABTester({ db: c.env.DB });
    await ab.deleteTest(c.req.param('id'));
    return c.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Failed to delete test', details: message }, 500);
  }
});

export default fineTuning;
