import { Hono } from 'hono';
import type { Env } from '../types';
import type { GitHubWebhookPayload, CodeReviewRow, CodeReviewIssueRow } from '../types/code-review';
import { fetchPRDiff, postPRReview } from '../services/github';
import { analyzeDiff } from '../services/code-review-agent';

interface CodeReviewEnv extends Env {
  GITHUB_TOKEN: string;
  GITHUB_WEBHOOK_SECRET: string;
}

const codeReview = new Hono<{ Bindings: CodeReviewEnv }>();

// Verify webhook signature
async function verifySignature(
  body: string,
  signature: string | null,
  secret: string
): Promise<boolean> {
  if (!signature) return false;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signed = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
  const expectedSignature = `sha256=${Array.from(new Uint8Array(signed))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')}`;

  return signature === expectedSignature;
}

// GitHub webhook endpoint
codeReview.post('/webhook', async (c) => {
  const signature = c.req.header('x-hub-signature-256');
  const bodyText = await c.req.text();

  // Verify webhook signature
  if (!(await verifySignature(bodyText, signature || null, c.env.GITHUB_WEBHOOK_SECRET))) {
    return c.json({ error: 'Unauthorized signature' }, 401);
  }

  const payload = JSON.parse(bodyText) as GitHubWebhookPayload;

  // Only review when PR is opened or new code is pushed
  if (payload.action !== 'opened' && payload.action !== 'synchronize') {
    return c.json({ status: 'ignored', action: payload.action });
  }

  const repo = payload.repository.full_name;
  const prNumber = payload.number;
  const commitSha = payload.pull_request.head.sha;

  // Process review in background
  c.executionCtx.waitUntil(
    (async () => {
      const reviewId = crypto.randomUUID();
      const startTime = Date.now();

      try {
        // Save pending review
        await c.env.DB.prepare(
          `INSERT INTO code_reviews (id, pr_number, repo, status) VALUES (?, ?, ?, 'pending')`
        )
          .bind(reviewId, prNumber, repo)
          .run();

        // Fetch PR diff
        const diff = await fetchPRDiff(payload.pull_request.diff_url, c.env.GITHUB_TOKEN);

        // Analyze with Gemini
        const reviewResult = await analyzeDiff(diff, c.env.GEMINI_API_KEY);

        const latencyMs = Date.now() - startTime;

        // Calculate issues by severity
        const issuesBySeverity = {
          critical: reviewResult.issues.filter((i) => i.severity === 'critical').length,
          warning: reviewResult.issues.filter((i) => i.severity === 'warning').length,
          info: reviewResult.issues.filter((i) => i.severity === 'info').length,
        };

        // Update review status
        await c.env.DB.prepare(
          `UPDATE code_reviews 
           SET status = 'completed', total_issues = ?, issues_by_severity = ?, latency_ms = ?
           WHERE id = ?`
        )
          .bind(
            reviewResult.issues.length,
            JSON.stringify(issuesBySeverity),
            latencyMs,
            reviewId
          )
          .run();

        // Save individual issues
        for (const issue of reviewResult.issues) {
          const issueId = crypto.randomUUID();
          await c.env.DB.prepare(
            `INSERT INTO code_review_issues (id, review_id, file_path, line_number, severity, message, suggestion)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
          )
            .bind(
              issueId,
              reviewId,
              issue.file,
              issue.line,
              issue.severity,
              issue.message,
              issue.suggestion || null
            )
            .run();
        }

        // Post review to GitHub
        await postPRReview(repo, prNumber, commitSha, reviewResult.issues, c.env.GITHUB_TOKEN);

        console.log(
          `Review completed: ${reviewId} - ${reviewResult.issues.length} issues found in ${latencyMs}ms`
        );
      } catch (err) {
        console.error('Code review processing failed:', err);

        // Update review status to failed
        await c.env.DB.prepare(`UPDATE code_reviews SET status = 'failed' WHERE id = ?`)
          .bind(reviewId)
          .run();
      }
    })()
  );

  return c.json({ status: 'processing', reviewId: crypto.randomUUID(), message: 'Review started' });
});

// Get all reviews
codeReview.get('/reviews', async (c) => {
  try {
    const { repo, limit = '20' } = c.req.query();

    let whereClause = 'WHERE 1=1';
    const params: string[] = [];

    if (repo) {
      whereClause += ' AND repo = ?';
      params.push(repo);
    }

    const results = await c.env.DB.prepare(
      `SELECT * FROM code_reviews ${whereClause} ORDER BY created_at DESC LIMIT ?`
    )
      .bind(...params, parseInt(limit))
      .all();

    return c.json({ reviews: results.results as unknown as CodeReviewRow[] });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Failed to fetch reviews', details: message }, 500);
  }
});

// Get single review with issues
codeReview.get('/reviews/:id', async (c) => {
  try {
    const reviewId = c.req.param('id');

    const review = await c.env.DB.prepare(`SELECT * FROM code_reviews WHERE id = ?`)
      .bind(reviewId)
      .first();

    if (!review) {
      return c.json({ error: 'Review not found' }, 404);
    }

    const issues = await c.env.DB.prepare(
      `SELECT * FROM code_review_issues WHERE review_id = ? ORDER BY 
       CASE severity WHEN 'critical' THEN 1 WHEN 'warning' THEN 2 ELSE 3 END, line_number`
    )
      .bind(reviewId)
      .all();

    return c.json({
      review: review as unknown as CodeReviewRow,
      issues: issues.results as unknown as CodeReviewIssueRow[],
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Failed to fetch review', details: message }, 500);
  }
});

// Get review metrics
codeReview.get('/metrics', async (c) => {
  try {
    const stats = await c.env.DB.prepare(`
      SELECT 
        COUNT(*) as total_reviews,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
        AVG(total_issues) as avg_issues,
        AVG(latency_ms) as avg_latency,
        SUM(total_issues) as total_issues
      FROM code_reviews
    `).first();

    const severityStats = await c.env.DB.prepare(`
      SELECT 
        severity,
        COUNT(*) as count
      FROM code_review_issues
      GROUP BY severity
    `).all();

    const topRepos = await c.env.DB.prepare(`
      SELECT 
        repo,
        COUNT(*) as review_count,
        SUM(total_issues) as total_issues
      FROM code_reviews
      GROUP BY repo
      ORDER BY review_count DESC
      LIMIT 5
    `).all();

    return c.json({
      stats: stats || {
        total_reviews: 0,
        completed: 0,
        failed: 0,
        avg_issues: 0,
        avg_latency: 0,
        total_issues: 0,
      },
      severityBreakdown: severityStats.results,
      topRepos: topRepos.results,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Failed to fetch metrics', details: message }, 500);
  }
});

// Manual review trigger (for testing)
codeReview.post('/analyze', async (c) => {
  try {
    const body = await c.req.json<{ diff: string }>();
    const { diff } = body;

    if (!diff) {
      return c.json({ error: 'diff is required' }, 400);
    }

    const startTime = Date.now();
    const result = await analyzeDiff(diff, c.env.GEMINI_API_KEY);
    const latencyMs = Date.now() - startTime;

    return c.json({
      issues: result.issues,
      latency_ms: latencyMs,
      total_issues: result.issues.length,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Failed to analyze diff', details: message }, 500);
  }
});

export default codeReview;
