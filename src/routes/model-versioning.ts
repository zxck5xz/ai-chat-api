import { Hono } from 'hono';
import type { Env } from '../types';
import { ModelVersioningService } from '../services/model-versioning';

const modelVersioning = new Hono<{ Bindings: Env }>();

function getService(env: Env): ModelVersioningService {
  return new ModelVersioningService({ db: env.DB });
}

// === Stats ===

modelVersioning.get('/stats', async (c) => {
  const service = getService(c.env);
  const stats = await service.getStats();
  return c.json({ stats });
});

// === Model Versions ===

modelVersioning.get('/versions', async (c) => {
  const service = getService(c.env);
  const { provider, status } = c.req.query();
  const versions = await service.listVersions({ provider, status });
  return c.json({ versions });
});

modelVersioning.get('/versions/:id', async (c) => {
  const service = getService(c.env);
  const version = await service.getVersion(c.req.param('id'));
  if (!version) {
    return c.json({ error: 'Version not found' }, 404);
  }
  return c.json({ version });
});

modelVersioning.post('/versions', async (c) => {
  try {
    const body = await c.req.json<{
      name: string;
      version: string;
      provider: 'gemini' | 'openai' | 'anthropic' | 'custom';
      modelId: string;
      config?: Record<string, unknown>;
      notes?: string;
    }>();

    if (!body.name || !body.version || !body.provider || !body.modelId) {
      return c.json({ error: 'name, version, provider, and modelId are required' }, 400);
    }

    const service = getService(c.env);
    const version = await service.createVersion(body);
    return c.json({ version }, 201);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Failed to create version', details: message }, 500);
  }
});

modelVersioning.put('/versions/:id', async (c) => {
  try {
    const body = await c.req.json<{
      name?: string;
      status?: 'active' | 'inactive' | 'deprecated' | 'archived';
      config?: Record<string, unknown>;
      notes?: string;
    }>();

    const service = getService(c.env);
    const version = await service.updateVersion(c.req.param('id'), body);
    if (!version) {
      return c.json({ error: 'Version not found' }, 404);
    }
    return c.json({ version });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Failed to update version', details: message }, 500);
  }
});

modelVersioning.delete('/versions/:id', async (c) => {
  const service = getService(c.env);
  await service.deleteVersion(c.req.param('id'));
  return c.json({ success: true });
});

modelVersioning.get('/versions/:id/metrics', async (c) => {
  const service = getService(c.env);
  const metrics = await service.getVersionMetrics(c.req.param('id'));
  return c.json({ metrics });
});

// === Deployments ===

modelVersioning.get('/deployments', async (c) => {
  const service = getService(c.env);
  const { environment, versionId, status } = c.req.query();
  const deployments = await service.listDeployments({ environment, versionId, status });
  return c.json({ deployments });
});

modelVersioning.get('/deployments/:id', async (c) => {
  const service = getService(c.env);
  const deployment = await service.getDeployment(c.req.param('id'));
  if (!deployment) {
    return c.json({ error: 'Deployment not found' }, 404);
  }
  return c.json({ deployment });
});

modelVersioning.get('/deployments/active/:environment', async (c) => {
  const service = getService(c.env);
  const deployment = await service.getActiveDeployment(c.req.param('environment'));
  if (!deployment) {
    return c.json({ error: 'No active deployment found' }, 404);
  }
  return c.json({ deployment });
});

modelVersioning.post('/deployments', async (c) => {
  try {
    const body = await c.req.json<{
      versionId: string;
      environment: 'production' | 'staging' | 'canary';
      strategy: 'rolling' | 'canary' | 'blue_green' | 'instant';
      trafficPercent?: number;
      deployedBy?: string;
    }>();

    if (!body.versionId || !body.environment || !body.strategy) {
      return c.json({ error: 'versionId, environment, and strategy are required' }, 400);
    }

    const service = getService(c.env);
    const deployment = await service.createDeployment(body);
    return c.json({ deployment }, 201);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Failed to create deployment', details: message }, 500);
  }
});

// === Rollback ===

modelVersioning.post('/rollback', async (c) => {
  try {
    const body = await c.req.json<{
      deploymentId: string;
      reason: string;
      triggeredBy?: string;
    }>();

    if (!body.deploymentId || !body.reason) {
      return c.json({ error: 'deploymentId and reason are required' }, 400);
    }

    const service = getService(c.env);
    const rollback = await service.rollback(
      body.deploymentId,
      body.reason,
      body.triggeredBy || 'user'
    );
    return c.json({ rollback }, 201);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Rollback failed', details: message }, 500);
  }
});

modelVersioning.get('/rollbacks', async (c) => {
  const service = getService(c.env);
  const { deploymentId } = c.req.query();
  const rollbacks = await service.listRollbacks(deploymentId);
  return c.json({ rollbacks });
});

// === Comparison ===

modelVersioning.get('/compare', async (c) => {
  try {
    const { versionA, versionB } = c.req.query();

    if (!versionA || !versionB) {
      return c.json({ error: 'versionA and versionB query params are required' }, 400);
    }

    const service = getService(c.env);
    const comparison = await service.compareVersions(versionA, versionB);
    return c.json({ comparison });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Comparison failed', details: message }, 500);
  }
});

export default modelVersioning;
