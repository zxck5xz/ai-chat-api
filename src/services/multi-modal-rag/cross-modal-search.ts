import { QdrantClient } from '@qdrant/js-client-rest';
import type { CrossModalSearchResult, CrossModalSearchRequest } from '../../types/multi-modal-rag';

const COLLECTION_NAME = 'multi-modal-documents';
const EMBEDDING_DIMENSION = 768; // multimodalembedding dimension

export class CrossModalSearch {
  private qdrant: QdrantClient;

  constructor(qdrant: QdrantClient) {
    this.qdrant = qdrant;
  }

  async ensureCollection(): Promise<void> {
    try {
      await this.qdrant.getCollection(COLLECTION_NAME);
    } catch {
      console.log('Creating multi-modal collection:', COLLECTION_NAME);
      await this.qdrant.createCollection(COLLECTION_NAME, {
        vectors: {
          size: EMBEDDING_DIMENSION,
          distance: 'Cosine',
        },
      });
    }
  }

  async upsertDocument(doc: {
    id: string;
    title: string;
    type: 'image' | 'text' | 'mixed';
    content: string;
    imageUrl?: string;
    mimeType?: string;
    embedding: number[];
    metadata: Record<string, unknown>;
  }): Promise<void> {
    await this.ensureCollection();

    await this.qdrant.upsert(COLLECTION_NAME, {
      points: [
        {
          id: doc.id,
          vector: doc.embedding,
          payload: {
            title: doc.title,
            type: doc.type,
            content: doc.content,
            imageUrl: doc.imageUrl || '',
            mimeType: doc.mimeType || '',
            metadata: JSON.stringify(doc.metadata),
          },
        },
      ],
    });
  }

  async search(
    queryEmbedding: number[],
    topK: number = 10,
    filter?: { type?: string }
  ): Promise<CrossModalSearchResult[]> {
    await this.ensureCollection();

    const queryOptions: Parameters<QdrantClient['query']>[1] = {
      query: queryEmbedding,
      limit: topK,
      with_payload: true,
    };

    if (filter?.type) {
      queryOptions.filter = {
        must: [
          {
            key: 'type',
            match: { value: filter.type },
          },
        ],
      };
    }

    const results = await this.qdrant.query(COLLECTION_NAME, queryOptions);

    return results.points.map((result) => ({
      id: result.id as string,
      documentId: result.id as string,
      title: (result.payload?.title as string) || '',
      type: (result.payload?.type as 'image' | 'text' | 'mixed') || 'text',
      content: (result.payload?.content as string) || '',
      imageUrl: (result.payload?.imageUrl as string) || undefined,
      score: result.score,
      matchType: 'text-to-text' as const,
    }));
  }

  async hybridSearch(
    textEmbedding: number[],
    imageEmbedding: number[] | null,
    topK: number = 10,
    weights: { text: number; image: number } = { text: 0.6, image: 0.4 }
  ): Promise<CrossModalSearchResult[]> {
    await this.ensureCollection();

    const textResults = await this.search(textEmbedding, topK * 2);

    let imageResults: CrossModalSearchResult[] = [];
    if (imageEmbedding) {
      imageResults = await this.search(imageEmbedding, topK * 2);
    }

    // Score fusion
    const scoreMap = new Map<string, CrossModalSearchResult & { fusedScore: number }>();

    for (const result of textResults) {
      scoreMap.set(result.id, {
        ...result,
        fusedScore: result.score * weights.text,
        matchType: 'text-to-text',
      });
    }

    for (const result of imageResults) {
      const existing = scoreMap.get(result.id);
      if (existing) {
        existing.fusedScore += result.score * weights.image;
        existing.matchType = 'text-to-image';
      } else {
        scoreMap.set(result.id, {
          ...result,
          fusedScore: result.score * weights.image,
          matchType: 'image-to-image',
        });
      }
    }

    const fused = Array.from(scoreMap.values())
      .sort((a, b) => b.fusedScore - a.fusedScore)
      .slice(0, topK)
      .map(({ fusedScore, ...rest }) => ({
        ...rest,
        score: fusedScore,
      }));

    return fused;
  }

  async deleteDocument(id: string): Promise<void> {
    await this.qdrant.delete(COLLECTION_NAME, {
      points: [id],
    });
  }

  async getDocumentCount(): Promise<number> {
    try {
      const collection = await this.qdrant.getCollection(COLLECTION_NAME);
      return collection.points_count || 0;
    } catch {
      return 0;
    }
  }
}
