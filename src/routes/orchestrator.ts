import { Hono } from 'hono';
import type { Env } from '../types';
import { Orchestrator } from '../services/agents';

const orchestrator = new Hono<{ Bindings: Env }>();

// Run a multi-agent workflow
orchestrator.post('/run', async (c) => {
  try {
    const body = await c.req.json<{ input: string; requireApproval?: boolean }>();
    const { input, requireApproval } = body;

    if (!input) {
      return c.json({ error: 'input is required' }, 400);
    }

    const orchestratorInstance = new Orchestrator({
      apiKey: c.env.GEMINI_API_KEY,
      requireApproval,
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

// Approve a pending task
orchestrator.post('/approve', async (c) => {
  try {
    const body = await c.req.json<{ approvalId: string }>();
    const { approvalId } = body;

    if (!approvalId) {
      return c.json({ error: 'approvalId is required' }, 400);
    }

    const approved = Orchestrator.approveTask(approvalId);
    return c.json({ success: approved });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Failed to approve', details: message }, 500);
  }
});

// Reject a pending task
orchestrator.post('/reject', async (c) => {
  try {
    const body = await c.req.json<{ approvalId: string }>();
    const { approvalId } = body;

    if (!approvalId) {
      return c.json({ error: 'approvalId is required' }, 400);
    }

    const rejected = Orchestrator.rejectTask(approvalId);
    return c.json({ success: rejected });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Failed to reject', details: message }, 500);
  }
});

export default orchestrator;
