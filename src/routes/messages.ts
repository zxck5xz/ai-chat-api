import { Hono } from 'hono';
import type { Env, Source } from '../types';

const messages = new Hono<{ Bindings: Env }>();

const SYSTEM_PROMPT = `You are a helpful AI assistant. Always respond with structured JSON when sources are available.

Response format:
{
  "answer": "Your detailed answer here",
  "sources": [
    {
      "id": "source-1",
      "title": "Source title",
      "url": "https://example.com",
      "snippet": "Relevant excerpt from the source",
      "score": 0.95
    }
  ],
  "confidence": 0.85
}

Guidelines:
- Provide accurate, well-structured answers
- Include sources when available to support your response
- If no sources are available, respond with just the answer text
- Be concise but thorough`;

const MOCK_SOURCES: Source[] = [
  {
    id: 'src-1',
    title: 'Getting Started with React 19',
    url: 'https://react.dev/learn',
    snippet: 'React 19 introduces new features like Server Components and Actions.',
    score: 0.95,
  },
  {
    id: 'src-2',
    title: 'Hono Documentation',
    url: 'https://hono.dev',
    snippet: 'Hono is a lightweight web framework for edge runtimes.',
    score: 0.88,
  },
];

// SSE helper: format message as SSE data
function formatSSE(data: string): string {
  return `data: ${data}\n\n`;
}

// Send message (streaming)
messages.post('/chat', async (c) => {
  try {
    const body = await c.req.json<{ messages: { role: string; content: string }[]; conversationId?: string }>();
    const { messages: chatMessages, conversationId } = body;

    if (!chatMessages || !Array.isArray(chatMessages)) {
      return c.json({ error: 'messages array is required' }, 400);
    }

    // Save user message to DB
    if (conversationId && chatMessages.length > 0) {
      // Create conversation if not exists
      const existing = await c.env.DB.prepare(
        'SELECT id FROM conversations WHERE id = ?'
      ).bind(conversationId).first();

      if (!existing) {
        const title = chatMessages[0]?.content?.slice(0, 50) || 'New Chat';
        await c.env.DB.prepare(
          'INSERT INTO conversations (id, title) VALUES (?, ?)'
        ).bind(conversationId, title).run();
      }

      const lastUserMsg = chatMessages[chatMessages.length - 1];
      if (lastUserMsg.role === 'user') {
        const msgId = crypto.randomUUID();
        await c.env.DB.prepare(
          'INSERT INTO messages (id, conversation_id, role, content) VALUES (?, ?, ?, ?)'
        ).bind(msgId, conversationId, 'user', lastUserMsg.content).run();

        const { count } = await c.env.DB.prepare(
          'SELECT COUNT(*) as count FROM messages WHERE conversation_id = ?'
        ).bind(conversationId).first() as { count: number };

        if (count === 1) {
          const title = lastUserMsg.content.slice(0, 50) + (lastUserMsg.content.length > 50 ? '...' : '');
          await c.env.DB.prepare(
            'UPDATE conversations SET title = ?, updated_at = datetime("now") WHERE id = ?'
          ).bind(title, conversationId).run();
        }
      }
    }

    // Call Google Gemini API with streaming
    const apiKey = c.env.GEMINI_API_KEY;
    const models = ['gemini-3.6-flash', 'gemini-2.0-flash-lite'];

    const contents = chatMessages.map((msg) => ({
      role: msg.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: msg.content }],
    }));

    let response: Response | null = null;
    let lastError = '';
    let selectedModel = '';

    for (const model of models) {
      for (let attempt = 0; attempt < 2; attempt++) {
        if (attempt > 0) {
          await new Promise((r) => setTimeout(r, 1000 * attempt));
        }

        response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
              contents,
              generationConfig: {
                temperature: 0.7,
                maxOutputTokens: 4096,
              },
            }),
          }
        );

        if (response.ok) {
          selectedModel = model;
          break;
        }

        lastError = await response.text();
        console.error(`Gemini ${model} error (attempt ${attempt + 1}):`, response.status, lastError);
      }
      if (response?.ok) break;
    }

    if (!response || !response.ok) {
      return c.json({ error: 'Failed to call AI model', details: lastError }, 503);
    }

    // Create SSE stream
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        try {
          let fullText = '';
          const reader = response!.body?.getReader();
          const decoder = new TextDecoder();

          if (!reader) {
            controller.enqueue(encoder.encode(formatSSE(JSON.stringify({ type: 'error', message: 'No stream available' }))));
            controller.close();
            return;
          }

          // Signal start of stream
          controller.enqueue(encoder.encode(formatSSE(JSON.stringify({ type: 'start', model: selectedModel }))));

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
                  const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
                  if (text) {
                    fullText += text;
                    controller.enqueue(encoder.encode(formatSSE(JSON.stringify({ type: 'token', content: text }))));
                  }
                } catch {
                  // Skip malformed JSON
                }
              }
            }
          }

          // Save assistant message to DB
          if (conversationId && fullText) {
            const msgId = crypto.randomUUID();
            await c.env.DB.prepare(
              'INSERT INTO messages (id, conversation_id, role, content, sources) VALUES (?, ?, ?, ?, ?)'
            ).bind(msgId, conversationId, 'assistant', fullText, JSON.stringify(MOCK_SOURCES)).run();

            await c.env.DB.prepare(
              'UPDATE conversations SET updated_at = datetime("now") WHERE id = ?'
            ).bind(conversationId).run();
          }

          // Send sources at the end
          controller.enqueue(encoder.encode(formatSSE(JSON.stringify({ type: 'sources', sources: MOCK_SOURCES }))));

          // Signal end of stream
          controller.enqueue(encoder.encode(formatSSE('[DONE]')));
          controller.close();
        } catch (err) {
          console.error('Stream error:', err);
          controller.enqueue(encoder.encode(formatSSE(JSON.stringify({ type: 'error', message: err instanceof Error ? err.message : String(err) }))));
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (err) {
    console.error('Chat error:', err);
    return c.json({ error: 'Internal error', message: err instanceof Error ? err.message : String(err) }, 500);
  }
});

// Update message feedback
messages.put('/:id/feedback', async (c) => {
  const id = c.req.param('id');
  const { rating, comment } = await c.req.json();

  await c.env.DB.prepare(
    'UPDATE messages SET feedback_rating = ?, feedback_comment = ? WHERE id = ?'
  ).bind(rating, comment || null, id).run();

  return c.json({ success: true });
});

export default messages;
