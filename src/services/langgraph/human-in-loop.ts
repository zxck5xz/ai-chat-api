/**
 * Human-in-the-Loop — Interrupt/Resume primitives
 * First-class support for human approval gates
 */

export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

export interface ApprovalRequest {
  id: string;
  threadId: string;
  nodeId: string;
  description: string;
  stateSnapshot: Record<string, any>;
  options?: string[];
  createdAt: number;
  status: ApprovalStatus;
  respondedAt?: number;
  response?: string;
}

export interface HumanApprovalStore {
  save(request: ApprovalRequest): Promise<void>;
  get(id: string): Promise<ApprovalRequest | null>;
  getByThread(threadId: string): Promise<ApprovalRequest[]>;
  respond(id: string, status: ApprovalStatus, response?: string): Promise<void>;
}

/**
 * In-memory approval store (for development)
 */
export class MemoryApprovalStore implements HumanApprovalStore {
  private requests: Map<string, ApprovalRequest> = new Map();

  async save(request: ApprovalRequest): Promise<void> {
    this.requests.set(request.id, request);
  }

  async get(id: string): Promise<ApprovalRequest | null> {
    return this.requests.get(id) || null;
  }

  async getByThread(threadId: string): Promise<ApprovalRequest[]> {
    return Array.from(this.requests.values()).filter((r) => r.threadId === threadId);
  }

  async respond(id: string, status: ApprovalStatus, response?: string): Promise<void> {
    const req = this.requests.get(id);
    if (req) {
      req.status = status;
      req.respondedAt = Date.now();
      req.response = response;
    }
  }
}

/**
 * D1-backed approval store (for production)
 */
export class D1ApprovalStore implements HumanApprovalStore {
  constructor(private db: D1Database) {}

  async save(request: ApprovalRequest): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO langgraph_approvals (id, thread_id, node_id, description, state_snapshot, options, created_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        request.id,
        request.threadId,
        request.nodeId,
        request.description,
        JSON.stringify(request.stateSnapshot),
        JSON.stringify(request.options || []),
        request.createdAt,
        request.status
      )
      .run();
  }

  async get(id: string): Promise<ApprovalRequest | null> {
    const result = await this.db
      .prepare('SELECT * FROM langgraph_approvals WHERE id = ?')
      .bind(id)
      .first();
    if (!result) return null;
    return {
      id: result.id as string,
      threadId: result.thread_id as string,
      nodeId: result.node_id as string,
      description: result.description as string,
      stateSnapshot: JSON.parse(result.state_snapshot as string),
      options: JSON.parse(result.options as string),
      createdAt: result.created_at as number,
      status: result.status as ApprovalStatus,
      respondedAt: result.responded_at as number | undefined,
      response: result.response as string | undefined,
    };
  }

  async getByThread(threadId: string): Promise<ApprovalRequest[]> {
    const results = await this.db
      .prepare('SELECT * FROM langgraph_approvals WHERE thread_id = ? ORDER BY created_at DESC')
      .bind(threadId)
      .all();
    return results.results.map((r) => ({
      id: r.id as string,
      threadId: r.thread_id as string,
      nodeId: r.node_id as string,
      description: r.description as string,
      stateSnapshot: JSON.parse(r.state_snapshot as string),
      options: JSON.parse(r.options as string),
      createdAt: r.created_at as number,
      status: r.status as ApprovalStatus,
      respondedAt: r.responded_at as number | undefined,
      response: r.response as string | undefined,
    }));
  }

  async respond(id: string, status: ApprovalStatus, response?: string): Promise<void> {
    await this.db
      .prepare(
        'UPDATE langgraph_approvals SET status = ?, responded_at = ?, response = ? WHERE id = ?'
      )
      .bind(status, Date.now(), response || null, id)
      .run();
  }
}

/**
 * Generate unique ID for approval requests
 */
export function generateApprovalId(): string {
  return `apr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
