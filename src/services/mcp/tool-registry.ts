/**
 * MCP Tool Registry
 * Wires our existing services into MCP-shaped tools.
 * Each tool declares a JSON Schema input and a handler that calls the
 * underlying Cloudflare Worker service.
 */

import type {
  Tool,
  ToolHandler,
  RegisteredTool,
  ToolInputSchema,
  CallToolResult,
} from '../../types/mcp';
import { embedText } from '../embedder';
import { QueryClassifier } from '../search-engine/query-classifier';
import { QueryExpansion } from '../search-engine/query-expansion';
import { HybridSearch } from '../hybrid-search';
import { ParallelRetrieval } from '../parallel-retrieval';
import { createQdrantClient, ensureCollection } from '../qdrant';
import { BM25Index, tokenize } from '../bm25';

// Helper to build a JSON Schema for an object input
function objectSchema(
  properties: Record<string, unknown>,
  required: string[] = []
): ToolInputSchema {
  return {
    type: 'object',
    properties,
    required,
    additionalProperties: false,
  };
}

// Tool result helper — wraps a string as a single text content block.
function textResult(text: string, isError = false): CallToolResult {
  return { content: [{ type: 'text', text }], isError };
}

// JSON result helper — pretty-prints structured data.
function jsonResult(data: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
  };
}

function errorResult(message: string): CallToolResult {
  return textResult(message, true);
}

function asString(v: unknown, name: string): string | null {
  if (typeof v !== 'string' || v.length === 0) return null;
  return v;
}

// ---------------------------------------------------------------------------
// Tool 1: search_query — classify + expand a query
// ---------------------------------------------------------------------------
const searchQueryTool: Tool = {
  name: 'search_query',
  description:
    'Analyze a search query: classify complexity (simple|moderate|complex|ambiguous) and expand it using HyDE / multi-query / decomposition / step-back strategies. Returns the classified query + expanded queries ready for retrieval.',
  inputSchema: objectSchema(
    {
      query: { type: 'string', description: 'The user search query' },
      strategy: {
        type: 'string',
        enum: ['auto', 'hyde', 'multi_query', 'decomposition', 'step_back'],
        description: 'Expansion strategy (auto picks based on query shape)',
      },
    },
    ['query']
  ),
};

const searchQueryHandler: ToolHandler = async (args, env) => {
  const query = asString(args.query, 'query');
  if (!query) return errorResult('query must be a non-empty string');
  const strategy = (args.strategy as string) ?? 'auto';

  try {
    const classifier = new QueryClassifier(env.GEMINI_API_KEY);
    const expansion = new QueryExpansion(env.GEMINI_API_KEY);

    const classified = await classifier.classify(query);
    const expanded = await expansion.expand(
      query,
      strategy as 'auto' | 'hyde' | 'multi_query' | 'decomposition' | 'step_back'
    );

    return jsonResult({ classified, expanded });
  } catch (err) {
    return errorResult(`search_query failed: ${err instanceof Error ? err.message : String(err)}`);
  }
};

// ---------------------------------------------------------------------------
// Tool 2: hybrid_search — parallel BM25 + vector retrieval
// ---------------------------------------------------------------------------
const hybridSearchTool: Tool = {
  name: 'hybrid_search',
  description:
    'Run a hybrid search over the document index. Combines BM25 keyword search with vector similarity in parallel and fuses scores. Returns the top results with content, scores, and source metadata.',
  inputSchema: objectSchema(
    {
      query: { type: 'string', description: 'The search query' },
      topK: { type: 'number', description: 'Number of results to return', default: 5 },
      vectorWeight: { type: 'number', description: 'Weight for vector score in fusion', default: 0.6 },
      bm25Weight: { type: 'number', description: 'Weight for BM25 score in fusion', default: 0.4 },
    },
    ['query']
  ),
};

