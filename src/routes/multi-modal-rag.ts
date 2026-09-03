import { Hono } from 'hono';
import type { Env } from '../types';
import { MultiModalEmbedder } from '../services/multi-modal-rag/multi-modal-embedder';
import { CrossModalSearch } from '../services/multi-modal-rag/cross-modal-search';
import { createQdrantClient } from '../services/qdrant';

const multiModalRAG = new Hono<{ Bindings: Env }>();

function createServices(c: { env: Env }) {
  const qdrant = createQdrantClient(c.env.QDRANT_URL, c.env.QDRANT_API_KEY);
  return {
    embedder: new MultiModalEmbedder(c.env.GEMINI_API_KEY),
    search: new CrossModalSearch(qdrant),
  };
}

// POST /index - Index a document (text, image, or mixed)
multiModalRAG.post('/index', async (c) => {
  const body = await c.req.json<{
    title: string;
    type: 'image' | 'text' | 'mixed';
    content: string;
    imageBase64?: string;
    mimeType?: string;
    metadata?: Record<string, unknown>;
  }>();

  const { embedder, search } = createServices(c);

  const embedding = await embedder.embedMultiModal(
    body.content,
    body.imageBase64,
    body.mimeType
  );

  const docId = crypto.randomUUID();

  await search.upsertDocument({
    id: docId,
    title: body.title,
    type: body.type,
    content: body.content,
    imageUrl: body.imageBase64 ? `data:${body.mimeType || 'image/png'};base64,${body.imageBase64}` : undefined,
    mimeType: body.mimeType,
    embedding,
    metadata: body.metadata || {},
  });

  // Save metadata to D1
  await c.env.DB.prepare(
    'INSERT INTO multi_modal_documents (id, title, type, content, image_url, mime_type, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).bind(
    docId,
    body.title,
    body.type,
    body.content,
    body.imageBase64 ? `data:${body.mimeType || 'image/png'};base64,${body.imageBase64.slice(0, 100)}` : null,
    body.mimeType || null,
    JSON.stringify(body.metadata || {})
  ).run();

  return c.json({
    success: true,
    document: {
      id: docId,
      title: body.title,
      type: body.type,
    },
  });
});

// POST /search - Cross-modal search
multiModalRAG.post('/search', async (c) => {
  const body = await c.req.json<{
    query: string;
    queryImageBase64?: string;
    queryMimeType?: string;
    searchType: 'text-to-image' | 'image-to-text' | 'text-to-text' | 'image-to-image' | 'cross';
    topK?: number;
  }>();

  const { embedder, search } = createServices(c);
  const startTime = Date.now();

  let textEmbedding: number[] | null = null;
  let imageEmbedding: number[] | null = null;

  if (body.query) {
    textEmbedding = await embedder.embedText(body.query);
  }

  if (body.queryImageBase64 && body.queryMimeType) {
    imageEmbedding = await embedder.embedImage(body.queryImageBase64, body.queryMimeType);
  }

  let results;

  if (body.searchType === 'cross' && textEmbedding && imageEmbedding) {
    results = await search.hybridSearch(textEmbedding, imageEmbedding, body.topK || 10);
  } else if (body.searchType === 'text-to-image' && textEmbedding) {
    results = await search.search(textEmbedding, body.topK || 10, { type: 'image' });
    results = results.map((r) => ({ ...r, matchType: 'text-to-image' as const }));
  } else if (body.searchType === 'image-to-text' && imageEmbedding) {
    results = await search.search(imageEmbedding, body.topK || 10, { type: 'text' });
    results = results.map((r) => ({ ...r, matchType: 'image-to-text' as const }));
  } else if (body.searchType === 'text-to-text' && textEmbedding) {
    results = await search.search(textEmbedding, body.topK || 10, { type: 'text' });
    results = results.map((r) => ({ ...r, matchType: 'text-to-text' as const }));
  } else if (body.searchType === 'image-to-image' && imageEmbedding) {
    results = await search.search(imageEmbedding, body.topK || 10, { type: 'image' });
    results = results.map((r) => ({ ...r, matchType: 'image-to-image' as const }));
  } else {
    return c.json({ error: 'Invalid search type or missing query' }, 400);
  }

  const latencyMs = Date.now() - startTime;

  // Record search analytics
  try {
    await c.env.DB.prepare(
      'INSERT INTO multi_modal_searches (id, query, search_type, results_count, latency_ms) VALUES (?, ?, ?, ?, ?)'
    ).bind(
      crypto.randomUUID(),
      body.query || '(image query)',
      body.searchType,
      results.length,
      latencyMs
    ).run();
  } catch {
    // Non-critical
  }

  return c.json({
    success: true,
    results,
    searchType: body.searchType,
    latencyMs,
    totalResults: results.length,
  });
});

// GET /documents - List indexed documents
multiModalRAG.get('/documents', async (c) => {
  const limit = parseInt(c.req.query('limit') || '50');
  const offset = parseInt(c.req.query('offset') || '0');

  const result = await c.env.DB.prepare(
    'SELECT * FROM multi_modal_documents ORDER BY created_at DESC LIMIT ? OFFSET ?'
  ).bind(limit, offset).all();

  const countResult = await c.env.DB.prepare(
    'SELECT COUNT(*) as total FROM multi_modal_documents'
  ).first();

  return c.json({
    success: true,
    documents: result.results,
    total: countResult?.total || 0,
  });
});

// DELETE /documents/:id - Delete a document
multiModalRAG.delete('/documents/:id', async (c) => {
  const id = c.req.param('id');
  const { search } = createServices(c);

  await search.deleteDocument(id);
  await c.env.DB.prepare('DELETE FROM multi_modal_documents WHERE id = ?').bind(id).run();

  return c.json({ success: true });
});

// GET /metrics - Usage metrics
multiModalRAG.get('/metrics', async (c) => {
  const docCount = await c.env.DB.prepare(
    'SELECT COUNT(*) as total FROM multi_modal_documents'
  ).first();

  const docsByType = await c.env.DB.prepare(
    'SELECT type, COUNT(*) as count FROM multi_modal_documents GROUP BY type'
  ).all();

  const searchCount = await c.env.DB.prepare(
    'SELECT COUNT(*) as total FROM multi_modal_searches'
  ).first();

  const avgLatency = await c.env.DB.prepare(
    'SELECT AVG(latency_ms) as avg FROM multi_modal_searches'
  ).first();

  return c.json({
    metrics: {
      totalDocuments: docCount?.total || 0,
      documentsByType: Object.fromEntries(
        (docsByType.results || []).map((r: any) => [r.type, r.count])
      ),
      totalSearches: searchCount?.total || 0,
      avgLatencyMs: avgLatency?.avg || 0,
    },
  });
});

export default multiModalRAG;
