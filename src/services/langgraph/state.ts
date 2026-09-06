/**
 * LangGraph State Management
 * Typed state with reducers for concurrent node updates
 */

export type StateReducer<T> = (current: T, update: T) => T;

export interface StateField<T = any> {
  default: T;
  reducer?: StateReducer<any>;
}

export type StateSchema = Record<string, StateField>;

export type InferState<S extends StateSchema> = {
  [K in keyof S]: S[K] extends StateField<infer T> ? T : never;
};

// Built-in reducers
export const reducers = {
  append: <T>(): StateReducer<T[]> => (current, update) => [...current, ...update],
  replace: <T>(): StateReducer<T> => (_, update) => update,
  merge: <T extends Record<string, any>>(): StateReducer<T> => (current, update) => ({ ...current, ...update }),
  counter: (): StateReducer<number> => (current, update) => current + update,
};

// Create initial state from schema
export function createInitialState<S extends StateSchema>(schema: S): InferState<S> {
  const state: any = {};
  for (const [key, field] of Object.entries(schema)) {
    state[key] = typeof field.default === 'function' ? field.default() : field.default;
  }
  return state;
}

// Apply node update to state using reducers
export function applyUpdate<S extends StateSchema>(
  schema: S,
  current: InferState<S>,
  update: Partial<InferState<S>>
): InferState<S> {
  const next: any = { ...current };
  for (const [key, value] of Object.entries(update)) {
    if (key in schema) {
      const field = schema[key];
      if (field.reducer) {
        next[key] = field.reducer(current[key], value);
      } else {
        next[key] = value;
      }
    }
  }
  return next;
}

// Compute state diff for observability
export function stateDiff(
  before: Record<string, any>,
  after: Record<string, any>
): Record<string, { before: any; after: any }> {
  const diff: Record<string, { before: any; after: any }> = {};
  const allKeys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of allKeys) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      diff[key] = { before: before[key], after: after[key] };
    }
  }
  return diff;
}
