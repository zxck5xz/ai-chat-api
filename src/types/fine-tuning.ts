export interface Dataset {
  id: string;
  name: string;
  description: string | null;
  source: 'manual' | 'import' | 'generated' | 'curated';
  format: 'chat' | 'instruction' | 'completion';
  total_entries: number;
  valid_entries: number;
  duplicate_entries: number;
  status: 'draft' | 'validating' | 'ready' | 'archived';
  created_at: string;
  updated_at: string;
}

export interface DatasetEntry {
  id: string;
  dataset_id: string;
  prompt: string;
  completion: string;
  system_prompt: string | null;
  metadata: string | null;
  is_valid: number;
  is_duplicate: number;
  created_at: string;
}

export interface TrainingJob {
  id: string;
  name: string;
  dataset_id: string;
  base_model: string;
  method: 'lora' | 'qlora' | 'full';
  status: 'queued' | 'preparing' | 'training' | 'evaluating' | 'completed' | 'failed';
  hyperparameters: string;
  output_model: string | null;
  total_steps: number;
  completed_steps: number;
  current_loss: number | null;
  best_loss: number | null;
  training_loss_history: string;
  epoch: number;
  total_epochs: number;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
}

export interface ModelEval {
  id: string;
  job_id: string;
  base_model: string;
  fine_tuned_model: string;
  eval_set: string;
  total_cases: number;
  base_pass_rate: number;
  ft_pass_rate: number;
  base_avg_latency: number;
  ft_avg_latency: number;
  base_avg_cost: number;
  ft_avg_cost: number;
  improvement_pct: number;
  status: 'running' | 'completed' | 'failed';
  created_at: string;
}

export interface ABTest {
  id: string;
  name: string;
  base_model: string;
  variant_model: string;
  traffic_split: number;
  total_requests: number;
  base_requests: number;
  variant_requests: number;
  base_avg_latency: number;
  variant_avg_latency: number;
  base_pass_rate: number;
  variant_pass_rate: number;
  winner: 'base' | 'variant' | null;
  status: 'running' | 'stopped' | 'completed';
  created_at: string;
  stopped_at: string | null;
}

export interface FineTuningMetrics {
  total_datasets: number;
  total_jobs: number;
  completed_jobs: number;
  total_entries: number;
  avg_improvement: number;
  active_ab_tests: number;
}

export interface LossPoint {
  step: number;
  loss: number;
  epoch: number;
}
