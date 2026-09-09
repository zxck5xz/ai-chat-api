import type { KnowledgeGraphNode, KnowledgeGraphEdge, CreateGraphNodeInput, CreateGraphEdgeInput } from '../../types/memory';

export class KnowledgeGraphStore {
  constructor(private db: D1Database) {}

  async createNode(input: CreateGraphNodeInput): Promise<KnowledgeGraphNode> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const properties = input.properties ? JSON.stringify(input.properties) : '{}';

    await this.db.prepare(`
      INSERT INTO memory_kg_nodes (id, user_id, name, type, description, properties, strength, access_count, last_accessed_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 1.0, 1, ?, ?)
    `).bind(id, input.user_id, input.name, input.type, input.description || '', properties, now, now).run();

    return (await this.getNode(id))!;
  }

  async getNode(id: string): Promise<KnowledgeGraphNode | null> {
    const row = await this.db.prepare('SELECT * FROM memory_kg_nodes WHERE id = ?').bind(id).first();
    return row ? this.mapNodeRow(row) : null;
  }

  async findNode(userId: string, name: string, type?: string): Promise<KnowledgeGraphNode | null> {
    let query = 'SELECT * FROM memory_kg_nodes WHERE user_id = ? AND name = ?';
    const params: unknown[] = [userId, name];
    if (type) {
      query += ' AND type = ?';
      params.push(type);
    }
    const row = await this.db.prepare(query).bind(...params).first();
    return row ? this.mapNodeRow(row) : null;
  }

  async listNodes(userId: string, type?: string, limit = 100, offset = 0): Promise<KnowledgeGraphNode[]> {
    let query = 'SELECT * FROM memory_kg_nodes WHERE user_id = ?';
    const params: unknown[] = [userId];
    if (type) {
      query += ' AND type = ?';
      params.push(type);
    }
    query += ' ORDER BY strength DESC, created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const { results } = await this.db.prepare(query).bind(...params).all();
    return results.map(r => this.mapNodeRow(r));
  }

  async searchNodes(userId: string, query: string, limit = 20): Promise<KnowledgeGraphNode[]> {
    const { results } = await this.db.prepare(
      `SELECT *,
        (CASE WHEN name LIKE ? THEN 0.4 ELSE 0 END +
         CASE WHEN description LIKE ? THEN 0.3 ELSE 0 END +
         CASE WHEN type LIKE ? THEN 0.1 ELSE 0 END) as match_score
       FROM memory_kg_nodes 
       WHERE user_id = ? AND (name LIKE ? OR description LIKE ? OR type LIKE ?)
       ORDER BY match_score DESC, strength DESC
       LIMIT ?`
    ).bind(
      `%${query}%`, `%${query}%`, `%${query}%`,
      userId,
      `%${query}%`, `%${query}%`, `%${query}%`,
      limit
    ).all();
    return results.map(r => this.mapNodeRow(r));
  }

  async accessNode(id: string): Promise<void> {
    const now = new Date().toISOString();
    await this.db.prepare(`
      UPDATE memory_kg_nodes 
      SET access_count = access_count + 1, last_accessed_at = ?, strength = MIN(1.0, strength + 0.05)
      WHERE id = ?
    `).bind(now, id).run();
  }

  async createEdge(input: CreateGraphEdgeInput): Promise<KnowledgeGraphEdge> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const metadata = input.metadata ? JSON.stringify(input.metadata) : '{}';

    await this.db.prepare(`
      INSERT INTO memory_kg_edges (id, user_id, source_node_id, target_node_id, relationship, weight, metadata, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(id, input.user_id, input.source_node_id, input.target_node_id, input.relationship, input.weight ?? 1.0, metadata, now).run();

    return (await this.getEdge(id))!;
  }

  async getEdge(id: string): Promise<KnowledgeGraphEdge | null> {
    const row = await this.db.prepare('SELECT * FROM memory_kg_edges WHERE id = ?').bind(id).first();
    return row ? this.mapEdgeRow(row) : null;
  }

  async listEdges(userId: string, nodeId?: string, limit = 200): Promise<KnowledgeGraphEdge[]> {
    let query = 'SELECT * FROM memory_kg_edges WHERE user_id = ?';
    const params: unknown[] = [userId];
    if (nodeId) {
      query += ' AND (source_node_id = ? OR target_node_id = ?)';
      params.push(nodeId, nodeId);
    }
    query += ' ORDER BY weight DESC LIMIT ?';
    params.push(limit);

    const { results } = await this.db.prepare(query).bind(...params).all();
    return results.map(r => this.mapEdgeRow(r));
  }

  async getNeighbors(userId: string, nodeId: string, depth = 1): Promise<{ nodes: KnowledgeGraphNode[]; edges: KnowledgeGraphEdge[] }> {
    const visitedNodes = new Set<string>();
    const visitedEdges = new Set<string>();
    const allNodes: KnowledgeGraphNode[] = [];
    const allEdges: KnowledgeGraphEdge[] = [];

    let currentIds = [nodeId];

    for (let d = 0; d < depth; d++) {
      const nextIds: string[] = [];
      for (const id of currentIds) {
        const edges = await this.listEdges(userId, id);
        for (const edge of edges) {
          if (!visitedEdges.has(edge.id)) {
            visitedEdges.add(edge.id);
            allEdges.push(edge);
            const neighborId = edge.source_node_id === id ? edge.target_node_id : edge.source_node_id;
            if (!visitedNodes.has(neighborId)) {
              visitedNodes.add(neighborId);
              nextIds.push(neighborId);
              const node = await this.getNode(neighborId);
              if (node) allNodes.push(node);
            }
          }
        }
      }
      currentIds = nextIds;
    }

    return { nodes: allNodes, edges: allEdges };
  }

  async getSubgraph(userId: string, nodeIds: string[]): Promise<{ nodes: KnowledgeGraphNode[]; edges: KnowledgeGraphEdge[] }> {
    if (nodeIds.length === 0) return { nodes: [], edges: [] };

    const placeholders = nodeIds.map(() => '?').join(',');
    const { results: nodes } = await this.db.prepare(
      `SELECT * FROM memory_kg_nodes WHERE user_id = ? AND id IN (${placeholders})`
    ).bind(userId, ...nodeIds).all();

    const { results: edges } = await this.db.prepare(
      `SELECT * FROM memory_kg_edges WHERE user_id = ? AND (source_node_id IN (${placeholders}) OR target_node_id IN (${placeholders}))`
    ).bind(userId, ...nodeIds, ...nodeIds).all();

    return {
      nodes: nodes.map(r => this.mapNodeRow(r)),
      edges: edges.map(r => this.mapEdgeRow(r)),
    };
  }

  async deleteNode(id: string): Promise<void> {
    await this.db.prepare('DELETE FROM memory_kg_edges WHERE source_node_id = ? OR target_node_id = ?').bind(id, id).run();
    await this.db.prepare('DELETE FROM memory_kg_nodes WHERE id = ?').bind(id).run();
  }

  async deleteEdge(id: string): Promise<void> {
    await this.db.prepare('DELETE FROM memory_kg_edges WHERE id = ?').bind(id).run();
  }

  async deleteByUser(userId: string): Promise<void> {
    await this.db.prepare('DELETE FROM memory_kg_edges WHERE user_id = ?').bind(userId).run();
    await this.db.prepare('DELETE FROM memory_kg_nodes WHERE user_id = ?').bind(userId).run();
  }

  async countNodes(userId: string): Promise<number> {
    const row = await this.db.prepare(
      'SELECT COUNT(*) as count FROM memory_kg_nodes WHERE user_id = ?'
    ).bind(userId).first() as { count: number } | null;
    return row?.count ?? 0;
  }

  async countEdges(userId: string): Promise<number> {
    const row = await this.db.prepare(
      'SELECT COUNT(*) as count FROM memory_kg_edges WHERE user_id = ?'
    ).bind(userId).first() as { count: number } | null;
    return row?.count ?? 0;
  }

  async getNodeTypes(userId: string): Promise<{ type: string; count: number }[]> {
    const { results } = await this.db.prepare(
      'SELECT type, COUNT(*) as count FROM memory_kg_nodes WHERE user_id = ? GROUP BY type ORDER BY count DESC'
    ).bind(userId).all();
    return results as { type: string; count: number }[];
  }

  async getRelationshipTypes(userId: string): Promise<{ relationship: string; count: number }[]> {
    const { results } = await this.db.prepare(
      'SELECT relationship, COUNT(*) as count FROM memory_kg_edges WHERE user_id = ? GROUP BY relationship ORDER BY count DESC'
    ).bind(userId).all();
    return results as { relationship: string; count: number }[];
  }

  private mapNodeRow(row: Record<string, unknown>): KnowledgeGraphNode {
    return {
      id: row.id as string,
      user_id: row.user_id as string,
      name: row.name as string,
      type: row.type as string,
      description: row.description as string,
      properties: row.properties as string,
      strength: row.strength as number,
      access_count: row.access_count as number,
      last_accessed_at: row.last_accessed_at as string,
      created_at: row.created_at as string,
    };
  }

  private mapEdgeRow(row: Record<string, unknown>): KnowledgeGraphEdge {
    return {
      id: row.id as string,
      user_id: row.user_id as string,
      source_node_id: row.source_node_id as string,
      target_node_id: row.target_node_id as string,
      relationship: row.relationship as string,
      weight: row.weight as number,
      metadata: row.metadata as string,
      created_at: row.created_at as string,
    };
  }
}
