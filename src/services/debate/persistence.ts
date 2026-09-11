// Project 17: Multi-Agent Debate & Verifier — D1 Persistence

import type { DebateRun, DebateMetrics, DebateFormat, ArgumentPosition } from '../../types/debate';

export class DebateStore {
  private db: D1Database;

  constructor(db: D1Database) {
    this.db = db;
  }

  async saveRun(run: DebateRun): Promise<void> {
    await this.db
      .prepare(
        `INSERT OR REPLACE INTO debate_runs (id, question, format, status, debaters, judge_verdict, fact_check, consensus, total_rounds, total_claims, accuracy_rate, duration_ms, created_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        run.id,
        run.question,
        run.format,
        run.status,
        JSON.stringify(run.debaters),
        run.judge_verdict ? JSON.stringify(run.judge_verdict) : null,
        run.fact_check ? JSON.stringify(run.fact_check) : null,
        run.consensus ? JSON.stringify(run.consensus) : null,
        run.total_rounds,
        run.total_claims,
        run.accuracy_rate,
        run.duration_ms,
        run.created_at,
        run.completed_at
      )
      .run();
  }

  async getRun(id: string): Promise<DebateRun | null> {
    const row = await this.db.prepare('SELECT * FROM debate_runs WHERE id = ?').bind(id).first();
    if (!row) return null;
    return this.rowToRun(row);
  }

  async getRuns(limit = 20, offset = 0): Promise<{ runs: DebateRun[]; total: number }> {
    const countResult = await this.db.prepare('SELECT COUNT(*) as total FROM debate_runs').first();
    const total = (countResult?.total as number) || 0;

    const result = await this.db
      .prepare('SELECT * FROM debate_runs ORDER BY created_at DESC LIMIT ? OFFSET ?')
      .bind(limit, offset)
      .all();

    return {
      runs: result.results.map(r => this.rowToRun(r)),
      total,
    };
  }

  async getMetrics(): Promise<DebateMetrics> {
    const totals = await this.db
      .prepare('SELECT COUNT(*) as total, AVG(duration_ms) as avg_duration, AVG(accuracy_rate) as avg_accuracy, AVG(total_claims) as avg_claims FROM debate_runs WHERE status = ?')
      .bind('completed')
      .first();

    const formatRows = await this.db
      .prepare('SELECT format, COUNT(*) as count FROM debate_runs GROUP BY format')
      .all();

    const format_breakdown: Record<string, number> = {};
    for (const row of formatRows.results) {
      format_breakdown[row.format as string] = row.count as number;
    }

    const winRates = await this.db
      .prepare("SELECT judge_verdict FROM debate_runs WHERE status = 'completed' AND judge_verdict IS NOT NULL")
      .all();

    const position_win_rates: Record<string, number> = { for: 0, against: 0, nuanced: 0 };
    let totalDebates = 0;
    for (const row of winRates.results) {
      try {
        const verdict = JSON.parse(row.judge_verdict as string);
        if (verdict.winner) {
          position_win_rates[verdict.winner] = (position_win_rates[verdict.winner] || 0) + 1;
          totalDebates++;
        }
      } catch { /* skip malformed */ }
    }
    if (totalDebates > 0) {
      for (const key of Object.keys(position_win_rates)) {
        position_win_rates[key] /= totalDebates;
      }
    }

    const recent = await this.db
      .prepare('SELECT * FROM debate_runs ORDER BY created_at DESC LIMIT 5')
      .all();

    return {
      total_debates: (totals?.total as number) || 0,
      avg_duration_ms: (totals?.avg_duration as number) || 0,
      avg_accuracy_rate: (totals?.avg_accuracy as number) || 0,
      avg_claims_per_debate: (totals?.avg_claims as number) || 0,
      format_breakdown: format_breakdown as Record<DebateFormat, number>,
      position_win_rates: position_win_rates as Record<ArgumentPosition, number>,
      recent_debates: recent.results.map(r => this.rowToRun(r)),
    };
  }

  private rowToRun(row: Record<string, unknown>): DebateRun {
    return {
      id: row.id as string,
      question: row.question as string,
      format: row.format as DebateFormat,
      status: row.status as DebateRun['status'],
      debaters: row.debaters ? JSON.parse(row.debaters as string) : [],
      judge_verdict: row.judge_verdict ? JSON.parse(row.judge_verdict as string) : null,
      fact_check: row.fact_check ? JSON.parse(row.fact_check as string) : null,
      consensus: row.consensus ? JSON.parse(row.consensus as string) : null,
      total_rounds: row.total_rounds as number,
      total_claims: row.total_claims as number,
      accuracy_rate: row.accuracy_rate as number,
      duration_ms: row.duration_ms as number,
      created_at: row.created_at as string,
      completed_at: row.completed_at as string | null,
    };
  }
}
