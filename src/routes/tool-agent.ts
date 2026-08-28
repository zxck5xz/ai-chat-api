import { Hono } from 'hono';
import type { Env } from '../types';
import { ToolAgent, toolRegistry } from '../services/tool-agent';

const toolAgent = new Hono<{ Bindings: Env }>();

function getAgent(env: Env): ToolAgent {
  return new ToolAgent({
    apiKey: env.GEMINI_API_KEY,
    db: env.DB,
  });
}

// Run a tool agent query with SSE streaming
toolAgent.post('/run', async (c) => {
  try {
    const body = await c.req.json<{ query: string }>();
    const { query } = body;

    if (!query) {
      return c.json({ error: 'query is required' }, 400);
    }

    const agent = getAgent(c.env);

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        try {
          const run = await agent.run(query, (event) => {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(event)}\n\n`)
            );
          });

          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ type: 'run_complete', run })}\n\n`
            )
          );
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        } catch (err) {
          console.error('Tool agent error:', err);
          const message = err instanceof Error ? err.message : String(err);
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ type: 'error', error: message })}\n\n`
            )
          );
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Failed to run agent', details: message }, 500);
  }
});

// Get available tools
toolAgent.get('/tools', (c) => {
  return c.json({
    tools: toolRegistry.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    })),
  });
});

// Get recent runs
toolAgent.get('/runs', async (c) => {
  const agent = getAgent(c.env);
  const limit = parseInt(c.req.query('limit') || '20');
  const runs = await agent.getRecentRuns(limit);
  return c.json({ runs });
});

// Get a specific run
toolAgent.get('/runs/:id', async (c) => {
  const agent = getAgent(c.env);
  const run = await agent.getRun(c.req.param('id'));
  if (!run) {
    return c.json({ error: 'Run not found' }, 404);
  }
  return c.json({ run });
});

export default toolAgent;
