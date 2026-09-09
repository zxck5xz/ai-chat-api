/**
 * Agentic RAG Persistence
 * Saves and retrieves runs, steps, and rounds from D1.
 *
 * Part of Project 15: Agentic RAG with Self-Correction
 */

import type { AgenticRAGRun, AgenticRAGStep, RetrievalRound } from '../../types/agentic-rag';

export interface AgenticRAGMetrics {
  totalRuns: number;
  avgConfidence: number;
  avgRounds: number;
  avgLatencyMs: number;
  hallucinationRate: number;
  correctionRate: number;
  runsByIntent: Record<string, number>;
  runsByStrategy: Record<string, number>;
  confidenceDistribution: Array<{ range: string; count: number }>;
  recentRuns: AgenticRAGRun[];
}

export class AgenticRAGStore {
  private db: D1Database;

  constructor(db: D1Database) {
    this.db = db;
  }

  /**
   * Save a completed run with steps and rounds
   */
  async saveRun(run: AgenticRAGRun): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO agentic_rag_runs (id, query, analysis, final_answer, confidence_score, confidence_reasoning,
         has_hallucination, citation_coverage, contradictions_found, total_rounds, total_latency_ms, status, created_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        run.id,
        run.query,
        JSON.stringify(run.analysis),
        run.finalAnswer,
        run.confidence.score,
        run.confidence.reasoning,
        run.confidence.hasHallucination ? 1 : 0,
        run.confidence.citationCoverage,
        run.confidence.contradictionsFound,
        run.totalRounds,
        run.totalLatencyMs,
        run.status,
        run.createdAt,
        run.completedAt
      )
      .run();

    // Save steps
    if (run.steps.length > 0) {
      const stepBatch = run.steps.map((step) =>
        this.db
          .prepare(
            `INSERT INTO agentic_rag_steps (id, run_id, step_number, type, query, input, output, latency_ms, metadata)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .bind(
            crypto.randomUUID(),
            run.id,
            step.stepNumber,
            step.type,
            step.query,
            step.input,
            step.output,
            step.latencyMs,
            JSON.stringify(step.metadata)
          )
      );
      await this.db.batch(stepBatch);
    }

    // Save rounds
    if (run.rounds.length > 0) {
      const roundBatch = run.rounds.map((round) =>
        this.db
          .prepare(
            `INSERT INTO agentic_rag_retrieval_rounds (id, run_id, round_number, query, strategy, chunks_retrieved, avg_relevance_score, top_score, latency_ms)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .bind(
            crypto.randomUUID(),
            run.id,
            round.roundNumber,
            round.query,
            round.strategy,
            round.chunksRetrieved,
            round.avgRelevanceScore,
            round.topScore,
            round.latencyMs
          )
      );
      await this.db.batch(roundBatch);
    }
  }

  /**
   * Get a run by ID with steps and rounds
   */
  async getRun(id: string): Promise<AgenticRAGRun | null> {
    const row = await this.db
      .prepare('SELECT * FROM agentic_rag_runs WHERE id = ?')
      .bind(id)
      .first<Record<string, unknown>>();

    if (!row) return null;

    return this.rowToRun(row);
  }

  /**
   * Get recent runs with pagination
   */
  async getRecentRuns(limit = 20, offset = 0): Promise<{ runs: AgenticRAGRun[]; total: number }> {
    const countResult = await this.db
      .prepare('SELECT COUNT(*) as total FROM agentic_rag_runs')
      .first<{ total: number }>();

    const rows = await this.db
      .prepare('SELECT * FROM agentic_rag_runs ORDER BY created_at DESC LIMIT ? OFFSET ?')
      .bind(limit, offset)
      .all<Record<string, unknown>>();

    const runs = rows.results.map((row) => this.rowToRun(row));

    return {
      runs,
      total: countResult?.total || 0,
    };
  }

