/**
 * StateGraph — Core LangGraph Engine
 */

import { type StateSchema, type InferState, createInitialState } from './state';
import { Checkpointer } from './checkpoint';
import { ObservabilityTracer } from './observability';

export type NodeFn<S extends StateSchema = StateSchema> = (state: any) => Promise<Record<string, any>>;

export interface NodeConfig<S extends StateSchema = StateSchema> {
  fn: NodeFn<S>;
  retry?: { maxAttempts: number; backoffMs: number };
}

interface EdgeDef {
  from: string;
  to: string;
  condition?: (state: any) => string;
}

export interface GraphConfig<S extends StateSchema> {
  name: string;
  stateSchema: S;
  maxIterations?: number;
}

export class StateGraph<S extends StateSchema = StateSchema> {
  private nodes: Map<string, NodeConfig<S>> = new Map();
  private edges: EdgeDef[] = [];
  private entryPoint: string = '';
  private finishNodes: Set<string> = new Set();
  private config: GraphConfig<S>;

  constructor(config: GraphConfig<S>) {
    this.config = config;
  }

  addNode(name: string, fn: NodeFn<S>, retry?: { maxAttempts: number; backoffMs: number }): this {
    this.nodes.set(name, { fn, retry });
    return this;
  }

  addEdge(from: string, to: string): this {
    this.edges.push({ from, to });
    return this;
  }

  addConditionalEdge(from: string, condition: (state: any) => string): this {
    this.edges.push({ from, to: '', condition });
    return this;
  }

  setEntryPoint(name: string): this {
    this.entryPoint = name;
    return this;
  }

  setFinishPoint(name: string): this {
    this.finishNodes.add(name);
    return this;
  }

  private resolveNext(from: string, state: any): string | null {
    for (const edge of this.edges) {
      if (edge.from === from) {
        if (edge.condition) {
          const result = edge.condition(state);
          return result || null;
        }
        return edge.to;
      }
    }
    return null;
  }

  async compile(options?: {
    checkpointer?: Checkpointer;
    tracer?: ObservabilityTracer;
    threadId?: string;
  }): Promise<(input: Record<string, any>) => Promise<any>> {
    const { checkpointer, tracer, threadId } = options || {};

    return async (input: Record<string, any>): Promise<any> => {
      let state = createInitialState(this.config.stateSchema);
      state = { ...state, ...input };

      if (checkpointer && threadId) {
        const checkpoint = await checkpointer.load(threadId);
        if (checkpoint) state = { ...state, ...checkpoint.state };
      }

      let currentNode = this.entryPoint;
      let iterations = 0;
      const maxIter = this.config.maxIterations || 100;

      while (currentNode) {
        if (iterations >= maxIter) break;

        const nodeConfig = this.nodes.get(currentNode);
        if (!nodeConfig) throw new Error(`Node "${currentNode}" not found`);

        const startTime = Date.now();
        let update: Record<string, any> = {};
        let error: string | undefined;

        try {
          update = await this.executeWithRetry(nodeConfig, state);
        } catch (e) {
          error = e instanceof Error ? e.message : String(e);
          throw e;
        } finally {
          if (tracer) {
            tracer.traceNode({ nodeId: currentNode, duration: Date.now() - startTime, stateUpdate: update, error, timestamp: startTime });
          }
        }

        state = { ...state, ...update };

        if (checkpointer && threadId) {
          await checkpointer.save(threadId, { state, nodeId: currentNode, timestamp: Date.now() });
        }

        // Check if we reached a finish point AFTER executing
        if (this.finishNodes.has(currentNode)) break;

        const next = this.resolveNext(currentNode, state);
        if (!next || next === '__end__') break;
        currentNode = next;
        iterations++;
      }

      return state;
    };
  }

  private async executeWithRetry(nodeConfig: NodeConfig<S>, state: any): Promise<Record<string, any>> {
    const { fn, retry } = nodeConfig;
    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= (retry?.maxAttempts || 0); attempt++) {
      try {
        return await fn(state);
      } catch (e) {
        lastError = e instanceof Error ? e : new Error(String(e));
        if (attempt < (retry?.maxAttempts || 0)) {
          await new Promise((r) => setTimeout(r, (retry?.backoffMs || 1000) * Math.pow(2, attempt)));
        }
      }
    }
    throw lastError;
  }
}
