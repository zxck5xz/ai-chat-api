import type { RewrittenQuery, ConversationTurn } from '../../types/search-engine';

const REWRITE_PROMPT = `You are a search query rewriter for conversational search. Given the user's current query and recent chat history, rewrite the query to be self-contained and optimized for semantic search.

Rules:
1. Resolve pronouns and references (it, that, this, they, the previous one, etc.)
2. Inject necessary context from chat history
3. Keep the rewritten query concise and focused
4. Preserve technical terms and specific nouns
5. If the query is already self-contained, return it unchanged

Return ONLY the rewritten query, no labels or formatting.`;

export class ConversationRewriter {
  private geminiApiKey: string;
  private model = 'gemini-2.0-flash';

  constructor(geminiApiKey: string) {
    this.geminiApiKey = geminiApiKey;
  }

  async rewrite(
    currentQuery: string,
    chatHistory: ConversationTurn[] = []
  ): Promise<RewrittenQuery> {
    // No history = no rewrite needed
    if (chatHistory.length === 0) {
      return {
        originalQuery: currentQuery,
        rewrittenQuery: currentQuery,
        contextInjected: false,
        pronounsResolved: [],
        chatHistoryUsed: 0,
      };
    }

    // Check if rewrite is needed (has pronouns or references)
    const needsRewrite = this.needsRewrite(currentQuery, chatHistory);

    if (!needsRewrite) {
      return {
        originalQuery: currentQuery,
        rewrittenQuery: currentQuery,
        contextInjected: false,
        pronounsResolved: [],
        chatHistoryUsed: 0,
      };
    }

    try {
      const historyContext = chatHistory
        .slice(-6)
        .map((turn) => `${turn.role}: ${turn.content}`)
        .join('\n');

      const prompt = `${REWRITE_PROMPT}\n\nChat history:\n${historyContext}\n\nCurrent query: "${currentQuery}"`;

      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.geminiApiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
              maxOutputTokens: 256,
              temperature: 0.1,
            },
          }),
        }
      );

      if (!response.ok) {
        return {
          originalQuery: currentQuery,
          rewrittenQuery: currentQuery,
          contextInjected: false,
          pronounsResolved: [],
          chatHistoryUsed: 0,
        };
      }

      const data = await response.json() as {
        candidates: Array<{ content: { parts: Array<{ text: string }> } }>;
      };

      const rewritten = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
      const pronounsResolved = this.detectPronouns(currentQuery, rewritten || currentQuery);

      return {
        originalQuery: currentQuery,
        rewrittenQuery: rewritten || currentQuery,
        contextInjected: rewritten !== currentQuery,
        pronounsResolved,
        chatHistoryUsed: Math.min(chatHistory.length, 6),
      };
    } catch {
      return {
        originalQuery: currentQuery,
        rewrittenQuery: currentQuery,
        contextInjected: false,
        pronounsResolved: [],
        chatHistoryUsed: 0,
      };
    }
  }

  private needsRewrite(query: string, history: ConversationTurn[]): boolean {
    const lower = query.toLowerCase();

    // Pronouns and references
    if (/\b(it|that|this|they|them|their|theirs|those|these|him|her|his|hers)\b/i.test(lower)) {
      return true;
    }

    // Reference phrases
    if (/\b(the previous|the one above|the first|the second|the last|as mentioned|like before|similar to)\b/i.test(lower)) {
      return true;
    }

    // Very short queries with history
    if (query.split(/\s+/).length <= 3 && history.length > 0) {
      return true;
    }

    return false;
  }

  private detectPronouns(original: string, rewritten: string): string[] {
    const pronouns = /\b(it|that|this|they|them|their|those|these|him|her|his)\b/gi;
    const found: string[] = [];
    let match;

    while ((match = pronouns.exec(original)) !== null) {
      found.push(match[1]);
    }

    return [...new Set(found)];
  }
}
