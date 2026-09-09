import { Hono } from 'hono';
import type { Env } from '../types';
import { EpisodicMemoryStore } from '../services/memory/episodic';
import { SemanticMemoryStore } from '../services/memory/semantic';
import { KnowledgeGraphStore } from '../services/memory/knowledge-graph';
import { MemoryConsolidator } from '../services/memory/consolidation';
import { MemoryRetriever } from '../services/memory/retrieval';
import { ForgettingCurve } from '../services/memory/forgetting';

const memory = new Hono<{ Bindings: Env }>();

memory.get('/metrics', async (c) => {
  const db = c.env.DB;
  const userId = c.req.query('user_id') || 'default';
  const episodic = new EpisodicMemoryStore(db);
  const semantic = new SemanticMemoryStore(db);
  const kg = new KnowledgeGraphStore(db);

  const [epMetrics, semMetrics, epCount, semCount, nodeCount, edgeCount, categories, nodeTypes, relTypes] = await Promise.all([
    episodic.getMetrics(userId),
    semantic.getMetrics(userId),
    episodic.count(userId),
    semantic.count(userId),
    kg.countNodes(userId),
    kg.countEdges(userId),
    semantic.getCategories(userId),
    kg.getNodeTypes(userId),
    kg.getRelationshipTypes(userId),
  ]);

  const accessLog = await db.prepare(
    'SELECT * FROM memory_access_log WHERE user_id = ? ORDER BY created_at DESC LIMIT 20'
  ).bind(userId).all();

  const epAccesses = (epMetrics as Record<string, unknown>)?.total_accesses ?? 0;
  const semAccesses = (semMetrics as Record<string, unknown>)?.total_accesses ?? 0;
  const epConsolidated = (epMetrics as Record<string, unknown>)?.consolidated_count ?? 0;

  return c.json({
    total_episodic: epCount,
    total_semantic: semCount,
    total_nodes: nodeCount,
    total_edges: edgeCount,
    avg_episodic_strength: (epMetrics as Record<string, unknown>)?.avg_strength ?? 0,
    avg_semantic_strength: (semMetrics as Record<string, unknown>)?.avg_strength ?? 0,
    memory_hit_rate: 0,
    total_accesses: Number(epAccesses) + Number(semAccesses),
    consolidated_count: epConsolidated,
    pending_consolidation: epCount - Number(epConsolidated),
    memory_types_breakdown: [
      { type: 'episodic', count: epCount },
      { type: 'semantic', count: semCount },
      { type: 'knowledge_graph', count: nodeCount },
    ],
    categories,
    node_types: nodeTypes,
    relationship_types: relTypes,
    recent_accesses: accessLog.results || [],
  });
});

// Episodic memory CRUD
memory.post('/episodic', async (c) => {
  const db = c.env.DB;
  const store = new EpisodicMemoryStore(db);
  const body = await c.req.json();
  const memory_entry = await store.create({
    user_id: body.user_id || 'default',
    conversation_id: body.conversation_id,
    content: body.content,
    summary: body.summary,
    topics: body.topics,
    outcome: body.outcome,
    sentiment: body.sentiment,
    importance: body.importance,
    metadata: body.metadata,
  });
  return c.json(memory_entry, 201);
});

memory.get('/episodic', async (c) => {
  const db = c.env.DB;
  const store = new EpisodicMemoryStore(db);
  const userId = c.req.query('user_id') || 'default';
  const limit = parseInt(c.req.query('limit') || '50');
  const offset = parseInt(c.req.query('offset') || '0');
  const memories = await store.list(userId, limit, offset);
  const total = await store.count(userId);
  return c.json({ memories, total });
});

memory.get('/episodic/search', async (c) => {
  const db = c.env.DB;
  const store = new EpisodicMemoryStore(db);
  const userId = c.req.query('user_id') || 'default';
  const query = c.req.query('q') || '';
  const limit = parseInt(c.req.query('limit') || '20');
  const memories = await store.search(userId, query, limit);
  return c.json({ memories });
});

memory.get('/episodic/:id', async (c) => {
  const db = c.env.DB;
  const store = new EpisodicMemoryStore(db);
  const memory_entry = await store.get(c.req.param('id'));
  if (!memory_entry) return c.json({ error: 'Not found' }, 404);
  return c.json(memory_entry);
});

