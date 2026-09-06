import { describe, it, expect } from 'vitest';
import { createSupervisor, createCodeReviewSupervisor } from './supervisor';

describe('Supervisor Pattern', () => {
  it('should route through all agents', async () => {
    const graph = createSupervisor({
      maxIterations: 10,
      agents: [
        { name: 'researcher', description: 'Research', fn: async () => ({ findings: 'done' }) },
        { name: 'coder', description: 'Code', fn: async () => ({ code: 'done' }) },
        { name: 'reviewer', description: 'Review', fn: async () => ({ review: 'approved' }) },
      ],
    });

    const compiled = await graph.compile();
    const result = await compiled({ task: 'test', messages: [] });

    expect(result.results).toHaveProperty('researcher');
    expect(result.results).toHaveProperty('coder');
    expect(result.results).toHaveProperty('reviewer');
    expect(result.status).toBe('completed');
  });

  it('should work with code review supervisor', async () => {
    const graph = createCodeReviewSupervisor();
    const compiled = await graph.compile();
    const result = await compiled({ task: 'review code', messages: [] });

    expect(result.results).toHaveProperty('researcher');
    expect(result.results).toHaveProperty('coder');
    expect(result.results).toHaveProperty('reviewer');
  });
});
