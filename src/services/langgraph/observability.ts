/**
 * Observability — Per-node timing, state diffs, and trace logging
 */

export interface NodeTrace {
  nodeId: string;
  duration: number;
  stateUpdate: Record<string, any>;
  error?: string;
  timestamp: number;
}

export interface GraphTrace {
  graphName: string;
  threadId: string;
  nodes: NodeTrace[];
  startTime: number;
  endTime: number;
  totalDuration: number;
  status: 'running' | 'completed' | 'error';
  finalState?: Record<string, any>;
}

export class ObservabilityTracer {
  private traces: NodeTrace[] = [];
  private startTime: number;
  private graphName: string;
  private threadId: string;

  constructor(graphName: string, threadId: string) {
    this.graphName = graphName;
    this.threadId = threadId;
    this.startTime = Date.now();
  }

  traceNode(node: NodeTrace): void {
    this.traces.push(node);
  }

  getTraces(): NodeTrace[] {
    return [...this.traces];
  }

  getSlowestNodes(count: number = 5): NodeTrace[] {
    return [...this.traces].sort((a, b) => b.duration - a.duration).slice(0, count);
  }

  getTotalDuration(): number {
    if (this.traces.length === 0) return 0;
    const last = this.traces[this.traces.length - 1];
    return last.timestamp + last.duration - this.startTime;
  }

  buildTrace(status: 'completed' | 'error', finalState?: Record<string, any>): GraphTrace {
    return {
      graphName: this.graphName,
      threadId: this.threadId,
      nodes: this.traces,
      startTime: this.startTime,
      endTime: Date.now(),
      totalDuration: this.getTotalDuration(),
      status,
      finalState,
    };
  }

  // Format for structured logging
  toLogEntry(): Record<string, any> {
    return {
      graph: this.graphName,
      thread: this.threadId,
      nodes: this.traces.map((t) => ({
        id: t.nodeId,
        ms: t.duration,
        error: t.error,
        keys: Object.keys(t.stateUpdate),
      })),
      totalMs: this.getTotalDuration(),
    };
  }
}

/**
 * Cost tracker — estimate token cost per graph execution
 */
export interface CostEntry {
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  nodeId: string;
  timestamp: number;
}

export class CostTracker {
  private entries: CostEntry[] = [];

  record(entry: Omit<CostEntry, 'timestamp'>): void {
    this.entries.push({ ...entry, timestamp: Date.now() });
  }

  getTotalCost(): number {
    return this.entries.reduce((sum, e) => sum + e.costUsd, 0);
  }

  getByModel(): Record<string, number> {
    const byModel: Record<string, number> = {};
    for (const e of this.entries) {
      byModel[e.model] = (byModel[e.model] || 0) + e.costUsd;
    }
    return byModel;
  }

  getByNode(): Record<string, number> {
    const byNode: Record<string, number> = {};
    for (const e of this.entries) {
      byNode[e.nodeId] = (byNode[e.nodeId] || 0) + e.costUsd;
    }
    return byNode;
  }

  getEntries(): CostEntry[] {
    return [...this.entries];
  }
}
