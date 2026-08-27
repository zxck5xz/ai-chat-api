/**
 * Hybrid Search Service
 * Combines BM25 keyword search with Vector similarity search
 */

import { QdrantClient } from '@qdrant/js-client-rest';
import { BM25Index, tokenize, type BM25Result } from './bm25';
import { embedText } from './embedder';

export interface HybridSearchConfig {
  vectorWeight: number;      // Weight for vector search (0-1)
  bm25Weight: number;        // Weight for BM25 search (0-1)
  vectorTopK: number;        // Number of results from vector search
  bm25TopK: number;          // Number of results from BM25 search
  finalTopK: number;         // Number of results after fusion
  rrfK: number;              // RRF constant (default 60)
  fusionMethod: 'rrf' | 'weighted' | 'combmnz';
}

export interface HybridSearchResult {
  id: string;
  content: string;
  documentId: string;
  documentTitle: string;
  documentUrl: string;
  chunkIndex: number;
  vectorScore: number;
  bm25Score: number;
  finalScore: number;
  fusionMethod: string;
}

const DEFAULT_CONFIG: HybridSearchConfig = {
  vectorWeight: 0.6,
  bm25Weight: 0.4,
  vectorTopK: 20,
  bm25TopK: 20,
  finalTopK: 10,
  rrfK: 60,
  fusionMethod: 'rrf',
};

/**
 * Reciprocal Rank Fusion (RRF)
 * Combines ranked lists from multiple sources
 */
function reciprocalRankFusion(
  rankedLists: Array<Array<{ id: string; score: number }>>,
  k: number = 60
): Array<{ id: string; score: number }> {
  const scoreMap = new Map<string, number>();

  for (const list of rankedLists) {
    for (let rank = 0; rank < list.length; rank++) {
      const item = list[rank];
      const rrfScore = 1 / (k + rank + 1);
      scoreMap.set(item.id, (scoreMap.get(item.id) || 0) + rrfScore);
    }
  }

  return Array.from(scoreMap.entries())
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);
}

/**
 * Weighted Score Fusion
 * Normalizes scores and combines with weights
 */
function weightedFusion(
  rankedLists: Array<Array<{ id: string; score: number }>>,
  weights: number[]
): Array<{ id: string; score: number }> {
  const scoreMap = new Map<string, number>();

  for (let i = 0; i < rankedLists.length; i++) {
    const list = rankedLists[i];
    const weight = weights[i] || 0;

    // Normalize scores to 0-1 range
    const maxScore = Math.max(...list.map((item) => item.score), 1);

    for (const item of list) {
      const normalizedScore = item.score / maxScore;
      scoreMap.set(
        item.id,
        (scoreMap.get(item.id) || 0) + normalizedScore * weight
      );
    }
  }

  return Array.from(scoreMap.entries())
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);
}

/**
 * CombMNZ Fusion
 * Combines with multiplication by number of non-zero scores
 */
function combMNZFusion(
  rankedLists: Array<Array<{ id: string; score: number }>>
): Array<{ id: string; score: number }> {
  const scoreMap = new Map<string, number>();
  const nonZeroCount = new Map<string, number>();

  for (const list of rankedLists) {
    const maxScore = Math.max(...list.map((item) => item.score), 1);

    for (const item of list) {
      const normalizedScore = item.score / maxScore;
      scoreMap.set(
        item.id,
        (scoreMap.get(item.id) || 0) + normalizedScore
      );
      nonZeroCount.set(item.id, (nonZeroCount.get(item.id) || 0) + 1);
    }
  }

  return Array.from(scoreMap.entries())
    .map(([id, score]) => ({
      id,
      score: score * (nonZeroCount.get(id) || 0),
    }))
    .sort((a, b) => b.score - a.score);
}

/**
 * Hybrid Search class combining BM25 + Vector search
 */
export class HybridSearch {
  private bm25Index: BM25Index;
  private qdrant: QdrantClient;
  private collectionName: string;
  private config: HybridSearchConfig;

