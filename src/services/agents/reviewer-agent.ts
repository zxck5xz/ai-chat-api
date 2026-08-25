import { BaseAgent, type AgentConfig } from './base-agent';

export interface ReviewResult {
  score: number;
  passed: boolean;
  issues: {
    severity: 'error' | 'warning' | 'info';
    category: string;
    message: string;
    line?: number;
  }[];
  suggestions: string[];
  accessibility: {
    score: number;
    issues: string[];
  };
  performance: {
    score: number;
    issues: string[];
  };
}

export class ReviewerAgent extends BaseAgent {
  readonly type = 'reviewer';

  readonly systemPrompt = `You are a Reviewer Agent in a multi-agent UI development workflow.

Your job is to review generated code for quality, accessibility, and performance.

Output a JSON object with this exact structure:
{
  "score": 85,
  "passed": true,
  "issues": [
    {
      "severity": "error|warning|info",
      "category": "accessibility|performance|best-practice|type-safety",
      "message": "Description of the issue",
      "line": 42 (optional)
    }
  ],
  "suggestions": ["Suggestion 1", "Suggestion 2"],
  "accessibility": {
    "score": 90,
    "issues": ["Missing alt text on image", "Low contrast ratio"]
  },
  "performance": {
    "score": 85,
    "issues": ["Unnecessary re-render", "Large bundle size"]
  }
}

Rules:
- Score 0-100 where 80+ is passing
- Be constructive and specific
- Check for: semantic HTML, aria attributes, keyboard navigation, color contrast
- Check for: unnecessary re-renders, large dependencies, unoptimized images
- Check for: React best practices, TypeScript types, error handling
- Do NOT include any text outside the JSON object`;

  async review(code: string, designSpec?: string): Promise<{ success: boolean; result?: ReviewResult; error?: string }> {
    const input = `Review this code for quality, accessibility, and performance:

Code:
${code}

${designSpec ? `Design Specification (for reference):\n${designSpec}` : ''}`;

    const response = await this.run(input);

    if (!response.success) {
      return { success: false, error: response.error };
    }

    try {
      const result = JSON.parse(response.output) as ReviewResult;
      return { success: true, result };
    } catch {
      const match = response.output.match(/\{[\s\S]*\}/);
      if (match) {
        try {
          const result = JSON.parse(match[0]) as ReviewResult;
          return { success: true, result };
        } catch {
          return { success: false, error: 'Failed to parse reviewer response' };
        }
      }
      return { success: false, error: 'No JSON in reviewer response' };
    }
  }
}
