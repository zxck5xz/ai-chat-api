/**
 * Hybrid Search API Routes
 * Combines BM25 + Vector search with re-ranking
 */

import { Hono } from 'hono';
import type { Env } from '../types';
import {
  createQdrantClient,
  ensureCollection,
  upsertChunks,
  type DocumentChunk,
} from '../services/qdrant';
import { embedText, chunkText } from '../services/embedder';
import { BM25Index, tokenize } from '../services/bm25';
import { HybridSearch, type HybridSearchConfig } from '../services/hybrid-search';
import { ParallelRetrieval } from '../services/parallel-retrieval';
import { rerank, Reranker } from '../services/reranker';
import {
  chunkDocument,
  getChunkingStats,
  type ChunkingConfig,
} from '../services/chunking';
import {
  computeMetrics,
  aggregateMetrics,
  type EvaluationResult,
} from '../services/eval-metrics';
import {
  createABTest,
  startABTest,
  recordABTestResult,
  getABTestSummary,
  selectVariant,
  type ABTestConfig,
  type ABVariant,
} from '../services/ab-testing';
import { getEmbeddingCache } from '../services/cache/embedding-cache';

const hybridSearch = new Hono<{ Bindings: Env }>();

// In-memory BM25 index (build on startup or cache)
let bm25Index: BM25Index | null = null;

/**
 * Build or rebuild BM25 index from Qdrant
 */
async function buildBM25Index(qdrant: ReturnType<typeof createQdrantClient>) {
  const index = new BM25Index();
  let offset: string | number | null = null;
  let hasMore = true;

  while (hasMore) {
    const result = await qdrant.scroll('ai-chat-documents', {
      limit: 100,
      offset,
      with_payload: true,
    });

    for (const point of result.points) {
      const content = point.payload?.content as string;
      if (content) {
        index.addDocument(point.id as string, content);
      }
    }

    offset = (result.next_page_offset as string | number | null) ?? null;
    hasMore = result.points.length === 100 && offset !== null;
  }

  bm25Index = index;
  return index;
}

/**
 * POST /hybrid/documents
 * Upload document with configurable chunking strategy
 */
hybridSearch.post('/documents', async (c) => {
  try {
    const body = await c.req.json<{
      title: string;
      url?: string;
      content: string;
      chunkingStrategy?: string;
      chunkSize?: number;
      chunkOverlap?: number;
    }>();

    const { title, url, content, chunkingStrategy, chunkSize, chunkOverlap } = body;

    if (!title || !content) {
      return c.json({ error: 'title and content are required' }, 400);
    }

    const qdrant = createQdrantClient(c.env.QDRANT_URL, c.env.QDRANT_API_KEY);
    await ensureCollection(qdrant);

    // Configure chunking
    const chunkingConfig: Partial<ChunkingConfig> = {
      strategy: (chunkingStrategy as ChunkingConfig['strategy']) || 'recursive',
      chunkSize: chunkSize || 500,
      overlap: chunkOverlap || 50,
    };

    // Chunk the document with selected strategy
    const chunks = chunkDocument(content, chunkingConfig);

    // Embed all chunks
    const embeddings: number[][] = [];
    for (const chunk of chunks) {
      const embedding = await embedText(c.env.GEMINI_API_KEY, chunk.content);
      embeddings.push(embedding);
    }

    // Create document chunks
    const documentId = crypto.randomUUID();
    const documentChunks: DocumentChunk[] = chunks.map((chunk, index) => ({
      id: crypto.randomUUID(),
      documentId,
      documentTitle: title,
      documentUrl: url || '',
      chunkIndex: index,
      content: chunk.content,
      embedding: embeddings[index],
    }));

    // Store in Qdrant
    await upsertChunks(qdrant, documentChunks);

    // Store metadata in D1
    await c.env.DB.prepare(
      'INSERT INTO documents (id, title, url, chunk_count) VALUES (?, ?, ?, ?)'
    ).bind(documentId, title, url || null, chunks.length).run();

    // Get chunking stats
    const stats = getChunkingStats(chunks);

    // Rebuild BM25 index
    await buildBM25Index(qdrant);

    return c.json({
      id: documentId,
      title,
      chunkCount: chunks.length,
      chunkingStrategy: chunkingConfig.strategy,
      stats,
    });
  } catch (err) {
    console.error('Document upload error:', err);
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Failed to process document', details: message }, 500);
  }
});

/**
 * POST /hybrid/search
 * Perform hybrid search with optional re-ranking
 */
