/**
 * Confidence Evaluator
 * Evaluates whether a generated answer is reliable enough.
 * Detects hallucinations, measures citation coverage, finds contradictions.
 *
 * Part of Project 15: Agentic RAG with Self-Correction
 */

import type { ConfidenceEvaluation } from '../../types/agentic-rag';

const EVALUATE_PROMPT = `You are a faithfulness evaluator for a RAG system. Given a user query, retrieved source documents, and a generated answer, evaluate the answer's reliability.

Check for:
1. **Hallucination**: Are there claims in the answer NOT supported by the retrieved documents?
2. **Citation coverage**: What percentage of claims in the answer cite or reference specific source documents?
3. **Contradictions**: Does the answer contradict any of the source documents?
4. **Completeness**: Does the answer address all parts of the user's query?

Return JSON:
{
  "score": 0.85,
  "reasoning": "...",
  "hasHallucination": false,
  "citationCoverage": 0.7,
  "contradictionsFound": 0,
  "unsupportedClaims": ["claim1", "claim2"],
  "missingAspects": ["aspect1"]
}`;

export class ConfidenceEvaluator {
  private geminiApiKey: string;
  private model = 'gemini-2.0-flash';
  private confidenceThreshold: number;

  constructor(geminiApiKey: string, confidenceThreshold: number = 0.7) {
    this.geminiApiKey = geminiApiKey;
    this.confidenceThreshold = confidenceThreshold;
  }

  /**
   * Evaluate answer confidence against source documents
   */
  async evaluate(
    query: string,
    answer: string,
    sources: Array<{ content: string; documentTitle: string; score: number }>
  ): Promise<ConfidenceEvaluation> {
    if (sources.length === 0) {
      return {
        score: 0.3,
        reasoning: 'No source documents provided — cannot verify answer',
        hasHallucination: true,
        citationCoverage: 0,
        contradictionsFound: 0,
        needsRegeneration: true,
        needsMoreRetrieval: true,
      };
    }

    try {
      const sourceText = sources
        .map((s, i) => `[Source ${i + 1}] (${s.documentTitle}, score: ${s.score.toFixed(2)})\n${s.content}`)
        .join('\n\n');

      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.geminiApiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [
              {
                parts: [
                  {
                    text: `${EVALUATE_PROMPT}\n\n--- User Query ---\n${query}\n\n--- Retrieved Sources ---\n${sourceText}\n\n--- Generated Answer ---\n${answer}`,
                  },
                ],
              },
            ],
            generationConfig: {
              maxOutputTokens: 512,
              temperature: 0.1,
              responseMimeType: 'application/json',
            },
          }),
        }
      );

      if (!response.ok) {
        return this.heuristicEvaluate(query, answer, sources);
      }

      const data = await response.json() as {
        candidates: Array<{ content: { parts: Array<{ text: string }> } }>;
      };

      const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
      const parsed = JSON.parse(text);

      const score = clamp(parsed.score ?? 0.5, 0, 1);
      const hasHallucination = parsed.hasHallucination ?? score < 0.5;
      const citationCoverage = clamp(parsed.citationCoverage ?? 0, 0, 1);
      const contradictionsFound = parsed.contradictionsFound ?? 0;

      return {
        score,
        reasoning: parsed.reasoning || 'LLM evaluation',
        hasHallucination,
        citationCoverage,
        contradictionsFound,
        needsRegeneration: hasHallucination || contradictionsFound > 0,
        needsMoreRetrieval: score < this.confidenceThreshold && !hasHallucination,
      };
    } catch {
      return this.heuristicEvaluate(query, answer, sources);
    }
  }

  /**
   * Heuristic fallback when LLM is unavailable
   */
  private heuristicEvaluate(
    query: string,
    answer: string,
    sources: Array<{ content: string; score: number }>
  ): ConfidenceEvaluation {
    const queryTokens = new Set(tokenize(query));
    const answerTokens = new Set(tokenize(answer));

    // Check if answer tokens overlap with source tokens
    const sourceText = sources.map((s) => s.content).join(' ');
    const sourceTokens = new Set(tokenize(sourceText));

    let sourceOverlap = 0;
    for (const t of answerTokens) {
      if (sourceTokens.has(t)) sourceOverlap++;
    }
    const citationCoverage = answerTokens.size > 0 ? sourceOverlap / answerTokens.size : 0;

    // Check if answer overlaps with query intent
    let queryOverlap = 0;
    for (const t of queryTokens) {
      if (answerTokens.has(t)) queryOverlap++;
    }
    const queryCoverage = queryTokens.size > 0 ? queryOverlap / queryTokens.size : 0;

    // Average source relevance
    const avgRelevance = sources.reduce((sum, s) => sum + s.score, 0) / sources.length;

    const score = clamp(
      citationCoverage * 0.4 + queryCoverage * 0.3 + avgRelevance * 0.3,
      0,
      1
    );

    return {
      score,
      reasoning: `Heuristic evaluation: citationCoverage=${citationCoverage.toFixed(2)}, queryCoverage=${queryCoverage.toFixed(2)}, avgRelevance=${avgRelevance.toFixed(2)}`,
      hasHallucination: citationCoverage < 0.3,
      citationCoverage,
      contradictionsFound: 0,
      needsRegeneration: score < 0.4,
      needsMoreRetrieval: score < this.confidenceThreshold && citationCoverage >= 0.3,
    };
  }

  getThreshold(): number {
    return this.confidenceThreshold;
  }
}

// --- Helpers ---

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function tokenize(text: string): string[] {
  const stopwords = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for',
    'on', 'with', 'at', 'by', 'from', 'as', 'and', 'or', 'but', 'if',
    'this', 'that', 'it', 'its', 'not', 'no', 'nor',
  ]);

  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stopwords.has(w));
}
