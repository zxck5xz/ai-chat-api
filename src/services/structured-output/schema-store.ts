// Project 19: Schema registry + generation log (D1).
//
// Schemas are versioned by name: saving an existing name bumps the version
// rather than overwriting, so a generation logged last week still points at
// the schema it was actually validated against.

import type {
  GenerationRecord,
  JsonSchema,
  SchemaRecord,
  StructuredMetrics,
  StructuredResult,
} from '../../types/structured-output';

interface SchemaRow {
  id: string;
  name: string;
  version: number;
  description: string | null;
  schema_json: string;
  created_at: string;
  updated_at: string;
}

interface GenerationRow {
  id: string;
  schema_name: string | null;
  prompt: string;
  success: number;
  total_attempts: number;
  final_output: string | null;
  errors: string | null;
  duration_ms: number;
  created_at: string;
}

function toSchemaRecord(row: SchemaRow): SchemaRecord {
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    description: row.description,
    schema: JSON.parse(row.schema_json) as JsonSchema,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export class SchemaStore {
  private db: D1Database;

  constructor(db: D1Database) {
    this.db = db;
  }

  /** Create a schema, or bump to the next version if the name already exists. */
  async save(name: string, schema: JsonSchema, description?: string): Promise<SchemaRecord> {
    const existing = await this.getLatest(name);
    const version = existing ? existing.version + 1 : 1;
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    await this.db
      .prepare(
        `INSERT INTO output_schemas (id, name, version, description, schema_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(id, name, version, description ?? null, JSON.stringify(schema), now, now)
      .run();

    return {
      id,
      name,
      version,
      description: description ?? null,
      schema,
      created_at: now,
      updated_at: now,
    };
  }

  /** Latest version of a schema by name. */
  async getLatest(name: string): Promise<SchemaRecord | null> {
    const row = await this.db
      .prepare('SELECT * FROM output_schemas WHERE name = ? ORDER BY version DESC LIMIT 1')
      .bind(name)
      .first<SchemaRow>();

    return row ? toSchemaRecord(row) : null;
  }

  /** A specific version of a schema. */
  async getVersion(name: string, version: number): Promise<SchemaRecord | null> {
    const row = await this.db
      .prepare('SELECT * FROM output_schemas WHERE name = ? AND version = ?')
      .bind(name, version)
      .first<SchemaRow>();

    return row ? toSchemaRecord(row) : null;
  }

  /** Latest version of every registered schema. */
  async list(): Promise<SchemaRecord[]> {
    const { results } = await this.db
      .prepare(
        `SELECT s.* FROM output_schemas s
         INNER JOIN (
           SELECT name, MAX(version) AS max_version FROM output_schemas GROUP BY name
         ) latest ON s.name = latest.name AND s.version = latest.max_version
         ORDER BY s.updated_at DESC`
      )
      .all<SchemaRow>();

    return (results ?? []).map(toSchemaRecord);
  }

  /** All versions of one schema, newest first. */
  async listVersions(name: string): Promise<SchemaRecord[]> {
    const { results } = await this.db
      .prepare('SELECT * FROM output_schemas WHERE name = ? ORDER BY version DESC')
      .bind(name)
      .all<SchemaRow>();

    return (results ?? []).map(toSchemaRecord);
  }

  /** Delete every version of a schema. Returns how many rows went. */
  async remove(name: string): Promise<number> {
    const result = await this.db
      .prepare('DELETE FROM output_schemas WHERE name = ?')
      .bind(name)
      .run();

    return result.meta?.changes ?? 0;
  }

  /** Log one generation run for the metrics dashboard. */
  async logGeneration(prompt: string, result: StructuredResult): Promise<string> {
    const id = crypto.randomUUID();

    // Only the failing errors are worth keeping — a success has none
    const errors = result.success
      ? null
      : JSON.stringify(result.attempts.flatMap((a) => a.errors).slice(0, 20));

    await this.db
      .prepare(
        `INSERT INTO structured_generations
         (id, schema_name, prompt, success, total_attempts, final_output, errors, duration_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        id,
        result.schema_name,
        prompt.slice(0, 2000),
        result.success ? 1 : 0,
        result.total_attempts,
        result.data !== null ? JSON.stringify(result.data).slice(0, 4000) : null,
        errors,
        result.duration_ms,
        new Date().toISOString()
      )
      .run();

    return id;
  }

  async listGenerations(limit = 20, offset = 0): Promise<{ generations: GenerationRecord[]; total: number }> {
    const { results } = await this.db
      .prepare('SELECT * FROM structured_generations ORDER BY created_at DESC LIMIT ? OFFSET ?')
      .bind(limit, offset)
      .all<GenerationRow>();

    const countRow = await this.db
      .prepare('SELECT COUNT(*) AS total FROM structured_generations')
      .first<{ total: number }>();

    return { generations: results ?? [], total: countRow?.total ?? 0 };
  }

  async getMetrics(): Promise<StructuredMetrics> {
    const agg = await this.db
      .prepare(
        `SELECT
           COUNT(*) AS total,
           SUM(success) AS successes,
           SUM(CASE WHEN success = 1 AND total_attempts = 1 THEN 1 ELSE 0 END) AS first_try,
           AVG(total_attempts) AS avg_attempts,
           AVG(duration_ms) AS avg_duration
         FROM structured_generations`
      )
      .first<{
        total: number;
        successes: number | null;
        first_try: number | null;
        avg_attempts: number | null;
        avg_duration: number | null;
      }>();

    const total = agg?.total ?? 0;
    const successes = agg?.successes ?? 0;
    const firstTry = agg?.first_try ?? 0;

    // Error keywords live inside a JSON blob, so tally them in JS rather than SQL
    const { results } = await this.db
      .prepare('SELECT errors FROM structured_generations WHERE errors IS NOT NULL LIMIT 500')
      .all<{ errors: string }>();

    const counts = new Map<string, number>();
    for (const row of results ?? []) {
      try {
        const parsed = JSON.parse(row.errors) as Array<{ keyword?: string }>;
        for (const e of parsed) {
          if (!e.keyword) continue;
          counts.set(e.keyword, (counts.get(e.keyword) ?? 0) + 1);
        }
      } catch {
        // A malformed log row must not take the metrics endpoint down
      }
    }

    const top_error_keywords = [...counts.entries()]
      .map(([keyword, count]) => ({ keyword, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    return {
      total_generations: total,
      success_count: successes,
      success_rate: total > 0 ? successes / total : 0,
      first_attempt_success_rate: total > 0 ? firstTry / total : 0,
      avg_attempts: agg?.avg_attempts ?? 0,
      avg_duration_ms: agg?.avg_duration ?? 0,
      top_error_keywords,
    };
  }
}
