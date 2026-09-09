/**
 * Agentic RAG Routes
 * Part of Project 15: Agentic RAG with Self-Correction
 */

import { Hono } from 'hono';
import type { Env } from '../types';
import { QueryAnalyzer } from '../services/agentic-rag/query-analyzer';
import { RetrievalLoop } from '../services/agentic-rag/retrieval-loop';
import { HallucinationChecker } from '../services/agentic-rag/hallucination-checker';
import { AgenticRAGStore } from '../services/agentic-rag/persistence';
import { createQdrantClient } from '../services/qdrant';

const router = new Hono<{ Bindings: Env }>();

/**
 * POST /api/agentic-rag/analyze
 * Analyze a query: determine if retrieval is needed, classify intent, plan strategy
 */
router.post('/analyze', async (c) => {
  const body = await c.req.json<{ query: string }>();
  const { query } = body;

  if (!query || typeof query !== 'string') {
    return c.json({ error: 'query is required' }, 400);
  }

  const apiKey = c.env.GEMINI_API_KEY;
  if (!apiKey) {
    return c.json({ error: 'GEMINI_API_KEY not configured' }, 500);
  }

  const analyzer = new QueryAnalyzer(apiKey);
  const analysis = await analyzer.analyze(query);

  return c.json({ analysis });
});

/**
 * POST /api/agentic-rag/analyze/batch
 * Analyze multiple queries at once
 */
router.post('/analyze/batch', async (c) => {
  const body = await c.req.json<{ queries: string[] }>();
  const { queries } = body;

  if (!Array.isArray(queries) || queries.length === 0) {
    return c.json({ error: 'queries array is required' }, 400);
  }

  if (queries.length > 20) {
    return c.json({ error: 'Maximum 20 queries per batch' }, 400);
  }

  const apiKey = c.env.GEMINI_API_KEY;
  if (!apiKey) {
    return c.json({ error: 'GEMINI_API_KEY not configured' }, 500);
  }

  const analyzer = new QueryAnalyzer(apiKey);
  const analyses = await Promise.all(queries.map((q) => analyzer.analyze(q)));

  return c.json({ analyses });
});

/**
 * POST /api/agentic-rag/run
 * Run the full agentic RAG pipeline with persistence
 */
router.post('/run', async (c) => {
  const body = await c.req.json<{
    query: string;
    maxRounds?: number;
    confidenceThreshold?: number;
    topK?: number;
  }>();
  const { query, maxRounds, confidenceThreshold, topK } = body;

  if (!query || typeof query !== 'string') {
    return c.json({ error: 'query is required' }, 400);
  }

  const geminiApiKey = c.env.GEMINI_API_KEY;
  const qdrantUrl = c.env.QDRANT_URL;
  const qdrantApiKey = c.env.QDRANT_API_KEY;

  if (!geminiApiKey || !qdrantUrl || !qdrantApiKey) {
    return c.json({ error: 'Missing required env vars (GEMINI_API_KEY, QDRANT_URL, QDRANT_API_KEY)' }, 500);
  }

  const qdrant = createQdrantClient(qdrantUrl, qdrantApiKey);

  const loop = new RetrievalLoop(qdrant, 'ai-chat-documents', geminiApiKey, c.env.COHERE_API_KEY, {
    maxRounds: maxRounds ?? 3,
    confidenceThreshold: confidenceThreshold ?? 0.7,
    topK: topK ?? 10,
  });

  const result = await loop.run(query);

  // Persist run if D1 available
  if (c.env.DB) {
    try {
      const store = new AgenticRAGStore(c.env.DB);
      await store.saveRun(result.run);
    } catch (err) {
      console.error('Failed to persist agentic RAG run:', err);
    }
  }

  return c.json({ result });
});

/**
 * POST /api/agentic-rag/run-stream
 * Run the full agentic RAG pipeline with SSE streaming events
 */
