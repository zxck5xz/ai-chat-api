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

// Send message and stream response
messages.post('/chat', async (c) => {
  const { messages: chatMessages, conversationId } = await c.req.json();

  if (!chatMessages || !Array.isArray(chatMessages)) {
    return c.json({ error: 'messages array is required' }, 400);
  }

  // Save user message to DB
  if (conversationId && chatMessages.length > 0) {
    const lastUserMsg = chatMessages[chatMessages.length - 1];
    if (lastUserMsg.role === 'user') {
      const msgId = crypto.randomUUID();
      await c.env.DB.prepare(
        'INSERT INTO messages (id, conversation_id, role, content) VALUES (?, ?, ?, ?)'
      ).bind(msgId, conversationId, 'user', lastUserMsg.content).run();

      // Update conversation title if first message
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

  // Call OpenAI API
  const apiKey = c.env.OPENAI_API_KEY;

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        ...chatMessages,
      ],
      temperature: 0.7,
      max_tokens: 4096,
      stream: true,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    console.error('OpenAI error:', error);
    return c.json({ error: 'Failed to call AI model' }, 500);
  }

  // Stream response back to client
  const encoder = new TextEncoder();
  let fullContent = '';

  const stream = new ReadableStream({
    async start(controller) {
      const reader = response.body?.getReader();
      if (!reader) {
        controller.close();
        return;
      }

      const decoder = new TextDecoder();

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value, { stream: true });
          const lines = chunk.split('\n').filter((line) => line.startsWith('data: '));

          for (const line of lines) {
            const data = line.slice(6);
            if (data === '[DONE]') break;

            try {
              const json = JSON.parse(data);
              const content = json.choices?.[0]?.delta?.content;
              if (content) {
                fullContent += content;
                controller.enqueue(encoder.encode(content));
              }
            } catch {
              // Skip malformed JSON
            }
          }
        }

        // Append sources at the end
        const sourcesData = `\n\n[SOURCES]${JSON.stringify(MOCK_SOURCES)}[/SOURCES]`;
        controller.enqueue(encoder.encode(sourcesData));

        // Save assistant message to DB
        if (conversationId) {
          const msgId = crypto.randomUUID();
          await c.env.DB.prepare(
            'INSERT INTO messages (id, conversation_id, role, content, sources) VALUES (?, ?, ?, ?, ?)'
          ).bind(msgId, conversationId, 'assistant', fullContent, JSON.stringify(MOCK_SOURCES)).run();

          await c.env.DB.prepare(
            'UPDATE conversations SET updated_at = datetime("now") WHERE id = ?'
          ).bind(conversationId).run();
        }
      } catch (error) {
        console.error('Stream error:', error);
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Transfer-Encoding': 'chunked',
    },
  });
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
