// Project 17: Multi-Agent Debate & Verifier — Debater Agent
// 3 debaters argue different positions (for, against, nuanced)

import type { Argument, ArgumentPosition, Claim, RoundType } from '../../types/debate';

const DEBATER_PROMPTS: Record<ArgumentPosition, string> = {
  for: `You are an expert debater arguing FOR a proposition.
Your goal is to present the strongest possible case in favor of the topic.
Use logical reasoning, evidence, and persuasive language.
Always cite sources when making factual claims.
Be respectful but passionate about your position.`,
  against: `You are an expert debater arguing AGAINST a proposition.
Your goal is to present the strongest possible case against the topic.
Use logical reasoning, evidence, and persuasive language.
Always cite sources when making factual claims.
Be respectful but firm in your opposition.`,
  nuanced: `You are an expert debater presenting a NUANCED position on a proposition.
Your goal is to explore multiple perspectives, acknowledge valid points on both sides, and present a balanced analysis.
Use logical reasoning, evidence, and balanced language.
Always cite sources when making factual claims.
Be fair and comprehensive in your analysis.`,
};

function getRoundInstruction(round: RoundType): string {
  switch (round) {
    case 'opening':
      return 'Present your opening statement. Make your strongest arguments clear and compelling.';
    case 'rebuttal':
      return 'Rebut the arguments made by other debaters. Address their strongest points and explain why they are flawed.';
    case 'closing':
      return 'Deliver your closing statement. Summarize your key arguments, address counterarguments, and make a final compelling appeal.';
  }
}

function parseClaims(content: string): Claim[] {
  const claims: Claim[] = [];
  const sentences = content.split(/[.!?]+/).filter(s => s.trim().length > 20);

  for (let i = 0; i < sentences.length; i++) {
    const sentence = sentences[i].trim();
    const hasCitation = /\[\d+\]|according to|research shows|studies indicate|evidence suggests/i.test(sentence);
    const hasSpecifics = /\d+%|\d{4}|\$\d|million|billion|university|institute/i.test(sentence);

    if (hasCitation || hasSpecifics) {
      claims.push({
        id: `claim-${i}`,
        text: sentence,
        source: hasCitation ? sentence.match(/\[?\d+\]?|according to [^.]+/i)?.[0] : undefined,
        verdict: 'unverifiable',
        confidence: hasSpecifics ? 0.7 : 0.5,
        explanation: 'Claim extracted from argument',
      });
    }
  }

  return claims;
}

function calculateStrength(content: string, claims: Claim[]): number {
  let score = 0.5;

  if (content.length > 500) score += 0.1;
  if (content.length > 1000) score += 0.1;
  if (claims.length > 0) score += 0.1;
  if (claims.length > 3) score += 0.1;

  const hasCounterargument = /however|although|while|despite|on the other hand|counter/i.test(content);
  if (hasCounterargument) score += 0.1;

  return Math.min(score, 1.0);
}

export class DebaterAgent {
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async argue(
    question: string,
    position: ArgumentPosition,
    round: RoundType,
    context?: { previousArguments?: string[]; rebuttalTargets?: string[] }
  ): Promise<Argument> {
    const systemPrompt = DEBATER_PROMPTS[position];
    const roundInstruction = getRoundInstruction(round);

    let userPrompt = `Question: ${question}\n\nRound: ${round}\n${roundInstruction}`;

    if (context?.previousArguments && context.previousArguments.length > 0) {
      userPrompt += `\n\nPrevious arguments from other debaters:\n${context.previousArguments.join('\n---\n')}`;
    }

    if (context?.rebuttalTargets && context.rebuttalTargets.length > 0) {
      userPrompt += `\n\nArguments to rebuttal:\n${context.rebuttalTargets.join('\n---\n')}`;
    }

    userPrompt += `\n\nProvide your ${round} argument. Be specific, cite evidence where possible, and structure your argument clearly.`;

    const content = await this.callLLM(systemPrompt, userPrompt);
    const claims = parseClaims(content);
    const strength_score = calculateStrength(content, claims);

    return {
      id: crypto.randomUUID(),
      debater_id: position,
      position,
      round,
      content,
      claims,
      evidence_count: claims.filter(c => c.source).length,
      strength_score,
      created_at: new Date().toISOString(),
    };
  }

  async debate(
    question: string,
    format: 'oxford' | 'lincoln_douglas' | 'free_form',
    onEvent?: (event: { type: string; data: unknown }) => void
  ): Promise<{ position: ArgumentPosition; arguments: Argument[]; overall_score: number }> {
    const rounds: RoundType[] = format === 'free_form'
      ? ['opening', 'closing']
      : format === 'lincoln_douglas'
        ? ['opening', 'rebuttal', 'closing']
        : ['opening', 'rebuttal', 'closing'];

    const position = 'for' as ArgumentPosition;
    const args: Argument[] = [];
    const previousContents: string[] = [];

    for (const round of rounds) {
      onEvent?.({ type: 'debater_start', data: { position, round } });

      const arg = await this.argue(question, position, round, {
        previousArguments: round !== 'opening' ? previousContents : undefined,
      });

      args.push(arg);
      previousContents.push(arg.content);

      onEvent?.({ type: 'argument', data: { argument: arg } });
    }

    const overall_score = args.reduce((sum, a) => sum + a.strength_score, 0) / args.length;

    return { position, arguments: args, overall_score };
  }

  private async callLLM(systemPrompt: string, userPrompt: string): Promise<string> {
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${this.apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            system_instruction: { parts: [{ text: systemPrompt }] },
            contents: [{ parts: [{ text: userPrompt }] }],
            generationConfig: { temperature: 0.8, maxOutputTokens: 2048 },
          }),
        }
      );

      if (!response.ok) {
        throw new Error(`Gemini API error: ${response.status}`);
      }

      const data = await response.json() as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
      return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    } catch (error) {
      console.error('DebaterAgent LLM error:', error);
      return `[Debater temporarily unavailable: ${error instanceof Error ? error.message : 'unknown error'}]`;
    }
  }
}

export function createAllDebaters(apiKey: string): Record<ArgumentPosition, DebaterAgent> {
  return {
    for: new DebaterAgent(apiKey),
    against: new DebaterAgent(apiKey),
    nuanced: new DebaterAgent(apiKey),
  };
}
