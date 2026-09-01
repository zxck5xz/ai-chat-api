/**
 * Search Analytics API
 * Persists search queries + clicks/feedback, aggregates CTR/MRR.
 */

import { Hono } from 'hono';
import type { Env } from '../../types';
import { SearchAnalyticsService } from '../../services/search-analytics';

const searchAnalytics = new Hono<{ Bindings: Env }>();

function service(c: { env: Env }) {
  return new SearchAnalyticsService(c.env.DB);
}

// POST /record-query — persist a search query after retrieval
searchAnalytics.post('/record-query', async (c) => {
  const body = await c.req.json<{
    query: string;
    expandedQuery?: string;
    complexity: 'simple' | 'moderate' | 'complex' | 'ambiguous';
    strategy: string;
    resultsCount: number;
    latencyMs: number;
  }>();

  if (!body.query || !body.complexity || !body.strategy) {
    return c.json({ error: 'query, complexity, and strategy are required' }, 400);
  }

  const result = await service(c).recordQuery({
    query: body.query,
    expandedQuery: body.expandedQuery,
    complexity: body.complexity,
    strategy: body.strategy,
    resultsCount: body.resultsCount ?? 0,
    latencyMs: body.latencyMs ?? 0,
  });
  return c.json({ success: true, query: result });
});

// POST /record-click — track a click on a result
searchAnalytics.post('/record-click', async (c) => {
  const body = await c.req.json<{
    queryId: string;
    resultId: string;
    position: number;
    documentId?: string;
    chunkId?: string;
  }>();

  if (!body.queryId || !body.resultId || body.position == null) {
    return c.json({ error: 'queryId, resultId, and position are required' }, 400);
  }

  await service(c).recordClick({
    queryId: body.queryId,
    resultId: body.resultId,
    position: body.position,
    documentId: body.documentId,
    chunkId: body.chunkId,
  });
  return c.json({ success: true });
});

// POST /record-feedback — store thumbs rating
searchAnalytics.post('/record-feedback', async (c) => {
  const body = await c.req.json<{
    queryId: string;
    rating: 'positive' | 'negative';
    comment?: string;
  }>();

  if (!body.queryId || !body.rating) {
    return c.json({ error: 'queryId and rating are required' }, 400);
  }

  await service(c).recordFeedback({
    queryId: body.queryId,
    rating: body.rating,
    comment: body.comment,
  });
  return c.json({ success: true });
});

// GET /metrics — CTR, MRR, zero-click, breakdown
searchAnalytics.get('/metrics', async (c) => {
  const metrics = await service(c).getMetrics();
  return c.json({ success: true, metrics });
});

// GET /queries — list recent search queries
searchAnalytics.get('/queries', async (c) => {
  const limit = Number(c.req.query('limit') ?? '50');
  const queries = await service(c).listQueries(limit);
  return c.json({ success: true, queries });
});

export default searchAnalytics;
