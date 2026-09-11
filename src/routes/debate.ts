// Project 17: Multi-Agent Debate & Verifier — API Routes

import { Hono } from 'hono';
import type { Env } from '../types';
import { DebateEngine } from '../services/debate/debate-engine';
import { DebateStore } from '../services/debate/persistence';
import type { DebateFormat } from '../types/debate';

const router = new Hono<{ Bindings: Env }>();

// Run a debate
router.post('/run', async (c) => {
  if (!c.env.DB) return c.json({ error: 'Database not configured' }, 500);
  if (!c.env.GEMINI_API_KEY) return c.json({ error: 'Gemini API key not configured' }, 500);

  const body = await c.req.json<{ question: string; format?: DebateFormat }>();
  const { question, format = 'free_form' } = body;

  if (!question || question.trim().length === 0) {
    return c.json({ error: 'Question is required' }, 400);
  }

  const store = new DebateStore(c.env.DB);
  const engine = new DebateEngine(c.env.GEMINI_API_KEY, store);

  const events: Array<{ type: string; data: unknown; timestamp: string }> = [];

  const run = await engine.run(question, format, (event) => {
    events.push({ ...event, timestamp: new Date().toISOString() });
  });

  return c.json({ run, events });
});

// Stream debate via SSE
router.get('/run-stream', async (c) => {
  if (!c.env.DB) return c.json({ error: 'Database not configured' }, 500);
  if (!c.env.GEMINI_API_KEY) return c.json({ error: 'Gemini API key not configured' }, 500);

  const question = c.req.query('question') || '';
  const format = (c.req.query('format') || 'free_form') as DebateFormat;

  if (!question) {
    return c.json({ error: 'Question is required' }, 400);
  }

  const store = new DebateStore(c.env.DB);
  const engine = new DebateEngine(c.env.GEMINI_API_KEY, store);

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (eventType: string, data: unknown) => {
        controller.enqueue(encoder.encode(`event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`));
      };

      try {
        const run = await engine.run(question, format, (event) => {
          send(event.type, event.data);
        });
        send('done', { runId: run.id });
      } catch (error) {
        send('error', { message: error instanceof Error ? error.message : 'Unknown error' });
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

// Get debate run by ID
router.get('/runs/:id', async (c) => {
  if (!c.env.DB) return c.json({ error: 'Database not configured' }, 500);

  const id = c.req.param('id');
  const store = new DebateStore(c.env.DB);
  const run = await store.getRun(id);

  if (!run) return c.json({ error: 'Debate not found' }, 404);
  return c.json({ run });
});

// List debate runs
router.get('/runs', async (c) => {
  if (!c.env.DB) return c.json({ error: 'Database not configured' }, 500);

  const limit = parseInt(c.req.query('limit') || '20');
  const offset = parseInt(c.req.query('offset') || '0');

  const store = new DebateStore(c.env.DB);
  const { runs, total } = await store.getRuns(limit, offset);

  return c.json({ runs, total, limit, offset });
});

// Get debate metrics
router.get('/metrics', async (c) => {
  if (!c.env.DB) return c.json({ error: 'Database not configured' }, 500);

  const store = new DebateStore(c.env.DB);
  const metrics = await store.getMetrics();

  return c.json({ metrics });
});

// Health check
router.get('/health', (c) => {
  return c.json({ status: 'ok', service: 'debate' });
});

export default router;
