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

-- Observability: Alert Rules (enhanced)
CREATE TABLE IF NOT EXISTS alert_rules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  metric TEXT NOT NULL,
  condition TEXT NOT NULL CHECK (condition IN ('gt', 'lt', 'eq')),
  threshold REAL NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  severity TEXT NOT NULL DEFAULT 'warning' CHECK (severity IN ('info', 'warning', 'critical')),
  evaluation_window_minutes INTEGER NOT NULL DEFAULT 5,
  cooldown_minutes INTEGER NOT NULL DEFAULT 15,
  last_evaluated_at TEXT,
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

-- Monitoring: Anomaly Events
CREATE TABLE IF NOT EXISTS anomaly_events (
  id TEXT PRIMARY KEY,
  metric TEXT NOT NULL,
  model TEXT,
  anomaly_type TEXT NOT NULL CHECK (anomaly_type IN ('spike', 'drop', 'drift', 'outlier')),
  severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  actual_value REAL NOT NULL,
  expected_min REAL,
  expected_max REAL,
  z_score REAL,
  description TEXT NOT NULL,
  acknowledged INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_anomaly_events_metric ON anomaly_events(metric);
CREATE INDEX IF NOT EXISTS idx_anomaly_events_ack ON anomaly_events(acknowledged);
CREATE INDEX IF NOT EXISTS idx_anomaly_events_date ON anomaly_events(created_at);

-- Monitoring: Drift Events
CREATE TABLE IF NOT EXISTS drift_events (
  id TEXT PRIMARY KEY,
  metric TEXT NOT NULL,
  model TEXT,
  drift_type TEXT NOT NULL CHECK (drift_type IN ('accuracy', 'cost', 'latency', 'quality')),
  direction TEXT NOT NULL CHECK (direction IN ('improving', 'degrading')),
  baseline_value REAL NOT NULL,
  current_value REAL NOT NULL,
  change_pct REAL NOT NULL,
  window_days INTEGER NOT NULL DEFAULT 7,
  description TEXT NOT NULL,
  acknowledged INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_drift_events_metric ON drift_events(metric);
CREATE INDEX IF NOT EXISTS idx_drift_events_ack ON drift_events(acknowledged);
CREATE INDEX IF NOT EXISTS idx_drift_events_date ON drift_events(created_at);

-- Monitoring: Metric Snapshots (periodic metric recordings for trend analysis)
CREATE TABLE IF NOT EXISTS metric_snapshots (
  id TEXT PRIMARY KEY,
  metric TEXT NOT NULL,
  model TEXT,
  value REAL NOT NULL,
  sample_count INTEGER NOT NULL DEFAULT 0,
  window_minutes INTEGER NOT NULL DEFAULT 5,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_metric_snapshots_metric ON metric_snapshots(metric);
CREATE INDEX IF NOT EXISTS idx_metric_snapshots_date ON metric_snapshots(created_at);

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

-- Voice Sessions
CREATE TABLE IF NOT EXISTS voice_sessions (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('listening', 'processing', 'speaking', 'completed', 'failed', 'interrupted')),
  transcript TEXT NOT NULL DEFAULT '[]',
  user_language TEXT NOT NULL DEFAULT 'en',
  total_turns INTEGER NOT NULL DEFAULT 0,
  total_input_tokens INTEGER NOT NULL DEFAULT 0,
  total_output_tokens INTEGER NOT NULL DEFAULT 0,
  total_cost_usd REAL NOT NULL DEFAULT 0,
  total_latency_ms REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_voice_sessions_status ON voice_sessions(status);
CREATE INDEX IF NOT EXISTS idx_voice_sessions_date ON voice_sessions(created_at);

-- Image Text Replacement
CREATE TABLE IF NOT EXISTS image_text_replacements (
  id TEXT PRIMARY KEY,
  image_base64_hash TEXT NOT NULL,
  regions_detected INTEGER NOT NULL DEFAULT 0,
  regions_replaced INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('detecting', 'editing', 'generating', 'completed', 'failed')),
  model TEXT NOT NULL DEFAULT 'gemini-2.0-flash-exp',
  latency_ms REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_itr_status ON image_text_replacements(status);
CREATE INDEX IF NOT EXISTS idx_itr_date ON image_text_replacements(created_at);

-- Search Engine Analytics
CREATE TABLE IF NOT EXISTS search_queries (
  id TEXT PRIMARY KEY,
  query TEXT NOT NULL,
  expanded_query TEXT,
  complexity TEXT NOT NULL CHECK (complexity IN ('simple', 'moderate', 'complex', 'ambiguous')),
  strategy TEXT NOT NULL,
  results_count INTEGER NOT NULL DEFAULT 0,
  clicked_result_id TEXT,
  clicked_position INTEGER,
  latency_ms REAL NOT NULL DEFAULT 0,
  has_click INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_search_queries_date ON search_queries(created_at);
CREATE INDEX IF NOT EXISTS idx_search_queries_complexity ON search_queries(complexity);
CREATE INDEX IF NOT EXISTS idx_search_queries_query ON search_queries(query);

CREATE TABLE IF NOT EXISTS search_clicks (
  id TEXT PRIMARY KEY,
  query_id TEXT NOT NULL,
  result_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  document_id TEXT,
  chunk_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (query_id) REFERENCES search_queries(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_search_clicks_query ON search_clicks(query_id);
CREATE INDEX IF NOT EXISTS idx_search_clicks_position ON search_clicks(position);

CREATE TABLE IF NOT EXISTS search_feedback (
  id TEXT PRIMARY KEY,
  query_id TEXT NOT NULL,
  rating TEXT NOT NULL CHECK (rating IN ('positive', 'negative')),
  comment TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (query_id) REFERENCES search_queries(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_search_feedback_query ON search_feedback(query_id);
CREATE INDEX IF NOT EXISTS idx_search_feedback_rating ON search_feedback(rating);

-- MCP Server: connected remote MCP servers (we act as MCP client)
CREATE TABLE IF NOT EXISTS connected_mcp_servers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  auth_token_hash TEXT NOT NULL,
  protocol_version TEXT NOT NULL DEFAULT '2024-11-05',
  server_info TEXT,
  status TEXT NOT NULL CHECK (status IN ('connected', 'error', 'disconnected')),
  last_error TEXT,
  last_seen_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_mcp_servers_status ON connected_mcp_servers(status);

-- Catalog of tools advertised by remote MCP servers
CREATE TABLE IF NOT EXISTS remote_mcp_tools (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  input_schema TEXT NOT NULL DEFAULT '{}',
  cached_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (server_id) REFERENCES connected_mcp_servers(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_mcp_tools_server ON remote_mcp_tools(server_id);

-- Audit log for every call to a remote MCP server
CREATE TABLE IF NOT EXISTS mcp_call_log (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  args_json TEXT NOT NULL DEFAULT '{}',
  result_summary TEXT,
  latency_ms REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('ok', 'error')),
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (server_id) REFERENCES connected_mcp_servers(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_mcp_call_log_server ON mcp_call_log(server_id);
CREATE INDEX IF NOT EXISTS idx_mcp_call_log_tool ON mcp_call_log(tool_name);
CREATE INDEX IF NOT EXISTS idx_mcp_call_log_date ON mcp_call_log(created_at);

-- Model Versioning: Versions
CREATE TABLE IF NOT EXISTS model_versions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('gemini', 'openai', 'anthropic', 'custom')),
  model_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'inactive', 'deprecated', 'archived')),
  config TEXT NOT NULL DEFAULT '{}',
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_model_versions_provider ON model_versions(provider);
CREATE INDEX IF NOT EXISTS idx_model_versions_status ON model_versions(status);
CREATE INDEX IF NOT EXISTS idx_model_versions_model ON model_versions(model_id);

-- Model Versioning: Deployments
CREATE TABLE IF NOT EXISTS model_deployments (
  id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL,
  environment TEXT NOT NULL CHECK (environment IN ('production', 'staging', 'canary')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'rolled_back', 'failed')),
  traffic_percent INTEGER NOT NULL DEFAULT 100,
  strategy TEXT NOT NULL CHECK (strategy IN ('rolling', 'canary', 'blue_green', 'instant')),
  deployed_at TEXT,
  rolled_back_at TEXT,
  rollback_reason TEXT,
  deployed_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (version_id) REFERENCES model_versions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_model_deployments_env ON model_deployments(environment);
CREATE INDEX IF NOT EXISTS idx_model_deployments_status ON model_deployments(status);
CREATE INDEX IF NOT EXISTS idx_model_deployments_version ON model_deployments(version_id);

-- Model Versioning: Rollbacks
CREATE TABLE IF NOT EXISTS model_rollbacks (
  id TEXT PRIMARY KEY,
  deployment_id TEXT NOT NULL,
  from_version_id TEXT NOT NULL,
  to_version_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  triggered_by TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'failed')),
  rolled_back_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (deployment_id) REFERENCES model_deployments(id) ON DELETE CASCADE,
  FOREIGN KEY (from_version_id) REFERENCES model_versions(id),
  FOREIGN KEY (to_version_id) REFERENCES model_versions(id)
);

CREATE INDEX IF NOT EXISTS idx_model_rollbacks_deployment ON model_rollbacks(deployment_id);
CREATE INDEX IF NOT EXISTS idx_model_rollbacks_status ON model_rollbacks(status);
CREATE INDEX IF NOT EXISTS idx_model_rollbacks_date ON model_rollbacks(created_at);

-- Model Versioning: Request Log (for metrics)
CREATE TABLE IF NOT EXISTS model_requests (
  id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL,
  deployment_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('ok', 'error', 'timeout')),
  latency_ms REAL NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (version_id) REFERENCES model_versions(id),
  FOREIGN KEY (deployment_id) REFERENCES model_deployments(id)
);

CREATE INDEX IF NOT EXISTS idx_model_requests_version ON model_requests(version_id);
CREATE INDEX IF NOT EXISTS idx_model_requests_deployment ON model_requests(deployment_id);
CREATE INDEX IF NOT EXISTS idx_model_requests_status ON model_requests(status);
CREATE INDEX IF NOT EXISTS idx_model_requests_date ON model_requests(created_at);
