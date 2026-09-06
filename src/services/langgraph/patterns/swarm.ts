/**
 * Swarm Pattern — Decentralized multi-agent collaboration
 */

import { StateGraph, type NodeFn } from '../graph';
import { type StateSchema } from '../state';

export const swarmSchema = {
  messages: { default: [] as any[] },
  task: { default: '' },
  activeAgent: { default: '' },
  handoffHistory: { default: [] as string[] },
  results: { default: {} as Record<string, any> },
  iteration: { default: 0 },
  status: { default: 'pending' },
} satisfies StateSchema;

export interface SwarmAgent {
  name: string;
  description: string;
  canHandle: (state: any) => boolean;
  fn: NodeFn<typeof swarmSchema>;
  handoffTo?: (state: any) => string | null;
}

export interface SwarmConfig {
  agents: SwarmAgent[];
  maxIterations?: number;
}

export function createSwarm(config: SwarmConfig): StateGraph<typeof swarmSchema> {
  const { agents, maxIterations = 20 } = config;
  const graph = new StateGraph({ name: 'swarm', stateSchema: swarmSchema, maxIterations });

  graph.addNode('router', async (state) => {
    const capable = agents.filter((a) => a.canHandle(state));
    if (capable.length === 0) return { status: 'completed', activeAgent: '' };
    return { activeAgent: capable[0].name };
  });

  for (const agent of agents) {
    graph.addNode(agent.name, async (state) => {
      const result = await agent.fn(state);
      const updatedResults = { ...state.results, [agent.name]: result };
      let nextAgent = '';
      if (agent.handoffTo) {
        nextAgent = agent.handoffTo({ ...state, results: updatedResults }) || '';
      }
      return {
        results: updatedResults,
        handoffHistory: [...state.handoffHistory, `${agent.name} → ${nextAgent || 'end'}`],
        iteration: state.iteration + 1,
        activeAgent: nextAgent,
      };
    });
  }

  graph.setEntryPoint('router');
  graph.addConditionalEdge('router', (state: any) => state.activeAgent || '');

  for (const agent of agents) {
    graph.addConditionalEdge(agent.name, (state: any) => state.activeAgent || 'router');
  }

  return graph;
}

export function createCodeSwarm(): StateGraph<typeof swarmSchema> {
  return createSwarm({
    maxIterations: 9,
    agents: [
      {
        name: 'writer', description: 'Write code', canHandle: (state) => !state.results.writer,
        fn: async (state) => ({ code: `function solve() { /* ${state.task} */ }`, quality: 'draft' }),
        handoffTo: (state) => state.results.writer?.quality === 'draft' ? 'checker' : null,
      },
      {
        name: 'checker', description: 'Check quality', canHandle: (state) => !!state.results.writer && !state.results.checker,
        fn: async (state) => ({ issues: ['Missing error handling', 'No input validation'], score: 6 }),
        handoffTo: (state) => state.results.checker?.score < 8 ? 'fixer' : null,
      },
      {
        name: 'fixer', description: 'Fix issues', canHandle: (state) => !!state.results.checker && state.results.checker.score < 8,
        fn: async (state) => ({ fixes: state.results.checker.issues, finalCode: 'function solve() { /* fixed */ }' }),
        handoffTo: () => null,
      },
    ],
  });
}
