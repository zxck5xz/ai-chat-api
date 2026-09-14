// Project 19: Structured generation with schema enforcement + auto-retry.
//
// Loop: prompt -> extract JSON -> validate -> on failure, feed the exact
// validation errors back as a repair instruction and try again.

import type {
  JsonSchema,
  StructuredAttempt,
  StructuredResult,
  StructuredGenerateOptions,
  ValidationError,
} from '../../types/structured-output';
import { extractJson } from './extractor';
import { formatErrors, validate } from './validator';

const DEFAULT_MODEL = 'gemini-2.0-flash';
const DEFAULT_MAX_ATTEMPTS = 3;

const BASE_SYSTEM_PROMPT = `You are a structured data generator.
You MUST respond with a single JSON value that conforms to the provided JSON Schema.
Rules:
- Output raw JSON only. No prose, no explanation, no markdown fences.
- Every property listed in "required" must be present.
- Respect every type, enum, format and range constraint in the schema.
- Never invent properties that the schema forbids.`;

/**
 * Turn validation failures into an instruction the model can act on.
 * Errors are grouped by path so a deeply-nested failure reads as one item.
 */
export function buildRepairPrompt(
  errors: ValidationError[],
  previousOutput: string,
  schema: JsonSchema
): string {
  const grouped = new Map<string, ValidationError[]>();
  for (const e of errors) {
    const key = e.path || '(root)';
    const list = grouped.get(key) ?? [];
    list.push(e);
    grouped.set(key, list);
  }

  const issues = [...grouped.entries()]
    .map(([path, list]) => {
      const details = list.map((e) => `${e.message} [${e.keyword}]`).join('; ');
      return `- ${path}: ${details}`;
    })
    .join('\n');

  return `Your previous output did not satisfy the JSON Schema.

Previous output:
${previousOutput.slice(0, 2000)}

Validation errors (${errors.length}):
${issues}

Schema:
${JSON.stringify(schema, null, 2)}

Produce a corrected JSON value that fixes every error listed above.
Keep the parts that were already correct. Output raw JSON only.`;
}

/** Instruction shown when the model produced nothing parseable as JSON. */
export function buildParseRepairPrompt(previousOutput: string, schema: JsonSchema): string {
  return `Your previous output could not be parsed as JSON.

Previous output:
${previousOutput.slice(0, 2000)}

Schema:
${JSON.stringify(schema, null, 2)}

Respond with a single valid JSON value matching the schema.
No markdown fences, no commentary, no trailing commas — raw JSON only.`;
}

export class StructuredClient {
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  /**
   * Generate a value conforming to `schema`, retrying with repair prompts
   * until it validates or the attempt budget is exhausted.
   */
  async generate<T = unknown>(
    prompt: string,
    schema: JsonSchema,
    options: StructuredGenerateOptions = {}
  ): Promise<StructuredResult<T>> {
    const maxAttempts = Math.max(1, Math.min(options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS, 6));
    const startedAt = Date.now();
    const attempts: StructuredAttempt[] = [];

    const systemPrompt = [
      BASE_SYSTEM_PROMPT,
      options.systemPrompt ? `\nAdditional instructions:\n${options.systemPrompt}` : '',
      `\nJSON Schema:\n${JSON.stringify(schema, null, 2)}`,
    ].join('');

    let userPrompt = prompt;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const attemptStart = Date.now();
      let raw: string;

      try {
        raw = await this.callLLM(systemPrompt, userPrompt, options);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'unknown error';
        attempts.push({
          attempt,
          outcome: 'llm_error',
          raw_output: '',
          extracted_json: null,
          errors: [],
          repair_prompt: null,
          duration_ms: Date.now() - attemptStart,
        });
        // A transport failure is not something a repair prompt can fix
        return this.fail(attempts, options, startedAt, `LLM call failed: ${message}`);
      }

      if (!raw || raw.trim().length === 0) {
        attempts.push({
          attempt,
          outcome: 'empty_response',
          raw_output: raw ?? '',
          extracted_json: null,
          errors: [],
          repair_prompt: attempt < maxAttempts ? buildParseRepairPrompt('', schema) : null,
          duration_ms: Date.now() - attemptStart,
        });
        userPrompt = buildParseRepairPrompt('', schema);
        continue;
      }

      const extracted = extractJson(raw);

      if (extracted.value === null) {
        const repair = buildParseRepairPrompt(raw, schema);
        attempts.push({
          attempt,
          outcome: 'invalid_json',
          raw_output: raw,
          extracted_json: extracted.raw,
          errors: [
            {
              path: '',
              keyword: 'parse',
              message: 'response is not parseable JSON',
              received: raw.slice(0, 200),
            },
          ],
          repair_prompt: attempt < maxAttempts ? repair : null,
          duration_ms: Date.now() - attemptStart,
        });
        userPrompt = repair;
        continue;
      }

      const result = validate<T>(extracted.value, schema);

      if (result.valid) {
        attempts.push({
          attempt,
          outcome: 'valid',
          raw_output: raw,
          extracted_json: extracted.raw,
          errors: [],
          repair_prompt: null,
          duration_ms: Date.now() - attemptStart,
        });
        return {
          success: true,
          data: result.value as T,
          attempts,
          total_attempts: attempts.length,
          schema_name: options.schemaName ?? null,
          duration_ms: Date.now() - startedAt,
          error: null,
        };
      }

      const repair = buildRepairPrompt(result.errors, extracted.raw ?? raw, schema);
      attempts.push({
        attempt,
        outcome: 'schema_violation',
        raw_output: raw,
        extracted_json: extracted.raw,
        errors: result.errors,
        repair_prompt: attempt < maxAttempts ? repair : null,
        duration_ms: Date.now() - attemptStart,
      });
      userPrompt = repair;
    }

    const lastErrors = attempts[attempts.length - 1]?.errors ?? [];
    return this.fail(
      attempts,
      options,
      startedAt,
      `Failed to produce valid output in ${maxAttempts} attempts:\n${formatErrors(lastErrors)}`
    );
  }

  private fail<T>(
    attempts: StructuredAttempt[],
    options: StructuredGenerateOptions,
    startedAt: number,
    error: string
  ): StructuredResult<T> {
    return {
      success: false,
      data: null,
      attempts,
      total_attempts: attempts.length,
      schema_name: options.schemaName ?? null,
      duration_ms: Date.now() - startedAt,
      error,
    };
  }

  private async callLLM(
    systemPrompt: string,
    userPrompt: string,
    options: StructuredGenerateOptions
  ): Promise<string> {
    const model = options.model ?? DEFAULT_MODEL;

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${this.apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: systemPrompt }] },
          contents: [{ parts: [{ text: userPrompt }] }],
          generationConfig: {
            // Low temperature: structured output wants determinism, not creativity
            temperature: options.temperature ?? 0.2,
            maxOutputTokens: options.maxOutputTokens ?? 2048,
            responseMimeType: 'application/json',
          },
        }),
      }
    );

    if (!response.ok) {
      throw new Error(`Gemini API error: ${response.status}`);
    }

    const data = (await response.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    return data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  }
}
