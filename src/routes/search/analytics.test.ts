import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import searchAnalytics from './analytics';
import type { Env } from '../../types';
import { SearchAnalyticsService } from '../../services/search-analytics';

class FakeD1 {
  rows: any[] = [];
  prepare(sql: string) {
    const self = this;
    const exec = (params: any[]) => ({
      async run() {
        if (/INSERT INTO search_queries/.test(sql)) {
          self.rows.push({
            table: 'queries',
            id: params[0],
            query: params[1],
            expanded_query: params[2],
            complexity: params[3],
            strategy: params[4],
            results_count: params[5],
            latency_ms: params[6],
            clicked_result_id: null,
            clicked_position: null,
            has_click: 0,
            created_at: new Date().toISOString(),
          });
        } else if (/INSERT INTO search_clicks/.test(sql)) {
          self.rows.push({
            table: 'clicks',
            id: params[0],
            query_id: params[1],
            result_id: params[2],
            position: params[3],
            document_id: params[4],
            chunk_id: params[5],
          });
          const q = self.rows.find(
            (r) => r.table === 'queries' && r.id === params[1]
          );
          if (q) {
            if (q.clicked_result_id == null) {
              q.clicked_result_id = params[2];
              q.clicked_position = params[3];
            }
            q.has_click = 1;
          }
        } else if (/INSERT INTO search_feedback/.test(sql)) {
          self.rows.push({
            table: 'feedback',
            id: params[0],
            query_id: params[1],
            rating: params[2],
            comment: params[3],
          });
        }
        return { success: true };
      },
      async first() {
        return self.firstFor(sql, params);
      },
      async all() {
        return { results: self.allFor(sql, params) };
      },
    });
    return {
      bind(...args: any[]) {
        return exec(args);
      },
      async first() {
        return self.firstFor(sql, []);
      },
      async all() {
        return { results: self.allFor(sql, []) };
      },
    };
  }
  firstFor(sql: string, _params: any[]) {
    const queries = this.rows.filter((r) => r.table === 'queries');
    if (/COUNT\(\*\) AS total_queries/.test(sql)) {
      return {
        total_queries: queries.length,
        avg_latency: queries.length ? queries.reduce((s, q) => s + (q.latency_ms || 0), 0) / queries.length : 0,
        clicked_queries: queries.filter((q) => q.has_click).length,
      };
    }
    if (/AVG\(1\.0 \/ clicked_position\)/.test(sql)) {
      const valid = queries.filter((q) => q.clicked_position > 0);
      if (!valid.length) return { mrr: 0 };
      return { mrr: valid.reduce((s, q) => s + 1 / q.clicked_position, 0) / valid.length };
    }
    return null;
  }
  allFor(sql: string, params: any[]) {
    const queries = this.rows.filter((r) => r.table === 'queries');
    const clicks = this.rows.filter((r) => r.table === 'clicks');
    if (/GROUP BY complexity/.test(sql)) {
      const m: Record<string, number> = {};
      for (const q of queries) m[q.complexity] = (m[q.complexity] ?? 0) + 1;
      return Object.entries(m).map(([complexity, count]) => ({ complexity, count }));
    }
    if (/GROUP BY position/.test(sql)) {
      const m: Record<number, number> = {};
      for (const c of clicks) m[c.position] = (m[c.position] ?? 0) + 1;
      return Object.entries(m)
        .map(([position, count]) => ({ position: Number(position), count }))
        .sort((a, b) => a.position - b.position);
    }
    if (/ORDER BY ctr ASC/.test(sql)) {
      const m: Record<string, { count: number; click: number; pos: number }> = {};
      for (const q of queries) {
        if (!q.has_click) continue;
        m[q.query] = m[q.query] ?? { count: 0, click: 0, pos: 0 };
        m[q.query].count++;
        m[q.query].click++;
        m[q.query].pos += q.clicked_position;
      }
      return Object.entries(m)
        .map(([query, v]) => ({
          query,
          count: v.count,
          ctr: v.click / v.count,
          avg_position: v.pos / v.count,
        }))
        .sort((a, b) => a.ctr - b.ctr)
        .slice(0, 10);
    }
    if (/ORDER BY count DESC[\s\S]+LIMIT 10/.test(sql)) {
      const m: Record<string, { count: number; click: number }> = {};
      for (const q of queries) {
        m[q.query] = m[q.query] ?? { count: 0, click: 0 };
        m[q.query].count++;
        if (q.has_click) m[q.query].click++;
      }
      return Object.entries(m)
        .map(([query, v]) => ({ query, count: v.count, ctr: v.click / v.count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 10);
    }
    if (/SELECT id, query[\s\S]+ORDER BY created_at DESC/.test(sql)) {
      const limit = params[0] ?? 50;
      return queries
        .map((q) => ({
          id: q.id,
          query: q.query,
          expanded_query: q.expanded_query,
          complexity: q.complexity,
          strategy: q.strategy,
          results_count: q.results_count,
          clicked_result_id: q.clicked_result_id,
          clicked_position: q.clicked_position,
          latency_ms: q.latency_ms,
          created_at: q.created_at,
        }))
        .slice(0, limit);
    }
    return [];
  }
}

function buildApp(db: FakeD1) {
  const app = new Hono<{ Bindings: Env }>();
  app.route('/', searchAnalytics);
  return {
    app,
    fetch: (path: string, init?: RequestInit) =>
      app.request(path, init, { DB: db as unknown as D1Database }),
  };
}

describe('search/analytics routes (integration)', () => {
  let db: FakeD1;
  let fetcher: ReturnType<typeof buildApp>['fetch'];

  beforeEach(() => {
    db = new FakeD1();
    fetcher = buildApp(db).fetch;
  });

  it('POST /record-query returns 400 when query missing', async () => {
    const res = await fetcher('/record-query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ complexity: 'simple', strategy: 'hyde', resultsCount: 0, latencyMs: 0 }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('query');
  });

  it('full record-query → record-click → metrics flow', async () => {
    // 1. Record a query
    const q1 = await fetcher('/record-query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: 'integration test',
        complexity: 'simple',
        strategy: 'hyde',
        resultsCount: 5,
        latencyMs: 100,
      }),
    });
    expect(q1.status).toBe(200);
    const q1Body = (await q1.json()) as { query: { id: string } };
    const queryId = q1Body.query.id;
    expect(typeof queryId).toBe('string');

    // 2. Record a click
    const c1 = await fetcher('/record-click', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ queryId, resultId: 'doc-1', position: 2 }),
    });
    expect(c1.status).toBe(200);

