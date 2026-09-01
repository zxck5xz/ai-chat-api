import { describe, it, expect, beforeEach } from 'vitest';
import { EmbeddingCache } from './embedding-cache';

describe('EmbeddingCache (integration)', () => {
  it('caches identical text and reuses results', async () => {
    const cache = new EmbeddingCache({ maxEntries: 10, ttlMs: 60_000 });
    let calls = 0;
    const loader = async () => {
      calls++;
      return [Math.random(), Math.random(), Math.random()];
    };

    const a1 = await cache.getOrCompute('hello world', loader);
    const a2 = await cache.getOrCompute('hello world', loader);
    const a3 = await cache.getOrCompute('different', loader);

    expect(calls).toBe(2);
    expect(a1.hit).toBe(false);
    expect(a2.hit).toBe(true);
    expect(a3.hit).toBe(false);
    // First call result is identical to second (same object identity)
    expect(a1.value).toBe(a2.value);
  });

  it('respects custom TTL via constructor', async () => {
    const cache = new EmbeddingCache({ maxEntries: 5, ttlMs: 10 });
    await cache.set('q', [1]);
    expect(await cache.get('q')).toEqual([1]);
    await new Promise((r) => setTimeout(r, 30));
    expect(await cache.get('q')).toBeNull();
  });

  it('does not collide on different texts', async () => {
    const cache = new EmbeddingCache({ maxEntries: 100, ttlMs: 60_000 });
    await cache.set('foo', [1, 2]);
    await cache.set('bar', [3, 4]);
    expect(await cache.get('foo')).toEqual([1, 2]);
    expect(await cache.get('bar')).toEqual([3, 4]);
  });

  it('invalidate() removes a single key without affecting others', async () => {
    const cache = new EmbeddingCache({ maxEntries: 100, ttlMs: 60_000 });
    await cache.set('foo', [1]);
    await cache.set('bar', [2]);
    await cache.invalidate('foo');
    expect(await cache.get('foo')).toBeNull();
    expect(await cache.get('bar')).toEqual([2]);
  });

  it('clear() empties cache but keeps stats', async () => {
    const cache = new EmbeddingCache({ maxEntries: 10, ttlMs: 60_000 });
    await cache.set('x', [1]);
    await cache.get('x'); // hit
    await cache.get('missing'); // miss
    cache.clear();
    const s = cache.getStats();
    expect(s.size).toBe(0);
    expect(s.hits).toBe(1);
    expect(s.misses).toBe(1);
  });

  it('SHA-256 key is stable for the same input', async () => {
    const cache = new EmbeddingCache();
    // Same text → same key, so second set overwrites (no duplicate count)
    await cache.set('same text', [1]);
    await cache.set('same text', [2]);
    expect(await cache.get('same text')).toEqual([2]);
    expect(cache.getStats().size).toBe(1);
  });

  it('handles empty string as a valid key', async () => {
    const cache = new EmbeddingCache();
    await cache.set('', [42]);
    expect(await cache.get('')).toEqual([42]);
  });

  it('evicts oldest entry first (insertion-order)', async () => {
    const cache = new EmbeddingCache({ maxEntries: 2, ttlMs: 60_000 });
    await cache.set('a', [1]);
    await cache.set('b', [2]);
    await cache.set('c', [3]); // evicts 'a'
    expect(await cache.get('a')).toBeNull();
    expect(await cache.get('b')).toEqual([2]);
    expect(await cache.get('c')).toEqual([3]);
    expect(cache.getStats().evictions).toBe(1);
  });
});