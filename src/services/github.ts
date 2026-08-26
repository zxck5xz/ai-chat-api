import type { ReviewIssue } from '../types/code-review';

export async function fetchPRDiff(diffUrl: string, githubToken: string): Promise<string> {
  const response = await fetch(diffUrl, {
    headers: {
      Accept: 'application/vnd.github.v3.diff',
      Authorization: `Bearer ${githubToken}`,
      'User-Agent': 'ai-code-review-bot',
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch PR diff: ${response.status} ${response.statusText}`);
  }

  return response.text();
}

export async function postPRReview(
  repo: string,
  prNumber: number,
  commitSha: string,
  issues: ReviewIssue[],
  githubToken: string
): Promise<void> {
  if (issues.length === 0) return;

  const body = formatReviewBody(issues);

  const response = await fetch(
    `https://api.github.com/repos/${repo}/pulls/${prNumber}/reviews`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github.v3+json',
        Authorization: `Bearer ${githubToken}`,
        'Content-Type': 'application/json',
        'User-Agent': 'ai-code-review-bot',
      },
      body: JSON.stringify({
        commit_id: commitSha,
        body: body.summary,
        event: issues.some((i) => i.severity === 'critical') ? 'REQUEST_CHANGES' : 'COMMENT',
        comments: issues.map((issue) => ({
          path: issue.file,
          line: issue.line,
          body: formatCommentBody(issue),
        })),
      }),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to post PR review: ${response.status} ${errorText}`);
  }
}

function formatReviewBody(issues: ReviewIssue[]): { summary: string } {
  const critical = issues.filter((i) => i.severity === 'critical').length;
  const warnings = issues.filter((i) => i.severity === 'warning').length;
  const info = issues.filter((i) => i.severity === 'info').length;

  const lines: string[] = [
    '## 🤖 AI Code Review',
    '',
    `**Summary:** ${critical} critical, ${warnings} warnings, ${info} info`,
    '',
  ];

  if (critical > 0) {
    lines.push('### ⛔ Critical Issues');
    issues
      .filter((i) => i.severity === 'critical')
      .forEach((issue) => {
        lines.push(`- **${issue.file}:${issue.line}** — ${issue.message}`);
        if (issue.suggestion) lines.push(`  > 💡 ${issue.suggestion}`);
      });
    lines.push('');
  }

  if (warnings > 0) {
    lines.push('### ⚠️ Warnings');
    issues
      .filter((i) => i.severity === 'warning')
      .forEach((issue) => {
        lines.push(`- **${issue.file}:${issue.line}** — ${issue.message}`);
        if (issue.suggestion) lines.push(`  > 💡 ${issue.suggestion}`);
      });
    lines.push('');
  }

  if (info > 0) {
    lines.push('### ℹ️ Suggestions');
    issues
      .filter((i) => i.severity === 'info')
      .forEach((issue) => {
        lines.push(`- **${issue.file}:${issue.line}** — ${issue.message}`);
        if (issue.suggestion) lines.push(`  > 💡 ${issue.suggestion}`);
      });
  }

  lines.push('', '---', '*Powered by AI Code Review Bot*');

  return { summary: lines.join('\n') };
}

function formatCommentBody(issue: ReviewIssue): string {
  const icon =
    issue.severity === 'critical' ? '⛔' : issue.severity === 'warning' ? '⚠️' : 'ℹ️';
  let body = `${icon} ${issue.message}`;
  if (issue.suggestion) body += `\n\n💡 **Suggestion:** ${issue.suggestion}`;
  return body;
}
