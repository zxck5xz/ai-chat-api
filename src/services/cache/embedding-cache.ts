/**
 * Embedding Cache (LRU + TTL)
 * Caches Gemini embedding API results in-memory to reduce API calls.
 * - LRU eviction when max entries reached.
 * - TTL expiration on stale entries.
 */

export interface EmbeddingCacheOptions {
  maxEntries: number;
  ttlMs: number;
}

export interface EmbeddingCacheStats {
  hits: number;
  misses: number;
  evictions: number;
  expirations: number;
  size: number;
  hitRate: number;
}

interface CacheEntry {
  value: number[];
  expiresAt: number;
}

const DEFAULT_OPTIONS: EmbeddingCacheOptions = {
  maxEntries: 1000,
  ttlMs: 24 * 60 * 60 * 1000, // 24h
};

export class EmbeddingCache {
  private cache: Map<string, CacheEntry> = new Map();
  private options: EmbeddingCacheOptions;
  private hits = 0;
  private misses = 0;
  private evictions = 0;
  private expirations = 0;

  constructor(options: Partial<EmbeddingCacheOptions> = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /**
   * Hash a string to a stable cache key using SHA-256.
   * Returns a hex string. Falls back to plain string if subtle unavailable.
   */
  private static async hashKey(text: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(text);
    if (typeof crypto !== 'undefined' && crypto.subtle) {
      const hashBuffer = await crypto.subtle.digest('SHA-256', data);
      return Array.from(new Uint8Array(hashBuffer))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
    }
    return text;
  }

  /**
   * Get an embedding from the cache. Returns null if missing or expired.
   */
  async get(text: string): Promise<number[] | null> {
    const key = await EmbeddingCache.hashKey(text);
    const entry = this.cache.get(key);

    if (!entry) {
      this.misses++;
      return null;
    }

    if (entry.expiresAt < Date.now()) {
      this.cache.delete(key);
      this.expirations++;
      this.misses++;
      return null;
    }

    // LRU: re-insert to bump to most-recently-used
    this.cache.delete(key);
    this.cache.set(key, entry);
    this.hits++;
    return entry.value;
  }

  /**
   * Set an embedding in the cache.
   */
  async set(text: string, value: number[]): Promise<void> {
    const key = await EmbeddingCache.hashKey(text);

    if (this.cache.has(key)) {
      this.cache.delete(key);
    }

    const entry: CacheEntry = {
      value,
      expiresAt: Date.now() + this.options.ttlMs,
    };
    this.cache.set(key, entry);

    // Evict oldest entries (Map iteration order is insertion order)
    while (this.cache.size > this.options.maxEntries) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey === undefined) break;
      this.cache.delete(firstKey);
      this.evictions++;
    }
  }

  /**
   * Get or compute an embedding using a loader function on miss.
   */
  async getOrCompute(
    text: string,
    loader: () => Promise<number[]>
  ): Promise<{ value: number[]; hit: boolean }> {
    const cached = await this.get(text);
    if (cached) {
      return { value: cached, hit: true };
    }
    const value = await loader();
    await this.set(text, value);
    return { value, hit: false };
  }

  /**
   * Invalidate a single entry.
   */
  async invalidate(text: string): Promise<void> {
    const key = await EmbeddingCache.hashKey(text);
    this.cache.delete(key);
  }

  /**
   * Clear the entire cache.
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Get cache statistics.
   */
  getStats(): EmbeddingCacheStats {
    const total = this.hits + this.misses;
    return {
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      expirations: this.expirations,
      size: this.cache.size,
      hitRate: total > 0 ? this.hits / total : 0,
    };
  }

  /**
   * Reset statistics.
   */
  resetStats(): void {
    this.hits = 0;
    this.misses = 0;
    this.evictions = 0;
    this.expirations = 0;
  }
}

// Module-level singleton for the API process
let defaultCache: EmbeddingCache | null = null;

export function getEmbeddingCache(): EmbeddingCache {
  if (!defaultCache) {
    defaultCache = new EmbeddingCache();
  }
  return defaultCache;
}