  constructor(
    qdrant: QdrantClient,
    collectionName: string = 'ai-chat-documents',
    config: Partial<HybridSearchConfig> = {}
  ) {
    this.bm25Index = new BM25Index();
    this.qdrant = qdrant;
    this.collectionName = collectionName;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Build BM25 index from Qdrant collection
   */
  async buildBM25Index(): Promise<void> {
    // Fetch all documents from Qdrant
    let offset: string | number | null = null;
    let hasMore = true;

    while (hasMore) {
      const result = await this.qdrant.scroll(this.collectionName, {
        limit: 100,
        offset,
        with_payload: true,
      });

      for (const point of result.points) {
        const content = point.payload?.content as string;
        if (content) {
          this.bm25Index.addDocument(point.id as string, content);
        }
      }

      offset = (result.next_page_offset as string | number | null) ?? null;
      hasMore = result.points.length === 100 && offset !== null;
    }

    console.log('BM25 index built:', this.bm25Index.getStats());
  }

  /**
   * Perform hybrid search
   */
  async search(
    query: string,
    apiKey: string,
    config?: Partial<HybridSearchConfig>
  ): Promise<HybridSearchResult[]> {
    const cfg = { ...this.config, ...config };

    // Run vector search
    const queryEmbedding = await embedText(apiKey, query);
    const vectorResults = await this.qdrant.query(this.collectionName, {
      query: queryEmbedding,
      limit: cfg.vectorTopK,
      with_payload: true,
    });

    // Run BM25 search
    const bm25Results = this.bm25Index.search(query, cfg.bm25TopK);

    // Prepare ranked lists for fusion
    const vectorRanked = vectorResults.points.map((p) => ({
      id: p.id as string,
      score: p.score,
    }));

    const bm25Ranked = bm25Results.map((r) => ({
      id: r.id,
      score: r.score,
    }));

    // Apply fusion
    let fusedResults: Array<{ id: string; score: number }>;

    switch (cfg.fusionMethod) {
      case 'weighted':
        fusedResults = weightedFusion(
          [vectorRanked, bm25Ranked],
          [cfg.vectorWeight, cfg.bm25Weight]
        );
        break;
      case 'combmnz':
        fusedResults = combMNZFusion([vectorRanked, bm25Ranked]);
        break;
      case 'rrf':
      default:
        fusedResults = reciprocalRankFusion(
          [vectorRanked, bm25Ranked],
          cfg.rrfK
        );
        break;
    }

    // Get top K results
    const topResults = fusedResults.slice(0, cfg.finalTopK);

    // Fetch full document data from Qdrant
    const resultIds = topResults.map((r) => r.id);
    const points = await this.qdrant.retrieve(this.collectionName, {
      ids: resultIds,
      with_payload: true,
    });

    // Map results
    const pointMap = new Map(points.map((p) => [p.id as string, p]));

    return topResults.map((result) => {
      const point = pointMap.get(result.id);
      const payload = point?.payload || {};

      // Find scores from original results
      const vectorScore =
        vectorRanked.find((v) => v.id === result.id)?.score || 0;
      const bm25Score =
        bm25Ranked.find((b) => b.id === result.id)?.score || 0;

      return {
        id: result.id,
        content: (payload.content as string) || '',
        documentId: (payload.documentId as string) || '',
        documentTitle: (payload.documentTitle as string) || '',
        documentUrl: (payload.documentUrl as string) || '',
        chunkIndex: (payload.chunkIndex as number) || 0,
        vectorScore,
        bm25Score,
        finalScore: result.score,
        fusionMethod: cfg.fusionMethod,
      };
    });
  }

  /**
   * Get index stats
   */
  getStats() {
    return {
      bm25: this.bm25Index.getStats(),
      config: this.config,
    };
  }
}

/**
 * Standalone hybrid search function (builds index on each call)
 * For simpler use cases without persistent index
 */
export async function hybridSearch(
  qdrant: QdrantClient,
  collectionName: string,
  query: string,
  apiKey: string,
  config?: Partial<HybridSearchConfig>
): Promise<HybridSearchResult[]> {
  const hybrid = new HybridSearch(qdrant, collectionName, config);
  await hybrid.buildBM25Index();
  return hybrid.search(query, apiKey, config);
}