hybridSearch.post('/search', async (c) => {
  try {
    const body = await c.req.json<{
      query: string;
      topK?: number;
      searchMethod?: 'vector' | 'bm25' | 'hybrid';
      hybridConfig?: Partial<HybridSearchConfig>;
      rerankResults?: boolean;
      cohereApiKey?: string;
      parallel?: boolean;
    }>();

    const {
      query,
      topK = 5,
      searchMethod = 'hybrid',
      hybridConfig,
      rerankResults = false,
      cohereApiKey,
      parallel = false,
    } = body;

    if (!query) {
      return c.json({ error: 'query is required' }, 400);
    }

    const qdrant = createQdrantClient(c.env.QDRANT_URL, c.env.QDRANT_API_KEY);
    await ensureCollection(qdrant);

    // Ensure BM25 index is built
    if (!bm25Index) {
      await buildBM25Index(qdrant);
    }

    let results: Array<{
      id: string;
      content: string;
      documentId: string;
      documentTitle: string;
      documentUrl: string;
      chunkIndex: number;
      score: number;
      searchMethod: string;
    }> = [];

    // Vector search
    if (searchMethod === 'vector' || searchMethod === 'hybrid') {
      const queryEmbedding = await embedText(c.env.GEMINI_API_KEY, query);
      const vectorResults = await qdrant.query('ai-chat-documents', {
        query: queryEmbedding,
        limit: searchMethod === 'hybrid' ? (hybridConfig?.vectorTopK || 20) : topK,
        with_payload: true,
      });

      for (const point of vectorResults.points) {
        results.push({
          id: point.id as string,
          content: (point.payload?.content as string) || '',
          documentId: (point.payload?.documentId as string) || '',
          documentTitle: (point.payload?.documentTitle as string) || '',
          documentUrl: (point.payload?.documentUrl as string) || '',
          chunkIndex: (point.payload?.chunkIndex as number) || 0,
          score: point.score,
          searchMethod: 'vector',
        });
      }
    }

    // BM25 search
    if (searchMethod === 'bm25' || searchMethod === 'hybrid') {
      const bm25Results = bm25Index!.search(query, hybridConfig?.bm25TopK || 20);

      for (const result of bm25Results) {
        const existing = results.find((r) => r.id === result.id);
        if (existing) {
          // Combine scores for hybrid
          existing.score = existing.score + result.score * 0.4;
        } else {
          // Fetch full document data
          const point = await qdrant.retrieve('ai-chat-documents', {
            ids: [result.id],
            with_payload: true,
          });

          if (point.length > 0) {
            results.push({
              id: result.id,
              content: (point[0].payload?.content as string) || '',
              documentId: (point[0].payload?.documentId as string) || '',
              documentTitle: (point[0].payload?.documentTitle as string) || '',
              documentUrl: (point[0].payload?.documentUrl as string) || '',
              chunkIndex: (point[0].payload?.chunkIndex as number) || 0,
              score: result.score,
              searchMethod: 'bm25',
            });
          }
        }
      }
    }

    // Parallel retrieval (BM25 + Vector) — when requested and method is hybrid
    if (parallel && searchMethod === 'hybrid') {
      const retriever = new ParallelRetrieval(qdrant, 'ai-chat-documents');
      const parallelResults = await retriever.search(
        query,
        c.env.GEMINI_API_KEY,
        bm25Index!,
        {
          vectorTopK: hybridConfig?.vectorTopK || 20,
          bm25TopK: hybridConfig?.bm25TopK || 20,
          vectorWeight: hybridConfig?.vectorWeight || 0.6,
          bm25Weight: hybridConfig?.bm25Weight || 0.4,
        }
      );

      results = parallelResults.map((r) => ({
        id: r.id,
        content: r.content,
        documentId: r.documentId,
        documentTitle: r.documentTitle,
        documentUrl: r.documentUrl,
        chunkIndex: r.chunkIndex,
        score: r.combinedScore,
        searchMethod: 'parallel',
      }));
    }

    // Sort by score and take top K
    results.sort((a, b) => b.score - a.score);
    results = results.slice(0, topK);

    // Apply re-ranking if requested
    let rerankProvider: 'cohere' | 'bge' | 'local' | undefined;
    if (rerankResults && results.length > 0) {
      const reranker = new Reranker(cohereApiKey || c.env.COHERE_API_KEY, {
        topN: topK,
      });

      const reranked = await reranker.rerank(
        query,
        results.map((r) => ({ id: r.id, content: r.content }))
      );

      // Re-order results based on reranking
      const rerankedMap = new Map(reranked.map((r) => [r.id, r]));
      rerankProvider = reranked[0]?.provider;
      results = results
        .map((r) => ({
          ...r,
          score: rerankedMap.get(r.id)?.relevanceScore || r.score,
        }))
        .sort((a, b) => b.score - a.score);
    }

    return c.json({
      query,
      searchMethod,
      results,
      totalResults: results.length,
      rerankProvider,
    });
  } catch (err) {
    console.error('Hybrid search error:', err);
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Search failed', details: message }, 500);
  }
});

