import { Hono } from 'hono';
import type { Env } from '../types';
import {
  createQdrantClient,
  ensureCollection,
  upsertChunks,
  searchSimilar,
  type DocumentChunk,
} from '../services/qdrant';
import { embedText, chunkText } from '../services/embedder';

const rag = new Hono<{ Bindings: Env }>();

// Upload and embed a document
rag.post('/documents', async (c) => {
  try {
    const body = await c.req.json<{
      title: string;
      url?: string;
      content: string;
    }>();

    const { title, url, content } = body;

    if (!title || !content) {
      return c.json({ error: 'title and content are required' }, 400);
    }

    const qdrant = createQdrantClient(c.env.QDRANT_URL, c.env.QDRANT_API_KEY);
    await ensureCollection(qdrant);

    // Chunk the document
    const chunks = chunkText(content, 500, 50);

    // Embed all chunks
    const embeddings: number[][] = [];
    for (const chunk of chunks) {
      const embedding = await embedText(c.env.GEMINI_API_KEY, chunk);
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
      content: chunk,
      embedding: embeddings[index],
    }));

    // Store in Qdrant
    await upsertChunks(qdrant, documentChunks);

    // Store metadata in D1
    await c.env.DB.prepare(
      'INSERT INTO documents (id, title, url, chunk_count) VALUES (?, ?, ?, ?)'
    ).bind(documentId, title, url || null, chunks.length).run();

    return c.json({
      id: documentId,
      title,
      chunkCount: chunks.length,
    });
  } catch (err) {
    console.error('Document upload error:', err);
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : '';
    console.error('Error stack:', stack);
    return c.json({ error: 'Failed to process document', details: message, stack }, 500);
  }
});

// List all documents
rag.get('/documents', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT id, title, url, chunk_count, created_at FROM documents ORDER BY created_at DESC'
  ).all();

  return c.json(results);
});

// Delete a document
rag.delete('/documents/:id', async (c) => {
  const id = c.req.param('id');

  await c.env.DB.prepare('DELETE FROM documents WHERE id = ?').bind(id).run();

  // TODO: Delete from Qdrant as well

  return c.json({ success: true });
});

// RAG query - ask a question about uploaded documents
rag.post('/query', async (c) => {
  try {
    const body = await c.req.json<{
      query: string;
      conversationId?: string;
    }>();

    const { query, conversationId } = body;

    if (!query) {
      return c.json({ error: 'query is required' }, 400);
    }

    const qdrant = createQdrantClient(c.env.QDRANT_URL, c.env.QDRANT_API_KEY);
    await ensureCollection(qdrant);

    // Embed the query
    const queryEmbedding = await embedText(c.env.GEMINI_API_KEY, query);

    // Search for similar chunks
    const results = await searchSimilar(qdrant, queryEmbedding, 5);

    if (results.length === 0) {
      return c.json({
        answer: 'No relevant documents found. Please upload some documents first.',
        sources: [],
      });
    }

    // Build context from retrieved chunks
    const context = results
      .map(
        (r, i) =>
          `[Source ${i + 1}: ${r.documentTitle}]\n${r.content}`
      )
      .join('\n\n');

    // Build sources for frontend
    const sources = results.map((r) => ({
      id: r.id,
      title: r.documentTitle,
      url: r.documentUrl,
      snippet: r.content.slice(0, 200) + '...',
      score: Math.round(r.score * 100) / 100,
      chunkIndex: r.chunkIndex,
    }));

    // Call Gemini with context
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
            encoder.encode(`data: ${JSON.stringify({ type: 'start', model })}\n\n`)
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
    console.error('RAG query error:', err);
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Failed to process query', details: message }, 500);
  }
});

export default rag;
