/**
 * Hierarchical Pattern — Manager → Workers → Aggregation
 */

import { StateGraph, type NodeFn } from '../graph';
import { type StateSchema } from '../state';

export const hierarchicalSchema = {
  messages: { default: [] as any[] },
  task: { default: '' },
  subtasks: { default: [] as string[] },
  workerResults: { default: {} as Record<string, any> },
  aggregatedResult: { default: {} as any },
  status: { default: 'pending' },
  iteration: { default: 0 },
} satisfies StateSchema;

export interface WorkerDefinition {
  name: string;
  description: string;
  fn: (subtask: string, state: any) => Promise<any>;
}

export interface HierarchicalConfig {
  manager: (state: any) => Promise<string[]>;
  workers: WorkerDefinition[];
  aggregator: (results: Record<string, any>, state: any) => Promise<any>;
  maxIterations?: number;
}

export function createHierarchical(config: HierarchicalConfig): StateGraph<typeof hierarchicalSchema> {
  const { manager, workers, aggregator, maxIterations = 10 } = config;
  const graph = new StateGraph({ name: 'hierarchical', stateSchema: hierarchicalSchema, maxIterations });

  graph.addNode('manager', async (state) => {
    const subtasks = await manager(state);
    return { subtasks, status: 'distributing' };
  });

  graph.addNode('dispatcher', async (state) => {
    const results: Record<string, any> = {};
    const promises = state.subtasks.map(async (subtask: string, i: number) => {
      const worker = workers[i % workers.length];
      const result = await worker.fn(subtask, state);
      return { name: `${worker.name}-${i}`, result };
    });
    const completed = await Promise.all(promises);
    for (const { name, result } of completed) results[name] = result;
    return { workerResults: results, iteration: state.iteration + 1 };
  });

  graph.addNode('aggregator', async (state) => {
    const aggregated = await aggregator(state.workerResults, state);
    return { aggregatedResult: aggregated, status: 'completed' };
  });

  graph.setEntryPoint('manager');
  graph.addEdge('manager', 'dispatcher');
  graph.addEdge('dispatcher', 'aggregator');
  graph.setFinishPoint('aggregator');
  return graph;
}

export function createParallelReviewer(): StateGraph<typeof hierarchicalSchema> {
  return createHierarchical({
    manager: async () => ['security-review', 'performance-review', 'style-review'],
    workers: [
      { name: 'security', description: 'Security', fn: async () => ({ score: 9, issues: ['No SQL injection'] }) },
      { name: 'performance', description: 'Performance', fn: async () => ({ score: 7, issues: ['O(n²) loop'] }) },
      { name: 'style', description: 'Style', fn: async () => ({ score: 8, issues: ['Inconsistent naming'] }) },
    ],
    aggregator: async (results) => {
      const scores = Object.values(results).map((r: any) => r.score);
      const avg = scores.reduce((a: number, b: number) => a + b, 0) / scores.length;
      const issues = Object.entries(results).flatMap(([name, r]: [string, any]) => r.issues.map((i: string) => `${name}: ${i}`));
      return { averageScore: avg, issues, passed: avg >= 7 };
    },
  });
}
