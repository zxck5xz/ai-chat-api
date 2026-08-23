import { Hono } from 'hono';
import type { Env } from '../types';

const conversations = new Hono<{ Bindings: Env }>();

// List conversations
conversations.get('/', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM conversations ORDER BY updated_at DESC LIMIT 50'
  ).all();

  return c.json(results);
});

// Create conversation
conversations.post('/', async (c) => {
  const body = await c.req.json();
  const id = crypto.randomUUID();
  const title = body.title || 'New Chat';

  await c.env.DB.prepare(
    'INSERT INTO conversations (id, title) VALUES (?, ?)'
  ).bind(id, title).run();

  const conversation = await c.env.DB.prepare(
    'SELECT * FROM conversations WHERE id = ?'
  ).bind(id).first();

  return c.json(conversation, 201);
});

// Get conversation with messages
conversations.get('/:id', async (c) => {
  const id = c.req.param('id');

  const conversation = await c.env.DB.prepare(
    'SELECT * FROM conversations WHERE id = ?'
  ).bind(id).first();

  if (!conversation) {
    return c.json({ error: 'Conversation not found' }, 404);
  }

  const { results: messages } = await c.env.DB.prepare(
    'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC'
  ).bind(id).all();

  return c.json({
    ...conversation,
    messages: messages.map((m) => ({
      ...m,
      sources: m.sources ? JSON.parse(m.sources as string) : null,
    })),
  });
});

// Update conversation title
conversations.put('/:id', async (c) => {
  const id = c.req.param('id');
  const { title } = await c.req.json();

  await c.env.DB.prepare(
    'UPDATE conversations SET title = ?, updated_at = datetime("now") WHERE id = ?'
  ).bind(title, id).run();

  return c.json({ success: true });
});

// Delete conversation
conversations.delete('/:id', async (c) => {
  const id = c.req.param('id');

  await c.env.DB.prepare('DELETE FROM messages WHERE conversation_id = ?').bind(id).run();
  await c.env.DB.prepare('DELETE FROM conversations WHERE id = ?').bind(id).run();

  return c.json({ success: true });
});

export default conversations;
