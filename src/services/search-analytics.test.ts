import { describe, it, expect, beforeEach } from 'vitest';
import { SearchAnalyticsService } from './search-analytics';

// Minimal in-memory D1 mock sufficient for analytics queries
class FakeD1 {
  rows: any[] = [];
  nextId = 0;

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
            created_at: new Date().toISOString(),
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
            created_at: new Date().toISOString(),
          });
        } else if (/UPDATE search_queries/.test(sql)) {
          // handled above
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

  firstFor(sql: string, params: any[]) {
    const queries = this.rows.filter((r) => r.table === 'queries');
    const clicks = this.rows.filter((r) => r.table === 'clicks');
    if (/COUNT\(\*\) AS total_queries/.test(sql)) {
      return {
        total_queries: queries.length,
        avg_latency:
          queries.length === 0
            ? 0
            : queries.reduce((s, q) => s + (q.latency_ms || 0), 0) / queries.length,
        clicked_queries: queries.filter((q) => q.has_click).length,
      };
    }
    if (/AVG\(1\.0 \/ clicked_position\)/.test(sql)) {
      const valid = queries.filter((q) => q.clicked_position > 0);
      if (valid.length === 0) return { mrr: 0 };
      const sum = valid.reduce((s, q) => s + 1 / q.clicked_position, 0);
      return { mrr: sum / valid.length };
    }
    return null;
  }

  allFor(sql: string, params: any[]) {
    const queries = this.rows.filter((r) => r.table === 'queries');
    const clicks = this.rows.filter((r) => r.table === 'clicks');
    if (/GROUP BY complexity/.test(sql)) {
      const counts: Record<string, number> = {};
      for (const q of queries) counts[q.complexity] = (counts[q.complexity] ?? 0) + 1;
      return Object.entries(counts).map(([complexity, count]) => ({ complexity, count }));
    }
    if (/GROUP BY query[\s\S]+ORDER BY count DESC/.test(sql)) {
      const groups: Record<string, { count: number; click: number }> = {};
      for (const q of queries) {
        groups[q.query] = groups[q.query] ?? { count: 0, click: 0 };
        groups[q.query].count++;
        if (q.has_click) groups[q.query].click++;
      }
      return Object.entries(groups)
        .map(([query, v]) => ({ query, count: v.count, ctr: v.click / v.count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 10);
    }
    if (/WHERE has_click = 1[\s\S]+ORDER BY ctr ASC/.test(sql)) {
      const groups: Record<string, { count: number; click: number; posSum: number }> = {};
      for (const q of queries) {
        if (!q.has_click) continue;
        groups[q.query] = groups[q.query] ?? { count: 0, click: 0, posSum: 0 };
        groups[q.query].count++;
        groups[q.query].click++;
        groups[q.query].posSum += q.clicked_position;
      }
      return Object.entries(groups)
        .map(([query, v]) => ({
          query,
          count: v.count,
          ctr: v.click / v.count,
          avg_position: v.posSum / v.count,
        }))
        .sort((a, b) => a.ctr - b.ctr)
        .slice(0, 10);
    }
    if (/GROUP BY position[\s\S]+ORDER BY position ASC/.test(sql)) {
      const groups: Record<number, number> = {};
      for (const c of clicks) groups[c.position] = (groups[c.position] ?? 0) + 1;
      return Object.entries(groups)
        .map(([position, count]) => ({ position: Number(position), count }))
        .sort((a, b) => a.position - b.position);
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

describe('SearchAnalyticsService', () => {
  let db: FakeD1;
  let svc: SearchAnalyticsService;

  beforeEach(() => {
    db = new FakeD1();
    // @ts-expect-error - mock for tests
    svc = new SearchAnalyticsService(db);
  });

  it('returns zero metrics when empty', async () => {
    const m = await svc.getMetrics();
    expect(m.totalQueries).toBe(0);
    expect(m.ctr).toBe(0);
    expect(m.mrr).toBe(0);
  });

  it('records a query and computes CTR from clicks', async () => {
    await svc.recordQuery({
      query: 'react',
      complexity: 'simple',
      strategy: 'hyde',
      resultsCount: 5,
      latencyMs: 100,
    });
    const second = await svc.recordQuery({
      query: 'vue',
      complexity: 'simple',
      strategy: 'hyde',
      resultsCount: 5,
      latencyMs: 120,
    });
    // Click only the second one → CTR 0.5
    const rec = await svc.recordQuery({
      query: 'angular',
      complexity: 'simple',
      strategy: 'hyde',
      resultsCount: 5,
      latencyMs: 130,
    });
    void second;
    await svc.recordClick({
      queryId: rec.id,
      resultId: 'doc-1',
      position: 1,
    });

    const m = await svc.getMetrics();
    expect(m.totalQueries).toBe(3);
    expect(m.ctr).toBeCloseTo(1 / 3);
    expect(m.mrr).toBe(1); // single click at position 1
    expect(m.zeroClickRate).toBeCloseTo(2 / 3);
  });

  it('breaks down queries by complexity', async () => {
    await svc.recordQuery({ query: 'a', complexity: 'simple', strategy: 'hyde', resultsCount: 1, latencyMs: 10 });
    await svc.recordQuery({ query: 'b', complexity: 'complex', strategy: 'decomposition', resultsCount: 1, latencyMs: 10 });
    await svc.recordQuery({ query: 'c', complexity: 'complex', strategy: 'decomposition', resultsCount: 1, latencyMs: 10 });
    const m = await svc.getMetrics();
    expect(m.queriesByComplexity.simple).toBe(1);
    expect(m.queriesByComplexity.complex).toBe(2);
    expect(m.queriesByComplexity.moderate).toBe(0);
  });

  it('lists recent queries', async () => {
    for (let i = 0; i < 5; i++) {
      await svc.recordQuery({
        query: `q${i}`,
        complexity: 'simple',
        strategy: 'hyde',
        resultsCount: 0,
        latencyMs: 0,
      });
    }
    const list = await svc.listQueries(3);
    expect(list.length).toBe(3);
  });

  it('records feedback without affecting CTR', async () => {
    const rec = await svc.recordQuery({
      query: 'feedback test',
      complexity: 'simple',
      strategy: 'hyde',
      resultsCount: 1,
      latencyMs: 50,
    });
    await svc.recordFeedback({ queryId: rec.id, rating: 'positive' });
    const m = await svc.getMetrics();
    expect(m.totalQueries).toBe(1);
    expect(m.ctr).toBe(0);
  });
});
