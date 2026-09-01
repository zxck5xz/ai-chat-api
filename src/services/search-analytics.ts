/**
 * Search Analytics Service
 * Persists search queries, clicks, feedback, and aggregates them
 * for CTR, MRR, zero-click, and per-query breakdowns.
 */

import type { SearchAnalytics, SearchQuery, QueryComplexity } from '../types/search-engine';

export interface RecordQueryInput {
  query: string;
  expandedQuery?: string;
  complexity: QueryComplexity;
  strategy: string;
  resultsCount: number;
  latencyMs: number;
}

export interface RecordClickInput {
  queryId: string;
  resultId: string;
  position: number;
  documentId?: string;
  chunkId?: string;
}

export interface RecordFeedbackInput {
  queryId: string;
  rating: 'positive' | 'negative';
  comment?: string;
}

export class SearchAnalyticsService {
  private db: D1Database;

  constructor(db: D1Database) {
    this.db = db;
  }

  async recordQuery(input: RecordQueryInput): Promise<SearchQuery> {
    const id = crypto.randomUUID();
    await this.db
      .prepare(
        `INSERT INTO search_queries (id, query, expanded_query, complexity, strategy, results_count, latency_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        id,
        input.query,
        input.expandedQuery ?? null,
        input.complexity,
        input.strategy,
        input.resultsCount,
        input.latencyMs
      )
      .run();
    return {
      id,
      query: input.query,
      expanded_query: input.expandedQuery,
      complexity: input.complexity,
      strategy: input.strategy,
      results_count: input.resultsCount,
      latency_ms: input.latencyMs,
      created_at: new Date().toISOString(),
    };
  }

  async recordClick(input: RecordClickInput): Promise<void> {
    const id = crypto.randomUUID();
    await this.db
      .prepare(
        `INSERT INTO search_clicks (id, query_id, result_id, position, document_id, chunk_id)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .bind(
        id,
        input.queryId,
        input.resultId,
        input.position,
        input.documentId ?? null,
        input.chunkId ?? null
      )
      .run();

    // Update query with first click info
    await this.db
      .prepare(
        `UPDATE search_queries
         SET clicked_result_id = COALESCE(clicked_result_id, ?),
             clicked_position = COALESCE(clicked_position, ?),
             has_click = 1
         WHERE id = ?`
      )
      .bind(input.resultId, input.position, input.queryId)
      .run();
  }

  async recordFeedback(input: RecordFeedbackInput): Promise<void> {
    const id = crypto.randomUUID();
    await this.db
      .prepare(
        `INSERT INTO search_feedback (id, query_id, rating, comment)
         VALUES (?, ?, ?, ?)`
      )
      .bind(id, input.queryId, input.rating, input.comment ?? null)
      .run();
  }

  /**
   * Aggregate CTR, MRR, zero-click rate, and per-complexity / per-query breakdown.
   */
  async getMetrics(): Promise<SearchAnalytics> {
    const totals = await this.db
      .prepare(
        `SELECT
           COUNT(*) AS total_queries,
           AVG(latency_ms) AS avg_latency,
           SUM(has_click) AS clicked_queries
         FROM search_queries`
      )
      .first<{ total_queries: number; avg_latency: number | null; clicked_queries: number | null }>();

    const totalQueries = totals?.total_queries ?? 0;
    const avgLatency = totals?.avg_latency ?? 0;
    const clicked = totals?.clicked_queries ?? 0;
    const ctr = totalQueries > 0 ? clicked / totalQueries : 0;
    const zeroClickRate = totalQueries > 0 ? 1 - ctr : 0;

    // MRR: 1 / position of first click per query (averaged)
    const mrrRow = await this.db
      .prepare(
        `SELECT AVG(1.0 / clicked_position) AS mrr
         FROM search_queries
         WHERE clicked_position IS NOT NULL AND clicked_position > 0`
      )
      .first<{ mrr: number | null }>();
    const mrr = mrrRow?.mrr ?? 0;

    // By complexity
    const complexityRows = await this.db
      .prepare(
        `SELECT complexity, COUNT(*) AS count
         FROM search_queries
         GROUP BY complexity`
      )
      .all<{ complexity: QueryComplexity; count: number }>();
    const queriesByComplexity: Record<QueryComplexity, number> = {
      simple: 0,
      moderate: 0,
      complex: 0,
      ambiguous: 0,
    };
    for (const r of complexityRows.results ?? []) {
      queriesByComplexity[r.complexity] = r.count;
    }

    // Top queries (by count) with their CTR
    const topRows = await this.db
      .prepare(
        `SELECT query, COUNT(*) AS count,
                AVG(CASE WHEN has_click = 1 THEN 1.0 ELSE 0.0 END) AS ctr
         FROM search_queries
         GROUP BY query
         ORDER BY count DESC
         LIMIT 10`
      )
      .all<{ query: string; count: number; ctr: number | null }>();
    const topQueries = (topRows.results ?? []).map((r) => ({
      query: r.query,
      count: r.count,
      ctr: r.ctr ?? 0,
    }));

    // Worst queries (highest count, lowest CTR, with avg click position)
    const worstRows = await this.db
      .prepare(
        `SELECT query, COUNT(*) AS count,
                AVG(CASE WHEN has_click = 1 THEN 1.0 ELSE 0.0 END) AS ctr,
                AVG(clicked_position) AS avg_position
         FROM search_queries
         WHERE has_click = 1
         GROUP BY query
         ORDER BY ctr ASC, count DESC
         LIMIT 10`
      )
      .all<{ query: string; count: number; ctr: number | null; avg_position: number | null }>();
    const worstQueries = (worstRows.results ?? []).map((r) => ({
      query: r.query,
      count: r.count,
      ctr: r.ctr ?? 0,
      avgPosition: r.avg_position ?? 0,
    }));

    // Clicks by position
    const positionRows = await this.db
      .prepare(
        `SELECT position, COUNT(*) AS count
         FROM search_clicks
         GROUP BY position
         ORDER BY position ASC`
      )
      .all<{ position: number; count: number }>();
    const clicksByPosition = (positionRows.results ?? []).map((r) => ({
      position: r.position,
      count: r.count,
    }));

    return {
      totalQueries,
      avgLatencyMs: avgLatency,
      ctr,
      mrr,
      zeroClickRate,
      queriesByComplexity,
      topQueries,
      worstQueries,
      clicksByPosition,
    };
  }

  async listQueries(limit = 50): Promise<SearchQuery[]> {
    const rows = await this.db
      .prepare(
        `SELECT id, query, expanded_query, complexity, strategy, results_count,
                clicked_result_id, clicked_position, latency_ms, created_at
         FROM search_queries
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .bind(limit)
      .all<SearchQuery>();
    return rows.results ?? [];
  }
}
