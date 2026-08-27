/**
 * BM25 Keyword Search Implementation
 * Okapi BM25 algorithm for Cloudflare Workers
 */

export interface BM25Config {
  k1: number;  // Term frequency saturation (default 1.2)
  b: number;   // Length normalization (default 0.75)
}

export interface BM25Document {
  id: string;
  content: string;
  tokens: string[];
  length: number;
}

export interface BM25Result {
  id: string;
  score: number;
  content: string;
}

const DEFAULT_CONFIG: BM25Config = {
  k1: 1.2,
  b: 0.75,
};

/**
 * Tokenize text into terms
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

/**
 * Build BM25 index from documents
 */
export class BM25Index {
  private documents: Map<string, BM25Document> = new Map();
  private invertedIndex: Map<string, Set<string>> = new Map();
  private docLengths: number[] = [];
  private avgDocLength: number = 0;
  private totalDocs: number = 0;
  private config: BM25Config;

  constructor(config: Partial<BM25Config> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Add a document to the index
   */
  addDocument(id: string, content: string): void {
    const tokens = tokenize(content);
    const doc: BM25Document = {
      id,
      content,
      tokens,
      length: tokens.length,
    };

    this.documents.set(id, doc);
    this.docLengths.push(tokens.length);
    this.avgDocLength =
      this.docLengths.reduce((a, b) => a + b, 0) / this.docLengths.length;
    this.totalDocs = this.documents.size;

    // Update inverted index
    const uniqueTokens = new Set(tokens);
    for (const token of uniqueTokens) {
      if (!this.invertedIndex.has(token)) {
        this.invertedIndex.set(token, new Set());
      }
      this.invertedIndex.get(token)!.add(id);
    }
  }

  /**
   * Add multiple documents
   */
  addDocuments(docs: Array<{ id: string; content: string }>): void {
    for (const doc of docs) {
      this.addDocument(doc.id, doc.content);
    }
  }

  /**
   * Remove a document from the index
   */
  removeDocument(id: string): void {
    const doc = this.documents.get(id);
    if (!doc) return;

    // Remove from inverted index
    for (const token of doc.tokens) {
      const docIds = this.invertedIndex.get(token);
      if (docIds) {
        docIds.delete(id);
        if (docIds.size === 0) {
          this.invertedIndex.delete(token);
        }
      }
    }

    // Remove from documents
    this.documents.delete(id);

    // Recalculate stats
    this.docLengths = this.docLengths.filter((_, i) => {
      const docArray = Array.from(this.documents.values());
      return docArray[i]?.id !== id;
    });
    this.avgDocLength =
      this.docLengths.length > 0
        ? this.docLengths.reduce((a, b) => a + b, 0) / this.docLengths.length
        : 0;
    this.totalDocs = this.documents.size;
  }

  /**
   * Calculate IDF (Inverse Document Frequency) for a term
   */
  private idf(term: string): number {
    const docsWithTerm = this.invertedIndex.get(term)?.size || 0;
    // IDF with smoothing
    return Math.log(
      (this.totalDocs - docsWithTerm + 0.5) / (docsWithTerm + 0.5) + 1
    );
  }

  /**
   * Calculate BM25 score for a query against a document
   */
  private scoreDocument(queryTokens: string[], doc: BM25Document): number {
    let score = 0;

    for (const term of queryTokens) {
      const termFreq = doc.tokens.filter((t) => t === term).length;
      const idf = this.idf(term);

      // BM25 formula
      const tfComponent =
        (termFreq * (this.config.k1 + 1)) /
        (termFreq +
          this.config.k1 *
            (1 -
              this.config.b +
              (this.config.b * doc.length) / this.avgDocLength));

      score += idf * tfComponent;
    }

    return score;
  }

  /**
   * Search the index with a query
   */
  search(query: string, topK: number = 10): BM25Result[] {
    const queryTokens = tokenize(query);
    const results: BM25Result[] = [];

    // Find candidate documents (union of documents containing any query term)
    const candidateIds = new Set<string>();
    for (const token of queryTokens) {
      const docIds = this.invertedIndex.get(token);
      if (docIds) {
        for (const id of docIds) {
          candidateIds.add(id);
        }
      }
    }

    // Score each candidate
    for (const id of candidateIds) {
      const doc = this.documents.get(id);
      if (doc) {
        const score = this.scoreDocument(queryTokens, doc);
        if (score > 0) {
          results.push({
            id,
            score,
            content: doc.content,
          });
        }
      }
    }

    // Sort by score descending
    results.sort((a, b) => b.score - a.score);

    return results.slice(0, topK);
  }

  /**
   * Get index stats
   */
  getStats() {
    return {
      totalDocuments: this.totalDocs,
      averageDocLength: this.avgDocLength,
      uniqueTerms: this.invertedIndex.size,
    };
  }
}

/**
 * Simple BM25 search without pre-built index (for small datasets)
 */
export function bm25Search(
  documents: Array<{ id: string; content: string }>,
  query: string,
  topK: number = 10,
  config: Partial<BM25Config> = {}
): BM25Result[] {
  const index = new BM25Index(config);
  index.addDocuments(documents);
  return index.search(query, topK);
}
