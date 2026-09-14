// Project 19: Structured Output Validation — Types

export type JsonSchemaType =
  | 'object'
  | 'array'
  | 'string'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'null';

/**
 * Supported subset of JSON Schema (draft 2020-12).
 * Deliberately small: everything here is enforceable without a dependency
 * and expressible in a repair prompt the LLM can actually act on.
 */
export interface JsonSchema {
  type?: JsonSchemaType | JsonSchemaType[];
  description?: string;

  // object
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;

  // array
  items?: JsonSchema;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;

  // string
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: 'email' | 'uri' | 'uuid' | 'date' | 'date-time';

  // number
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  multipleOf?: number;

  // any
  enum?: unknown[];
  const?: unknown;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  nullable?: boolean;
}

export interface ValidationError {
  /** JSON Pointer-ish path, e.g. "/items/0/price" ("" = root) */
  path: string;
  /** Schema keyword that failed, e.g. "required", "type", "minimum" */
  keyword: string;
  message: string;
  expected?: unknown;
  received?: unknown;
}

export interface ValidationResult<T = unknown> {
  valid: boolean;
  errors: ValidationError[];
  /** Present only when valid — coerced value (integers, trimmed strings) */
  value?: T;
}

export type AttemptOutcome =
  | 'valid'
  | 'invalid_json'
  | 'schema_violation'
  | 'empty_response'
  | 'llm_error';

export interface StructuredAttempt {
  attempt: number;
  outcome: AttemptOutcome;
  raw_output: string;
  extracted_json: string | null;
  errors: ValidationError[];
  /** Repair instruction sent to the model for the NEXT attempt */
  repair_prompt: string | null;
  duration_ms: number;
}

export interface StructuredResult<T = unknown> {
  success: boolean;
  data: T | null;
  attempts: StructuredAttempt[];
  total_attempts: number;
  schema_name: string | null;
  duration_ms: number;
  error: string | null;
}

export interface SchemaRecord {
  id: string;
  name: string;
  version: number;
  description: string | null;
  schema: JsonSchema;
  created_at: string;
  updated_at: string;
}

export interface GenerationRecord {
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

export interface StructuredMetrics {
  total_generations: number;
  success_count: number;
  success_rate: number;
  /** Share that succeeded without any repair round */
  first_attempt_success_rate: number;
  avg_attempts: number;
  avg_duration_ms: number;
  /** Most common failing schema keywords, most frequent first */
  top_error_keywords: Array<{ keyword: string; count: number }>;
}

export interface StructuredGenerateOptions {
  /** Max total attempts including the first one. Default 3. */
  maxAttempts?: number;
  temperature?: number;
  maxOutputTokens?: number;
  model?: string;
  systemPrompt?: string;
  /** Persist the generation to D1 when a store is supplied */
  schemaName?: string;
}
