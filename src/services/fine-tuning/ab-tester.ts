export interface ABTesterConfig {
  db: D1Database;
}

export class ABTester {
  private db: D1Database;

  constructor(config: ABTesterConfig) {
    this.db = config.db;
  }

  async list(): Promise<unknown[]> {
    const results = await this.db.prepare(
      'SELECT * FROM ft_ab_tests ORDER BY created_at DESC'
    ).all();
    return results.results;
  }

  async getById(id: string): Promise<unknown | null> {
    return await this.db.prepare('SELECT * FROM ft_ab_tests WHERE id = ?').bind(id).first();
  }

  async create(input: {
    name: string;
    base_model: string;
    variant_model: string;
    traffic_split: number;
  }): Promise<string> {
    const id = crypto.randomUUID();
    await this.db.prepare(`
      INSERT INTO ft_ab_tests 
        (id, name, base_model, variant_model, traffic_split, status)
      VALUES (?, ?, ?, ?, ?, 'running')
    `).bind(id, input.name, input.base_model, input.variant_model, input.traffic_split).run();
    return id;
  }

  async routeRequest(testId: string): Promise<'base' | 'variant'> {
    const test = await this.db.prepare(
      "SELECT * FROM ft_ab_tests WHERE id = ? AND status = 'running'"
    ).bind(testId).first() as { traffic_split: number } | null;

    if (!test) return 'base';
    const rand = Math.random() * 100;
    return rand < test.traffic_split ? 'variant' : 'base';
  }

  async recordResult(testId: string, model: 'base' | 'variant', latency: number, passed: boolean): Promise<void> {
    const field = model === 'base' ? 'base' : 'variant';
    await this.db.prepare(`
      UPDATE ft_ab_tests
      SET total_requests = total_requests + 1,
          ${field}_requests = ${field}_requests + 1,
          ${field}_avg_latency = (${field}_avg_latency * (${field}_requests - 1) + ?) / ${field}_requests,
          ${field}_pass_rate = (${field}_pass_rate * (${field}_requests - 1) + ?) / ${field}_requests
      WHERE id = ?
    `).bind(latency, passed ? 1 : 0, testId).run();
  }

  async stopTest(id: string): Promise<void> {
    await this.db.prepare(`
      UPDATE ft_ab_tests SET status = 'stopped', stopped_at = datetime('now') WHERE id = ?
    `).bind(id).run();
  }

  async getActiveTests(): Promise<unknown[]> {
    const results = await this.db.prepare(
      "SELECT * FROM ft_ab_tests WHERE status = 'running' ORDER BY created_at DESC"
    ).all();
    return results.results;
  }

  async deleteTest(id: string): Promise<void> {
    await this.db.prepare('DELETE FROM ft_ab_tests WHERE id = ?').bind(id).run();
  }
}
