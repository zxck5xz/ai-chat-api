// Project 17: Multi-Agent Debate & Verifier — Fact Checker Agent
// Verifies claims from each debater against sources

import type { Claim, ClaimVerdict, FactCheckResult } from '../../types/debate';

const FACT_CHECK_PROMPT = `You are an expert fact-checker.
Your role is to verify claims made in a debate.

For each claim, determine:
1. VERDICT: supported, unsupported, contradicted, or unverifiable
2. CONFIDENCE: 0.0 to 1.0
3. EXPLANATION: Brief explanation of your assessment

Consider:
- Is the claim factually accurate?
- Is the cited source relevant and credible?
- Does the evidence actually support the claim?
- Are there any logical fallacies?

Be thorough but fair. Acknowledge uncertainty when it exists.`;

function extractClaimsFromArguments(args: string[]): Claim[] {
  const claims: Claim[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const sentences = arg.split(/[.!?]+/).filter(s => s.trim().length > 20);

    for (let j = 0; j < sentences.length; j++) {
      const sentence = sentences[j].trim();
      const hasFactualBasis = /\d+%|\d{4}|\$\d|million|billion|university|institute|research|study|evidence|according|data/i.test(sentence);

      if (hasFactualBasis) {
        const sourceMatch = sentence.match(/\[?\d+\]?|according to [^.]+|study by [^.]+/i);
        claims.push({
          id: `claim-${i}-${j}`,
          text: sentence,
          source: sourceMatch?.[0],
          verdict: 'unverifiable',
          confidence: 0.5,
          explanation: 'Awaiting verification',
        });
      }
    }
  }

  return claims;
}

function parseFactCheckResponse(content: string, claims: Claim[]): Claim[] {
  const verdictPattern = /supported|unsupported|contradicted|unverifiable/gi;
  const confidencePattern = /confidence[:\s]*(\d+(?:\.\d+)?)/gi;

  const verdicts = content.match(verdictPattern) || [];
  const confidences = [...content.matchAll(confidencePattern)];

  return claims.map((claim, index) => {
    const verdict = (verdicts[index] || 'unverifiable').toLowerCase() as ClaimVerdict;
    const confidence = confidences[index] ? parseFloat(confidences[index][1]) : 0.5;

    const explanationMatch = content.match(new RegExp(`${claim.text.slice(0, 30)}[\\s\\S]*?explanation[:\\s]*([^.]+)`, 'i'));
    const explanation = explanationMatch?.[1] || 'Verified by fact-checker';

    return {
      ...claim,
      verdict,
      confidence: Math.min(Math.max(confidence, 0), 1),
      explanation,
    };
  });
}

export class FactCheckerAgent {
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async factCheck(
    question: string,
    argumentsByPosition: Record<string, string[]>
  ): Promise<FactCheckResult> {
    const allArguments = Object.values(argumentsByPosition).flat();
    let claims = extractClaimsFromArguments(allArguments);

    if (claims.length === 0) {
      return {
        total_claims: 0,
        supported: 0,
        unsupported: 0,
        contradicted: 0,
        unverifiable: 0,
        accuracy_rate: 1.0,
        claims: [],
      };
    }

    claims = claims.slice(0, 20);

    const verificationPrompt = `Question: ${question}\n\nClaims to verify:\n${claims.map((c, i) => `${i + 1}. ${c.text}`).join('\n')}\n\nFor each claim, provide:\n- VERDICT: supported/unsupported/contradicted/unverifiable\n- CONFIDENCE: 0.0-1.0\n- EXPLANATION: brief reason`;

    const content = await this.callLLM(verificationPrompt);
    const verifiedClaims = parseFactCheckResponse(content, claims);

    const supported = verifiedClaims.filter(c => c.verdict === 'supported').length;
    const unsupported = verifiedClaims.filter(c => c.verdict === 'unsupported').length;
    const contradicted = verifiedClaims.filter(c => c.verdict === 'contradicted').length;
    const unverifiable = verifiedClaims.filter(c => c.verdict === 'unverifiable').length;

    return {
      total_claims: verifiedClaims.length,
      supported,
      unsupported,
      contradicted,
      unverifiable,
      accuracy_rate: verifiedClaims.length > 0 ? supported / verifiedClaims.length : 1.0,
      claims: verifiedClaims,
    };
  }

  private async callLLM(userPrompt: string): Promise<string> {
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${this.apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            system_instruction: { parts: [{ text: FACT_CHECK_PROMPT }] },
            contents: [{ parts: [{ text: userPrompt }] }],
            generationConfig: { temperature: 0.2, maxOutputTokens: 2048 },
          }),
        }
      );

      if (!response.ok) {
        throw new Error(`Gemini API error: ${response.status}`);
      }

      const data = await response.json() as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
      return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    } catch (error) {
      console.error('FactCheckerAgent LLM error:', error);
      return this.generateFallbackCheck();
    }
  }

  private generateFallbackCheck(): string {
    return `1. VERDICT: unverifiable, CONFIDENCE: 0.3, EXPLANATION: API unavailable for verification
2. VERDICT: unverifiable, CONFIDENCE: 0.3, EXPLANATION: API unavailable for verification
3. VERDICT: unverifiable, CONFIDENCE: 0.3, EXPLANATION: API unavailable for verification`;
  }
}