/**
 * POST /hybrid/query
 * Full RAG query with hybrid search + streaming response
 */
hybridSearch.post('/query', async (c) => {
  try {
    const body = await c.req.json<{
      query: string;
      conversationId?: string;
      searchMethod?: 'vector' | 'bm25' | 'hybrid';
      topK?: number;
      rerankResults?: boolean;
    }>();

    const {
      query,
      conversationId,
      searchMethod = 'hybrid',
      topK = 5,
      rerankResults = false,
    } = body;

    if (!query) {
      return c.json({ error: 'query is required' }, 400);
    }

    const qdrant = createQdrantClient(c.env.QDRANT_URL, c.env.QDRANT_API_KEY);
    await ensureCollection(qdrant);

    // Ensure BM25 index is built
    if (!bm25Index) {
      await buildBM25Index(qdrant);
    }

    // Perform hybrid search
    let searchResults: Array<{
      id: string;
      content: string;
      documentTitle: string;
      documentUrl: string;
      score: number;
    }> = [];

    if (searchMethod === 'hybrid') {
      const hybrid = new HybridSearch(qdrant, 'ai-chat-documents');
      const results = await hybrid.search(query, c.env.GEMINI_API_KEY, {
        vectorTopK: 20,
        bm25TopK: 20,
        finalTopK: topK,
      });

      searchResults = results.map((r) => ({
        id: r.id,
        content: r.content,
        documentTitle: r.documentTitle,
        documentUrl: r.documentUrl,
        score: r.finalScore,
      }));
    } else {
      // Single search method
      const queryEmbedding = await embedText(c.env.GEMINI_API_KEY, query);
      const vectorResults = await qdrant.query('ai-chat-documents', {
        query: queryEmbedding,
        limit: topK,
        with_payload: true,
      });

      searchResults = vectorResults.points.map((p) => ({
        id: p.id as string,
        content: (p.payload?.content as string) || '',
        documentTitle: (p.payload?.documentTitle as string) || '',
        documentUrl: (p.payload?.documentUrl as string) || '',
        score: p.score,
      }));
    }

    if (searchResults.length === 0) {
      return c.json({
        answer: 'No relevant documents found. Please upload some documents first.',
        sources: [],
      });
    }

    // Build context
    const context = searchResults
      .map(
        (r, i) =>
          `[Source ${i + 1}: ${r.documentTitle}]\n${r.content}`
      )
      .join('\n\n');

    // Build sources
    const sources = searchResults.map((r) => ({
      id: r.id,
      title: r.documentTitle,
      url: r.documentUrl,
      snippet: r.content.slice(0, 200) + '...',
      score: Math.round(r.score * 100) / 100,
      searchMethod,
    }));

    // Call Gemini with streaming
    const model = 'gemini-3.6-flash';
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${c.env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: {
            parts: [
              {
                text: `You are a helpful AI assistant that answers questions based on the provided context.

Rules:
- Answer based ONLY on the provided context
- If the context doesn't contain enough information, say so
- Cite sources using [Source N] notation
- Be concise and accurate

Context:
${context}`,
              },
            ],
          },
          contents: [{ role: 'user', parts: [{ text: query }] }],
          generationConfig: {
            temperature: 0.3,
            maxOutputTokens: 4096,
          },
        }),
      }
    );

    if (!response.ok) {
      throw new Error(`Gemini API error: ${response.status}`);
    }

    // Create SSE stream
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        try {
          let fullText = '';
          const reader = response.body?.getReader();
          const decoder = new TextDecoder();

          if (!reader) {
            controller.close();
            return;
          }

          // Signal start
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ type: 'start', model, searchMethod })}\n\n`
            )
          );

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value, { stream: true });
            const lines = chunk.split('\n');

            for (const line of lines) {
              if (line.startsWith('data: ')) {
                const data = line.slice(6);
                if (data === '[DONE]') continue;

                try {
                  const parsed = JSON.parse(data);
                  const text =
                    parsed.candidates?.[0]?.content?.parts?.[0]?.text;
                  if (text) {
                    fullText += text;
                    controller.enqueue(
                      encoder.encode(
                        `data: ${JSON.stringify({ type: 'token', content: text })}\n\n`
                      )
                    );
                  }
                } catch {
                  // Skip malformed JSON
                }
              }
            }
          }

          // Send sources at the end
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ type: 'sources', sources })}\n\n`
            )
          );

          // Save to conversation if provided
          if (conversationId && fullText) {
            const msgId = crypto.randomUUID();
            await c.env.DB.prepare(
              'INSERT INTO messages (id, conversation_id, role, content, sources) VALUES (?, ?, ?, ?, ?)'
            )
              .bind(
                msgId,
                conversationId,
                'assistant',
                fullText,
                JSON.stringify(sources)
              )
              .run();
          }

          // Signal end
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        } catch (err) {
          console.error('Stream error:', err);
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (err) {
    console.error('Hybrid query error:', err);
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Failed to process query', details: message }, 500);
  }
});

