export interface ReviewIssue {
  file: string;
  line: number;
  severity: 'critical' | 'warning' | 'info';
  message: string;
  suggestion?: string;
}

export interface ReviewResult {
  issues: ReviewIssue[];
}

export interface GitHubWebhookPayload {
  action: string;
  number: number;
  pull_request: {
    diff_url: string;
    html_url: string;
    title: string;
    head: {
      sha: string;
      ref: string;
    };
    user: {
      login: string;
    };
  };
  repository: {
    full_name: string;
    owner: {
      login: string;
    };
    name: string;
  };
}

export interface CodeReviewRow {
  id: string;
  pr_number: number;
  repo: string;
  status: 'pending' | 'completed' | 'failed';
  total_issues: number;
  issues_by_severity: string | null;
  latency_ms: number | null;
  cost_usd: number | null;
  created_at: string;
}

export interface CodeReviewIssueRow {
  id: string;
  review_id: string;
  file_path: string;
  line_number: number;
  severity: 'critical' | 'warning' | 'info';
  message: string;
  suggestion: string | null;
  created_at: string;
}
