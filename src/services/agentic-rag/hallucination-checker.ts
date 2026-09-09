/**
 * Hallucination Checker
 * Verifies generated claims against source documents with citation mapping.
 * Detects unsupported claims, checks citation accuracy, and maps claims to sources.
 *
 * Part of Project 15: Agentic RAG with Self-Correction
 */

const CHECK_PROMPT = `You are a hallucination detection system for a RAG pipeline. Given a user query, retrieved source documents, and a generated answer, perform thorough verification.

For EACH claim in the answer:
1. Identify the claim text
2. Determine if it is supported by the sources (SUPPORTED, UNSUPPORTED, or CONTRADICTED)
3. Map it to the specific source(s) that support or contradict it
4. If SUPPORTED, quote the exact passage from the source

Also check:
- Citation accuracy: Are [Source N] references pointing to correct sources?
- Factual consistency: Do different parts of the answer contradict each other?
- Completeness: Are there aspects of the query not addressed?

Return JSON:
{
  "claims": [
    {
      "text": "claim text from answer",
      "verdict": "SUPPORTED|UNSUPPORTED|CONTRADICTED",
      "sourceIndex": [1],
      "sourceQuote": "exact quote from source",
      "confidence": 0.95
    }
  ],
  "overallScore": 0.85,
  "unsupportedCount": 1,
  "contradictedCount": 0,
  "citationAccuracy": 0.9,
  "hallucinationDetected": false,
  "summary": "Brief explanation of findings"
}`;

export interface ClaimVerification {
  text: string;
  verdict: 'SUPPORTED' | 'UNSUPPORTED' | 'CONTRADICTED';
  sourceIndex: number[];
  sourceQuote: string;
  confidence: number;
}

export interface HallucinationCheckResult {
  claims: ClaimVerification[];
  overallScore: number;
  unsupportedCount: number;
  contradictedCount: number;
  citationAccuracy: number;
  hallucinationDetected: boolean;
  summary: string;
}

export class HallucinationChecker {
  private geminiApiKey: string;
  private model = 'gemini-2.0-flash';

  constructor(geminiApiKey: string) {
    this.geminiApiKey = geminiApiKey;
  }

  /**
   * Check a generated answer for hallucinations against source documents
   */
  async check(
    query: string,
    answer: string,
    sources: Array<{ content: string; documentTitle: string; score: number }>
  ): Promise<HallucinationCheckResult> {
    if (sources.length === 0) {
      return {
        claims: [],
        overallScore: 0,
        unsupportedCount: 0,
        contradictedCount: 0,
        citationAccuracy: 0,
        hallucinationDetected: true,
        summary: 'No sources provided — cannot verify claims',
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
                    text: `${CHECK_PROMPT}\n\n--- User Query ---\n${query}\n\n--- Retrieved Sources ---\n${sourceText}\n\n--- Generated Answer ---\n${answer}`,
                  },
                ],
              },
            ],
            generationConfig: {
              maxOutputTokens: 2048,
              temperature: 0.1,
              responseMimeType: 'application/json',
            },
          }),
        }
      );

      if (!response.ok) {
        return this.heuristicCheck(answer, sources);
      }

      const data = await response.json() as {
        candidates: Array<{ content: { parts: Array<{ text: string }> } }>;
      };

      const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
      const parsed = JSON.parse(text);

      const claims: ClaimVerification[] = Array.isArray(parsed.claims)
        ? parsed.claims.map((c: Record<string, unknown>) => ({
            text: String(c.text || ''),
            verdict: this.validateVerdict(String(c.verdict || '')),
            sourceIndex: Array.isArray(c.sourceIndex) ? c.sourceIndex : [],
            sourceQuote: String(c.sourceQuote || ''),
            confidence: clamp(Number(c.confidence) || 0.5, 0, 1),
          }))
        : [];

      const unsupportedCount = claims.filter((c) => c.verdict === 'UNSUPPORTED').length;
      const contradictedCount = claims.filter((c) => c.verdict === 'CONTRADICTED').length;

      return {
        claims,
        overallScore: clamp(Number(parsed.overallScore) || 0.5, 0, 1),
        unsupportedCount,
        contradictedCount,
        citationAccuracy: clamp(Number(parsed.citationAccuracy) || 0, 0, 1),
        hallucinationDetected: Boolean(parsed.hallucinationDetected) || unsupportedCount > 0 || contradictedCount > 0,
        summary: String(parsed.summary || 'Check completed'),
      };
    } catch {
      return this.heuristicCheck(answer, sources);
    }
  }

  /**
   * Heuristic fallback: token-overlap based claim verification
   */
  private heuristicCheck(
    answer: string,
    sources: Array<{ content: string; score: number }>
  ): HallucinationCheckResult {
    const sentences = splitSentences(answer);
    const sourceText = sources.map((s) => s.content).join(' ');
    const sourceTokens = new Set(tokenize(sourceText));

    const claims: ClaimVerification[] = sentences.map((sentence) => {
      const tokens = new Set(tokenize(sentence));
      let overlap = 0;
      for (const t of tokens) {
        if (sourceTokens.has(t)) overlap++;
      }
      const coverage = tokens.size > 0 ? overlap / tokens.size : 0;

      return {
        text: sentence,
        verdict: coverage > 0.4 ? 'SUPPORTED' : 'UNSUPPORTED',
        sourceIndex: [],
        sourceQuote: '',
        confidence: clamp(coverage, 0, 1),
      };
    });

    const unsupportedCount = claims.filter((c) => c.verdict === 'UNSUPPORTED').length;
    const contradictedCount = 0;
    const supportedCount = claims.filter((c) => c.verdict === 'SUPPORTED').length;
    const overallScore = claims.length > 0 ? supportedCount / claims.length : 0;

    return {
      claims,
      overallScore,
      unsupportedCount,
      contradictedCount,
      citationAccuracy: overallScore,
      hallucinationDetected: unsupportedCount > 0,
      summary: `Heuristic check: ${supportedCount}/${claims.length} claims supported by source overlap`,
    };
  }

  private validateVerdict(value: string): 'SUPPORTED' | 'UNSUPPORTED' | 'CONTRADICTED' {
    if (['SUPPORTED', 'UNSUPPORTED', 'CONTRADICTED'].includes(value)) {
      return value as 'SUPPORTED' | 'UNSUPPORTED' | 'CONTRADICTED';
    }
    return 'UNSUPPORTED';
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

function splitSentences(text: string): string[] {
  return text
    .split(/[.!?]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 10);
}
