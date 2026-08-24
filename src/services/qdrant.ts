import { QdrantClient } from '@qdrant/js-client-rest';

const COLLECTION_NAME = 'ai-chat-documents';
const EMBEDDING_DIMENSION = 3072; // gemini-embedding-001

export function createQdrantClient(url: string, apiKey: string): QdrantClient {
  return new QdrantClient({
    url,
    apiKey,
  });
}

export async function ensureCollection(client: QdrantClient): Promise<void> {
  try {
    await client.getCollection(COLLECTION_NAME);
  } catch (err) {
    console.log('Creating collection:', COLLECTION_NAME);
    await client.createCollection(COLLECTION_NAME, {
      vectors: {
        size: EMBEDDING_DIMENSION,
        distance: 'Cosine',
      },
    });
  }
}

export interface DocumentChunk {
  id: string;
  documentId: string;
  documentTitle: string;
  documentUrl: string;
  chunkIndex: number;
  content: string;
  embedding: number[];
}

export interface SearchResult {
  id: string;
  documentId: string;
  documentTitle: string;
  documentUrl: string;
  chunkIndex: number;
  content: string;
  score: number;
}

export async function upsertChunks(
  client: QdrantClient,
  chunks: DocumentChunk[]
): Promise<void> {
  const points = chunks.map((chunk) => ({
    id: chunk.id,
    vector: chunk.embedding,
    payload: {
      documentId: chunk.documentId,
      documentTitle: chunk.documentTitle,
      documentUrl: chunk.documentUrl,
      chunkIndex: chunk.chunkIndex,
      content: chunk.content,
    },
  }));

  console.log('Upserting points:', points.length);

  // Upsert in batches of 100
  for (let i = 0; i < points.length; i += 100) {
    const batch = points.slice(i, i + 100);
    const result = await client.upsert(COLLECTION_NAME, {
      points: batch,
    });
    console.log('Upsert result:', result);
  }
}

export async function searchSimilar(
  client: QdrantClient,
  queryEmbedding: number[],
  topK: number = 5
): Promise<SearchResult[]> {
  const results = await client.query(COLLECTION_NAME, {
    query: queryEmbedding,
    limit: topK,
    with_payload: true,
  });

  return results.points.map((result) => ({
    id: result.id as string,
    documentId: (result.payload?.documentId as string) || '',
    documentTitle: (result.payload?.documentTitle as string) || '',
    documentUrl: (result.payload?.documentUrl as string) || '',
    chunkIndex: (result.payload?.chunkIndex as number) || 0,
    content: (result.payload?.content as string) || '',
    score: result.score,
  }));
}
