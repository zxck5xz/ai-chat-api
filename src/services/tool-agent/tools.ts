import type { ToolDefinition } from '../../types/tool-agent';

async function jinaSearch(query: string): Promise<string> {
  const response = await fetch(`https://s.jina.ai/${encodeURIComponent(query)}`, {
    headers: {
      Accept: 'application/json',
      'X-No-Cache': 'true',
    },
  });

  if (!response.ok) {
    throw new Error(`Jina search failed: ${response.status}`);
  }

  const data = await response.json() as {
    data?: Array<{ title?: string; url?: string; content?: string }>;
  };

  if (!data.data || data.data.length === 0) {
    return 'No results found.';
  }

  return data.data
    .slice(0, 5)
    .map((r, i) => `[${i + 1}] ${r.title || 'Untitled'}\n${r.url || ''}\n${r.content || ''}`)
    .join('\n\n');
}

async function httpRequest(args: Record<string, unknown>): Promise<string> {
  const url = args.url as string;
  const method = (args.method as string) || 'GET';
  const headers = (args.headers as Record<string, string>) || {};
  const body = args.body as string | undefined;

  const response = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    body: method !== 'GET' && body ? body : undefined,
  });

  const text = await response.text();
  return `Status: ${response.status}\n${text.slice(0, 3000)}`;
}

function calculate(expression: string): string {
  try {
    // Safe math evaluation using Function constructor
    const sanitized = expression.replace(/[^0-9+\-*/().,%^ ]/g, '');
    if (sanitized !== expression) {
      return 'Error: Invalid characters in expression';
    }
    // eslint-disable-next-line no-new-func
    const result = new Function(`return (${sanitized})`)();
    return String(result);
  } catch {
    return `Error: Could not evaluate "${expression}"`;
  }
}

function getCurrentTime(): string {
  return new Date().toISOString();
}

export const toolRegistry: ToolDefinition[] = [
  {
    name: 'search_web',
    description:
      'Search the web for current information. Use this when you need to find up-to-date facts, prices, news, or any information that may not be in your training data.',
    parameters: {
      type: 'OBJECT',
      properties: {
        query: {
          type: 'STRING',
          description: 'The search query',
        },
      },
      required: ['query'],
    },
    execute: async (args) => jinaSearch(args.query as string),
  },
  {
    name: 'http_request',
    description:
      'Make an HTTP request to a URL and return the response. Use this to call APIs, fetch web pages, or interact with web services.',
    parameters: {
      type: 'OBJECT',
      properties: {
        url: {
          type: 'STRING',
          description: 'The URL to request',
        },
        method: {
          type: 'STRING',
          description: 'HTTP method (GET, POST, PUT, DELETE)',
          enum: ['GET', 'POST', 'PUT', 'DELETE'],
        },
        headers: {
          type: 'STRING',
          description: 'JSON string of headers (optional)',
        },
        body: {
          type: 'STRING',
          description: 'Request body for POST/PUT (optional)',
        },
      },
      required: ['url'],
    },
    execute: async (args) => {
      const headers = args.headers ? JSON.parse(args.headers as string) : {};
      return httpRequest({ ...args, headers });
    },
  },
  {
    name: 'calculate',
    description:
      'Evaluate a mathematical expression. Supports basic arithmetic: +, -, *, /, %, ^, parentheses.',
    parameters: {
      type: 'OBJECT',
      properties: {
        expression: {
          type: 'STRING',
          description: 'The math expression to evaluate, e.g. "2 + 3 * 4"',
        },
      },
      required: ['expression'],
    },
    execute: async (args) => calculate(args.expression as string),
  },
  {
    name: 'get_current_time',
    description: 'Get the current date and time in ISO format.',
    parameters: {
      type: 'OBJECT',
      properties: {},
      required: [],
    },
    execute: async () => getCurrentTime(),
  },
];

export function getToolByName(name: string): ToolDefinition | undefined {
  return toolRegistry.find((t) => t.name === name);
}

export function getGeminiTools() {
  return [
    {
      functionDeclarations: toolRegistry.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      })),
    },
  ];
}