memory.delete('/episodic/:id', async (c) => {
  const db = c.env.DB;
  const store = new EpisodicMemoryStore(db);
  await store.delete(c.req.param('id'));
  return c.json({ ok: true });
});

// Semantic memory CRUD
memory.post('/semantic', async (c) => {
  const db = c.env.DB;
  const store = new SemanticMemoryStore(db);
  const body = await c.req.json();
  const entry = await store.create({
    user_id: body.user_id || 'default',
    fact: body.fact,
    category: body.category,
    confidence: body.confidence,
    source_episodic_id: body.source_episodic_id,
    source_type: body.source_type,
    metadata: body.metadata,
  });
  return c.json(entry, 201);
});

memory.get('/semantic', async (c) => {
  const db = c.env.DB;
  const store = new SemanticMemoryStore(db);
  const userId = c.req.query('user_id') || 'default';
  const limit = parseInt(c.req.query('limit') || '50');
  const offset = parseInt(c.req.query('offset') || '0');
  const memories = await store.list(userId, limit, offset);
  const total = await store.count(userId);
  return c.json({ memories, total });
});

memory.get('/semantic/search', async (c) => {
  const db = c.env.DB;
  const store = new SemanticMemoryStore(db);
  const userId = c.req.query('user_id') || 'default';
  const query = c.req.query('q') || '';
  const limit = parseInt(c.req.query('limit') || '20');
  const memories = await store.search(userId, query, limit);
  return c.json({ memories });
});

memory.delete('/semantic/:id', async (c) => {
  const db = c.env.DB;
  const store = new SemanticMemoryStore(db);
  await store.delete(c.req.param('id'));
  return c.json({ ok: true });
});

// Knowledge graph
memory.post('/graph/nodes', async (c) => {
  const db = c.env.DB;
  const store = new KnowledgeGraphStore(db);
  const body = await c.req.json();
  const node = await store.createNode({
    user_id: body.user_id || 'default',
    name: body.name,
    type: body.type,
    description: body.description,
    properties: body.properties,
  });
  return c.json(node, 201);
});

memory.get('/graph/nodes', async (c) => {
  const db = c.env.DB;
  const store = new KnowledgeGraphStore(db);
  const userId = c.req.query('user_id') || 'default';
  const type = c.req.query('type') || undefined;
  const nodes = await store.listNodes(userId, type);
  return c.json({ nodes });
});

memory.get('/graph/nodes/search', async (c) => {
  const db = c.env.DB;
  const store = new KnowledgeGraphStore(db);
  const userId = c.req.query('user_id') || 'default';
  const query = c.req.query('q') || '';
  const nodes = await store.searchNodes(userId, query);
  return c.json({ nodes });
});

memory.get('/graph/nodes/:id', async (c) => {
  const db = c.env.DB;
  const store = new KnowledgeGraphStore(db);
  const node = await store.getNode(c.req.param('id'));
  if (!node) return c.json({ error: 'Not found' }, 404);
  return c.json(node);
});

memory.get('/graph/nodes/:id/neighbors', async (c) => {
  const db = c.env.DB;
  const store = new KnowledgeGraphStore(db);
  const userId = c.req.query('user_id') || 'default';
  const depth = parseInt(c.req.query('depth') || '1');
  const result = await store.getNeighbors(userId, c.req.param('id'), depth);
  return c.json(result);
});

memory.delete('/graph/nodes/:id', async (c) => {
  const db = c.env.DB;
  const store = new KnowledgeGraphStore(db);
  await store.deleteNode(c.req.param('id'));
  return c.json({ ok: true });
});

memory.post('/graph/edges', async (c) => {
  const db = c.env.DB;
  const store = new KnowledgeGraphStore(db);
  const body = await c.req.json();
  const edge = await store.createEdge({
    user_id: body.user_id || 'default',
    source_node_id: body.source_node_id,
    target_node_id: body.target_node_id,
    relationship: body.relationship,
    weight: body.weight,
    metadata: body.metadata,
  });
  return c.json(edge, 201);
});

memory.get('/graph/edges', async (c) => {
  const db = c.env.DB;
  const store = new KnowledgeGraphStore(db);
  const userId = c.req.query('user_id') || 'default';
  const nodeId = c.req.query('node_id') || undefined;
  const edges = await store.listEdges(userId, nodeId);
  return c.json({ edges });
});

memory.delete('/graph/edges/:id', async (c) => {
  const db = c.env.DB;
  const store = new KnowledgeGraphStore(db);
  await store.deleteEdge(c.req.param('id'));
  return c.json({ ok: true });
});

