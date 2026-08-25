import { Hono } from 'hono';
import type { Env } from '../types';
import { Orchestrator } from '../services/agents';

const orchestrator = new Hono<{ Bindings: Env }>();

// Run a multi-agent workflow
orchestrator.post('/run', async (c) => {
  try {
    const body = await c.req.json<{ input: string }>();
    const { input } = body;

    if (!input) {
      return c.json({ error: 'input is required' }, 400);
    }

    const orchestratorInstance = new Orchestrator({
      apiKey: c.env.GEMINI_API_KEY,
    });

    // SSE stream for workflow events
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        try {
          const workflow = await orchestratorInstance.runWorkflow(input, (event) => {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(event)}\n\n`)
            );
          });

          // Send final workflow state
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ type: 'workflow_result', workflow })}\n\n`
            )
          );

          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        } catch (err) {
          console.error('Workflow error:', err);
          const message = err instanceof Error ? err.message : String(err);
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ type: 'task_error', error: message })}\n\n`
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
    console.error('Orchestrator error:', err);
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Failed to run workflow', details: message }, 500);
  }
});

// Get available agents info
orchestrator.get('/agents', (c) => {
  return c.json({
    agents: [
      {
        type: 'planner',
        name: 'Planner Agent',
        description: 'Analyzes requests and breaks them into tasks',
      },
      {
        type: 'designer',
        name: 'Designer Agent',
        description: 'Creates design specifications with layout, colors, typography',
      },
      {
        type: 'coder',
        name: 'Coder Agent',
        description: 'Generates React/TypeScript/Tailwind code',
      },
      {
        type: 'reviewer',
        name: 'Reviewer Agent',
        description: 'Reviews code for accessibility, performance, and quality',
      },
    ],
  });
});

export default orchestrator;