  /**
   * Get aggregated metrics
   */
  async getMetrics(): Promise<AgenticRAGMetrics> {
    const stats = await this.db
      .prepare(
        `SELECT
          COUNT(*) as total_runs,
          AVG(confidence_score) as avg_confidence,
          AVG(total_rounds) as avg_rounds,
          AVG(total_latency_ms) as avg_latency,
          AVG(CASE WHEN has_hallucination = 1 THEN 1.0 ELSE 0.0 END) as hallucination_rate
         FROM agentic_rag_runs`
      )
      .first<Record<string, unknown>>();

    // Runs by intent
    const intentRows = await this.db
      .prepare(
        `SELECT analysis, COUNT(*) as count FROM agentic_rag_runs GROUP BY analysis`
      )
      .all<{ analysis: string; count: number }>();

    const runsByIntent: Record<string, number> = {};
    for (const row of intentRows.results) {
      try {
        const analysis = JSON.parse(row.analysis);
        const intent = analysis.intent || 'unknown';
        runsByIntent[intent] = (runsByIntent[intent] || 0) + row.count;
      } catch {
        runsByIntent['unknown'] = (runsByIntent['unknown'] || 0) + row.count;
      }
    }

    // Runs by strategy
    const strategyRows = await this.db
      .prepare(
        `SELECT analysis, COUNT(*) as count FROM agentic_rag_runs GROUP BY analysis`
      )
      .all<{ analysis: string; count: number }>();

    const runsByStrategy: Record<string, number> = {};
    for (const row of strategyRows.results) {
      try {
        const analysis = JSON.parse(row.analysis);
        const strategy = analysis.retrievalStrategy || 'unknown';
        runsByStrategy[strategy] = (runsByStrategy[strategy] || 0) + row.count;
      } catch {
        runsByStrategy['unknown'] = (runsByStrategy['unknown'] || 0) + row.count;
      }
    }

    // Confidence distribution
    const distRows = await this.db
      .prepare(
        `SELECT
          CASE
            WHEN confidence_score >= 0.9 THEN '0.9-1.0'
            WHEN confidence_score >= 0.7 THEN '0.7-0.9'
            WHEN confidence_score >= 0.5 THEN '0.5-0.7'
            WHEN confidence_score >= 0.3 THEN '0.3-0.5'
            ELSE '0.0-0.3'
          END as range,
          COUNT(*) as count
         FROM agentic_rag_runs GROUP BY range ORDER BY range DESC`
      )
      .all<{ range: string; count: number }>();

    // Correction rate: runs that had more than 1 round (self-correction occurred)
    const correctionRow = await this.db
      .prepare(
        `SELECT
          CAST(SUM(CASE WHEN total_rounds > 1 THEN 1 ELSE 0 END) AS REAL) / COUNT(*) as correction_rate
         FROM agentic_rag_runs`
      )
      .first<{ correction_rate: number }>();

    // Recent runs
    const recentRows = await this.db
      .prepare('SELECT * FROM agentic_rag_runs ORDER BY created_at DESC LIMIT 5')
      .all<Record<string, unknown>>();

    return {
      totalRuns: Number(stats?.total_runs) || 0,
      avgConfidence: Number(stats?.avg_confidence) || 0,
      avgRounds: Number(stats?.avg_rounds) || 0,
      avgLatencyMs: Number(stats?.avg_latency) || 0,
      hallucinationRate: Number(stats?.hallucination_rate) || 0,
      correctionRate: Number(correctionRow?.correction_rate) || 0,
      runsByIntent,
      runsByStrategy,
      confidenceDistribution: distRows.results.map((r) => ({
        range: r.range,
        count: r.count,
      })),
      recentRuns: recentRows.results.map((r) => this.rowToRun(r)),
    };
  }

  /**
   * Delete a run and its related data
   */
  async deleteRun(id: string): Promise<boolean> {
    const result = await this.db
      .prepare('DELETE FROM agentic_rag_runs WHERE id = ?')
      .bind(id)
      .run();
    return result.meta?.changes > 0;
  }

  private rowToRun(row: Record<string, unknown>): AgenticRAGRun {
    let analysis;
    try {
      analysis = JSON.parse(String(row.analysis || '{}'));
    } catch {
      analysis = {
        originalQuery: String(row.query || ''),
        needsRetrieval: 'retrieve',
        decisionConfidence: 0.5,
        decisionReasoning: '',
        intent: 'factual',
        complexity: 0.5,
        subQuestions: [],
        retrievalStrategy: 'single',
        suggestedTopK: 8,
        maxRetrievalRounds: 3,
        keywords: [],
        entities: [],
      };
    }

    return {
      id: String(row.id),
      query: String(row.query),
      analysis,
      rounds: [],
      steps: [],
      finalAnswer: String(row.final_answer || ''),
      confidence: {
        score: Number(row.confidence_score) || 0,
        reasoning: String(row.confidence_reasoning || ''),
        hasHallucination: Boolean(row.has_hallucination),
        citationCoverage: Number(row.citation_coverage) || 0,
        contradictionsFound: Number(row.contradictions_found) || 0,
        needsRegeneration: false,
        needsMoreRetrieval: false,
      },
      totalRounds: Number(row.total_rounds) || 0,
      totalLatencyMs: Number(row.total_latency_ms) || 0,
      status: (String(row.status) || 'completed') as 'completed' | 'failed' | 'timeout',
      createdAt: String(row.created_at),
      completedAt: String(row.completed_at || row.created_at),
    };
  }
}
