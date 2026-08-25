import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env } from './types';
import conversations from './routes/conversations';
import messages from './routes/messages';
import rag from './routes/rag';
import orchestrator from './routes/orchestrator';
import eval_ from './routes/eval';
import safety from './routes/safety';

const app = new Hono<{ Bindings: Env }>();

// CORS middleware
app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
}));

// Health check
app.get('/', (c) => {
  return c.json({ status: 'ok', service: 'ai-chat-api' });
});

// Routes
app.route('/api/conversations', conversations);
app.route('/api/messages', messages);
app.route('/api/rag', rag);
app.route('/api/orchestrator', orchestrator);
app.route('/api/eval', eval_);
app.route('/api/safety', safety);

// 404 handler
app.notFound((c) => {
  return c.json({ error: 'Not found' }, 404);
});

// Error handler
app.onError((err, c) => {
  console.error('App error:', err.message, err.stack);
  return c.json({ error: 'Internal server error', message: err.message }, 500);
});

export default app;
