import { Hono } from 'hono';
import type { Env } from '../types';
import { QueryClassifier } from '../services/search-engine/query-classifier';
import { QueryExpansion } from '../services/search-engine/query-expansion';
import { ConversationRewriter } from '../services/search-engine/conversation-rewriter';

const queryUnderstanding = new Hono<{ Bindings: Env }>();

function createServices(c: { env: Env }) {
  return {
    classifier: new QueryClassifier(c.env.GEMINI_API_KEY),
    expansion: new QueryExpansion(c.env.GEMINI_API_KEY),
    rewriter: new ConversationRewriter(c.env.GEMINI_API_KEY),
  };
}

// POST /classify - Classify query complexity
queryUnderstanding.post('/classify', async (c) => {
  const body = await c.req.json<{ query: string }>();
  const { classifier } = createServices(c);

  const result = await classifier.classify(body.query);
  return c.json({ success: true, result });
});

// POST /expand - Expand query with multiple strategies
queryUnderstanding.post('/expand', async (c) => {
  const body = await c.req.json<{
    query: string;
    strategy?: 'hyde' | 'multi_query' | 'decomposition' | 'step_back' | 'auto';
  }>();
  const { expansion } = createServices(c);

  const result = await expansion.expand(body.query, body.strategy || 'auto');
  return c.json({ success: true, result });
});

// POST /rewrite - Rewrite conversational query
queryUnderstanding.post('/rewrite', async (c) => {
  const body = await c.req.json<{
    query: string;
    history?: Array<{ role: 'user' | 'assistant'; content: string; timestamp: string }>;
  }>();
  const { rewriter } = createServices(c);

  const result = await rewriter.rewrite(body.query, body.history || []);
  return c.json({ success: true, result });
});

// POST /process - Full query understanding pipeline
queryUnderstanding.post('/process', async (c) => {
  const body = await c.req.json<{
    query: string;
    history?: Array<{ role: 'user' | 'assistant'; content: string; timestamp: string }>;
  }>();
  const { classifier, expansion, rewriter } = createServices(c);
  const startTime = Date.now();

  // Step 1: Rewrite (if conversational)
  const rewritten = await rewriter.rewrite(body.query, body.history || []);

  // Step 2: Classify
  const classified = await classifier.classify(rewritten.rewrittenQuery);

  // Step 3: Expand based on complexity
  let strategy: 'hyde' | 'multi_query' | 'decomposition' | 'step_back' | 'auto' = 'auto';
  if (classified.complexity === 'complex') strategy = 'decomposition';
  else if (classified.complexity === 'ambiguous') strategy = 'multi_query';
  else if (classified.complexity === 'simple') strategy = 'hyde';

  const expanded = await expansion.expand(rewritten.rewrittenQuery, strategy);

  // Step 4: Combine all queries for retrieval
  const finalQueries = [...new Set([
    body.query,
    ...expanded.expandedQueries,
  ])];

  return c.json({
    success: true,
    result: {
      classified,
      expanded,
      rewritten,
      finalQueries,
      totalLatencyMs: Date.now() - startTime,
    },
  });
});

export default queryUnderstanding;