const hybridSearchHandler: ToolHandler = async (args, env) => {
  const query = asString(args.query, 'query');
  if (!query) return errorResult('query must be a non-empty string');
  const topK = Math.max(1, Math.min(20, Number(args.topK ?? 5)));
  const vectorWeight = Number(args.vectorWeight ?? 0.6);
  const bm25Weight = Number(args.bm25Weight ?? 0.4);

  try {
    const qdrant = createQdrantClient(env.QDRANT_URL, env.QDRANT_API_KEY);
    await ensureCollection(qdrant);

    // Build a small BM25 index from any pre-fetched chunks; for a stateless
    // MCP tool call we use a lightweight in-memory BM25 over Qdrant points.
    const bm25 = new BM25Index();
    let offset: string | number | null = null;
    let hasMore = true;
    while (hasMore) {
      const page = await qdrant.scroll('ai-chat-documents', {
        limit: 100,
        offset,
        with_payload: true,
      });
      for (const p of page.points) {
        const content = (p.payload?.content as string) ?? '';
        if (content) bm25.addDocument(String(p.id), content);
      }
      offset = (page.next_page_offset as string | number | null) ?? null;
      hasMore = page.points.length === 100 && offset !== null;
    }

    const retriever = new ParallelRetrieval(qdrant, 'ai-chat-documents');
    const results = await retriever.search(query, env.GEMINI_API_KEY, bm25, {
      vectorTopK: 20,
      bm25TopK: 20,
      vectorWeight,
      bm25Weight,
    });

    return jsonResult({
      query,
      totalResults: results.length,
      results: results.slice(0, topK).map((r) => ({
        id: r.id,
        documentTitle: r.documentTitle,
        documentUrl: r.documentUrl,
        chunkIndex: r.chunkIndex,
        content: r.content.slice(0, 400),
        vectorScore: r.vectorScore,
        bm25Score: r.bm25Score,
        combinedScore: r.combinedScore,
      })),
    });
  } catch (err) {
    return errorResult(`hybrid_search failed: ${err instanceof Error ? err.message : String(err)}`);
  }
};

// ---------------------------------------------------------------------------
// Tool 3: rag_query — RAG query against the document corpus
// ---------------------------------------------------------------------------
const ragQueryTool: Tool = {
  name: 'rag_query',
  description:
    'Run a Retrieval-Augmented Generation query: retrieve the most relevant chunks, then ask Gemini to answer grounded on them. Returns the answer + source citations.',
  inputSchema: objectSchema(
    {
      query: { type: 'string', description: 'The user question' },
      topK: { type: 'number', description: 'Number of chunks to ground the answer on', default: 3 },
    },
    ['query']
  ),
};

const ragQueryHandler: ToolHandler = async (args, env) => {
  const query = asString(args.query, 'query');
  if (!query) return errorResult('query must be a non-empty string');
  const topK = Math.max(1, Math.min(10, Number(args.topK ?? 3)));

  try {
    const qdrant = createQdrantClient(env.QDRANT_URL, env.QDRANT_API_KEY);
    await ensureCollection(qdrant);

    const queryEmbedding = await embedText(env.GEMINI_API_KEY, query);
    const vectorResults = await qdrant.query('ai-chat-documents', {
      query: queryEmbedding,
      limit: topK,
      with_payload: true,
    });

    if (vectorResults.points.length === 0) {
      return jsonResult({ answer: 'No relevant documents found.', sources: [] });
    }

    const sources = vectorResults.points.map((p) => ({
      id: p.id,
      title: (p.payload?.documentTitle as string) ?? '',
      url: (p.payload?.documentUrl as string) ?? '',
      snippet: ((p.payload?.content as string) ?? '').slice(0, 200),
    }));

    const context = sources
      .map((s, i) => `[Source ${i + 1}: ${s.title}]\n${s.snippet}`)
      .join('\n\n');

    const model = 'gemini-2.0-flash';
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: {
            parts: [
              {
                text: `You are a helpful AI assistant that answers based ONLY on the provided context. Cite sources as [Source N]. If the context is insufficient, say so.\n\nContext:\n${context}`,
              },
            ],
          },
          contents: [{ role: 'user', parts: [{ text: query }] }],
          generationConfig: { temperature: 0.3, maxOutputTokens: 1024 },
        }),
      }
    );

    if (!response.ok) {
      return errorResult(`Gemini API error: ${response.status}`);
    }
    const data = (await response.json()) as {
      candidates: Array<{ content: { parts: Array<{ text: string }> } }>;
    };
    const answer = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';

    return jsonResult({ answer, sources });
  } catch (err) {
    return errorResult(`rag_query failed: ${err instanceof Error ? err.message : String(err)}`);
  }
};

