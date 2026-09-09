/**
 * Query Analyzer Service
 * Determines if retrieval is needed and classifies query for optimal RAG strategy.
 *
 * Part of Project 15: Agentic RAG with Self-Correction
 */

import type {
  QueryAnalysis,
  RetrievalDecision,
  QueryIntent,
  RetrievalStrategy,
} from '../../types/agentic-rag';

const ANALYSIS_PROMPT = `You are a query analysis engine for a Retrieval-Augmented Generation system. Analyze the user's query and determine:

1. **needsRetrieval**: Does this query need external knowledge retrieval?
   - "skip": The answer is self-contained (chitchat, math, code generation, personal opinion, creative writing, definitions the model already knows)
   - "retrieve": The answer requires up-to-date, domain-specific, or document-grounded information
   - "ambiguous": Hard to tell — lean toward retrieval if there's any chance external info helps

2. **intent**: What type of query is this?
   - "factual": Asking for a specific fact, number, date, definition
   - "analytical": Asking for analysis, explanation of how/why
   - "comparative": Comparing two or more things
   - "exploratory": Open-ended exploration of a topic
   - "creative": Writing, brainstorming, ideation
   - "chitchat": Casual conversation, greetings, opinions
   - "code": Programming questions, debugging, code generation
   - "math": Mathematical calculations, proofs

3. **complexity**: Rate 0-1 how complex the reasoning required is

4. **subQuestions**: If the query can be decomposed into sub-questions, list them

5. **retrievalStrategy**: Best retrieval approach
   - "single": One round of retrieval is sufficient
   - "multi_round": May need multiple retrieval rounds (complex analysis)
   - "decompose": Should be broken into sub-queries, each retrieved separately
   - "step_back": Need to step back and retrieve broader context first

6. **suggestedTopK**: How many chunks to retrieve (3-15)

7. **maxRetrievalRounds**: Maximum retrieval iterations (1-5)

8. **keywords**: Key search terms

9. **entities**: Named entities (people, products, concepts)

Return JSON:
{
  "needsRetrieval": "skip|retrieve|ambiguous",
  "decisionConfidence": 0.95,
  "decisionReasoning": "...",
  "intent": "factual|analytical|comparative|exploratory|creative|chitchat|code|math",
  "complexity": 0.7,
  "subQuestions": ["..."],
  "retrievalStrategy": "single|multi_round|decompose|step_back",
  "suggestedTopK": 8,
  "maxRetrievalRounds": 3,
  "keywords": ["..."],
  "entities": ["..."]
}`;

// Patterns that strongly suggest NO retrieval needed
const SKIP_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /^(hi|hello|hey|thanks|thank you|bye|goodbye|ok|sure|yes|no)\s*[!.?]*$/i, reason: 'Greeting or acknowledgment' },
  { pattern: /^(what is \d+ [\+\-\*\/] \d+)/i, reason: 'Math calculation' },
  { pattern: /^(write|generate|create)\s+(a\s+)?(function|class|component|script|program)/i, reason: 'Code generation' },
  { pattern: /^(define|explain)\s+(react|vue|angular|javascript|typescript|python|html|css)\b/i, reason: 'Well-known concept definition' },
  { pattern: /^(how do you|what do you think|your opinion)/i, reason: 'Opinion or chat' },
  { pattern: /^(tell me a joke|make me laugh|say something funny)/i, reason: 'Creative/chitchat' },
  { pattern: /^(translate|convert)\s+/i, reason: 'Translation/conversion (no retrieval needed)' },
];

// Patterns that strongly suggest retrieval IS needed
const RETRIEVE_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\b(latest|recent|current|today|this week|this month|this year|2024|2025|2026)\b/i, reason: 'Time-sensitive query' },
  { pattern: /\b(price|cost|how much|stock|market|revenue|earning)/i, reason: 'Financial/live data' },
  { pattern: /\b(bug|error|issue|problem|crash|failing)\b.*\b(in|with|on|using)\b/i, reason: 'Specific technical issue' },
  { pattern: /\b(compare|vs|versus|difference between|better than)\b/i, reason: 'Comparison requiring current info' },
  { pattern: /\b(documentation|docs|api reference|manual|guide)\b/i, reason: 'Documentation lookup' },
  { pattern: /\b(my|our|the)\s+(document|file|code|project|repo|dataset)/i, reason: 'User-specific content reference' },
];

