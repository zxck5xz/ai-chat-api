/**
 * RAG Evaluation Metrics
 * Recall@k, MRR, Context Relevance, and more
 */

export interface EvaluationResult {
  query: string;
  expectedDocIds?: string[];
  retrievedDocIds: string[];
  retrievedContents: string[];
  expectedContents?: string[];
  scores: MetricsScores;
}

export interface MetricsScores {
  recallAtK: number;
  mrr: number;           // Mean Reciprocal Rank
  precisionAtK: number;
  ndcg: number;          // Normalized Discounted Cumulative Gain
  contextRelevance: number;
  answerRelevance: number;
  faithfulness: number;
}

export interface EvaluationSummary {
  totalQueries: number;
  avgMetrics: MetricsScores;
  minMetrics: MetricsScores;
  maxMetrics: MetricsScores;
  stdMetrics: MetricsScores;
}

/**
 * Recall@k: What fraction of relevant documents are retrieved?
 */
export function recallAtK(
  expectedDocIds: string[],
  retrievedDocIds: string[],
  k: number
): number {
  const relevant = new Set(expectedDocIds);
  const retrieved = retrievedDocIds.slice(0, k);
  
  let hits = 0;
  for (const docId of retrieved) {
    if (relevant.has(docId)) {
      hits++;
    }
  }
  
  return relevant.size > 0 ? hits / relevant.size : 0;
}

/**
 * Mean Reciprocal Rank (MRR)
 * How early does the first relevant document appear?
 */
export function meanReciprocalRank(
  expectedDocIds: string[],
  retrievedDocIds: string[]
): number {
  const relevant = new Set(expectedDocIds);
  
  for (let i = 0; i < retrievedDocIds.length; i++) {
    if (relevant.has(retrievedDocIds[i])) {
      return 1 / (i + 1);
    }
  }
  
  return 0;
}

/**
 * Precision@k: What fraction of retrieved documents are relevant?
 */
export function precisionAtK(
  expectedDocIds: string[],
  retrievedDocIds: string[],
  k: number
): number {
  const relevant = new Set(expectedDocIds);
  const retrieved = retrievedDocIds.slice(0, k);
  
  let hits = 0;
  for (const docId of retrieved) {
    if (relevant.has(docId)) {
      hits++;
    }
  }
  
  return k > 0 ? hits / k : 0;
}

/**
 * NDCG@k (Normalized Discounted Cumulative Gain)
 */
export function ndcgAtK(
  expectedDocIds: string[],
  retrievedDocIds: string[],
  k: number
): number {
  const relevant = new Set(expectedDocIds);
  
  // Calculate DCG
  let dcg = 0;
  for (let i = 0; i < Math.min(k, retrievedDocIds.length); i++) {
    const rel = relevant.has(retrievedDocIds[i]) ? 1 : 0;
    dcg += rel / Math.log2(i + 2); // i+2 because log2(1) = 0
  }
  
  // Calculate ideal DCG
  const idealRelCount = Math.min(relevant.size, k);
  let idcg = 0;
  for (let i = 0; i < idealRelCount; i++) {
    idcg += 1 / Math.log2(i + 2);
  }
  
  return idcg > 0 ? dcg / idcg : 0;
}

/**
 * Context Relevance
 * How relevant is the retrieved context to the query?
 * Uses keyword overlap as a proxy
 */
export function contextRelevance(
  query: string,
  retrievedContents: string[]
): number {
  if (retrievedContents.length === 0) return 0;
  
  const queryTokens = new Set(
    query
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 2)
  );
  
  let totalRelevance = 0;
  
  for (const content of retrievedContents) {
    const contentTokens = new Set(
      content
        .toLowerCase()
        .split(/\s+/)
        .filter((t) => t.length > 2)
    );
    
    let overlap = 0;
    for (const token of queryTokens) {
      if (contentTokens.has(token)) {
        overlap++;
      }
    }
    
    const relevance = queryTokens.size > 0 ? overlap / queryTokens.size : 0;
    totalRelevance += relevance;
  }
  
  return totalRelevance / retrievedContents.length;
}