// ---------------------------------------------------------------------------
// Tool 4: multi_modal_analyze — image / document analysis via Gemini Vision
// ---------------------------------------------------------------------------
const multiModalTool: Tool = {
  name: 'multi_modal_analyze',
  description:
    'Analyze an image (base64) using Gemini Vision. Supports modes: describe | ocr | receipt | chart | code. Returns the analysis text plus confidence metadata.',
  inputSchema: objectSchema(
    {
      imageBase64: { type: 'string', description: 'Base64-encoded image data' },
      mimeType: { type: 'string', description: 'Image MIME type', default: 'image/png' },
      mode: {
        type: 'string',
        enum: ['describe', 'ocr', 'receipt', 'chart', 'code'],
        description: 'Analysis mode',
        default: 'describe',
      },
      prompt: { type: 'string', description: 'Optional user prompt/question about the image' },
    },
    ['imageBase64']
  ),
};

const multiModalHandler: ToolHandler = async (args, env) => {
  const imageBase64 = asString(args.imageBase64, 'imageBase64');
  if (!imageBase64) return errorResult('imageBase64 is required');
  const mimeType = (args.mimeType as string) ?? 'image/png';
  const mode = (args.mode as string) ?? 'describe';
  const prompt = (args.prompt as string) ?? '';

  const modePrompts: Record<string, string> = {
    describe: 'Describe this image in detail.',
    ocr: 'Extract all visible text from this image. Return only the text, preserving structure.',
    receipt: 'Extract receipt details: merchant, date, line items, totals. Return as JSON.',
    chart: 'Describe this chart: type, axes, data series, key trends.',
    code: 'Extract the code shown in this image. Return only the code, no commentary.',
  };

  const userPrompt = prompt || modePrompts[mode] || modePrompts.describe;

  try {
    const model = 'gemini-2.0-flash';
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [
            {
              role: 'user',
              parts: [
                { text: userPrompt },
                {
                  inline_data: { mime_type: mimeType, data: imageBase64 },
                },
              ],
            },
          ],
          generationConfig: { temperature: 0.2, maxOutputTokens: 1024 },
        }),
      }
    );

    if (!response.ok) {
      return errorResult(`Gemini Vision error: ${response.status}`);
    }
    const data = (await response.json()) as {
      candidates: Array<{ content: { parts: Array<{ text: string }> } }>;
    };
    const analysis = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    return jsonResult({ mode, analysis });
  } catch (err) {
    return errorResult(`multi_modal_analyze failed: ${err instanceof Error ? err.message : String(err)}`);
  }
};

// ---------------------------------------------------------------------------
// Tool 5: orchestrator_run — start a multi-agent workflow
// ---------------------------------------------------------------------------
const orchestratorTool: Tool = {
  name: 'orchestrator_run',
  description:
    'Kick off a multi-agent workflow (Planner → Designer → Coder → Reviewer). Returns a workflow_run_id that can be polled for progress and approval.',
  inputSchema: objectSchema(
    {
      request: {
        type: 'string',
        description: 'High-level request for the agent team (e.g. "Build a React todo app")',
      },
      requireApproval: {
        type: 'boolean',
        description: 'If true, workflow pauses between agents for human approval',
      default: false,
      },
    },
    ['request']
  ),
};

