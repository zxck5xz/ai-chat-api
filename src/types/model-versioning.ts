// Model Versioning Types

export interface ModelVersion {
  id: string;
  name: string;
  version: string;
  provider: 'gemini' | 'openai' | 'anthropic' | 'custom';
  modelId: string; // e.g., "gemini-2.0-flash", "gpt-4o"
  status: 'active' | 'inactive' | 'deprecated' | 'archived';
  config: ModelConfig;
  metrics: ModelMetrics;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ModelConfig {
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  topK?: number;
  systemPrompt?: string;
  responseFormat?: string;
}

export interface ModelMetrics {
  totalRequests: number;
  avgLatencyMs: number;
  avgCostUsd: number;
  errorRate: number;
  successRate: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
}

export interface ModelDeployment {
  id: string;
  versionId: string;
  environment: 'production' | 'staging' | 'canary';
  status: 'pending' | 'active' | 'rolled_back' | 'failed';
  trafficPercent: number;
  strategy: 'rolling' | 'canary' | 'blue_green' | 'instant';
  deployedAt?: string;
  rolledBackAt?: string;
  rollbackReason?: string;
  deployedBy?: string;
  createdAt: string;
}

export interface RollbackRecord {
  id: string;
  deploymentId: string;
  fromVersionId: string;
  toVersionId: string;
  reason: string;
  triggeredBy: string;
  status: 'pending' | 'completed' | 'failed';
  rolledBackAt?: string;
  createdAt: string;
}

export interface ModelComparison {
  versionA: ModelVersion;
  versionB: ModelVersion;
  metricsDiff: {
    latencyChange: number; // percentage
    costChange: number;
    errorRateChange: number;
    successRateChange: number;
  };
  recommendation: 'keep_current' | 'rollback' | 'investigate';
}

export interface TrafficRoute {
  id: string;
  name: string;
  rules: TrafficRule[];
  enabled: boolean;
  createdAt: string;
}

export interface TrafficRule {
  condition: string; // e.g., "user_id % 100 < 10"
  versionId: string;
  percent: number;
}