/**
 * POST /hybrid/compare
 * Compare different search methods
 */
hybridSearch.post('/compare', async (c) => {
  try {
    const body = await c.req.json<{
      query: string;
      topK?: number;
      methods?: Array<'vector' | 'bm25' | 'hybrid'>;
    }>();

    const { query, topK = 5, methods = ['vector', 'bm25', 'hybrid'] } = body;

    if (!query) {
      return c.json({ error: 'query is required' }, 400);
    }

    const qdrant = createQdrantClient(c.env.QDRANT_URL, c.env.QDRANT_API_KEY);
    await ensureCollection(qdrant);

    if (!bm25Index) {
      await buildBM25Index(qdrant);
    }

    const comparison: Record<string, Array<{
      id: string;
      content: string;
      documentTitle: string;
      score: number;
    }>> = {};

    for (const method of methods) {
      if (method === 'vector') {
        const queryEmbedding = await embedText(c.env.GEMINI_API_KEY, query);
        const results = await qdrant.query('ai-chat-documents', {
          query: queryEmbedding,
          limit: topK,
          with_payload: true,
        });

        comparison.vector = results.points.map((p) => ({
          id: p.id as string,
          content: (p.payload?.content as string) || '',
          documentTitle: (p.payload?.documentTitle as string) || '',
          score: p.score,
        }));
      } else if (method === 'bm25') {
        const results = bm25Index!.search(query, topK);
        comparison.bm25 = results.map((r) => ({
          id: r.id,
          content: r.content,
          documentTitle: '',
          score: r.score,
        }));
      } else if (method === 'hybrid') {
        const hybrid = new HybridSearch(qdrant, 'ai-chat-documents');
        const results = await hybrid.search(query, c.env.GEMINI_API_KEY, {
          finalTopK: topK,
        });

        comparison.hybrid = results.map((r) => ({
          id: r.id,
          content: r.content,
          documentTitle: r.documentTitle,
          score: r.finalScore,
        }));
      }
    }

    // Calculate overlap between methods
    const overlap: Record<string, number> = {};
    const methodKeys = Object.keys(comparison);

    for (let i = 0; i < methodKeys.length; i++) {
      for (let j = i + 1; j < methodKeys.length; j++) {
        const m1 = methodKeys[i];
        const m2 = methodKeys[j];
        const ids1 = new Set(comparison[m1].map((r) => r.id));
        const ids2 = new Set(comparison[m2].map((r) => r.id));

        let intersection = 0;
        for (const id of ids1) {
          if (ids2.has(id)) intersection++;
        }

        overlap[`${m1}_vs_${m2}`] =
          topK > 0 ? intersection / topK : 0;
      }
    }

    return c.json({
      query,
      comparison,
      overlap,
    });
  } catch (err) {
    console.error('Compare error:', err);
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Comparison failed', details: message }, 500);
  }
});

/**
 * POST /hybrid/evaluate
 * Evaluate search quality with metrics
 */
