export interface TracerConfig {
  db: D1Database;
}

export interface Trace {
  id: string;
  user_id: string | null;
  operation: string;
  total_spans: number;
  total_tokens: number;
  total_cost_usd: number;
  total_latency_ms: number;
  status: 'ok' | 'error' | 'partial';
  started_at: string;
  completed_at: string | null;
}

export interface StartSpanInput {
  trace_id: string;
  parent_span_id?: string | null;
  operation: string;
  service: string;
  model?: string | null;
  metadata?: Record<string, unknown>;
}

export interface EndSpanInput {
  id: string;
  status: 'ok' | 'error' | 'timeout';
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cost_usd: number;
  latency_ms: number;
}

export class Tracer {
  private db: D1Database;

  constructor(config: TracerConfig) {
    this.db = config.db;
  }

  async startSpan(input: StartSpanInput): Promise<string> {
    const id = crypto.randomUUID();
    await this.db.prepare(`
      INSERT INTO trace_spans (id, trace_id, parent_span_id, operation, service, model, status, metadata, started_at)
      VALUES (?, ?, ?, ?, ?, ?, 'ok', ?, datetime('now'))
    `).bind(
      id,
      input.trace_id,
      input.parent_span_id || null,
      input.operation,
      input.service,
      input.model || null,
      input.metadata ? JSON.stringify(input.metadata) : null
    ).run();
    return id;
  }

  async endSpan(input: EndSpanInput): Promise<void> {
    await this.db.prepare(`
      UPDATE trace_spans
      SET status = ?, input_tokens = ?, output_tokens = ?, total_tokens = ?,
          cost_usd = ?, latency_ms = ?, completed_at = datetime('now')
      WHERE id = ?
    `).bind(
      input.status,
      input.input_tokens,
      input.output_tokens,
      input.total_tokens,
      input.cost_usd,
      input.latency_ms,
      input.id
    ).run();
  }

  async createTrace(userId?: string, operation?: string): Promise<string> {
    const id = crypto.randomUUID();
    await this.db.prepare(`
      INSERT INTO traces (id, user_id, operation, status, started_at)
      VALUES (?, ?, ?, 'ok', datetime('now'))
    `).bind(id, userId || null, operation || 'general').run();
    return id;
  }

  async completeTrace(traceId: string, status: 'ok' | 'error' | 'partial' = 'ok'): Promise<void> {
    const spans = await this.db.prepare(`
      SELECT 
        COUNT(*) as total_spans,
        COALESCE(SUM(total_tokens), 0) as total_tokens,
        COALESCE(SUM(cost_usd), 0) as total_cost_usd,
        COALESCE(SUM(latency_ms), 0) as total_latency_ms
      FROM trace_spans WHERE trace_id = ?
    `).bind(traceId).first() as {
      total_spans: number;
      total_tokens: number;
      total_cost_usd: number;
      total_latency_ms: number;
    } | null;

    if (spans) {
      await this.db.prepare(`
        UPDATE traces
        SET total_spans = ?, total_tokens = ?, total_cost_usd = ?, total_latency_ms = ?,
            status = ?, completed_at = datetime('now')
        WHERE id = ?
      `).bind(
        spans.total_spans,
        spans.total_tokens,
        spans.total_cost_usd,
        spans.total_latency_ms,
        status,
        traceId
      ).run();
    }
  }

  async getTraces(params: {
    limit?: number;
    offset?: number;
    user_id?: string;
    operation?: string;
    start_date?: string;
    end_date?: string;
  }): Promise<Trace[]> {
    let whereClause = 'WHERE 1=1';
    const bindParams: string[] = [];

    if (params.user_id) {
      whereClause += ' AND user_id = ?';
      bindParams.push(params.user_id);
    }
    if (params.operation) {
      whereClause += ' AND operation = ?';
      bindParams.push(params.operation);
    }
    if (params.start_date) {
      whereClause += ' AND started_at >= ?';
      bindParams.push(params.start_date);
    }
    if (params.end_date) {
      whereClause += ' AND started_at <= ?';
      bindParams.push(params.end_date);
    }

    const limit = params.limit || 50;
    const offset = params.offset || 0;

    const results = await this.db.prepare(`
      SELECT * FROM traces ${whereClause}
      ORDER BY started_at DESC LIMIT ? OFFSET ?
    `).bind(...bindParams, limit, offset).all();

    return results.results as unknown as Trace[];
  }

  async getTraceSpans(traceId: string): Promise<unknown[]> {
    const results = await this.db.prepare(`
      SELECT * FROM trace_spans WHERE trace_id = ? ORDER BY started_at ASC
    `).bind(traceId).all();
    return results.results;
  }

  async getTraceById(traceId: string): Promise<Trace | null> {
    const result = await this.db.prepare(`
      SELECT * FROM traces WHERE id = ?
    `).bind(traceId).first();
    return (result as unknown as Trace) || null;
  }
}
