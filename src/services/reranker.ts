/**
 * Re-ranker Service
 * Improves search results quality using cross-encoder scoring
 * Supports Cohere Rerank API and local cross-encoder fallback
 */

export interface RerankerConfig {
  provider: 'cohere' | 'local';
  model: string;
  topN: number;
}

export interface RerankerResult {
  id: string;
  index: number;
  relevanceScore: number;
  content: string;
}

export interface RerankableDocument {
  id: string;
  content: string;
  [key: string]: unknown;
}

const DEFAULT_CONFIG: RerankerConfig = {
  provider: 'cohere',
  model: 'rerank-english-v3.0',
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
  }));
}

/**
 * Local cross-encoder scoring using token overlap heuristic
 * Fallback when Cohere API is not available
 */
function localRerank(
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
    };
  });

  return scored
    .sort((a, b) => b.relevanceScore - a.relevanceScore)
    .slice(0, topN);
}

/**
 * Re-rank search results
 */
export async function rerank(
  apiKey: string | undefined,
  query: string,
  documents: RerankableDocument[],
  config: Partial<RerankerConfig> = {}
): Promise<RerankerResult[]> {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  // Use Cohere if API key is provided
  if (cfg.provider === 'cohere' && apiKey) {
    try {
      return await cohereRerank(apiKey, query, documents, config);
    } catch (err) {
      console.error('Cohere rerank failed, falling back to local:', err);
      return localRerank(query, documents, cfg.topN);
    }
  }

  // Fallback to local reranking
  return localRerank(query, documents, cfg.topN);
}

/**
 * Re-ranker class for persistent use
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
