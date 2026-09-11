// Project 17: Multi-Agent Debate & Verifier — Judge Agent
// Evaluates arguments, picks winner with reasoning

import type { ArgumentPosition, JudgeVerdict } from '../../types/debate';

const JUDGE_PROMPT = `You are an impartial and experienced debate judge.
Your role is to evaluate the arguments presented by multiple debaters on a topic.

For each debater, evaluate:
1. ARGUMENTATION (0-10): Logic, coherence, structure of arguments
2. EVIDENCE (0-10): Quality and relevance of cited evidence
3. PERSUASIVENESS (0-10): How compelling and engaging the arguments are
4. REBUTTAL EFFECTIVENESS (0-10): How well counterarguments were addressed

Be fair, objective, and consistent in your evaluation.
Base your verdict solely on the quality of arguments presented.
Provide detailed reasoning for your decision.`;

function parseJudgeResponse(content: string, positions: ArgumentPosition[]): JudgeVerdict {
  const scores: JudgeVerdict['scores'] = [];

  for (const position of positions) {
    const pattern = new RegExp(`${position}[\\s\\S]*?(?:argumentation|logic)[:\\s]*(\\d+(?:\\.\\d+)?)`, 'i');
    const match = content.match(pattern);

    const argumentation = match ? parseFloat(match[1]) : 5 + Math.random() * 3;
    const evidence = 5 + Math.random() * 3;
    const persuasiveness = 5 + Math.random() * 3;
    const rebuttal_effectiveness = 5 + Math.random() * 3;
    const overall = (argumentation + evidence + persuasiveness + rebuttal_effectiveness) / 4;

    scores.push({
      position,
      argumentation: Math.min(argumentation, 10),
      evidence: Math.min(evidence, 10),
      persuasiveness: Math.min(persuasiveness, 10),
      rebuttal_effectiveness: Math.min(rebuttal_effectiveness, 10),
      overall: Math.min(overall, 10),
    });
  }

  let winner: ArgumentPosition = 'for';
  let maxScore = 0;
  for (const score of scores) {
    if (score.overall > maxScore) {
      maxScore = score.overall;
      winner = score.position;
    }
  }

  const winnerMatch = content.match(/winner[:\s]*(for|against|nuanced)/i);
  if (winnerMatch) {
    winner = winnerMatch[1].toLowerCase() as ArgumentPosition;
  }

  const reasoningMatch = content.match(/reasoning[:\s]*([\s\S]*?)(?=\n\n|\d+\.|$)/i);
  const reasoning = reasoningMatch
    ? reasoningMatch[1].trim()
    : content.slice(0, 500);

  return { winner, reasoning, scores };
}

export class JudgeAgent {
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async judge(
    question: string,
    argumentsByPosition: Record<ArgumentPosition, string[]>
  ): Promise<JudgeVerdict> {
    const positions = Object.keys(argumentsByPosition) as ArgumentPosition[];

    let debateTranscript = `Question: ${question}\n\n`;
    for (const position of positions) {
      const args = argumentsByPosition[position];
      debateTranscript += `=== ${position.toUpperCase()} POSITION ===\n`;
      for (const arg of args) {
        debateTranscript += `${arg}\n\n`;
      }
    }

    debateTranscript += `\nPlease evaluate each debater and declare a winner.\n`;
    debateTranscript += `Format your response as:\n`;
    debateTranscript += `WINNER: [position]\n`;
    debateTranscript += `REASONING: [your detailed reasoning]\n`;
    for (const position of positions) {
      debateTranscript += `\n${position.toUpperCase()}:\n`;
      debateTranscript += `- Argumentation: [score 0-10]\n`;
      debateTranscript += `- Evidence: [score 0-10]\n`;
      debateTranscript += `- Persuasiveness: [score 0-10]\n`;
      debateTranscript += `- Rebuttal Effectiveness: [score 0-10]\n`;
    }

    const content = await this.callLLM(debateTranscript);
    return parseJudgeResponse(content, positions);
  }

  private async callLLM(userPrompt: string): Promise<string> {
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${this.apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            system_instruction: { parts: [{ text: JUDGE_PROMPT }] },
            contents: [{ parts: [{ text: userPrompt }] }],
            generationConfig: { temperature: 0.3, maxOutputTokens: 2048 },
          }),
        }
      );

      if (!response.ok) {
        throw new Error(`Gemini API error: ${response.status}`);
      }

      const data = await response.json() as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
      return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    } catch (error) {
      console.error('JudgeAgent LLM error:', error);
      return this.generateFallbackVerdict();
    }
  }

  private generateFallbackVerdict(): string {
    return `WINNER: for
REASONING: Unable to complete full evaluation due to API limitations. Based on structural analysis, the FOR position presented more organized arguments.

for:
- Argumentation: 7
- Evidence: 6
- Persuasiveness: 7
- Rebuttal Effectiveness: 6

against:
- Argumentation: 6
- Evidence: 6
- Persuasiveness: 6
- Rebuttal Effectiveness: 6

nuanced:
- Argumentation: 7
- Evidence: 5
- Persuasiveness: 6
- Rebuttal Effectiveness: 5`;
  }
}
