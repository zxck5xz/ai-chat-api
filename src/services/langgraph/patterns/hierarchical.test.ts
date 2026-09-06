import { describe, it, expect } from 'vitest';
import { createHierarchical, createParallelReviewer } from './hierarchical';

describe('Hierarchical Pattern', () => {
  it('should decompose and parallelize', async () => {
    const graph = createHierarchical({
      manager: async () => ['task-a', 'task-b', 'task-c'],
      workers: [
        { name: 'w1', description: 'W1', fn: async (subtask) => ({ result: subtask }) },
      ],
      aggregator: async (results) => ({
        total: Object.keys(results).length,
        summary: 'done',
      }),
    });

    const compiled = await graph.compile();
    const result = await compiled({ task: 'complex task', messages: [] });

    expect(result.aggregatedResult.total).toBe(3);
    expect(result.status).toBe('completed');
  });

  it('should work with parallel reviewer', async () => {
    const graph = createParallelReviewer();
    const compiled = await graph.compile();
    const result = await compiled({ task: 'review code', messages: [] });

    expect(result.aggregatedResult).toHaveProperty('averageScore');
    expect(result.aggregatedResult).toHaveProperty('issues');
    expect(result.aggregatedResult).toHaveProperty('passed');
    expect(result.aggregatedResult.passed).toBe(true);
  });
});
