// Project 18: Edge AI Inference — Type Definitions

export type ModelProvider = 'webllm' | 'onnx' | 'cloud';
export type ModelCategory = 'text-generation' | 'classification' | 'embedding' | 'summarization';
export type DeviceCapability = 'high-end' | 'mid-range' | 'low-end' | 'unsupported';
export type InferenceMode = 'local' | 'cloud' | 'hybrid';

export interface ModelConfig {
  id: string;
  name: string;
  provider: ModelProvider;
  category: ModelCategory;
  modelId: string;
  sizeMB: number;
  minGPUMemoryMB: number;
  minRAMMB: number;
  description: string;
  quantization?: string;
  maxTokens?: number;
}

export interface DeviceCapabilities {
  gpuAvailable: boolean;
  gpuMemoryMB: number;
  webgpuSupported: boolean;
  totalRAMMB: number;
  cpuCores: number;
  capability: DeviceCapability;
  recommendedModels: string[];
}

export interface InferenceRequest {
  modelId: string;
  prompt: string;
  mode: InferenceMode;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
}

export interface InferenceResult {
  id: string;
  modelId: string;
  input: string;
  output: string;
  mode: InferenceMode;
  tokensGenerated: number;
  tokensPerSecond: number;
  latencyMs: number;
  memoryUsedMB: number;
  provider: ModelProvider;
  created_at: string;
}

export interface ModelStatus {
  modelId: string;
  loaded: boolean;
  loading: boolean;
  loadTimeMs: number;
  memoryMB: number;
  lastUsed: string;
}

export interface PerformanceMetrics {
  totalInferences: number;
  avgTokensPerSecond: number;
  avgLatencyMs: number;
  avgMemoryMB: number;
  localInferences: number;
  cloudInferences: number;
  hybridInferences: number;
  modelsLoaded: number;
  uptimeMs: number;
  infByModel: Record<string, number>;
}

export interface OfflineConfig {
  enabled: boolean;
  serviceWorkerRegistered: boolean;
  cachedModels: string[];
  queueSize: number;
}

export interface EdgeAIStats {
  device: DeviceCapabilities;
  models: ModelStatus[];
  metrics: PerformanceMetrics;
  offline: OfflineConfig;
}
