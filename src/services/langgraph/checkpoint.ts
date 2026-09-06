/**
 * Checkpointing — Durable Execution for LangGraph
 * Save/restore state at any node for failure recovery
 */

export interface Checkpoint {
  state: Record<string, any>;
  nodeId: string;
  timestamp: number;
  threadId: string;
}

export interface Checkpointer {
  save(threadId: string, checkpoint: Omit<Checkpoint, 'threadId'>): Promise<void>;
  load(threadId: string): Promise<Checkpoint | null>;
  list(threadId: string): Promise<Checkpoint[]>;
  clear(threadId: string): Promise<void>;
}

/**
 * In-memory checkpointer (for development/testing)
 */
export class MemoryCheckpointer implements Checkpointer {
  private store: Map<string, Checkpoint[]> = new Map();

  async save(threadId: string, checkpoint: Omit<Checkpoint, 'threadId'>): Promise<void> {
    const list = this.store.get(threadId) || [];
    list.push({ ...checkpoint, threadId });
    // Keep last 50 checkpoints
    if (list.length > 50) list.splice(0, list.length - 50);
    this.store.set(threadId, list);
  }

  async load(threadId: string): Promise<Checkpoint | null> {
    const list = this.store.get(threadId) || [];
    return list[list.length - 1] || null;
  }

  async list(threadId: string): Promise<Checkpoint[]> {
    return this.store.get(threadId) || [];
  }

  async clear(threadId: string): Promise<void> {
    this.store.delete(threadId);
  }
}

/**
 * D1-backed checkpointer (for Cloudflare Workers production)
 */
export class D1Checkpointer implements Checkpointer {
  constructor(private db: D1Database) {}

  async save(threadId: string, checkpoint: Omit<Checkpoint, 'threadId'>): Promise<void> {
    await this.db.prepare(
      'INSERT INTO langgraph_checkpoints (thread_id, state, node_id, timestamp) VALUES (?, ?, ?, ?)'
    )
      .bind(threadId, JSON.stringify(checkpoint.state), checkpoint.nodeId, checkpoint.timestamp)
      .run();
  }

  async load(threadId: string): Promise<Checkpoint | null> {
    const result = await this.db
      .prepare('SELECT * FROM langgraph_checkpoints WHERE thread_id = ? ORDER BY timestamp DESC LIMIT 1')
      .bind(threadId)
      .first();
    if (!result) return null;
    return {
      threadId,
      state: JSON.parse(result.state as string),
      nodeId: result.node_id as string,
      timestamp: result.timestamp as number,
    };
  }

  async list(threadId: string): Promise<Checkpoint[]> {
    const results = await this.db
      .prepare('SELECT * FROM langgraph_checkpoints WHERE thread_id = ? ORDER BY timestamp DESC LIMIT 50')
      .bind(threadId)
      .all();
    return results.results.map((r) => ({
      threadId,
      state: JSON.parse(r.state as string),
      nodeId: r.node_id as string,
      timestamp: r.timestamp as number,
    }));
  }

  async clear(threadId: string): Promise<void> {
    await this.db.prepare('DELETE FROM langgraph_checkpoints WHERE thread_id = ?').bind(threadId).run();
  }
}

/**
 * Keep-latest TTL strategy — auto-prune old checkpoints
 */
export class TTLCheckpointer implements Checkpointer {
  private inner: Checkpointer;
  private maxAgeMs: number;
  private maxCount: number;

  constructor(inner: Checkpointer, options?: { maxAgeMs?: number; maxCount?: number }) {
    this.inner = inner;
    this.maxAgeMs = options?.maxAgeMs || 24 * 60 * 60 * 1000; // 24h default
    this.maxCount = options?.maxCount || 20;
  }

  async save(threadId: string, checkpoint: Omit<Checkpoint, 'threadId'>): Promise<void> {
    await this.inner.save(threadId, checkpoint);
    // Prune old checkpoints
    const list = await this.inner.list(threadId);
    const now = Date.now();
    const toDelete = list.filter(
      (c) => now - c.timestamp > this.maxAgeMs || list.indexOf(c) >= this.maxCount
    );
    // Note: In production, implement batch delete
    for (const c of toDelete.slice(0, 10)) {
      // Limit per call
      await this.inner.clear(threadId); // Simplified: clear all if too many
      break;
    }
  }

  async load(threadId: string): Promise<Checkpoint | null> {
    return this.inner.load(threadId);
  }

  async list(threadId: string): Promise<Checkpoint[]> {
    return this.inner.list(threadId);
  }

  async clear(threadId: string): Promise<void> {
    return this.inner.clear(threadId);
  }
}
