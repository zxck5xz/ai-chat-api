import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env } from './types';
import { authMiddleware } from './middleware/auth';
import conversations from './routes/conversations';
import messages from './routes/messages';
import rag from './routes/rag';
import orchestrator from './routes/orchestrator';
import eval_ from './routes/eval';
import safety from './routes/safety';
import codeReview from './routes/code-review';
import hybridSearch from './routes/hybrid-search';
import toolAgent from './routes/tool-agent';
import observability from './routes/observability';
import fineTuning from './routes/fine-tuning';
import voiceAgent from './routes/voice-agent';
import multiModal from './routes/multi-modal';
import queryUnderstanding from './routes/query-understanding';
import imageText from './routes/image-text-replacement';
import searchAnalytics from './routes/search/analytics';
import monitoring from './routes/monitoring';
import mcp from './routes/mcp';
import modelVersioning from './routes/model-versioning';
import multiModalRAG from './routes/multi-modal-rag';

const app = new Hono<{ Bindings: Env }>();

// CORS middleware
app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-API-Key'],
}));

// Auth middleware - skip if no API_KEY configured
app.use('*', async (c, next) => {
  const apiKey = c.env.API_KEY;
  if (!apiKey) return next();
  return authMiddleware(apiKey)(c, next);
});

// Health check (always public)
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
app.route('/api/code-review', codeReview);
app.route('/api/hybrid', hybridSearch);
app.route('/api/tool-agent', toolAgent);
app.route('/api/observability', observability);
app.route('/api/fine-tuning', fineTuning);
app.route('/api/voice-agent', voiceAgent);
app.route('/api/multi-modal', multiModal);
app.route('/api/query', queryUnderstanding);
app.route('/api/image-text', imageText);
app.route('/api/search/analytics', searchAnalytics);
app.route('/api/monitoring', monitoring);
app.route('/api/mcp', mcp);
app.route('/api/model-versioning', modelVersioning);
app.route('/api/multi-modal-rag', multiModalRAG);

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
