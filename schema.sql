-- D1 Schema for AI Chat

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT 'New Chat',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL,
  sources TEXT, -- JSON string
  feedback_rating TEXT CHECK (feedback_rating IN ('positive', 'negative', NULL)),
  feedback_comment TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);

-- Documents for RAG
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  url TEXT,
  chunk_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Eval Metrics
CREATE TABLE IF NOT EXISTS eval_runs (
  id TEXT PRIMARY KEY,
  model_version TEXT NOT NULL,
  prompt_variant TEXT,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  total_cases INTEGER NOT NULL DEFAULT 0,
  passed_cases INTEGER NOT NULL DEFAULT 0,
  failed_cases INTEGER NOT NULL DEFAULT 0,
  avg_latency_ms REAL,
  avg_cost_usd REAL,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_eval_runs_model ON eval_runs(model_version);
CREATE INDEX IF NOT EXISTS idx_eval_runs_date ON eval_runs(started_at);

-- Individual eval results
CREATE TABLE IF NOT EXISTS eval_results (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  query TEXT NOT NULL,
  expected_output TEXT,
  actual_output TEXT,
  score REAL NOT NULL DEFAULT 0,
  passed INTEGER NOT NULL DEFAULT 0, -- 0 or 1
  latency_ms REAL,
  cost_usd REAL,
  feedback_rating TEXT CHECK (feedback_rating IN ('positive', 'negative', NULL)),
  feedback_comment TEXT,
  hallucination_flag INTEGER NOT NULL DEFAULT 0, -- 0 or 1
  metadata TEXT, -- JSON string for additional data
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (run_id) REFERENCES eval_runs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_eval_results_run ON eval_results(run_id);
CREATE INDEX IF NOT EXISTS idx_eval_results_score ON eval_results(score);
CREATE INDEX IF NOT EXISTS idx_eval_results_feedback ON eval_results(feedback_rating);

-- Safety Gates
CREATE TABLE IF NOT EXISTS safety_gates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  metric TEXT NOT NULL, -- e.g., 'min_accuracy', 'max_latency', 'max_hallucination_rate'
  threshold REAL NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1, -- 0 or 1
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Deploy approvals
CREATE TABLE IF NOT EXISTS deploy_approvals (
  id TEXT PRIMARY KEY,
  eval_run_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
  approved_by TEXT,
  comment TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT,
  FOREIGN KEY (eval_run_id) REFERENCES eval_runs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_deploy_approvals_status ON deploy_approvals(status);

-- Code Review Bot
CREATE TABLE IF NOT EXISTS code_reviews (
  id TEXT PRIMARY KEY,
  pr_number INTEGER NOT NULL,
  repo TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'failed')),
  total_issues INTEGER NOT NULL DEFAULT 0,
  issues_by_severity TEXT, -- JSON string: {"critical": 1, "warning": 2, "info": 5}
  latency_ms REAL,
  cost_usd REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_code_reviews_repo_pr ON code_reviews(repo, pr_number);

CREATE TABLE IF NOT EXISTS code_review_issues (
  id TEXT PRIMARY KEY,
  review_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  line_number INTEGER NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('critical', 'warning', 'info')),
  message TEXT NOT NULL,
  suggestion TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (review_id) REFERENCES code_reviews(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_code_review_issues_review ON code_review_issues(review_id);