hybridSearch.post('/evaluate', async (c) => {
  try {
    const body = await c.req.json<{
      queries: Array<{
        query: string;
        expectedDocIds: string[];
      }>;
      topK?: number;
      searchMethod?: 'vector' | 'bm25' | 'hybrid';
    }>();

    const { queries, topK = 5, searchMethod = 'hybrid' } = body;

    if (!queries || queries.length === 0) {
      return c.json({ error: 'queries array is required' }, 400);
    }

    const qdrant = createQdrantClient(c.env.QDRANT_URL, c.env.QDRANT_API_KEY);
    await ensureCollection(qdrant);

    if (!bm25Index) {
      await buildBM25Index(qdrant);
    }

    const evalResults: EvaluationResult[] = [];

    for (const { query, expectedDocIds } of queries) {
      // Perform search
      let retrievedDocIds: string[] = [];
      let retrievedContents: string[] = [];

      if (searchMethod === 'hybrid') {
        const hybrid = new HybridSearch(qdrant, 'ai-chat-documents');
        const results = await hybrid.search(query, c.env.GEMINI_API_KEY, {
          finalTopK: topK,
        });

        retrievedDocIds = results.map((r) => r.id);
        retrievedContents = results.map((r) => r.content);
      } else {
        const queryEmbedding = await embedText(c.env.GEMINI_API_KEY, query);
        const results = await qdrant.query('ai-chat-documents', {
          query: queryEmbedding,
          limit: topK,
          with_payload: true,
        });

        retrievedDocIds = results.points.map((p) => p.id as string);
        retrievedContents = results.points.map(
          (p) => (p.payload?.content as string) || ''
        );
      }

      // Compute metrics
      const scores = computeMetrics(
        query,
        expectedDocIds,
        retrievedDocIds,
        retrievedContents,
        undefined,
        topK
      );

      evalResults.push({
        query,
        expectedDocIds,
        retrievedDocIds,
        retrievedContents,
        scores,
      });
    }

    // Aggregate metrics
    const summary = aggregateMetrics(evalResults);

    return c.json({
      summary,
      details: evalResults,
    });
  } catch (err) {
    console.error('Evaluate error:', err);
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Evaluation failed', details: message }, 500);
  }
});

/**
 * POST /hybrid/chunk
 * Preview chunking strategies
 */
hybridSearch.post('/chunk', async (c) => {
  try {
    const body = await c.req.json<{
      content: string;
      strategies?: string[];
      chunkSize?: number;
      chunkOverlap?: number;
    }>();

    const {
      content,
      strategies = ['fixed', 'recursive', 'semantic', 'document-aware'],
      chunkSize = 500,
      chunkOverlap = 50,
    } = body;

    if (!content) {
      return c.json({ error: 'content is required' }, 400);
    }

    const results: Record<string, {
      chunks: Array<{
        index: number;
        content: string;
        tokenCount: number;
        startOffset: number;
        endOffset: number;
      }>;
      stats: {
        totalChunks: number;
        avgChunkSize: number;
        minChunkSize: number;
        maxChunkSize: number;
        totalTokens: number;
      };
    }> = {};

    for (const strategy of strategies) {
      const config: ChunkingConfig = {
        strategy: strategy as ChunkingConfig['strategy'],
        chunkSize,
        overlap: chunkOverlap,
      };

      const chunks = chunkDocument(content, config);
      const stats = getChunkingStats(chunks);

      results[strategy] = {
        chunks: chunks.map((c) => ({
          index: c.index,
          content: c.content.slice(0, 200) + (c.content.length > 200 ? '...' : ''),
          tokenCount: c.metadata.tokenCount,
          startOffset: c.startOffset,
          endOffset: c.endOffset,
        })),
        stats,
      };
    }

    return c.json({
      contentLength: content.length,
      chunkSize,
      chunkOverlap,
      strategies: results,
    });
  } catch (err) {
    console.error('Chunk preview error:', err);
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Chunking failed', details: message }, 500);
  }
});

/**
 * POST /hybrid/ab-test
 * Create an A/B test
 */
hybridSearch.post('/ab-test', async (c) => {
  try {
    const body = await c.req.json<{
      name: string;
      description: string;
      variants: ABVariant[];
      trafficSplit: number[];
    }>();

    const { name, description, variants, trafficSplit } = body;

    if (!name || !variants || variants.length === 0) {
      return c.json({ error: 'name and variants are required' }, 400);
    }

    const test = createABTest({
      name,
      description,
      variants,
      trafficSplit,
    });

    return c.json(test);
  } catch (err) {
    console.error('A/B test creation error:', err);
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Failed to create A/B test', details: message }, 500);
  }
});

/**
 * POST /hybrid/ab-test/:id/start
 */
hybridSearch.post('/ab-test/:id/start', async (c) => {
  const id = c.req.param('id');
  const test = startABTest(id);
  if (!test) {
    return c.json({ error: 'Test not found' }, 404);
  }
  return c.json(test);
});

