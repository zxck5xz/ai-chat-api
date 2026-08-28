import type { Context, Next } from 'hono';

// Public paths that don't require authentication
const PUBLIC_PATHS = [
  '/',
  '/api/health',
];

export function authMiddleware(apiKey: string) {
  return async (c: Context, next: Next) => {
    const path = new URL(c.req.url).pathname;

    // Allow public paths
    if (PUBLIC_PATHS.includes(path)) {
      return next();
    }

    // Allow CORS preflight
    if (c.req.method === 'OPTIONS') {
      return next();
    }

    // Check API key from header or query param
    const headerKey = c.req.header('X-API-Key');
    const queryKey = new URL(c.req.url).searchParams.get('api_key');

    if (headerKey === apiKey || queryKey === apiKey) {
      return next();
    }

    return c.json(
      { error: 'Unauthorized', message: 'Invalid or missing API key. Send via X-API-Key header or ?api_key= query param.' },
      401
    );
  };
}
