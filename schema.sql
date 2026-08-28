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

-- Tool Agent Runs
CREATE TABLE IF NOT EXISTS tool_agent_runs (
  id TEXT PRIMARY KEY,
  query TEXT NOT NULL,
  steps TEXT NOT NULL DEFAULT '[]', -- JSON string: array of steps
  final_answer TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  total_tool_calls INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_tool_agent_runs_status ON tool_agent_runs(status);
CREATE INDEX IF NOT EXISTS idx_tool_agent_runs_date ON tool_agent_runs(created_at);

-- Observability: Traces
CREATE TABLE IF NOT EXISTS traces (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  operation TEXT NOT NULL DEFAULT 'general',
  total_spans INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  total_cost_usd REAL NOT NULL DEFAULT 0,
  total_latency_ms REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('ok', 'error', 'partial')),
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_traces_user ON traces(user_id);
CREATE INDEX IF NOT EXISTS idx_traces_operation ON traces(operation);
CREATE INDEX IF NOT EXISTS idx_traces_date ON traces(started_at);

-- Observability: Trace Spans
CREATE TABLE IF NOT EXISTS trace_spans (
  id TEXT PRIMARY KEY,
  trace_id TEXT NOT NULL,
  parent_span_id TEXT,
  operation TEXT NOT NULL,
  service TEXT NOT NULL,
  model TEXT,
  status TEXT NOT NULL CHECK (status IN ('ok', 'error', 'timeout')),
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  latency_ms REAL NOT NULL DEFAULT 0,
  metadata TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  FOREIGN KEY (trace_id) REFERENCES traces(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_trace_spans_trace ON trace_spans(trace_id);
CREATE INDEX IF NOT EXISTS idx_trace_spans_model ON trace_spans(model);
CREATE INDEX IF NOT EXISTS idx_trace_spans_date ON trace_spans(started_at);

-- Observability: Alert Rules
CREATE TABLE IF NOT EXISTS alert_rules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  metric TEXT NOT NULL,
  condition TEXT NOT NULL CHECK (condition IN ('gt', 'lt', 'eq')),
  threshold REAL NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Observability: Alert Events
CREATE TABLE IF NOT EXISTS alert_events (
  id TEXT PRIMARY KEY,
  rule_id TEXT NOT NULL,
  rule_name TEXT NOT NULL,
  metric TEXT NOT NULL,
  actual_value REAL NOT NULL,
  threshold REAL NOT NULL,
  acknowledged INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (rule_id) REFERENCES alert_rules(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_alert_events_ack ON alert_events(acknowledged);

-- Fine-tuning: Datasets
CREATE TABLE IF NOT EXISTS ft_datasets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  source TEXT NOT NULL CHECK (source IN ('manual', 'import', 'generated', 'curated')),
  format TEXT NOT NULL CHECK (format IN ('chat', 'instruction', 'completion')),
  total_entries INTEGER NOT NULL DEFAULT 0,
  valid_entries INTEGER NOT NULL DEFAULT 0,
  duplicate_entries INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('draft', 'validating', 'ready', 'archived')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Fine-tuning: Dataset Entries
CREATE TABLE IF NOT EXISTS ft_dataset_entries (
  id TEXT PRIMARY KEY,
  dataset_id TEXT NOT NULL,
  prompt TEXT NOT NULL,
  completion TEXT NOT NULL,
  system_prompt TEXT,
  metadata TEXT,
  is_valid INTEGER NOT NULL DEFAULT 1,
  is_duplicate INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (dataset_id) REFERENCES ft_datasets(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ft_entries_dataset ON ft_dataset_entries(dataset_id);

-- Fine-tuning: Training Jobs
CREATE TABLE IF NOT EXISTS ft_training_jobs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  dataset_id TEXT NOT NULL,
  base_model TEXT NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('lora', 'qlora', 'full')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'preparing', 'training', 'evaluating', 'completed', 'failed')),
  hyperparameters TEXT NOT NULL DEFAULT '{}',
  output_model TEXT,
  total_steps INTEGER NOT NULL DEFAULT 0,
  completed_steps INTEGER NOT NULL DEFAULT 0,
  current_loss REAL,
  best_loss REAL,
  training_loss_history TEXT NOT NULL DEFAULT '[]',
  epoch INTEGER NOT NULL DEFAULT 0,
  total_epochs INTEGER NOT NULL DEFAULT 1,
  metadata TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (dataset_id) REFERENCES ft_datasets(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ft_jobs_status ON ft_training_jobs(status);
CREATE INDEX IF NOT EXISTS idx_ft_jobs_dataset ON ft_training_jobs(dataset_id);

-- Fine-tuning: Model Evaluations
CREATE TABLE IF NOT EXISTS ft_model_evals (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  base_model TEXT NOT NULL,
  fine_tuned_model TEXT NOT NULL,
  eval_set TEXT NOT NULL,
  total_cases INTEGER NOT NULL DEFAULT 0,
  base_pass_rate REAL NOT NULL DEFAULT 0,
  ft_pass_rate REAL NOT NULL DEFAULT 0,
  base_avg_latency REAL NOT NULL DEFAULT 0,
  ft_avg_latency REAL NOT NULL DEFAULT 0,
  base_avg_cost REAL NOT NULL DEFAULT 0,
  ft_avg_cost REAL NOT NULL DEFAULT 0,
  improvement_pct REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (job_id) REFERENCES ft_training_jobs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ft_evals_job ON ft_model_evals(job_id);

-- Fine-tuning: A/B Tests
CREATE TABLE IF NOT EXISTS ft_ab_tests (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  base_model TEXT NOT NULL,
  variant_model TEXT NOT NULL,
  traffic_split REAL NOT NULL DEFAULT 50,
  total_requests INTEGER NOT NULL DEFAULT 0,
  base_requests INTEGER NOT NULL DEFAULT 0,
  variant_requests INTEGER NOT NULL DEFAULT 0,
  base_avg_latency REAL NOT NULL DEFAULT 0,
  variant_avg_latency REAL NOT NULL DEFAULT 0,
  base_pass_rate REAL NOT NULL DEFAULT 0,
  variant_pass_rate REAL NOT NULL DEFAULT 0,
  winner TEXT CHECK (winner IN ('base', 'variant')),
  status TEXT NOT NULL CHECK (status IN ('running', 'stopped', 'completed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  stopped_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_ft_ab_status ON ft_ab_tests(status);