// Intent-specific keyword signals
const INTENT_KEYWORDS: Record<QueryIntent, string[]> = {
  factual: ['what', 'when', 'where', 'who', 'which', 'how many', 'how much', 'define', 'meaning'],
  analytical: ['why', 'how does', 'explain', 'analyze', 'reason', 'cause', 'mechanism', 'process'],
  comparative: ['compare', 'vs', 'versus', 'difference', 'better', 'worse', 'pros', 'cons', 'alternative'],
  exploratory: ['tell me about', 'overview', 'summary', 'landscape', 'trends', 'approaches', 'options'],
  creative: ['write', 'create', 'generate', 'brainstorm', 'idea', 'design', 'draft', 'compose'],
  chitchat: ['hi', 'hello', 'hey', 'how are you', 'what\'s up', 'thanks', 'bye'],
  code: ['code', 'function', 'class', 'implement', 'debug', 'fix', 'error', 'bug', 'api', 'endpoint', 'react', 'typescript', 'python'],
  math: ['calculate', 'solve', 'equation', 'formula', 'proof', 'integral', 'derivative', 'matrix'],
};

export class QueryAnalyzer {
  private geminiApiKey: string;
  private model = 'gemini-2.0-flash';

  constructor(geminiApiKey: string) {
    this.geminiApiKey = geminiApiKey;
  }