const orchestratorHandler: ToolHandler = async (args, env) => {
  const request = asString(args.request, 'request');
  if (!request) return errorResult('request is required');
  const requireApproval = Boolean(args.requireApproval);

  // The orchestrator has in-memory state for approvals; an MCP tool call
  // cannot reuse it across requests, so we delegate by calling the
  // orchestrator endpoint via fetch (same host).
  try {
    const url = `https://ai-chat-api.ai-chat-api.workers.dev/api/orchestrator/run`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ request, requireApproval }),
    });
    if (!res.ok) {
      return errorResult(`orchestrator endpoint returned ${res.status}`);
    }
    const data = await res.json();
    return jsonResult(data);
  } catch (err) {
    // Fallback: report that this tool needs the in-process orchestrator instance
    return textResult(
      `orchestrator_run via MCP is not a a stateless tool: it needs an in-memory orchestrator store. Use the /api/orchestrator endpoint directly. Error: ${err instanceof Error ? err.message : String(err)}`,
      true
    );
  }
};

// ---------------------------------------------------------------------------
// Tool 6: code_review_pr — analyze a PR diff (text input)
// ---------------------------------------------------------------------------
const codeReviewTool: Tool = {
  name: 'code_review_pr',
  description:
    'Review a code diff and return a list of issues with severity, line numbers, and suggestions. Accepts either a raw diff string or { repo, pr_number }. For repo+pr mode the bot fetches the diff via the GitHub API.',
  inputSchema: objectSchema(
    {
      diff: { type: 'string', description: 'Raw unified diff text' },
      repo: { type: 'string', description: 'GitHub repo (owner/name)' },
      prNumber: { type: 'number', description: 'PR number' },
    },
    []
  ),
};

const codeReviewHandler: ToolHandler = async (args, env) => {
  let diff = asString(args.diff, 'diff');
  const repo = asString(args.repo, 'repo');
  const prNumber = args.prNumber ? Number(args.prNumber) : null;

  if (!diff && (!repo || !prNumber)) {
    return errorResult('Provide either diff or (repo + prNumber)');
  }

  try {
    // Fetch diff via GitHub API if not provided directly
    if (!diff && repo && prNumber) {
      const ghRes = await fetch(
        `https://api.github.com/repos/${repo}/pulls/${prNumber}`,
        {
          headers: {
            Accept: 'application/vnd.github.v3.diff',
            ...(env.GITHUB_TOKEN ? { Authorization: `token ${env.GITHUB_TOKEN}` } : {}),
          },
        }
      );
      if (!ghRes.ok) {
        return errorResult(`GitHub API error: ${ghRes.status}`);
      }
      diff = await ghRes.text();
    }

    if (!diff) {
      return errorResult('Failed to obtain diff');
    }

    // Call our existing code-review agent via its route
    const url = `https://ai-chat-api.ai-chat-api.workers.dev/api/code-review/analyze`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ diff, repo: repo ?? 'unknown', prNumber: prNumber ?? 0 }),
    });
    if (!res.ok) {
      return errorResult(`code-review endpoint returned ${res.status}`);
    }
    const data = await res.json();
    return jsonResult(data);
  } catch (err) {
    return errorResult(`code_review_pr failed: ${err instanceof Error ? err.message : String(err)}`);
  }
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const REGISTRY: RegisteredTool[] = [
  { tool: searchQueryTool, handler: searchQueryHandler },
  { tool: hybridSearchTool, handler: hybridSearchHandler },
  { tool: ragQueryTool, handler: ragQueryHandler },
  { tool: multiModalTool, handler: multiModalHandler },
  { tool: orchestratorTool, handler: orchestratorHandler },
  { tool: codeReviewTool, handler: codeReviewHandler },
];

export function listTools(): Tool[] {
  return REGISTRY.map((r) => r.tool);
}

export function findTool(name: string): RegisteredTool | undefined {
  return REGISTRY.find((r) => r.tool.name === name);
}

export const MCP_PROTOCOL_VERSION = '2024-11-05';
export const MCP_SERVER_INFO = { name: 'ai-chat-mcp-server', version: '1.0.0' };

// Re-export common helpers so tests can exercise them
export const _internals = { tokenize };