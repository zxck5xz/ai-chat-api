import type { MemorySearchResult } from '../../types/memory';
import { EpisodicMemoryStore } from './episodic';
import { SemanticMemoryStore } from './semantic';
import { KnowledgeGraphStore } from './knowledge-graph';

export class MemoryRetriever {
  private episodic: EpisodicMemoryStore;
  private semantic: SemanticMemoryStore;
  private kg: KnowledgeGraphStore;

  constructor(private db: D1Database) {
    this.episodic = new EpisodicMemoryStore(db);
    this.semantic = new SemanticMemoryStore(db);
    this.kg = new KnowledgeGraphStore(db);
  }

  async search(userId: string, query: string, limit = 10): Promise<MemorySearchResult[]> {
    const episodicResults = await this.episodic.search(userId, query, Math.ceil(limit / 3));
    const semanticResults = await this.semantic.search(userId, query, Math.ceil(limit / 3));
    const kgResults = await this.kg.searchNodes(userId, query, Math.ceil(limit / 3));

    // Log access for retrieved memories
    for (const ep of episodicResults) {
      await this.episodic.access(ep.id);
      await this.logAccess(userId, 'episodic', ep.id, query, ep.strength);
    }
    for (const sem of semanticResults) {
      await this.semantic.access(sem.id);
      await this.logAccess(userId, 'semantic', sem.id, query, sem.confidence);
    }
    for (const node of kgResults) {
      await this.kg.accessNode(node.id);
      await this.logAccess(userId, 'knowledge_graph', node.id, query, node.strength);
    }

    // Merge and rank results
    const allResults: MemorySearchResult[] = [
      ...episodicResults.map(ep => ({
        type: 'episodic' as const,
        id: ep.id,
        content: ep.summary,
        score: ep.strength,
        metadata: { topics: ep.topics, outcome: ep.outcome, importance: ep.importance },
      })),
      ...semanticResults.map(sem => ({
        type: 'semantic' as const,
        id: sem.id,
        content: sem.fact,
        score: sem.confidence * sem.strength,
        metadata: { category: sem.category, source_type: sem.source_type },
      })),
      ...kgResults.map(node => ({
        type: 'knowledge_graph' as const,
        id: node.id,
        content: `${node.name}: ${node.description}`,
        score: node.strength,
        metadata: { type: node.type, properties: node.properties },
      })),
    ];

    // Sort by score descending
    allResults.sort((a, b) => b.score - a.score);

    return allResults.slice(0, limit);
  }

  async getContext(userId: string, query: string, maxTokens = 500): Promise<string> {
    const results = await this.search(userId, query, 10);
    if (results.length === 0) return '';

    const lines: string[] = [];
    let tokenCount = 0;

    for (const result of results) {
      const line = `[${result.type}] ${result.content}`;
      const estimatedTokens = Math.ceil(line.length / 4);
      if (tokenCount + estimatedTokens > maxTokens) break;
      lines.push(line);
      tokenCount += estimatedTokens;
    }

    return lines.join('\n');
  }

  async getTimeline(userId: string, days = 30, limit = 100): Promise<MemorySearchResult[]> {
    const cutoff = new Date(Date.now() - days * 86400000).toISOString();
    const { results } = await this.db.prepare(
      `SELECT * FROM memory_episodic 
       WHERE user_id = ? AND created_at >= ?
       ORDER BY created_at DESC LIMIT ?`
    ).bind(userId, cutoff, limit).all();

    return results.map(r => ({
      type: 'episodic' as const,
      id: r.id as string,
      content: r.summary as string,
      score: r.strength as number,
      metadata: {
        topics: r.topics,
        outcome: r.outcome,
        importance: r.importance,
        created_at: r.created_at,
      },
    }));
  }

  async getGraphContext(userId: string, query: string): Promise<string> {
    const nodes = await this.kg.searchNodes(userId, query, 5);
    if (nodes.length === 0) return '';

    const lines: string[] = ['Knowledge Graph Context:'];
    for (const node of nodes) {
      const edges = await this.kg.listEdges(userId, node.id, 5);
      const relationships = edges.map(e => {
        const otherId = e.source_node_id === node.id ? e.target_node_id : e.source_node_id;
        return `${e.relationship} [${otherId}]`;
      }).join(', ');
      lines.push(`- ${node.name} (${node.type}): ${node.description}${relationships ? ` | Relations: ${relationships}` : ''}`);
    }

    return lines.join('\n');
  }

  private async logAccess(
    userId: string,
    memoryType: 'episodic' | 'semantic' | 'knowledge_graph',
    memoryId: string,
    query: string,
    relevanceScore: number
  ): Promise<void> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await this.db.prepare(`
      INSERT INTO memory_access_log (id, user_id, memory_type, memory_id, query, relevance_score, used_in_response, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?)
    `).bind(id, userId, memoryType, memoryId, query, relevanceScore, now).run();
  }
}
