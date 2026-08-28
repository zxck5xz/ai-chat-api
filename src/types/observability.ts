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
