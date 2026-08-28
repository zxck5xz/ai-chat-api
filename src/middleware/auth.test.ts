import { describe, it, expect } from 'vitest';
import { authMiddleware } from '../middleware/auth';

function createRequest(path = '/', headers: Record<string, string> = {}) {
  return new Request(`http://localhost${path}`, { headers });
}

function createEnv(apiKey = 'test-key') {
  return { apiKey };
}

describe('authMiddleware', () => {
  it('allows public paths without API key', async () => {
    const middleware = authMiddleware('test-key');
    const req = createRequest('/');
    const env = createEnv();
    let nextCalled = false;

    const c = {
      req: { url: req.url, header: (name: string) => req.headers.get(name), method: 'GET' },
      json: () => new Response('', { status: 401 }),
    } as any;

    const next = async () => { nextCalled = true; };
    await middleware(c, next);
    expect(nextCalled).toBe(true);
  });

  it('rejects requests without API key', async () => {
    const middleware = authMiddleware('test-key');
    let responseStatus = 0;

    const c = {
      req: {
        url: 'http://localhost/api/conversations',
        header: () => null,
        method: 'GET',
      },
      json: (body: any, status?: number) => {
        responseStatus = status || 200;
        return new Response(JSON.stringify(body), { status: status || 200 });
      },
    } as any;

    const next = async () => {};
    await middleware(c, next);
    expect(responseStatus).toBe(401);
  });

  it('allows requests with valid X-API-Key header', async () => {
    const middleware = authMiddleware('test-key');
    let nextCalled = false;

    const c = {
      req: {
        url: 'http://localhost/api/conversations',
        header: (name: string) => name === 'X-API-Key' ? 'test-key' : null,
        method: 'GET',
      },
      json: () => new Response('', { status: 401 }),
    } as any;

    const next = async () => { nextCalled = true; };
    await middleware(c, next);
    expect(nextCalled).toBe(true);
  });

  it('rejects requests with invalid API key', async () => {
    const middleware = authMiddleware('test-key');
    let responseStatus = 0;

    const c = {
      req: {
        url: 'http://localhost/api/conversations',
        header: (name: string) => name === 'X-API-Key' ? 'wrong-key' : null,
        method: 'GET',
      },
      json: (body: any, status?: number) => {
        responseStatus = status || 200;
        return new Response(JSON.stringify(body), { status: status || 200 });
      },
    } as any;

    const next = async () => {};
    await middleware(c, next);
    expect(responseStatus).toBe(401);
  });

  it('allows OPTIONS requests (CORS preflight)', async () => {
    const middleware = authMiddleware('test-key');
    let nextCalled = false;

    const c = {
      req: {
        url: 'http://localhost/api/conversations',
        header: () => null,
        method: 'OPTIONS',
      },
      json: () => new Response('', { status: 401 }),
    } as any;

    const next = async () => { nextCalled = true; };
    await middleware(c, next);
    expect(nextCalled).toBe(true);
  });
});
