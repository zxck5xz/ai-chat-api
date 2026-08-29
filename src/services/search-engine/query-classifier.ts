import type { ClassifiedQuery, QueryComplexity } from '../../types/search-engine';

const CLASSIFICATION_PROMPT = `You are a search query classifier. Analyze the user's query and classify its complexity.

Classification rules:
- SIMPLE: Direct entity lookup, keyword search, specific fact request. Examples: "What is React?", "Python docs", "error code 404"
- MODERATE: Single-hop question requiring context understanding. Examples: "How to deploy Next.js to Vercel?", "Best practices for TypeScript"
- COMPLEX: Multi-hop reasoning, comparisons, or multi-part questions. Examples: "Compare React vs Vue vs Angular for enterprise", "What are the trade-offs between X and Y, and when should I use each?"
- AMBIGUOUS: Vague, unclear intent, or multiple possible interpretations. Examples: "stuff about AI", "help me", "that thing"

Extract:
1. Keywords (search terms)
2. Entities (proper nouns, technical terms)
3. Complexity level
4. Confidence (0-1)
5. Brief reasoning

Return JSON:
{
  "complexity": "simple|moderate|complex|ambiguous",
  "confidence": 0.95,
  "reasoning": "...",
  "keywords": ["..."],
  "entities": ["..."]
}`;

export class QueryClassifier {
  private geminiApiKey: string;
  private model = 'gemini-2.0-flash';

  constructor(geminiApiKey: string) {
    this.geminiApiKey = geminiApiKey;
  }

  async classify(query: string): Promise<ClassifiedQuery> {
    // Fast path: rule-based classification for obvious cases
    const ruleBased = this.ruleBasedClassify(query);
    if (ruleBased && ruleBased.confidence > 0.9) {
      return ruleBased;
    }

    // LLM-based classification
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.geminiApiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: `${CLASSIFICATION_PROMPT}\n\nQuery: "${query}"` }] }],
            generationConfig: {
              maxOutputTokens: 256,
              temperature: 0.1,
              responseMimeType: 'application/json',
            },
          }),
        }
      );

      if (!response.ok) {
        return ruleBased || this.defaultClassification(query);
      }

      const data = await response.json() as {
        candidates: Array<{ content: { parts: Array<{ text: string }> } }>;
      };

      const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
      const parsed = JSON.parse(text);

      return {
        originalQuery: query,
        complexity: this.validateComplexity(parsed.complexity),
        confidence: Math.min(1, Math.max(0, parsed.confidence || 0.5)),
        reasoning: parsed.reasoning || 'LLM classification',
        keywords: parsed.keywords || [],
        entities: parsed.entities || [],
      };
    } catch {
      return ruleBased || this.defaultClassification(query);
    }
  }

  private ruleBasedClassify(query: string): ClassifiedQuery | null {
    const lower = query.toLowerCase().trim();
    const words = lower.split(/\s+/);

    // SIMPLE patterns
    if (
      words.length <= 3 ||
      /^(what is|how to|define|explain|docs?|api|error|bug|fix|install|setup|config)/.test(lower) ||
      /^[a-z]+\s+(api|docs?|tutorial|example|error|bug)/.test(lower)
    ) {
      return {
        originalQuery: query,
        complexity: 'simple',
        confidence: 0.85,
        reasoning: 'Short query with direct intent',
        keywords: words.filter((w) => w.length > 2),
        entities: [],
      };
    }

    // AMBIGUOUS patterns
    if (
      words.length <= 2 ||
      /^(stuff|things?|help|info|about|something|anything)/.test(lower) ||
      /\?$/.test(lower) && words.length <= 4
    ) {
      return {
        originalQuery: query,
        complexity: 'ambiguous',
        confidence: 0.7,
        reasoning: 'Vague or very short query',
        keywords: words.filter((w) => w.length > 2),
        entities: [],
      };
    }

    // COMPLEX patterns
    if (
      /\b(compare|vs|versus|difference|trade-?offs?|pros?\s*(and|&)\s*cons?|when\s+to\s+use|which\s+should)\b/.test(lower) ||
      /\b(and|or|also|additionally|furthermore|moreover)\b/.test(lower) && words.length > 8
    ) {
      return {
        originalQuery: query,
        complexity: 'complex',
        confidence: 0.8,
        reasoning: 'Multi-part or comparison query',
        keywords: words.filter((w) => w.length > 2),
        entities: [],
      };
    }

    return null;
  }

  private validateComplexity(value: string): QueryComplexity {
    if (['simple', 'moderate', 'complex', 'ambiguous'].includes(value)) {
      return value as QueryComplexity;
    }
    return 'moderate';
  }

  private defaultClassification(query: string): ClassifiedQuery {
    const words = query.split(/\s+/);
    return {
      originalQuery: query,
      complexity: words.length > 6 ? 'moderate' : 'simple',
      confidence: 0.5,
      reasoning: 'Default classification',
      keywords: words.filter((w) => w.length > 2),
      entities: [],
    };
  }
}