    // 3. GET /metrics
    const m = await fetcher('/metrics');
    const mBody = (await m.json()) as {
      success: boolean;
      metrics: {
        totalQueries: number;
        ctr: number;
        mrr: number;
        queriesByComplexity: { simple: number };
        clicksByPosition: Array<{ position: number; count: number }>;
      };
    };
    expect(mBody.success).toBe(true);
    expect(mBody.metrics.totalQueries).toBe(1);
    expect(mBody.metrics.ctr).toBe(1);
    expect(mBody.metrics.mrr).toBe(0.5); // clicked at position 2
    expect(mBody.metrics.queriesByComplexity.simple).toBe(1);
    expect(mBody.metrics.clicksByPosition).toEqual([{ position: 2, count: 1 }]);
  });

  it('POST /record-click returns 400 when fields missing', async () => {
    const res = await fetcher('/record-click', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ queryId: 'x' }),
    });
    expect(res.status).toBe(400);
  });

  it('POST /record-feedback returns 400 when rating missing', async () => {
    const res = await fetcher('/record-feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ queryId: 'x' }),
    });
    expect(res.status).toBe(400);
  });

  it('GET /queries respects ?limit', async () => {
    for (let i = 0; i < 5; i++) {
      await fetcher('/record-query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: `q${i}`,
          complexity: 'simple',
          strategy: 'hyde',
          resultsCount: 0,
          latencyMs: 0,
        }),
      });
    }
    const res = await fetcher('/queries?limit=2');
    const body = (await res.json()) as { queries: unknown[] };
    expect(body.queries.length).toBe(2);
  });
});