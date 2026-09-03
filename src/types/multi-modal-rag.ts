export interface MultiModalDocument {
  id: string;
  title: string;
  type: 'image' | 'text' | 'mixed';
  content: string;
  imageUrl?: string;
  mimeType?: string;
  embedding: number[];
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface CrossModalSearchResult {
  id: string;
  documentId: string;
  title: string;
  type: 'image' | 'text' | 'mixed';
  content: string;
  imageUrl?: string;
  score: number;
  matchType: 'text-to-image' | 'image-to-text' | 'text-to-text' | 'image-to-image';
}

export interface MultiModalEmbeddingRequest {
  title: string;
  type: 'image' | 'text' | 'mixed';
  content: string;
  imageBase64?: string;
  mimeType?: string;
  metadata?: Record<string, unknown>;
}

export interface CrossModalSearchRequest {
  query: string;
  queryImageBase64?: string;
  queryMimeType?: string;
  searchType: 'text-to-image' | 'image-to-text' | 'text-to-text' | 'image-to-image' | 'cross';
  topK?: number;
}

export interface MultiModalRAGMetrics {
  totalDocuments: number;
  documentsByType: Record<string, number>;
  totalSearches: number;
  avgLatencyMs: number;
}
