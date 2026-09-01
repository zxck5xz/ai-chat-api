/**
 * Re-ranker Service
 * Improves search results quality using cross-encoder scoring.
 * Supports Cohere Rerank API (v3.5 default) and BGE local cross-encoder via HTTP.
 * Falls back to a local token-overlap heuristic when no API is available.
 */

export type RerankerProvider = 'cohere' | 'bge' | 'local';

export interface RerankerConfig {
  provider: RerankerProvider;
  model: string;
  topN: number;
  /** URL of the local cross-encoder server (e.g. text-embeddings-inference / BGE). */
  bgeEndpoint?: string;
}

export interface RerankerResult {
  id: string;
  index: number;
  relevanceScore: number;
  content: string;
  provider: RerankerProvider;
}

export interface RerankableDocument {
  id: string;
  content: string;
  [key: string]: unknown;
}

const DEFAULT_CONFIG: RerankerConfig = {
  provider: 'cohere',
  model: 'rerank-english-v3.5',
  topN: 5,
};

/**
 * Cohere Rerank API
 */
async function cohereRerank(
  apiKey: string,
  query: string,
  documents: RerankableDocument[],
  config: Partial<RerankerConfig> = {}
): Promise<RerankerResult[]> {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  const response = await fetch('https://api.cohere.com/v1/rerank', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      query,
      documents: documents.map((d) => d.content),
      top_n: cfg.topN,
      return_documents: true,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Cohere rerank failed: ${response.status} - ${error}`);
  }

  const result = await response.json() as {
    results: Array<{
      index: number;
      relevance_score: number;
      document?: { text: string };
    }>;
  };

  return result.results.map((r) => ({
    id: documents[r.index]?.id || '',
    index: r.index,
    relevanceScore: r.relevance_score,
    content: r.document?.text || documents[r.index]?.content || '',
    provider: 'cohere',
  }));
}

/**
 * BGE cross-encoder via a local HTTP endpoint (e.g. text-embeddings-inference).
 * Expects a POST with { query, texts: string[] } returning [{ index, score }].
 */
async function bgeRerank(
  endpoint: string,
  query: string,
  documents: RerankableDocument[],
  config: Partial<RerankerConfig> = {}
): Promise<RerankerResult[]> {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query,
      texts: documents.map((d) => d.content),
      truncate_if_too_long: true,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`BGE rerank failed: ${response.status} - ${error}`);
  }

  const result = await response.json() as Array<{ index: number; score: number }>;
  const sorted = [...result].sort((a, b) => b.score - a.score).slice(0, cfg.topN);

  return sorted.map((r) => ({
    id: documents[r.index]?.id || '',
    index: r.index,
    relevanceScore: r.score,
    content: documents[r.index]?.content || '',
    provider: 'bge',
  }));
}

/**
 * Local cross-encoder scoring using token overlap heuristic.
 * Fallback when no external API is available. Exported for unit testing.
 */
export function localRerank(
  query: string,
  documents: RerankableDocument[],
  topN: number
): RerankerResult[] {
  const queryTokens = new Set(
    query
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 2)
  );

  const scored = documents.map((doc) => {
    const docTokens = new Set(
      doc.content
        .toLowerCase()
        .split(/\s+/)
        .filter((t) => t.length > 2)
    );

    // Calculate token overlap score
    let overlapCount = 0;
    for (const token of queryTokens) {
      if (docTokens.has(token)) {
        overlapCount++;
      }
    }

    // Jaccard-like similarity
    const intersection = overlapCount;
    const union = queryTokens.size + docTokens.size - intersection;
    const tokenScore = union > 0 ? intersection / union : 0;

    // Position bonus: earlier matches score higher
    const positionBonus = 1 / (1 + doc.content.toLowerCase().indexOf(query.toLowerCase()) * 0.001);

    // Length penalty: prefer shorter, more focused content
    const lengthPenalty = 1 / (1 + doc.content.length * 0.0001);

    const score = (tokenScore * 0.6 + positionBonus * 0.2 + lengthPenalty * 0.2);

    return {
      id: doc.id,
      index: documents.indexOf(doc),
      relevanceScore: score,
      content: doc.content,
      provider: 'local' as RerankerProvider,
    };
  });

  return scored
    .sort((a, b) => b.relevanceScore - a.relevanceScore)
    .slice(0, topN);
}

/**
 * Re-rank search results.
 * - `apiKey` is used for Cohere.
 * - `config.bgeEndpoint` selects the local BGE server when provider === 'bge'.
 */
export async function rerank(
  apiKey: string | undefined,
  query: string,
  documents: RerankableDocument[],
  config: Partial<RerankerConfig> = {}
): Promise<RerankerResult[]> {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  if (cfg.provider === 'cohere' && apiKey) {
    try {
      return await cohereRerank(apiKey, query, documents, config);
    } catch (err) {
      console.error('Cohere rerank failed, falling back to local:', err);
      return localRerank(query, documents, cfg.topN);
    }
  }

  if (cfg.provider === 'bge' && cfg.bgeEndpoint) {
    try {
      return await bgeRerank(cfg.bgeEndpoint, query, documents, config);
    } catch (err) {
      console.error('BGE rerank failed, falling back to local:', err);
      return localRerank(query, documents, cfg.topN);
    }
  }

  return localRerank(query, documents, cfg.topN);
}

/**
 * Re-ranker class for persistent use.
 */
export class Reranker {
  private config: RerankerConfig;
  private cohereApiKey?: string;

  constructor(
    cohereApiKey?: string,
    config: Partial<RerankerConfig> = {}
  ) {
    this.cohereApiKey = cohereApiKey;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async rerank(
    query: string,
    documents: RerankableDocument[]
  ): Promise<RerankerResult[]> {
    return rerank(this.cohereApiKey, query, documents, this.config);
  }

  getConfig() {
    return this.config;
  }
}
