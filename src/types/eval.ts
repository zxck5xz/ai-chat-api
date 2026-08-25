export interface EvalRun {
  id: string;
  model_version: string;
  prompt_variant: string | null;
  status: 'running' | 'completed' | 'failed';
  total_cases: number;
  passed_cases: number;
  failed_cases: number;
  avg_latency_ms: number | null;
  avg_cost_usd: number | null;
  started_at: string;
  completed_at: string | null;
}

export interface EvalResult {
  id: string;
  run_id: string;
  query: string;
  expected_output: string | null;
  actual_output: string | null;
  score: number;
  passed: number;
  latency_ms: number | null;
  cost_usd: number | null;
  feedback_rating: 'positive' | 'negative' | null;
  feedback_comment: string | null;
  hallucination_flag: number;
  metadata: string | null;
  created_at: string;
}

export interface SafetyGate {
  id: string;
  name: string;
  metric: string;
  threshold: number;
  enabled: number;
  created_at: string;
}

export interface DeployApproval {
  id: string;
  eval_run_id: string;
  status: 'pending' | 'approved' | 'rejected';
  approved_by: string | null;
  comment: string | null;
  created_at: string;
  resolved_at: string | null;
}

export interface EvalMetrics {
  total_runs: number;
  total_cases: number;
  avg_accuracy: number;
  avg_latency: number;
  hallucination_rate: number;
  feedback_positive: number;
  feedback_negative: number;
}

export interface MetricsTimeSeries {
  date: string;
  accuracy: number;
  latency: number;
  cost: number;
}

export interface FailureCase {
  id: string;
  query: string;
  expected_output: string | null;
  actual_output: string | null;
  score: number;
  feedback_rating: 'positive' | 'negative' | null;
  feedback_comment: string | null;
  hallucination_flag: number;
  created_at: string;
}
