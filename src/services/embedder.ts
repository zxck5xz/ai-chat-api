import { getEmbeddingCache } from './cache/embedding-cache';

const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta';
const MODEL = 'gemini-embedding-001';

export async function embedText(
  apiKey: string,
  text: string
): Promise<number[]> {
  const cache = getEmbeddingCache();
  const { value } = await cache.getOrCompute(text, () =>
    fetchEmbedding(apiKey, text)
  );
  return value;
}

async function fetchEmbedding(apiKey: string, text: string): Promise<number[]> {
  const response = await fetch(
    `${GEMINI_API_URL}/models/${MODEL}:embedContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: `models/${MODEL}`,
        content: {
          parts: [{ text }],
        },
      }),
    }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Embedding failed: ${response.status} - ${error}`);
  }

  const result = await response.json() as { embedding?: { values?: number[] } };
  return result.embedding?.values || [];
}

export async function embedBatch(
  apiKey: string,
  texts: string[]
): Promise<number[][]> {
  const results: number[][] = [];

  for (const text of texts) {
    const embedding = await embedText(apiKey, text);
    results.push(embedding);
  }

  return results;
}

export function chunkText(
  text: string,
  chunkSize: number = 500,
  overlap: number = 50
): string[] {
  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    const end = Math.min(start + chunkSize, text.length);
    const chunk = text.slice(start, end);

    if (chunk.trim().length > 0) {
      chunks.push(chunk.trim());
    }

    start = end - overlap;
    if (start + overlap >= text.length) break;
  }

  return chunks;
}