memory.get('/graph/subgraph', async (c) => {
  const db = c.env.DB;
  const store = new KnowledgeGraphStore(db);
  const userId = c.req.query('user_id') || 'default';
  const nodeIds = (c.req.query('node_ids') || '').split(',').filter(Boolean);
  const result = await store.getSubgraph(userId, nodeIds);
  return c.json(result);
});

// Retrieval-augmented memory
memory.get('/search', async (c) => {
  const db = c.env.DB;
  const retriever = new MemoryRetriever(db);
  const userId = c.req.query('user_id') || 'default';
  const query = c.req.query('q') || '';
  const limit = parseInt(c.req.query('limit') || '10');
  const results = await retriever.search(userId, query, limit);
  return c.json({ results });
});

memory.get('/context', async (c) => {
  const db = c.env.DB;
  const retriever = new MemoryRetriever(db);
  const userId = c.req.query('user_id') || 'default';
  const query = c.req.query('q') || '';
  const maxTokens = parseInt(c.req.query('max_tokens') || '500');
  const context = await retriever.getContext(userId, query, maxTokens);
  return c.json({ context });
});

memory.get('/timeline', async (c) => {
  const db = c.env.DB;
  const retriever = new MemoryRetriever(db);
  const userId = c.req.query('user_id') || 'default';
  const days = parseInt(c.req.query('days') || '30');
  const limit = parseInt(c.req.query('limit') || '100');
  const timeline = await retriever.getTimeline(userId, days, limit);
  return c.json({ timeline });
});

memory.get('/graph-context', async (c) => {
  const db = c.env.DB;
  const retriever = new MemoryRetriever(db);
  const userId = c.req.query('user_id') || 'default';
  const query = c.req.query('q') || '';
  const context = await retriever.getGraphContext(userId, query);
  return c.json({ context });
});

// Consolidation
memory.post('/consolidate', async (c) => {
  const db = c.env.DB;
  const consolidator = new MemoryConsolidator(db);
  const body = await c.req.json().catch(() => ({}));
  const userId = body.user_id || 'default';
  const result = await consolidator.consolidate(userId);
  return c.json(result);
});

// Forgetting curve
memory.post('/decay', async (c) => {
  const db = c.env.DB;
  const curve = new ForgettingCurve(db);
  const body = await c.req.json().catch(() => ({}));
  const userId = body.user_id || 'default';
  const result = await curve.applyDecay(userId);
  return c.json(result);
});

memory.post('/prune', async (c) => {
  const db = c.env.DB;
  const curve = new ForgettingCurve(db);
  const body = await c.req.json().catch(() => ({}));
  const userId = body.user_id || 'default';
  const result = await curve.prune(userId);
  return c.json(result);
});

memory.get('/weak', async (c) => {
  const db = c.env.DB;
  const curve = new ForgettingCurve(db);
  const userId = c.req.query('user_id') || 'default';
  const type = (c.req.query('type') || 'episodic') as 'episodic' | 'semantic';
  const weakest = await curve.getWeakest(userId, type);
  return c.json({ weakest });
});

memory.get('/forgetting-stats', async (c) => {
  const db = c.env.DB;
  const curve = new ForgettingCurve(db);
  const userId = c.req.query('user_id') || 'default';
  const stats = await curve.getStats(userId);
  return c.json(stats);
});

// Access log
memory.get('/access-log', async (c) => {
  const db = c.env.DB;
  const userId = c.req.query('user_id') || 'default';
  const limit = parseInt(c.req.query('limit') || '50');
  const { results } = await db.prepare(
    'SELECT * FROM memory_access_log WHERE user_id = ? ORDER BY created_at DESC LIMIT ?'
  ).bind(userId, limit).all();
  return c.json({ logs: results });
});

// Delete all user memory
memory.delete('/user/:userId', async (c) => {
  const db = c.env.DB;
  const userId = c.req.param('userId');
  const episodic = new EpisodicMemoryStore(db);
  const semantic = new SemanticMemoryStore(db);
  const kg = new KnowledgeGraphStore(db);
  await Promise.all([
    episodic.deleteByUser(userId),
    semantic.deleteByUser(userId),
    kg.deleteByUser(userId),
  ]);
  await db.prepare('DELETE FROM memory_access_log WHERE user_id = ?').bind(userId).run();
  return c.json({ ok: true });
});

export default memory;
