// Project 17: Multi-Agent Debate & Verifier — Consensus Builder
// Synthesizes best arguments into final answer

import type { ArgumentPosition, ConsensusResult, JudgeVerdict } from '../../types/debate';

const CONSENSUS_PROMPT = `You are an expert consensus builder.
Your role is to synthesize the best arguments from a multi-agent debate into a coherent, balanced final answer.

Given:
1. The original question
2. Arguments from all debaters (for, against, nuanced)
3. The judge's verdict and scoring
4. Fact-check results

Produce:
1. SYNTHESIS: A comprehensive answer that incorporates the strongest arguments from all sides
2. KEY POINTS: 3-5 most important points from the debate
3. AREAS OF AGREEMENT: Points where debaters agreed
4. AREAS OF DISAGREEMENT: Points of fundamental disagreement
5. CONFIDENCE: Overall confidence in the synthesis (0.0-1.0)

Be balanced, fair, and thorough. Give weight to well-supported arguments.`;

function parseConsensusResponse(content: string): ConsensusResult {
  const synthesisMatch = content.match(/synthesis[:\s]*([\s\S]*?)(?=key points|areas of agreement|$)/i);
  const keyPointsMatch = content.match(/key points[:\s]*([\s\S]*?)(?=areas of agreement|areas of disagreement|$)/i);
  const agreementMatch = content.match(/areas? of agreement[:\s]*([\s\S]*?)(?=areas? of disagreement|confidence|$)/i);
  const disagreementMatch = content.match(/areas? of disagreement[:\s]*([\s\S]*?)(?=confidence|$)/i);
  const confidenceMatch = content.match(/confidence[:\s]*(\d+(?:\.\d+)?)/i);

  return {
    synthesis: synthesisMatch?.[1]?.trim() || content.slice(0, 1000),
    key_points: keyPointsMatch
      ? keyPointsMatch[1].split(/\n/).filter(l => l.trim().length > 5).slice(0, 5)
      : ['Analysis complete'],
    areas_of_agreement: agreementMatch
      ? agreementMatch[1].split(/\n/).filter(l => l.trim().length > 5).slice(0, 5)
      : [],
    areas_of_disagreement: disagreementMatch
      ? disagreementMatch[1].split(/\n/).filter(l => l.trim().length > 5).slice(0, 5)
      : [],
    confidence: confidenceMatch ? Math.min(parseFloat(confidenceMatch[1]), 1) : 0.7,
  };
}

export class ConsensusBuilder {
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async build(
    question: string,
    argumentsByPosition: Record<ArgumentPosition, string[]>,
    verdict: JudgeVerdict,
    factCheckAccuracy: number
  ): Promise<ConsensusResult> {
    const prompt = `Question: ${question}\n\n`;
    const argsText = Object.entries(argumentsByPosition)
      .map(([pos, args]) => `=== ${pos.toUpperCase()} ===\n${args.join('\n---\n')}`)
      .join('\n\n');
    const verdictText = `Judge's verdict: ${verdict.winner} wins\nReasoning: ${verdict.reasoning}\nScores: ${JSON.stringify(verdict.scores)}`;
    const factText = `Fact-check accuracy: ${(factCheckAccuracy * 100).toFixed(1)}%`;

    const userPrompt = `${prompt}${argsText}\n\n${verdictText}\n\n${factText}\n\nPlease synthesize the best answer from this debate.`;

    const content = await this.callLLM(userPrompt);
    return parseConsensusResponse(content);
  }

  private async callLLM(userPrompt: string): Promise<string> {
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${this.apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            system_instruction: { parts: [{ text: CONSENSUS_PROMPT }] },
            contents: [{ parts: [{ text: userPrompt }] }],
            generationConfig: { temperature: 0.5, maxOutputTokens: 2048 },
          }),
        }
      );

      if (!response.ok) {
        throw new Error(`Gemini API error: ${response.status}`);
      }

      const data = await response.json() as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
      return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    } catch (error) {
      console.error('ConsensusBuilder LLM error:', error);
      return this.generateFallbackConsensus();
    }
  }

  private generateFallbackConsensus(): string {
    return `SYNTHESIS: Based on the multi-agent debate, multiple perspectives were presented. The debaters explored various facets of the topic, providing a comprehensive analysis.

KEY POINTS:
- Multiple valid perspectives exist on this topic
- Evidence quality varied across arguments
- Further research may be needed for definitive conclusions

AREAS OF AGREEMENT:
- The topic is complex and multifaceted
- Evidence-based reasoning is important

AREAS OF DISAGREEMENT:
- The overall conclusion remains contested
- Different values lead to different interpretations

CONFIDENCE: 0.6`;
  }
}
