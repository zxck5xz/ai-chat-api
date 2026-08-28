export interface DatasetConfig {
  db: D1Database;
}

export interface ValidateResult {
  total: number;
  valid: number;
  invalid: number;
  duplicates: number;
  errors: string[];
}

export class Dataset {
  private db: D1Database;

  constructor(config: DatasetConfig) {
    this.db = config.db;
  }

  async list(): Promise<unknown[]> {
    const results = await this.db.prepare(
      'SELECT * FROM ft_datasets ORDER BY created_at DESC'
    ).all();
    return results.results;
  }

  async getById(id: string): Promise<unknown | null> {
    return await this.db.prepare('SELECT * FROM ft_datasets WHERE id = ?').bind(id).first();
  }

  async create(input: {
    name: string;
    description?: string;
    source: 'manual' | 'import' | 'generated' | 'curated';
    format: 'chat' | 'instruction' | 'completion';
  }): Promise<string> {
    const id = crypto.randomUUID();
    await this.db.prepare(`
      INSERT INTO ft_datasets (id, name, description, source, format, status)
      VALUES (?, ?, ?, ?, ?, 'draft')
    `).bind(id, input.name, input.description || null, input.source, input.format).run();
    return id;
  }

  async addEntries(datasetId: string, entries: { prompt: string; completion: string; system_prompt?: string }[]): Promise<number> {
    let added = 0;
    for (const entry of entries) {
      const id = crypto.randomUUID();
      await this.db.prepare(`
        INSERT INTO ft_dataset_entries (id, dataset_id, prompt, completion, system_prompt, is_valid, is_duplicate)
        VALUES (?, ?, ?, ?, ?, 1, 0)
      `).bind(id, datasetId, entry.prompt, entry.completion, entry.system_prompt || null).run();
      added++;
    }
    await this.db.prepare(`
      UPDATE ft_datasets SET total_entries = total_entries + ?, updated_at = datetime('now') WHERE id = ?
    `).bind(added, datasetId).run();
    return added;
  }

  async getEntries(datasetId: string, limit = 100): Promise<unknown[]> {
    const results = await this.db.prepare(`
      SELECT * FROM ft_dataset_entries WHERE dataset_id = ? ORDER BY created_at DESC LIMIT ?
    `).bind(datasetId, limit).all();
    return results.results;
  }

  async validate(datasetId: string): Promise<ValidateResult> {
    const entries = await this.db.prepare(`
      SELECT * FROM ft_dataset_entries WHERE dataset_id = ?
    `).bind(datasetId).all() as { results: { id: string; prompt: string; completion: string }[] };

    const allEntries = entries.results;
    let valid = 0;
    let invalid = 0;
    const seen = new Set<string>();
    let duplicates = 0;
    const errors: string[] = [];

    for (const entry of allEntries) {
      const key = `${entry.prompt}|||${entry.completion}`;
      if (seen.has(key)) {
        duplicates++;
        await this.db.prepare(`
          UPDATE ft_dataset_entries SET is_duplicate = 1 WHERE id = ?
        `).bind(entry.id).run();
        continue;
      }
      seen.add(key);

      if (!entry.prompt.trim() || !entry.completion.trim()) {
        invalid++;
        errors.push(`Entry ${entry.id}: empty prompt or completion`);
        await this.db.prepare(`
          UPDATE ft_dataset_entries SET is_valid = 0 WHERE id = ?
        `).bind(entry.id).run();
        continue;
      }

      valid++;
    }

    await this.db.prepare(`
      UPDATE ft_datasets 
      SET valid_entries = ?, duplicate_entries = ?, 
          status = CASE WHEN ? > 0 THEN 'ready' ELSE 'draft' END,
          updated_at = datetime('now')
      WHERE id = ?
    `).bind(valid, duplicates, valid, datasetId).run();

    return { total: allEntries.length, valid, invalid, duplicates, errors };
  }

  async delete(datasetId: string): Promise<void> {
    await this.db.prepare('DELETE FROM ft_dataset_entries WHERE dataset_id = ?').bind(datasetId).run();
    await this.db.prepare('DELETE FROM ft_datasets WHERE id = ?').bind(datasetId).run();
  }

  async getStats(): Promise<{ total_datasets: number; total_entries: number }> {
    const ds = await this.db.prepare('SELECT COUNT(*) as c FROM ft_datasets').first() as { c: number };
    const en = await this.db.prepare('SELECT COUNT(*) as c FROM ft_dataset_entries').first() as { c: number };
    return { total_datasets: ds.c, total_entries: en.c };
  }
}
