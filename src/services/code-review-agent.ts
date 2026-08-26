import type { ReviewResult } from '../types/code-review';

const REVIEW_PROMPT = `You are an expert code reviewer. Analyze the following code diff and identify issues.

For each issue found, provide:
- file: The file path
- line: The line number in the new file (additions only)
- severity: "critical" for bugs/security issues, "warning" for code quality, "info" for suggestions
- message: Clear description of the issue
- suggestion: Optional fix suggestion

Focus on:
1. Bugs and logic errors
2. Security vulnerabilities (SQL injection, XSS, etc.)
3. Performance issues
4. Code quality (naming, duplication, complexity)
5. Best practices and patterns

Return a JSON object with an "issues" array. If no issues found, return {"issues": []}.`;

export async function analyzeDiff(
  diff: string,
  apiKey: string
): Promise<ReviewResult> {
  // Truncate very large diffs to avoid token limits
  const maxDiffLength = 30000;
  const truncatedDiff =
    diff.length > maxDiffLength ? diff.substring(0, maxDiffLength) + '\n\n... [truncated]' : diff;

  const prompt = `${REVIEW_PROMPT}\n\nCode Diff:\n\`\`\`diff\n${truncatedDiff}\n\`\`\``;

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: 'object',
            properties: {
              issues: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    file: { type: 'string' },
                    line: { type: 'integer' },
                    severity: { type: 'string', enum: ['critical', 'warning', 'info'] },
                    message: { type: 'string' },
                    suggestion: { type: 'string' },
                  },
                  required: ['file', 'line', 'severity', 'message'],
                },
              },
            },
            required: ['issues'],
          },
          temperature: 0.1,
          maxOutputTokens: 4096,
        },
      }),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini API error: ${response.status} ${errorText}`);
  }

  const data = (await response.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };

  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new Error('No response from Gemini');
  }

  const parsed = JSON.parse(text) as ReviewResult;

  // Validate and clean the response
  return {
    issues: (parsed.issues || []).filter(
      (issue) =>
        issue.file &&
        typeof issue.line === 'number' &&
        ['critical', 'warning', 'info'].includes(issue.severity) &&
        issue.message
    ),
  };
}
