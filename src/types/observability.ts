export interface TraceSpan {
  id: string;
  trace_id: string;
  parent_span_id: string | null;
  operation: string;
  service: string;
  model: string | null;
  status: 'ok' | 'error' | 'timeout';
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cost_usd: number;
  latency_ms: number;
  metadata: string | null;
  started_at: string;
  completed_at: string | null;
}

export interface Trace {
  id: string;
  user_id: string | null;
  operation: string;
  total_spans: number;
  total_tokens: number;
  total_cost_usd: number;
  total_latency_ms: number;
  status: 'ok' | 'error' | 'partial';
  started_at: string;
  completed_at: string | null;
}

export interface CostSummary {
  date: string;
  model: string;
  total_requests: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cost_usd: number;
}

export interface LatencyPercentile {
  model: string;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
  avg: number;
  count: number;
}

export interface TokenUsage {
  date: string;
  input_tokens: number;
  output_tokens: number;
  cache_hits: number;
  total_requests: number;
}

export interface AlertRule {
  id: string;
  name: string;
  metric: string;
  condition: 'gt' | 'lt' | 'eq';
  threshold: number;
  enabled: number;
  created_at: string;
}

export interface AlertEvent {
  id: string;
  rule_id: string;
  rule_name: string;
  metric: string;
  actual_value: number;
  threshold: number;
  acknowledged: number;
  created_at: string;
}

export interface ObservabilityMetrics {
  total_traces: number;
  total_spans: number;
  total_tokens: number;
  total_cost_usd: number;
  avg_latency_ms: number;
  error_rate: number;
  active_alerts: number;
}

export interface AnomalyEvent {
  id: string;
  metric: string;
  model: string | null;
  anomaly_type: 'spike' | 'drop' | 'drift' | 'outlier';
  severity: 'info' | 'warning' | 'critical';
  actual_value: number;
  expected_min: number | null;
  expected_max: number | null;
  z_score: number | null;
  description: string;
  acknowledged: number;
  created_at: string;
}

export interface DriftEvent {
  id: string;
  metric: string;
  model: string | null;
  drift_type: 'accuracy' | 'cost' | 'latency' | 'quality';
  direction: 'improving' | 'degrading';
  baseline_value: number;
  current_value: number;
  change_pct: number;
  window_days: number;
  description: string;
  acknowledged: number;
  created_at: string;
}

export interface MetricSnapshot {
  id: string;
  metric: string;
  model: string | null;
  value: number;
  sample_count: number;
  window_minutes: number;
  created_at: string;
}

export interface MonitoringOverview {
  anomalyStats: {
    total: number;
    bySeverity: Record<string, number>;
    byType: Record<string, number>;
    unacknowledged: number;
  };
  driftStats: {
    total: number;
    degrading: number;
    improving: number;
    byType: Record<string, number>;
    unacknowledged: number;
  };
  recentAnomalies: AnomalyEvent[];
  recentDrifts: DriftEvent[];
  systemHealth: 'healthy' | 'degraded' | 'critical';
}

export interface DriftResult {
  has_drift: boolean;
  direction: 'improving' | 'degrading' | 'stable';
  baseline_value: number;
  current_value: number;
  change_pct: number;
  description: string;
}

export interface EvaluationResult {
  rule_id: string;
  rule_name: string;
  triggered: boolean;
  actual_value: number;
  threshold: number;
  severity: string;
  message: string;
}
