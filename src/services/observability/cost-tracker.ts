export interface CostTrackerConfig {
  db: D1Database;
}

// Pricing per 1M tokens (USD) - Google Gemini models
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  'gemini-2.0-flash': { input: 0.10, output: 0.40 },
  'gemini-2.0-flash-lite': { input: 0.075, output: 0.30 },
  'gemini-1.5-pro': { input: 1.25, output: 5.00 },
  'gemini-1.5-flash': { input: 0.075, output: 0.30 },
  'gemini-pro': { input: 0.50, output: 1.50 },
};

export class CostTracker {
  private db: D1Database;

  constructor(config: CostTrackerConfig) {
    this.db = config.db;
  }

  calculateCost(model: string, inputTokens: number, outputTokens: number): number {
    const pricing = MODEL_PRICING[model] || { input: 0.50, output: 1.50 };
    return (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;
  }

  async getCostSummary(params: {
    days?: number;
    model?: string;
    user_id?: string;
  }): Promise<CostSummary[]> {
    const days = params.days || 30;
    let whereClause = `WHERE started_at >= datetime('now', '-${days} days')`;
    const bindParams: string[] = [];

    if (params.model) {
      whereClause += ' AND model = ?';
      bindParams.push(params.model);
    }
    if (params.user_id) {
      whereClause += ' AND trace_id IN (SELECT id FROM traces WHERE user_id = ?)';
      bindParams.push(params.user_id);
    }

    const results = await this.db.prepare(`
      SELECT 
        date(started_at) as date,
        model,
        COUNT(*) as total_requests,
        SUM(input_tokens) as input_tokens,
        SUM(output_tokens) as output_tokens,
        SUM(total_tokens) as total_tokens,
        SUM(cost_usd) as cost_usd
      FROM trace_spans
      ${whereClause}
      GROUP BY date(started_at), model
      ORDER BY date(started_at) DESC
    `).bind(...bindParams).all();

    return results.results as unknown as CostSummary[];
  }

  async getTotalCost(params: {
    days?: number;
    model?: string;
  }): Promise<{ total_cost_usd: number; total_tokens: number; total_requests: number }> {
    const days = params.days || 30;
    let whereClause = `WHERE started_at >= datetime('now', '-${days} days')`;
    const bindParams: string[] = [];

    if (params.model) {
      whereClause += ' AND model = ?';
      bindParams.push(params.model);
    }

    const result = await this.db.prepare(`
      SELECT 
        COALESCE(SUM(cost_usd), 0) as total_cost_usd,
        COALESCE(SUM(total_tokens), 0) as total_tokens,
        COUNT(*) as total_requests
      FROM trace_spans
      ${whereClause}
    `).bind(...bindParams).first() as {
      total_cost_usd: number;
      total_tokens: number;
      total_requests: number;
    } | null;

    return result || { total_cost_usd: 0, total_tokens: 0, total_requests: 0 };
  }

  async getCostByModel(params: { days?: number }): Promise<{ model: string; cost_usd: number; tokens: number }[]> {
    const days = params.days || 30;
    const results = await this.db.prepare(`
      SELECT 
        model,
        SUM(cost_usd) as cost_usd,
        SUM(total_tokens) as tokens
      FROM trace_spans
      WHERE started_at >= datetime('now', '-${days} days')
        AND model IS NOT NULL
      GROUP BY model
      ORDER BY cost_usd DESC
    `).all();

    return results.results as { model: string; cost_usd: number; tokens: number }[];
  }
}

interface CostSummary {
  date: string;
  model: string;
  total_requests: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cost_usd: number;
}
