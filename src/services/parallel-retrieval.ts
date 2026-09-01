/**
 * Parallel Retrieval Service
 * Runs BM25 and vector search concurrently, then merges results.
 * Significantly reduces wall-clock time vs sequential.
 */

import { embedText } from './embedder';
import { BM25Index, type BM25Result } from './bm25';
import type { QdrantClient } from '@qdrant/js-client-rest';

export interface ParallelResult {
  id: string;
  content: string;
  documentId: string;
  documentTitle: string;
  documentUrl: string;
  chunkIndex: number;
  vectorScore: number;
  bm25Score: number;
  combinedScore: number;
}

export interface ParallelSearchConfig {
  vectorTopK: number;
  bm25TopK: number;
  vectorWeight: number;
  bm25Weight: number;
}

const DEFAULT_CONFIG: ParallelSearchConfig = {
  vectorTopK: 20,
  bm25TopK: 20,
  vectorWeight: 0.6,
  bm25Weight: 0.4,
};

/**
 * Min-max normalize an array of scores to [0, 1].
 * If all scores are equal, returns 1.0 for each.
 * Exported for unit testing.
 */
export function normalizeScores(scores: number[]): number[] {
  if (scores.length === 0) return [];
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  const range = max - min || 1;
  return scores.map((s) => (s - min) / range);
}

function normalizeBM25Scores(results: BM25Result[]): Map<string, number> {
  if (results.length === 0) return new Map();
  const normalized = normalizeScores(results.map((r) => r.score));
  const map = new Map<string, number>();
  for (let i = 0; i < results.length; i++) {
    map.set(results[i].id, normalized[i]);
  }
  return map;
}

export class ParallelRetrieval {
  private qdrant: QdrantClient;
  private collection: string;

  constructor(qdrant: QdrantClient, collection: string) {
    this.qdrant = qdrant;
    this.collection = collection;
  }

  async search(
    query: string,
    apiKey: string,
    bm25Index: BM25Index,
    config: Partial<ParallelSearchConfig> = {}
  ): Promise<ParallelResult[]> {
    const cfg = { ...DEFAULT_CONFIG, ...config };

    // Kick off both retrievals in parallel.
    const vectorPromise = this.vectorSearch(query, apiKey, cfg.vectorTopK);
    const bm25Promise = Promise.resolve(bm25Index.search(query, cfg.bm25TopK));

    const [vectorResults, bm25Results] = await Promise.all([
      vectorPromise,
      bm25Promise,
    ]);

    const vectorPoints = vectorResults.points;
    const vectorRaw = vectorPoints.map((p) => p.score);
    const vectorNormArr = normalizeScores(vectorRaw);
    const vectorNorm = new Map<string, number>();
    vectorPoints.forEach((p, i) => vectorNorm.set(p.id as string, vectorNormArr[i]));
    const bm25Norm = normalizeBM25Scores(bm25Results);

    // Build result list — fetch full payload for any BM25-only hits.
    const allIds = new Set<string>([...vectorNorm.keys(), ...bm25Norm.keys()]);
    const vectorIdSet = new Set(vectorPoints.map((p) => p.id as string));
    const missingIds = [...allIds].filter((id) => !vectorIdSet.has(id));

    const payloads = new Map<string, {
      content: string;
      documentId: string;
      documentTitle: string;
      documentUrl: string;
      chunkIndex: number;
    }>();

    for (const p of vectorPoints) {
      payloads.set(p.id as string, {
        content: (p.payload?.content as string) || '',
        documentId: (p.payload?.documentId as string) || '',
        documentTitle: (p.payload?.documentTitle as string) || '',
        documentUrl: (p.payload?.documentUrl as string) || '',
        chunkIndex: (p.payload?.chunkIndex as number) || 0,
      });
    }

    if (missingIds.length > 0) {
      const retrieved = await this.qdrant.retrieve(this.collection, {
        ids: missingIds,
        with_payload: true,
      });
      for (const p of retrieved) {
        payloads.set(p.id as string, {
          content: (p.payload?.content as string) || '',
          documentId: (p.payload?.documentId as string) || '',
          documentTitle: (p.payload?.documentTitle as string) || '',
          documentUrl: (p.payload?.documentUrl as string) || '',
          chunkIndex: (p.payload?.chunkIndex as number) || 0,
        });
      }
    }

    const results: ParallelResult[] = [];
    for (const id of allIds) {
      const v = vectorNorm.get(id) ?? 0;
      const b = bm25Norm.get(id) ?? 0;
      const payload = payloads.get(id);
      if (!payload) continue;
      results.push({
        id,
        content: payload.content,
        documentId: payload.documentId,
        documentTitle: payload.documentTitle,
        documentUrl: payload.documentUrl,
        chunkIndex: payload.chunkIndex,
        vectorScore: v,
        bm25Score: b,
        combinedScore: v * cfg.vectorWeight + b * cfg.bm25Weight,
      });
    }

    results.sort((a, b) => b.combinedScore - a.combinedScore);
    return results;
  }

  private async vectorSearch(query: string, apiKey: string, topK: number) {
    const embedding = await embedText(apiKey, query);
    return this.qdrant.query(this.collection, {
      query: embedding,
      limit: topK,
      with_payload: true,
    });
  }
}
