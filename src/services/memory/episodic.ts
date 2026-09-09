import type { EpisodicMemory, CreateEpisodicInput } from '../../types/memory';

export class EpisodicMemoryStore {
  constructor(private db: D1Database) {}

  async create(input: CreateEpisodicInput): Promise<EpisodicMemory> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const topics = input.topics ? JSON.stringify(input.topics) : '[]';
    const metadata = input.metadata ? JSON.stringify(input.metadata) : '{}';

    await this.db.prepare(`
      INSERT INTO memory_episodic (id, user_id, conversation_id, content, summary, topics, outcome, sentiment, importance, access_count, last_accessed_at, strength, consolidated, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 1.0, 0, ?, ?, ?)
    `).bind(
      id,
      input.user_id,
      input.conversation_id || null,
      input.content,
      input.summary || input.content.slice(0, 200),
      topics,
      input.outcome || 'neutral',
      input.sentiment ?? 0.5,
      input.importance ?? 0.5,
      now,
      metadata,
      now,
      now
    ).run();

    return (await this.get(id))!;
  }

  async get(id: string): Promise<EpisodicMemory | null> {
    const row = await this.db.prepare('SELECT * FROM memory_episodic WHERE id = ?').bind(id).first();
    return row ? this.mapRow(row) : null;
  }

  async list(userId: string, limit = 50, offset = 0): Promise<EpisodicMemory[]> {
    const { results } = await this.db.prepare(
      'SELECT * FROM memory_episodic WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?'
    ).bind(userId, limit, offset).all();
    return results.map(r => this.mapRow(r));
  }

  async search(userId: string, query: string, limit = 20): Promise<EpisodicMemory[]> {
    const { results } = await this.db.prepare(
      `SELECT *, 
        (CASE WHEN content LIKE ? THEN 0.3 ELSE 0 END +
         CASE WHEN summary LIKE ? THEN 0.2 ELSE 0 END +
         CASE WHEN topics LIKE ? THEN 0.2 ELSE 0 END) as match_score
       FROM memory_episodic 
       WHERE user_id = ? AND (content LIKE ? OR summary LIKE ? OR topics LIKE ?)
       ORDER BY match_score DESC, strength DESC, created_at DESC
       LIMIT ?`
    ).bind(
      `%${query}%`, `%${query}%`, `%${query}%`,
      userId,
      `%${query}%`, `%${query}%`, `%${query}%`,
      limit
    ).all();
    return results.map(r => this.mapRow(r));
  }

  async access(id: string): Promise<void> {
    const now = new Date().toISOString();
    await this.db.prepare(`
      UPDATE memory_episodic 
      SET access_count = access_count + 1, 
          last_accessed_at = ?,
          strength = MIN(1.0, strength + 0.05)
      WHERE id = ?
    `).bind(now, id).run();
  }

  async decay(rate = 0.01): Promise<number> {
    const result = await this.db.prepare(`
      UPDATE memory_episodic 
      SET strength = MAX(0.01, strength - ?)
      WHERE strength > 0.01
    `).bind(rate).run();
    return result.meta?.changes ?? 0;
  }

  async getStale(userId: string, daysOld = 30, limit = 100): Promise<EpisodicMemory[]> {
    const cutoff = new Date(Date.now() - daysOld * 86400000).toISOString();
    const { results } = await this.db.prepare(
      `SELECT * FROM memory_episodic 
       WHERE user_id = ? AND last_accessed_at < ? AND consolidated = 0
       ORDER BY strength ASC, last_accessed_at ASC
       LIMIT ?`
    ).bind(userId, cutoff, limit).all();
    return results.map(r => this.mapRow(r));
  }

  async markConsolidated(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => '?').join(',');
    await this.db.prepare(
      `UPDATE memory_episodic SET consolidated = 1 WHERE id IN (${placeholders})`
    ).bind(...ids).run();
  }

  async delete(id: string): Promise<void> {
    await this.db.prepare('DELETE FROM memory_episodic WHERE id = ?').bind(id).run();
  }

  async deleteByUser(userId: string): Promise<void> {
    await this.db.prepare('DELETE FROM memory_episodic WHERE user_id = ?').bind(userId).run();
  }

  async count(userId: string): Promise<number> {
    const row = await this.db.prepare(
      'SELECT COUNT(*) as count FROM memory_episodic WHERE user_id = ?'
    ).bind(userId).first() as { count: number } | null;
    return row?.count ?? 0;
  }

  async getMetrics(userId: string) {
    const row = await this.db.prepare(`
      SELECT 
        COUNT(*) as total,
        AVG(strength) as avg_strength,
        AVG(importance) as avg_importance,
        SUM(access_count) as total_accesses,
        SUM(CASE WHEN consolidated = 1 THEN 1 ELSE 0 END) as consolidated_count
      FROM memory_episodic WHERE user_id = ?
    `).bind(userId).first();
    return row;
  }

  private mapRow(row: Record<string, unknown>): EpisodicMemory {
    return {
      id: row.id as string,
      user_id: row.user_id as string,
      conversation_id: row.conversation_id as string | null,
      content: row.content as string,
      summary: row.summary as string,
      topics: row.topics as string,
      outcome: row.outcome as 'positive' | 'negative' | 'neutral',
      sentiment: row.sentiment as number,
      importance: row.importance as number,
      access_count: row.access_count as number,
      last_accessed_at: row.last_accessed_at as string,
      strength: row.strength as number,
      consolidated: row.consolidated as number,
      metadata: row.metadata as string,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
  }
}
