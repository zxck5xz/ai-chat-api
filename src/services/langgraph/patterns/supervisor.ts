/**
 * Supervisor Pattern — Central agent routes to specialist subagents
 */

import { StateGraph, type NodeFn } from '../graph';
import { type StateSchema } from '../state';

export const supervisorSchema = {
  messages: { default: [] as any[] },
  task: { default: '' },
  currentAgent: { default: '' },
  results: { default: {} as Record<string, any> },
  iteration: { default: 0 },
  next: { default: '' },
  status: { default: 'pending' },
} satisfies StateSchema;

export interface AgentDefinition {
  name: string;
  description: string;
  fn: NodeFn<typeof supervisorSchema>;
}

export interface SupervisorConfig {
  maxIterations?: number;
  agents: AgentDefinition[];
  planner?: (state: any) => string;
}

export function createSupervisor(config: SupervisorConfig): StateGraph<typeof supervisorSchema> {
  const { agents, maxIterations = 10 } = config;
  const graph = new StateGraph({ name: 'supervisor', stateSchema: supervisorSchema, maxIterations });

  graph.addNode('supervisor', async (state) => {
    const runAgents = Object.keys(state.results);
    const remaining = agents.filter((a) => !runAgents.includes(a.name));

    if (remaining.length === 0) {
      return { status: 'completed', next: '' };
    }

    const nextAgent = config.planner ? config.planner(state) : remaining[0].name;
    return { currentAgent: nextAgent, next: nextAgent };
  });

  for (const agent of agents) {
    graph.addNode(agent.name, async (state) => {
      const result = await agent.fn(state);
      return { results: { ...state.results, [agent.name]: result }, iteration: state.iteration + 1, next: '' };
    });
  }

  graph.setEntryPoint('supervisor');
  graph.addConditionalEdge('supervisor', (state: any) => state.next || '');

  for (const agent of agents) {
    graph.addEdge(agent.name, 'supervisor');
  }

  return graph;
}

export function createCodeReviewSupervisor(): StateGraph<typeof supervisorSchema> {
  return createSupervisor({
    maxIterations: 6,
    agents: [
      { name: 'researcher', description: 'Research', fn: async (state) => ({ findings: `Research for: ${state.task}` }) },
      { name: 'coder', description: 'Code', fn: async (state) => ({ code: `Code for: ${state.task}` }) },
      { name: 'reviewer', description: 'Review', fn: async (state) => ({ review: 'Approved', approved: true }) },
    ],
  });
}