router.post('/run-stream', async (c) => {
  const body = await c.req.json<{
    query: string;
    maxRounds?: number;
    confidenceThreshold?: number;
    topK?: number;
  }>();
  const { query, maxRounds, confidenceThreshold, topK } = body;

  if (!query || typeof query !== 'string') {
    return c.json({ error: 'query is required' }, 400);
  }

  const geminiApiKey = c.env.GEMINI_API_KEY;
  const qdrantUrl = c.env.QDRANT_URL;
  const qdrantApiKey = c.env.QDRANT_API_KEY;

  if (!geminiApiKey || !qdrantUrl || !qdrantApiKey) {
    return c.json({ error: 'Missing required env vars' }, 500);
  }

  const qdrant = createQdrantClient(qdrantUrl, qdrantApiKey);
  const db = c.env.DB;

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();

      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };

      try {
        send('start', { query, timestamp: new Date().toISOString() });

        const loop = new RetrievalLoop(qdrant, 'ai-chat-documents', geminiApiKey, c.env.COHERE_API_KEY, {
          maxRounds: maxRounds ?? 3,
          confidenceThreshold: confidenceThreshold ?? 0.7,
          topK: topK ?? 10,
        });

        const result = await loop.run(query);

        // Persist run if D1 available
        if (db) {
          try {
            const store = new AgenticRAGStore(db);
            await store.saveRun(result.run);
          } catch (err) {
            console.error('Failed to persist agentic RAG run:', err);
          }
        }

        // Send events as they occurred
        for (const event of result.events) {
          send(event.type, event.data);
        }

        send('complete', { run: result.run });
      } catch (err) {
        send('error', { message: err instanceof Error ? err.message : 'Unknown error' });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
});

/**
 * POST /api/agentic-rag/check
 * Run hallucination check on a generated answer against sources
 */
router.post('/check', async (c) => {
  const body = await c.req.json<{
    query: string;
    answer: string;
    sources: Array<{ content: string; documentTitle: string; score: number }>;
  }>();
  const { query, answer, sources } = body;

  if (!query || !answer) {
    return c.json({ error: 'query and answer are required' }, 400);
  }

  const apiKey = c.env.GEMINI_API_KEY;
  if (!apiKey) {
    return c.json({ error: 'GEMINI_API_KEY not configured' }, 500);
  }

  const checker = new HallucinationChecker(apiKey);
  const result = await checker.check(query, answer, sources || []);

  return c.json({ result });
});

/**
 * GET /api/agentic-rag/runs
 * Get recent runs with pagination
 */
router.get('/runs', async (c) => {
  if (!c.env.DB) {
    return c.json({ error: 'Database not configured' }, 500);
  }

  const limit = parseInt(c.req.query('limit') || '20', 10);
  const offset = parseInt(c.req.query('offset') || '0', 10);

  const store = new AgenticRAGStore(c.env.DB);
  const result = await store.getRecentRuns(Math.min(limit, 100), offset);

  return c.json(result);
});

/**
 * GET /api/agentic-rag/runs/:id
 * Get a specific run by ID
 */
router.get('/runs/:id', async (c) => {
  if (!c.env.DB) {
    return c.json({ error: 'Database not configured' }, 500);
  }

  const id = c.req.param('id');
  const store = new AgenticRAGStore(c.env.DB);
  const run = await store.getRun(id);

  if (!run) {
    return c.json({ error: 'Run not found' }, 404);
  }

  return c.json({ run });
});

/**
 * DELETE /api/agentic-rag/runs/:id
 * Delete a specific run
 */
router.delete('/runs/:id', async (c) => {
  if (!c.env.DB) {
    return c.json({ error: 'Database not configured' }, 500);
  }

  const id = c.req.param('id');
  const store = new AgenticRAGStore(c.env.DB);
  const deleted = await store.deleteRun(id);

  if (!deleted) {
    return c.json({ error: 'Run not found' }, 404);
  }

  return c.json({ success: true });
});

/**
 * GET /api/agentic-rag/metrics
 * Get aggregated metrics for all runs
 */
router.get('/metrics', async (c) => {
  if (!c.env.DB) {
    return c.json({ error: 'Database not configured' }, 500);
  }

  const store = new AgenticRAGStore(c.env.DB);
  const metrics = await store.getMetrics();

  return c.json({ metrics });
});

/**
 * GET /api/agentic-rag/health
 * Health check
 */
router.get('/health', (c) => {
  return c.json({ status: 'ok', service: 'agentic-rag' });
});

export default router;