/**
 * POST /hybrid/ab-test/:id/record
 */
hybridSearch.post('/ab-test/:id/record', async (c) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json<{
      variantId: string;
      query: string;
      latencyMs: number;
      resultCount: number;
      scores?: {
        relevance?: number;
        faithfulness?: number;
        userRating?: 'positive' | 'negative' | null;
      };
    }>();

    recordABTestResult({
      testId: id,
      ...body,
    });

    return c.json({ success: true });
  } catch (err) {
    console.error('Record A/B result error:', err);
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Failed to record result', details: message }, 500);
  }
});

/**
 * GET /hybrid/ab-test/:id/summary
 */
hybridSearch.get('/ab-test/:id/summary', async (c) => {
  const id = c.req.param('id');
  const summary = getABTestSummary(id);
  if (!summary) {
    return c.json({ error: 'Test not found' }, 404);
  }
  return c.json(summary);
});

/**
 * GET /hybrid/stats
 */
hybridSearch.get('/stats', async (c) => {
  const qdrant = createQdrantClient(c.env.QDRANT_URL, c.env.QDRANT_API_KEY);
  await ensureCollection(qdrant);

  if (!bm25Index) {
    await buildBM25Index(qdrant);
  }

  return c.json({
    bm25: bm25Index?.getStats() || { totalDocuments: 0, averageDocLength: 0, uniqueTerms: 0 },
    collection: 'ai-chat-documents',
  });
});

/**
 * GET /hybrid/cache/stats — embedding cache statistics
 */
hybridSearch.get('/cache/stats', async (c) => {
  return c.json({ stats: getEmbeddingCache().getStats() });
});

/**
 * POST /hybrid/cache/clear — clear embedding cache
 */
hybridSearch.post('/cache/clear', async (c) => {
  getEmbeddingCache().clear();
  return c.json({ success: true, stats: getEmbeddingCache().getStats() });
});

/**
 * POST /hybrid/parallel-search
 * Run BM25 and vector search concurrently with normalized score fusion.
 */
hybridSearch.post('/parallel-search', async (c) => {
  try {
    const body = await c.req.json<{
      query: string;
      topK?: number;
      vectorTopK?: number;
      bm25TopK?: number;
      vectorWeight?: number;
      bm25Weight?: number;
      rerankResults?: boolean;
      cohereApiKey?: string;
    }>();

    const {
      query,
      topK = 10,
      vectorTopK = 20,
      bm25TopK = 20,
      vectorWeight = 0.6,
      bm25Weight = 0.4,
      rerankResults = false,
      cohereApiKey,
    } = body;

    if (!query) {
      return c.json({ error: 'query is required' }, 400);
    }

    const qdrant = createQdrantClient(c.env.QDRANT_URL, c.env.QDRANT_API_KEY);
    await ensureCollection(qdrant);

    if (!bm25Index) {
      await buildBM25Index(qdrant);
    }

    const startedAt = Date.now();
    const retriever = new ParallelRetrieval(qdrant, 'ai-chat-documents');
    const merged = await retriever.search(query, c.env.GEMINI_API_KEY, bm25Index!, {
      vectorTopK,
      bm25TopK,
      vectorWeight,
      bm25Weight,
    });

    let results = merged.slice(0, topK);

    if (rerankResults && results.length > 0) {
      const reranker = new Reranker(cohereApiKey || c.env.COHERE_API_KEY, { topN: topK });
      const reranked = await reranker.rerank(
        query,
        results.map((r) => ({ id: r.id, content: r.content }))
      );
      const map = new Map(reranked.map((r) => [r.id, r]));
      results = results
        .map((r) => ({ ...r, combinedScore: map.get(r.id)?.relevanceScore ?? r.combinedScore }))
        .sort((a, b) => b.combinedScore - a.combinedScore);
    }

    return c.json({
      query,
      searchMethod: 'parallel',
      results: results.map((r) => ({
        id: r.id,
        content: r.content,
        documentId: r.documentId,
        documentTitle: r.documentTitle,
        documentUrl: r.documentUrl,
        chunkIndex: r.chunkIndex,
        score: r.combinedScore,
        vectorScore: r.vectorScore,
        bm25Score: r.bm25Score,
      })),
      totalResults: results.length,
      latencyMs: Date.now() - startedAt,
    });
  } catch (err) {
    console.error('Parallel search error:', err);
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Parallel search failed', details: message }, 500);
  }
});

export default hybridSearch;