  /**
   * Full query analysis: decide retrieval, classify intent, plan strategy
   */
  async analyze(query: string): Promise<QueryAnalysis> {
    // Fast path: rule-based for obvious cases
    const ruleBased = this.ruleBasedAnalyze(query);
    if (ruleBased && ruleBased.decisionConfidence > 0.9) {
      return ruleBased;
    }

    // LLM-based analysis
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.geminiApiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: `${ANALYSIS_PROMPT}\n\nQuery: "${query}"` }] }],
            generationConfig: {
              maxOutputTokens: 512,
              temperature: 0.1,
              responseMimeType: 'application/json',
            },
          }),
        }
      );

      if (!response.ok) {
        return ruleBased || this.defaultAnalysis(query);
      }

      const data = await response.json() as {
        candidates: Array<{ content: { parts: Array<{ text: string }> } }>;
      };

      const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
      const parsed = JSON.parse(text);

      return {
        originalQuery: query,
        needsRetrieval: this.validateDecision(parsed.needsRetrieval),
        decisionConfidence: clamp(parsed.decisionConfidence ?? 0.7, 0, 1),
        decisionReasoning: parsed.decisionReasoning || 'LLM analysis',
        intent: this.validateIntent(parsed.intent),
        complexity: clamp(parsed.complexity ?? 0.5, 0, 1),
        subQuestions: Array.isArray(parsed.subQuestions) ? parsed.subQuestions : [],
        retrievalStrategy: this.validateStrategy(parsed.retrievalStrategy),
        suggestedTopK: clamp(parsed.suggestedTopK ?? 8, 3, 15),
        maxRetrievalRounds: clamp(parsed.maxRetrievalRounds ?? 3, 1, 5),
        keywords: Array.isArray(parsed.keywords) ? parsed.keywords : [],
        entities: Array.isArray(parsed.entities) ? parsed.entities : [],
      };
    } catch {
      return ruleBased || this.defaultAnalysis(query);
    }
  }

  /**
   * Rule-based fast path for obvious queries
   */
  private ruleBasedAnalyze(query: string): QueryAnalysis | null {
    const lower = query.toLowerCase().trim();

    // Check SKIP patterns
    for (const { pattern, reason } of SKIP_PATTERNS) {
      if (pattern.test(lower)) {
        return {
          originalQuery: query,
          needsRetrieval: 'skip',
          decisionConfidence: 0.92,
          decisionReasoning: reason,
          intent: this.guessIntentFromQuery(lower),
          complexity: 0.1,
          subQuestions: [],
          retrievalStrategy: 'single',
          suggestedTopK: 0,
          maxRetrievalRounds: 0,
          keywords: extractKeywords(query),
          entities: [],
        };
      }
    }

    // Check RETRIEVE patterns
    for (const { pattern, reason } of RETRIEVE_PATTERNS) {
      if (pattern.test(lower)) {
        const isComplex = /\b(compare|vs|versus|trade-?offs?|pros?\s*(and|&)\s*cons?)\b/.test(lower);
        return {
          originalQuery: query,
          needsRetrieval: 'retrieve',
          decisionConfidence: 0.88,
          decisionReasoning: reason,
          intent: this.guessIntentFromQuery(lower),
          complexity: isComplex ? 0.7 : 0.4,
          subQuestions: [],
          retrievalStrategy: isComplex ? 'decompose' : 'single',
          suggestedTopK: isComplex ? 12 : 8,
          maxRetrievalRounds: isComplex ? 3 : 1,
          keywords: extractKeywords(query),
          entities: [],
        };
      }
    }

    return null;
  }

  /**
   * Guess intent from query keywords without LLM
   */
  private guessIntentFromQuery(lower: string): QueryIntent {
    for (const [intent, keywords] of Object.entries(INTENT_KEYWORDS)) {
      for (const kw of keywords) {
        if (lower.includes(kw)) {
          return intent as QueryIntent;
        }
      }
    }
    return 'factual';
  }

  /**
   * Default analysis when both rule-based and LLM fail
   */
  private defaultAnalysis(query: string): QueryAnalysis {
    const words = query.split(/\s+/);
    const isLong = words.length > 8;
    return {
      originalQuery: query,
      needsRetrieval: isLong ? 'retrieve' : 'ambiguous',
      decisionConfidence: 0.5,
      decisionReasoning: 'Default analysis — insufficient signal',
      intent: 'factual',
      complexity: isLong ? 0.6 : 0.3,
      subQuestions: [],
      retrievalStrategy: 'single',
      suggestedTopK: 8,
      maxRetrievalRounds: 2,
      keywords: extractKeywords(query),
      entities: [],
    };
  }

  private validateDecision(value: string): RetrievalDecision {
    if (['skip', 'retrieve', 'ambiguous'].includes(value)) return value as RetrievalDecision;
    return 'ambiguous';
  }

  private validateIntent(value: string): QueryIntent {
    if (['factual', 'analytical', 'comparative', 'exploratory', 'creative', 'chitchat', 'code', 'math'].includes(value)) {
      return value as QueryIntent;
    }
    return 'factual';
  }

  private validateStrategy(value: string): RetrievalStrategy {
    if (['single', 'multi_round', 'decompose', 'step_back'].includes(value)) {
      return value as RetrievalStrategy;
    }
    return 'single';
  }
}

// --- Helpers ---

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function extractKeywords(query: string): string[] {
  const stopwords = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for',
    'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during',
    'before', 'after', 'above', 'below', 'between', 'out', 'off', 'over',
    'under', 'again', 'further', 'then', 'once', 'here', 'there', 'when',
    'where', 'why', 'how', 'all', 'each', 'every', 'both', 'few', 'more',
    'most', 'other', 'some', 'such', 'no', 'nor', 'not', 'only', 'own',
    'same', 'so', 'than', 'too', 'very', 'just', 'and', 'or', 'but', 'if',
    'this', 'that', 'these', 'those', 'i', 'me', 'my', 'we', 'our', 'you',
    'your', 'he', 'him', 'his', 'she', 'her', 'it', 'its', 'they', 'them',
    'what', 'which', 'who', 'whom', 'about',
  ]);

  return query
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stopwords.has(w))
    .slice(0, 15);
}
