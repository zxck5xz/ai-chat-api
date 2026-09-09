export class ForgettingCurve {
  constructor(private db: D1Database) {}

  async applyDecay(userId: string): Promise<{ episodic_decayed: number; semantic_decayed: number }> {
    const episodicDecayed = await this.decayEpisodic(userId);
    const semanticDecayed = await this.decaySemantic(userId);
    return { episodic_decayed: episodicDecayed, semantic_decayed: semanticDecayed };
  }

  private async decayEpisodic(userId: string): Promise<number> {
    // Ebbinghaus forgetting curve: strength = e^(-t/S) where t = time since last access, S = stability
    const result = await this.db.prepare(`
      UPDATE memory_episodic 
      SET strength = MAX(0.01, strength * EXP(-0.1 / MAX(1, CAST((julianday('now') - julianday(last_accessed_at)) AS REAL))))
      WHERE user_id = ? AND strength > 0.01
    `).bind(userId).run();
    return result.meta?.changes ?? 0;
  }

  private async decaySemantic(userId: string): Promise<number> {
    const result = await this.db.prepare(`
      UPDATE memory_semantic 
      SET strength = MAX(0.01, strength * EXP(-0.05 / MAX(1, CAST((julianday('now') - julianday(last_accessed_at)) AS REAL))))
      WHERE user_id = ? AND strength > 0.01
    `).bind(userId).run();
    return result.meta?.changes ?? 0;
  }

  async reinforceAccessed(userId: string, memoryType: 'episodic' | 'semantic', memoryId: string): Promise<void> {
    const table = memoryType === 'episodic' ? 'memory_episodic' : 'memory_semantic';
    const now = new Date().toISOString();
    await this.db.prepare(`
      UPDATE ${table} 
      SET access_count = access_count + 1, 
          last_accessed_at = ?,
          strength = MIN(1.0, strength + 0.1)
      WHERE id = ?
    `).bind(now, memoryId).run();
  }

  async getWeakest(userId: string, type: 'episodic' | 'semantic', limit = 20): Promise<{ id: string; strength: number; last_accessed: string }[]> {
    const table = type === 'episodic' ? 'memory_episodic' : 'memory_semantic';
    const { results } = await this.db.prepare(`
      SELECT id, strength, last_accessed_at as last_accessed
      FROM ${table} 
      WHERE user_id = ? AND strength > 0.01
      ORDER BY strength ASC
      LIMIT ?
    `).bind(userId, limit).all();
    return results as { id: string; strength: number; last_accessed: string }[];
  }

  async prune(userId: string, threshold = 0.02): Promise<{ episodic_pruned: number; semantic_pruned: number }> {
    const epResult = await this.db.prepare(
      'DELETE FROM memory_episodic WHERE user_id = ? AND strength <= ? AND access_count <= 1'
    ).bind(userId, threshold).run();

    const semResult = await this.db.prepare(
      'DELETE FROM memory_semantic WHERE user_id = ? AND strength <= ? AND access_count <= 1'
    ).bind(userId, threshold).run();

    return {
      episodic_pruned: epResult.meta?.changes ?? 0,
      semantic_pruned: semResult.meta?.changes ?? 0,
    };
  }

  async getStats(userId: string) {
    const epStats = await this.db.prepare(`
      SELECT 
        COUNT(*) as total,
        AVG(strength) as avg_strength,
        MIN(strength) as min_strength,
        SUM(CASE WHEN strength < 0.2 THEN 1 ELSE 0 END) as weak_count
      FROM memory_episodic WHERE user_id = ?
    `).bind(userId).first();

    const semStats = await this.db.prepare(`
      SELECT 
        COUNT(*) as total,
        AVG(strength) as avg_strength,
        MIN(strength) as min_strength,
        SUM(CASE WHEN strength < 0.2 THEN 1 ELSE 0 END) as weak_count
      FROM memory_semantic WHERE user_id = ?
    `).bind(userId).first();

    return { episodic: epStats, semantic: semStats };
  }
}
