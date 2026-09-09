import type { SemanticMemory, CreateSemanticInput } from '../../types/memory';

export class SemanticMemoryStore {
  constructor(private db: D1Database) {}

  async create(input: CreateSemanticInput): Promise<SemanticMemory> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const metadata = input.metadata ? JSON.stringify(input.metadata) : '{}';

    await this.db.prepare(`
      INSERT INTO memory_semantic (id, user_id, fact, category, confidence, source_episodic_id, source_type, access_count, last_accessed_at, strength, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, 1.0, ?, ?, ?)
    `).bind(
      id,
      input.user_id,
      input.fact,
      input.category || 'general',
      input.confidence ?? 0.7,
      input.source_episodic_id || null,
      input.source_type || 'extracted',
      now,
      metadata,
      now,
      now
    ).run();

    return (await this.get(id))!;
  }

  async get(id: string): Promise<SemanticMemory | null> {
    const row = await this.db.prepare('SELECT * FROM memory_semantic WHERE id = ?').bind(id).first();
    return row ? this.mapRow(row) : null;
  }

  async list(userId: string, limit = 50, offset = 0): Promise<SemanticMemory[]> {
    const { results } = await this.db.prepare(
      'SELECT * FROM memory_semantic WHERE user_id = ? ORDER BY strength DESC, created_at DESC LIMIT ? OFFSET ?'
    ).bind(userId, limit, offset).all();
    return results.map(r => this.mapRow(r));
  }

  async search(userId: string, query: string, limit = 20): Promise<SemanticMemory[]> {
    const { results } = await this.db.prepare(
      `SELECT *,
        (CASE WHEN fact LIKE ? THEN 0.4 ELSE 0 END +
         CASE WHEN category LIKE ? THEN 0.2 ELSE 0 END) as match_score
       FROM memory_semantic 
       WHERE user_id = ? AND (fact LIKE ? OR category LIKE ?)
       ORDER BY match_score DESC, confidence DESC, strength DESC
       LIMIT ?`
    ).bind(
      `%${query}%`, `%${query}%`,
      userId,
      `%${query}%`, `%${query}%`,
      limit
    ).all();
    return results.map(r => this.mapRow(r));
  }

  async getByCategory(userId: string, category: string): Promise<SemanticMemory[]> {
    const { results } = await this.db.prepare(
      'SELECT * FROM memory_semantic WHERE user_id = ? AND category = ? ORDER BY confidence DESC'
    ).bind(userId, category).all();
    return results.map(r => this.mapRow(r));
  }

  async access(id: string): Promise<void> {
    const now = new Date().toISOString();
    await this.db.prepare(`
      UPDATE memory_semantic 
      SET access_count = access_count + 1, 
          last_accessed_at = ?,
          strength = MIN(1.0, strength + 0.05)
      WHERE id = ?
    `).bind(now, id).run();
  }

  async decay(rate = 0.01): Promise<number> {
    const result = await this.db.prepare(`
      UPDATE memory_semantic 
      SET strength = MAX(0.01, strength - ?)
      WHERE strength > 0.01
    `).bind(rate).run();
    return result.meta?.changes ?? 0;
  }

  async delete(id: string): Promise<void> {
    await this.db.prepare('DELETE FROM memory_semantic WHERE id = ?').bind(id).run();
  }

  async deleteByUser(userId: string): Promise<void> {
    await this.db.prepare('DELETE FROM memory_semantic WHERE user_id = ?').bind(userId).run();
  }

  async count(userId: string): Promise<number> {
    const row = await this.db.prepare(
      'SELECT COUNT(*) as count FROM memory_semantic WHERE user_id = ?'
    ).bind(userId).first() as { count: number } | null;
    return row?.count ?? 0;
  }

  async getMetrics(userId: string) {
    const row = await this.db.prepare(`
      SELECT 
        COUNT(*) as total,
        AVG(strength) as avg_strength,
        AVG(confidence) as avg_confidence,
        SUM(access_count) as total_accesses,
        COUNT(DISTINCT category) as category_count
      FROM memory_semantic WHERE user_id = ?
    `).bind(userId).first();
    return row;
  }

  async getCategories(userId: string): Promise<{ category: string; count: number }[]> {
    const { results } = await this.db.prepare(
      'SELECT category, COUNT(*) as count FROM memory_semantic WHERE user_id = ? GROUP BY category ORDER BY count DESC'
    ).bind(userId).all();
    return results as { category: string; count: number }[];
  }

  private mapRow(row: Record<string, unknown>): SemanticMemory {
    return {
      id: row.id as string,
      user_id: row.user_id as string,
      fact: row.fact as string,
      category: row.category as string,
      confidence: row.confidence as number,
      source_episodic_id: row.source_episodic_id as string | null,
      source_type: row.source_type as 'extracted' | 'consolidated' | 'user_provided',
      access_count: row.access_count as number,
      last_accessed_at: row.last_accessed_at as string,
      strength: row.strength as number,
      metadata: row.metadata as string,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
  }
}
