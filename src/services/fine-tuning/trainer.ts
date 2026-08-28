export interface TrainerConfig {
  db: D1Database;
}

export interface Hyperparameters {
  learning_rate: number;
  batch_size: number;
  num_epochs: number;
  lora_rank: number;
  lora_alpha: number;
  lora_dropout: number;
  warmup_steps: number;
  weight_decay: number;
  max_seq_length: number;
}

const DEFAULT_HYPERPARAMETERS: Hyperparameters = {
  learning_rate: 2e-4,
  batch_size: 4,
  num_epochs: 3,
  lora_rank: 16,
  lora_alpha: 32,
  lora_dropout: 0.05,
  warmup_steps: 100,
  weight_decay: 0.01,
  max_seq_length: 2048,
};

export class Trainer {
  private db: D1Database;

  constructor(config: TrainerConfig) {
    this.db = config.db;
  }

  async list(): Promise<unknown[]> {
    const results = await this.db.prepare(
      'SELECT * FROM ft_training_jobs ORDER BY created_at DESC'
    ).all();
    return results.results;
  }

  async getById(id: string): Promise<unknown | null> {
    return await this.db.prepare('SELECT * FROM ft_training_jobs WHERE id = ?').bind(id).first();
  }

  async create(input: {
    name: string;
    dataset_id: string;
    base_model: string;
    method: 'lora' | 'qlora' | 'full';
    hyperparameters?: Partial<Hyperparameters>;
  }): Promise<string> {
    const id = crypto.randomUUID();
    const hp = { ...DEFAULT_HYPERPARAMETERS, ...input.hyperparameters };

    await this.db.prepare(`
      INSERT INTO ft_training_jobs 
        (id, name, dataset_id, base_model, method, status, hyperparameters, total_epochs, training_loss_history)
      VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, '[]')
    `).bind(id, input.name, input.dataset_id, input.base_model, input.method, JSON.stringify(hp), hp.num_epochs).run();

    return id;
  }

  async startJob(id: string): Promise<void> {
    await this.db.prepare(`
      UPDATE ft_training_jobs 
      SET status = 'training', started_at = datetime('now') 
      WHERE id = ?
    `).bind(id).run();
  }

  async updateProgress(id: string, progress: {
    completed_steps: number;
    total_steps: number;
    current_loss: number;
    best_loss: number;
    epoch: number;
    loss_history: { step: number; loss: number; epoch: number }[];
  }): Promise<void> {
    await this.db.prepare(`
      UPDATE ft_training_jobs 
      SET completed_steps = ?, total_steps = ?, current_loss = ?, best_loss = ?,
          epoch = ?, training_loss_history = ?, status = 'training'
      WHERE id = ?
    `).bind(
      progress.completed_steps,
      progress.total_steps,
      progress.current_loss,
      progress.best_loss,
      progress.epoch,
      JSON.stringify(progress.loss_history),
      id
    ).run();
  }

  async completeJob(id: string, outputModel: string): Promise<void> {
    await this.db.prepare(`
      UPDATE ft_training_jobs 
      SET status = 'completed', output_model = ?, completed_at = datetime('now'),
          completed_steps = total_steps
      WHERE id = ?
    `).bind(outputModel, id).run();
  }

  async failJob(id: string, reason?: string): Promise<void> {
    await this.db.prepare(`
      UPDATE ft_training_jobs 
      SET status = 'failed', metadata = ?
      WHERE id = ?
    `).bind(reason || 'Unknown error', id).run();
  }

  async deleteJob(id: string): Promise<void> {
    await this.db.prepare('DELETE FROM ft_training_jobs WHERE id = ?').bind(id).run();
  }

  async getStats(): Promise<{ total_jobs: number; completed: number; running: number }> {
    const total = await this.db.prepare('SELECT COUNT(*) as c FROM ft_training_jobs').first() as { c: number };
    const completed = await this.db.prepare("SELECT COUNT(*) as c FROM ft_training_jobs WHERE status = 'completed'").first() as { c: number };
    const running = await this.db.prepare("SELECT COUNT(*) as c FROM ft_training_jobs WHERE status IN ('training', 'preparing')").first() as { c: number };
    return { total_jobs: total.c, completed: completed.c, running: running.c };
  }
}
