import { describe, it, expect, beforeEach } from 'vitest';
import { EmbeddingCache } from './embedding-cache';

describe('EmbeddingCache', () => {
  let cache: EmbeddingCache;

  beforeEach(() => {
    cache = new EmbeddingCache({ maxEntries: 3, ttlMs: 60_000 });
  });

  it('returns null on miss', async () => {
    const value = await cache.get('hello');
    expect(value).toBeNull();
  });

  it('returns cached value on hit', async () => {
    await cache.set('hello', [1, 2, 3]);
    const value = await cache.get('hello');
    expect(value).toEqual([1, 2, 3]);
  });

  it('tracks hits and misses', async () => {
    await cache.set('a', [1]);
    await cache.get('a'); // hit
    await cache.get('a'); // hit
    await cache.get('missing'); // miss

    const stats = cache.getStats();
    expect(stats.hits).toBe(2);
    expect(stats.misses).toBe(1);
    expect(stats.hitRate).toBeCloseTo(2 / 3);
  });

  it('evicts oldest entry when maxEntries exceeded', async () => {
    await cache.set('a', [1]);
    await cache.set('b', [2]);
    await cache.set('c', [3]);
    await cache.set('d', [4]); // evicts 'a'

    expect(await cache.get('a')).toBeNull();
    expect(await cache.get('b')).toEqual([2]);
    expect(cache.getStats().evictions).toBe(1);
  });

  it('expires entries past TTL', async () => {
    cache = new EmbeddingCache({ maxEntries: 10, ttlMs: 5 });
    await cache.set('a', [1]);
    await new Promise((r) => setTimeout(r, 20));
    const value = await cache.get('a');
    expect(value).toBeNull();
    expect(cache.getStats().expirations).toBe(1);
  });

  it('getOrCompute loads on miss and caches', async () => {
    let calls = 0;
    const loader = async () => {
      calls++;
      return [42, 43];
    };

    const first = await cache.getOrCompute('q', loader);
    const second = await cache.getOrCompute('q', loader);

    expect(first.hit).toBe(false);
    expect(second.hit).toBe(true);
    expect(calls).toBe(1);
    expect(first.value).toEqual([42, 43]);
  });

  it('clear() empties cache and stats can be reset', async () => {
    await cache.set('a', [1]);
    await cache.get('missing');
    cache.clear();
    cache.resetStats();
    const stats = cache.getStats();
    expect(stats.size).toBe(0);
    expect(stats.hits).toBe(0);
    expect(stats.misses).toBe(0);
  });

  it('LRU bumps recent entries on hit', async () => {
    await cache.set('a', [1]);
    await cache.set('b', [2]);
    await cache.set('c', [3]);

    // Touch 'a' so it becomes most-recently-used
    await cache.get('a');

    // Add 'd' → should evict 'b' (oldest untouched), not 'a'
    await cache.set('d', [4]);

    expect(await cache.get('a')).toEqual([1]);
    expect(await cache.get('b')).toBeNull();
    expect(await cache.get('c')).toEqual([3]);
    expect(await cache.get('d')).toEqual([4]);
  });
});
