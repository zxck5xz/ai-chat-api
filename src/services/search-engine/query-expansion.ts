import type { ExpandedQuery } from '../../types/search-engine';

const HYDE_PROMPT = `You are a search query expander. Given a user query, generate a hypothetical document that would perfectly answer this query.

Write a short, factual paragraph (3-5 sentences) that directly answers the query as if it were from a knowledge base. Use specific terms and technical language.

Return ONLY the hypothetical document text, no labels or formatting.`;

const MULTI_QUERY_PROMPT = `You are a search query reformulator. Given a user query, generate 3-5 different search queries that capture the same intent using different vocabulary and phrasing.

Each query should:
1. Use different synonyms or related terms
2. Be a complete, natural search query
3. Target the same information need

Return ONLY the queries, one per line, no numbering or labels.`;

const DECOMPOSITION_PROMPT = `You are a query decomposer. Given a complex user query, break it down into 2-4 simpler sub-questions that can each be answered independently.

Each sub-question should:
1. Be a complete, standalone question
2. Target one specific aspect of the original query
3. Be simpler and more focused

Return ONLY the sub-questions, one per line, no numbering or labels.`;

const STEP_BACK_PROMPT = `You are a query abstraction engine. Given a specific user query, generate a broader, more general query that captures the underlying concept.

The step-back query should:
1. Be more abstract than the original
2. Capture the general category or concept
3. Help retrieve foundational context

Return ONLY the step-back query, no labels or formatting.`;

export class QueryExpansion {
  private geminiApiKey: string;
  private model = 'gemini-2.0-flash';

  constructor(geminiApiKey: string) {
    this.geminiApiKey = geminiApiKey;
  }

  async expand(
    query: string,
    strategy: 'hyde' | 'multi_query' | 'decomposition' | 'step_back' | 'auto' = 'auto'
  ): Promise<ExpandedQuery> {
    const startTime = Date.now();

    if (strategy === 'auto') {
      strategy = this.selectStrategy(query);
    }

    switch (strategy) {
      case 'hyde':
        return this.hyde(query, startTime);
      case 'multi_query':
        return this.multiQuery(query, startTime);
      case 'decomposition':
        return this.decomposition(query, startTime);
      case 'step_back':
        return this.stepBack(query, startTime);
      default:
        return {
          originalQuery: query,
          strategy: 'multi_query',
          expandedQueries: [query],
          latencyMs: Date.now() - startTime,
        };
    }
  }

  private selectStrategy(query: string): 'hyde' | 'multi_query' | 'decomposition' | 'step_back' {
    const lower = query.toLowerCase();
    const words = query.split(/\s+/);

    // Complex: multi-hop, comparison
    if (
      /\b(compare|vs|versus|difference|trade-?offs?|pros?\s*(and|&)\s*cons?|when\s+to\s+use)\b/.test(lower) ||
      (words.length > 8 && /\b(and|or|also|additionally)\b/.test(lower))
    ) {
      return 'decomposition';
    }

    // Ambiguous: very short, vague
    if (words.length <= 3 || /^(stuff|things?|help|info|about|something)/.test(lower)) {
      return 'multi_query';
    }

    // Sparse/factual: good for HyDE
    if (
      words.length <= 6 ||
      /^(what|how|when|where|why|who)\s/.test(lower) ||
      /\?$/.test(lower)
    ) {
      return 'hyde';
    }

    // Default: multi-query for most cases
    return 'multi_query';
  }

  private async hyde(query: string, startTime: number): Promise<ExpandedQuery> {
    try {
      const response = await this.callLLM(HYDE_PROMPT, query);
      const hydeDoc = response.trim();

      return {
        originalQuery: query,
        strategy: 'hyde',
        expandedQueries: [query, hydeDoc],
        hydeDocument: hydeDoc,
        latencyMs: Date.now() - startTime,
      };
    } catch {
      return {
        originalQuery: query,
        strategy: 'hyde',
        expandedQueries: [query],
        latencyMs: Date.now() - startTime,
      };
    }
  }

  private async multiQuery(query: string, startTime: number): Promise<ExpandedQuery> {
    try {
      const response = await this.callLLM(MULTI_QUERY_PROMPT, query);
      const queries = response
        .split('\n')
        .map((q) => q.trim())
        .filter((q) => q.length > 0 && q !== query);

      return {
        originalQuery: query,
        strategy: 'multi_query',
        expandedQueries: [query, ...queries.slice(0, 4)],
        latencyMs: Date.now() - startTime,
      };
    } catch {
      return {
        originalQuery: query,
        strategy: 'multi_query',
        expandedQueries: [query],
        latencyMs: Date.now() - startTime,
      };
    }
  }

  private async decomposition(query: string, startTime: number): Promise<ExpandedQuery> {
    try {
      const response = await this.callLLM(DECOMPOSITION_PROMPT, query);
      const subQuestions = response
        .split('\n')
        .map((q) => q.trim())
        .filter((q) => q.length > 0);

      return {
        originalQuery: query,
        strategy: 'decomposition',
        expandedQueries: [query, ...subQuestions],
        subQuestions,
        latencyMs: Date.now() - startTime,
      };
    } catch {
      return {
        originalQuery: query,
        strategy: 'decomposition',
        expandedQueries: [query],
        latencyMs: Date.now() - startTime,
      };
    }
  }

  private async stepBack(query: string, startTime: number): Promise<ExpandedQuery> {
    try {
      const response = await this.callLLM(STEP_BACK_PROMPT, query);
      const stepBackQuery = response.trim();

      return {
        originalQuery: query,
        strategy: 'step_back',
        expandedQueries: [query, stepBackQuery],
        latencyMs: Date.now() - startTime,
      };
    } catch {
      return {
        originalQuery: query,
        strategy: 'step_back',
        expandedQueries: [query],
        latencyMs: Date.now() - startTime,
      };
    }
  }

  private async callLLM(systemPrompt: string, query: string): Promise<string> {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.geminiApiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: `${systemPrompt}\n\nUser query: "${query}"` }] }],
          generationConfig: {
            maxOutputTokens: 512,
            temperature: 0.3,
          },
        }),
      }
    );

    if (!response.ok) {
      throw new Error(`Gemini API error: ${response.status}`);
    }

    const data = await response.json() as {
      candidates: Array<{ content: { parts: Array<{ text: string }> } }>;
    };

    return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  }
}
