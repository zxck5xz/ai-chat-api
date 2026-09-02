import type {
  MCPToolDefinition,
  MCPToolCallRequest,
  MCPToolCallResponse,
  InternalTool,
} from '../../types/mcp';

const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta';

// Registry of internal tools exposed via MCP
export const internalToolRegistry: InternalTool[] = [
  // === Code Review Tools ===
  {
    name: 'code_review',
    description:
      'Review code for issues, bugs, and improvements. Returns structured feedback with severity levels.',
    category: 'code-review',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'The code to review' },
        language: { type: 'string', description: 'Programming language (e.g., typescript, python)' },
        context: { type: 'string', description: 'Additional context about the code' },
      },
      required: ['code'],
    },
    handler: async (args: Record<string, unknown>, env: unknown): Promise<MCPToolCallResponse> => {
      const { GEMINI_API_KEY } = env as { GEMINI_API_KEY: string };
      const { code, language = 'unknown', context = '' } = args as {
        code: string;
        language?: string;
        context?: string;
      };

      try {
        const prompt = `Review the following ${language} code${context ? `. Context: ${context}` : ''}.\n\nCode:\n\`\`\`\n${code}\n\`\`\`\n\nReturn JSON with: { issues: [{ line, severity, message, suggestion }], summary, score }`;

        const response = await fetch(
          `${GEMINI_API_URL}/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: {
                responseMimeType: 'application/json',
              },
            }),
          }
        );

        if (!response.ok) {
          throw new Error(`Gemini API error: ${response.status}`);
        }

        const data = await response.json() as {
          candidates?: Array<{ content?: { parts?: Array<{ text: string }> } }>;
        };
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
        const analysis = JSON.parse(text);

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  language,
                  issueCount: analysis.issues?.length || 0,
                  score: analysis.score,
                  summary: analysis.summary,
                  issues: analysis.issues || [],
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text', text: `Code review error: ${message}` }],
          isError: true,
        };
      }
    },
  },

  // === Multi-Modal Tools ===
  {
    name: 'analyze_image',
    description:
      'Analyze an image: describe contents, extract text (OCR), read charts, parse receipts.',
    category: 'multi-modal',
    inputSchema: {
      type: 'object',
      properties: {
        imageBase64: { type: 'string', description: 'Base64-encoded image data' },
        analysisType: {
          type: 'string',
          description: 'Type of analysis to perform',
          enum: ['describe', 'ocr', 'code', 'receipt', 'chart'],
          default: 'describe',
        },
        prompt: { type: 'string', description: 'Custom prompt for analysis' },
      },
      required: ['imageBase64'],
    },
    handler: async (args: Record<string, unknown>, env: unknown): Promise<MCPToolCallResponse> => {
      const { GEMINI_API_KEY } = env as { GEMINI_API_KEY: string };
      const { imageBase64, analysisType = 'describe', prompt } = args as {
        imageBase64: string;
        analysisType?: string;
        prompt?: string;
      };

      try {
        const defaultPrompts: Record<string, string> = {
          describe: 'Describe this image in detail.',
          ocr: 'Extract all text from this image. Preserve formatting.',
          code: 'Extract any code shown in this image and return it as text.',
          receipt: 'Parse this receipt image. Extract items, prices, total, date, and store name.',
          chart: 'Analyze this chart/graph. Describe the data, trends, and key insights.',
        };

        const response = await fetch(
          `${GEMINI_API_URL}/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [
                {
                  parts: [
                    { inlineData: { mimeType: 'image/png', data: imageBase64 } },
                    { text: prompt || defaultPrompts[analysisType] || defaultPrompts.describe },
                  ],
                },
              ],
            }),
          }
        );

        if (!response.ok) {
          throw new Error(`Gemini API error: ${response.status}`);
        }

        const data = await response.json() as {
          candidates?: Array<{ content?: { parts?: Array<{ text: string }> } }>;
        };
        const result = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ analysisType, result }, null, 2),
            },
          ],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text', text: `Image analysis error: ${message}` }],
          isError: true,
        };
      }
    },
  },

  // === Utility Tools ===
  {
    name: 'get_current_time',
    description: 'Get the current date and time in UTC.',
    category: 'utility',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    handler: async (): Promise<MCPToolCallResponse> => ({
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ utc: new Date().toISOString() }, null, 2),
        },
      ],
    }),
  },

  {
    name: 'calculate',
    description: 'Evaluate a mathematical expression.',
    category: 'utility',
    inputSchema: {
      type: 'object',
      properties: {
        expression: { type: 'string', description: 'Mathematical expression to evaluate' },
      },
      required: ['expression'],
    },
    handler: async (args: Record<string, unknown>): Promise<MCPToolCallResponse> => {
      const { expression } = args as { expression: string };

      const sanitized = expression.replace(/[^0-9+\-*/().,%^ ]/g, '');
      if (sanitized !== expression) {
        return {
          content: [{ type: 'text', text: 'Error: Expression contains invalid characters' }],
          isError: true,
        };
      }

      try {
        // eslint-disable-next-line no-eval
        const result = new Function(`return (${sanitized})`)();
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ expression, result }, null, 2),
            },
          ],
        };
      } catch {
        return {
          content: [{ type: 'text', text: `Error evaluating expression: ${expression}` }],
          isError: true,
        };
      }
    },
  },

  {
    name: 'search_web',
    description: 'Search the web using Jina AI search API. Returns relevant search results.',
    category: 'search',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query' },
      },
      required: ['query'],
    },
    handler: async (args: Record<string, unknown>): Promise<MCPToolCallResponse> => {
      const { query } = args as { query: string };

      try {
        const response = await fetch(
          `https://s.jina.ai/${encodeURIComponent(query)}`,
          {
            headers: {
              Accept: 'application/json',
            },
          }
        );

        if (!response.ok) {
          throw new Error(`Search failed: ${response.status}`);
        }

        const data = await response.json() as { data?: Array<{ title: string; url: string; content: string }> };
        const results = data.data || [];

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  query,
                  resultCount: results.length,
                  results: results.slice(0, 5).map((r) => ({
                    title: r.title,
                    url: r.url,
                    snippet: r.content?.slice(0, 200),
                  })),
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text', text: `Search error: ${message}` }],
          isError: true,
        };
      }
    },
  },
];

// Convert internal tools to MCP tool definitions
export function getMCPToolDefinitions(): MCPToolDefinition[] {
  return internalToolRegistry.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));
}

// Execute a tool by name
export async function executeTool(
  request: MCPToolCallRequest,
  env: unknown
): Promise<MCPToolCallResponse> {
  const tool = internalToolRegistry.find((t) => t.name === request.name);
  if (!tool) {
    return {
      content: [{ type: 'text', text: `Tool not found: ${request.name}` }],
      isError: true,
    };
  }

  try {
    return await tool.handler(request.arguments, env);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: 'text', text: `Error executing tool: ${message}` }],
      isError: true,
    };
  }
}
