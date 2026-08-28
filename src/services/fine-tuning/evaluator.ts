export interface EvaluatorConfig {
  db: D1Database;
}

export class Evaluator {
  private db: D1Database;

  constructor(config: EvaluatorConfig) {
    this.db = config.db;
  }

  async createEval(input: {
    job_id: string;
    base_model: string;
    fine_tuned_model: string;
    eval_set: string;
  }): Promise<string> {
    const id = crypto.randomUUID();
    await this.db.prepare(`
      INSERT INTO ft_model_evals 
        (id, job_id, base_model, fine_tuned_model, eval_set, status)
      VALUES (?, ?, ?, ?, ?, 'running')
    `).bind(id, input.job_id, input.base_model, input.fine_tuned_model, input.eval_set).run();
    return id;
  }

  async completeEval(id: string, results: {
    total_cases: number;
    base_pass_rate: number;
    ft_pass_rate: number;
    base_avg_latency: number;
    ft_avg_latency: number;
    base_avg_cost: number;
    ft_avg_cost: number;
  }): Promise<void> {
    const improvement = results.base_pass_rate > 0
      ? ((results.ft_pass_rate - results.base_pass_rate) / results.base_pass_rate) * 100
      : 0;

    await this.db.prepare(`
      UPDATE ft_model_evals
      SET status = 'completed', total_cases = ?, base_pass_rate = ?, ft_pass_rate = ?,
          base_avg_latency = ?, ft_avg_latency = ?, base_avg_cost = ?, ft_avg_cost = ?,
          improvement_pct = ?
      WHERE id = ?
    `).bind(
      results.total_cases,
      results.base_pass_rate,
      results.ft_pass_rate,
      results.base_avg_latency,
      results.ft_avg_latency,
      results.base_avg_cost,
      results.ft_avg_cost,
      Math.round(improvement * 100) / 100,
      id
    ).run();
  }

  async getEvals(jobId?: string): Promise<unknown[]> {
    let query = 'SELECT * FROM ft_model_evals';
    const params: string[] = [];
    if (jobId) {
      query += ' WHERE job_id = ?';
      params.push(jobId);
    }
    query += ' ORDER BY created_at DESC';
    const results = await this.db.prepare(query).bind(...params).all();
    return results.results;
  }

  async getEvalById(id: string): Promise<unknown | null> {
    return await this.db.prepare('SELECT * FROM ft_model_evals WHERE id = ?').bind(id).first();
  }

  async getLatestEval(): Promise<unknown | null> {
    return await this.db.prepare(
      "SELECT * FROM ft_model_evals WHERE status = 'completed' ORDER BY created_at DESC LIMIT 1"
    ).first();
  }
}