/**
 * Answer Relevance
 * How relevant is the answer to the query?
 * Uses keyword overlap as a proxy
 */
export function answerRelevance(
  query: string,
  answer: string
): number {
  const queryTokens = new Set(
    query
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 2)
  );
  
  const answerTokens = new Set(
    answer
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 2)
  );
  
  let overlap = 0;
  for (const token of queryTokens) {
    if (answerTokens.has(token)) {
      overlap++;
    }
  }
  
  return queryTokens.size > 0 ? overlap / queryTokens.size : 0;
}

/**
 * Faithfulness
 * How faithful is the answer to the provided context?
 * Checks if answer tokens are present in context
 */
export function faithfulness(
  answer: string,
  contextContents: string[]
): number {
  if (contextContents.length === 0) return 0;
  
  const answerTokens = new Set(
    answer
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 2)
  );
  
  const contextText = contextContents.join(' ').toLowerCase();
  
  let presentCount = 0;
  for (const token of answerTokens) {
    if (contextText.includes(token)) {
      presentCount++;
    }
  }
  
  return answerTokens.size > 0 ? presentCount / answerTokens.size : 0;
}

/**
 * Compute all metrics for a single query
 */
export function computeMetrics(
  query: string,
  expectedDocIds: string[],
  retrievedDocIds: string[],
  retrievedContents: string[],
  answer?: string,
  k: number = 5
): MetricsScores {
  return {
    recallAtK: recallAtK(expectedDocIds, retrievedDocIds, k),
    mrr: meanReciprocalRank(expectedDocIds, retrievedDocIds),
    precisionAtK: precisionAtK(expectedDocIds, retrievedDocIds, k),
    ndcg: ndcgAtK(expectedDocIds, retrievedDocIds, k),
    contextRelevance: contextRelevance(query, retrievedContents),
    answerRelevance: answer ? answerRelevance(query, answer) : 0,
    faithfulness: answer
      ? faithfulness(answer, retrievedContents)
      : 0,
  };
}

/**
 * Aggregate metrics across multiple queries
 */
export function aggregateMetrics(
  results: EvaluationResult[]
): EvaluationSummary {
  if (results.length === 0) {
    return {
      totalQueries: 0,
      avgMetrics: {
        recallAtK: 0,
        mrr: 0,
        precisionAtK: 0,
        ndcg: 0,
        contextRelevance: 0,
        answerRelevance: 0,
        faithfulness: 0,
      },
      minMetrics: { ...defaultMetrics() },
      maxMetrics: { ...defaultMetrics() },
      stdMetrics: { ...defaultMetrics() },
    };
  }
  
  const metricKeys: Array<keyof MetricsScores> = [
    'recallAtK',
    'mrr',
    'precisionAtK',
    'ndcg',
    'contextRelevance',
    'answerRelevance',
    'faithfulness',
  ];
  
  const avgMetrics = { ...defaultMetrics() };
  const minMetrics = { ...defaultMetrics() };
  const maxMetrics = { ...defaultMetrics() };
  const stdMetrics = { ...defaultMetrics() };
  
  for (const key of metricKeys) {
    const values = results.map((r) => r.scores[key]);
    
    // Average
    avgMetrics[key] = values.reduce((a, b) => a + b, 0) / values.length;
    
    // Min/Max
    minMetrics[key] = Math.min(...values);
    maxMetrics[key] = Math.max(...values);
    
    // Standard deviation
    const mean = avgMetrics[key];
    const squaredDiffs = values.map((v) => Math.pow(v - mean, 2));
    const variance =
      squaredDiffs.reduce((a, b) => a + b, 0) / values.length;
    stdMetrics[key] = Math.sqrt(variance);
  }
  
  return {
    totalQueries: results.length,
    avgMetrics,
    minMetrics,
    maxMetrics,
    stdMetrics,
  };
}

function defaultMetrics(): MetricsScores {
  return {
    recallAtK: 0,
    mrr: 0,
    precisionAtK: 0,
    ndcg: 0,
    contextRelevance: 0,
    answerRelevance: 0,
    faithfulness: 0,
  };
}
