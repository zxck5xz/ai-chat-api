import { describe, it, expect } from 'vitest';
import { createCodeSwarm } from './swarm';

describe('Swarm Pattern', () => {
  it('should execute agents with handoffs', async () => {
    const graph = createCodeSwarm();
    const compiled = await graph.compile();
    const result = await compiled({ task: 'write code', messages: [] });

    expect(result.results).toHaveProperty('writer');
    expect(result.results).toHaveProperty('checker');
    expect(result.results).toHaveProperty('fixer');
  });

  it('should track handoff history', async () => {
    const graph = createCodeSwarm();
    const compiled = await graph.compile();
    const result = await compiled({ task: 'test', messages: [] });

    expect(result.handoffHistory.length).toBeGreaterThan(0);
  });
});
