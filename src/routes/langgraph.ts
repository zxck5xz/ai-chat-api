/**
 * LangGraph API Routes
 * 
 * POST /api/langgraph/run        — Run a multi-agent workflow
 * POST /api/langgraph/approve    — Approve/reject human-in-the-loop
 * GET  /api/langgraph/thread/:id — Get thread state and history
 * GET  /api/langgraph/patterns   — List available patterns
 */

import { Hono } from 'hono';
import { createSupervisor, createCodeReviewSupervisor } from '../services/langgraph/patterns/supervisor';
import { createSwarm, createCodeSwarm } from '../services/langgraph/patterns/swarm';
import { createHierarchical, createParallelReviewer } from '../services/langgraph/patterns/hierarchical';
import { ObservabilityTracer, CostTracker } from '../services/langgraph/observability';
import { MemoryCheckpointer } from '../services/langgraph/checkpoint';
import { MemoryApprovalStore } from '../services/langgraph/human-in-loop';
import type { Env } from '../types';

const app = new Hono<{ Bindings: Env }>();

const checkpointer = new MemoryCheckpointer();
const approvalStore = new MemoryApprovalStore();
const runs = new Map<string, any>();

app.get('/patterns', (c) => {
  return c.json({
    patterns: [
      { id: 'supervisor', name: 'Supervisor', description: 'Central agent routes to specialist subagents', agents: ['researcher', 'coder', 'reviewer'] },
      { id: 'supervisor-code', name: 'Code Review Supervisor', description: 'Researcher → Coder → Reviewer pipeline', agents: ['researcher', 'coder', 'reviewer'] },
      { id: 'swarm', name: 'Swarm', description: 'Decentralized agent collaboration with handoffs', agents: ['writer', 'checker', 'fixer'] },
      { id: 'swarm-code', name: 'Code Swarm', description: 'Writer → Checker → Fixer with quality loop', agents: ['writer', 'checker', 'fixer'] },
      { id: 'hierarchical', name: 'Hierarchical', description: 'Manager decomposes → Workers parallel → Aggregator', agents: ['manager', 'impl', 'test', 'doc'] },
      { id: 'hierarchical-review', name: 'Parallel Review', description: 'Security + Performance + Style reviewers in parallel', agents: ['security', 'performance', 'style'] },
    ],
  });
});

app.post('/run', async (c) => {
  const body = await c.req.json();
  const threadId = body.threadId || `thread_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  let graph;
  switch (body.pattern) {
    case 'supervisor':
      graph = createSupervisor({
        maxIterations: 10,
        agents: [
          { name: 'researcher', description: 'Research', fn: async (state: any) => ({ findings: `Researched: ${state.task}` }) },
          { name: 'coder', description: 'Code', fn: async (state: any) => ({ code: `Code for: ${state.task}` }) },
          { name: 'reviewer', description: 'Review', fn: async (state: any) => ({ review: 'Approved', approved: true }) },
        ],
      });
      break;
    case 'supervisor-code':
      graph = createCodeReviewSupervisor();
      break;
    case 'swarm':
    case 'swarm-code':
      graph = createCodeSwarm();
      break;
    case 'hierarchical':
      graph = createHierarchical({
        manager: async (state: any) => ['implementation', 'testing', 'documentation'],
        workers: [
          { name: 'impl', description: 'Implement', fn: async (subtask: string) => ({ output: `Done: ${subtask}` }) },
          { name: 'test', description: 'Test', fn: async (subtask: string) => ({ output: `Tested: ${subtask}`, passed: true }) },
          { name: 'doc', description: 'Document', fn: async (subtask: string) => ({ output: `Doc: ${subtask}` }) },
        ],
        aggregator: async (results: Record<string, any>) => ({ summary: 'All done', details: results, passed: true }),
      });
      break;
    case 'hierarchical-review':
      graph = createParallelReviewer();
      break;
    default:
      return c.json({ error: `Unknown pattern: ${body.pattern}` }, 400);
  }

  const tracer = new ObservabilityTracer(body.pattern, threadId);
  const costTracker = new CostTracker();

  try {
    const compiled = await graph.compile({ checkpointer, tracer, threadId });
    const result = await compiled({ task: body.task, messages: [] });
    const trace = tracer.buildTrace('completed', result);

    const run = {
      threadId, pattern: body.pattern, task: body.task, result,
      trace: { graphName: trace.graphName, nodes: trace.nodes.map((n) => ({ nodeId: n.nodeId, duration: n.duration, error: n.error })), totalDuration: trace.totalDuration },
      cost: { totalUsd: costTracker.getTotalCost(), byModel: costTracker.getByModel(), byNode: costTracker.getByNode() },
      createdAt: Date.now(), completedAt: Date.now(),
    };
    runs.set(threadId, run);

    return c.json({ threadId, status: 'completed', result, trace: run.trace, cost: run.cost });
  } catch (error) {
    const trace = tracer.buildTrace('error');
    return c.json({
      threadId, status: 'error', error: error instanceof Error ? error.message : String(error),
      trace: { graphName: trace.graphName, nodes: trace.nodes.map((n) => ({ nodeId: n.nodeId, duration: n.duration, error: n.error })), totalDuration: trace.totalDuration },
    }, 500);
  }
});

app.get('/thread/:id', async (c) => {
  const run = runs.get(c.req.param('id'));
  if (!run) return c.json({ error: 'Not found' }, 404);
  return c.json(run);
});

app.get('/runs', (c) => {
  const limit = parseInt(c.req.query('limit') || '20');
  const recent = Array.from(runs.values()).sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
  return c.json({ runs: recent });
});

app.post('/approve', async (c) => {
  const { approvalId, status, response } = await c.req.json();
  await approvalStore.respond(approvalId, status, response);
  return c.json({ success: true, approvalId, status });
});

app.get('/approvals/:threadId', async (c) => {
  const approvals = await approvalStore.getByThread(c.req.param('threadId'));
  return c.json({ approvals });
});

export default app;
