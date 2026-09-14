// Project 19: Pull JSON out of messy LLM output.
//
// Models wrap JSON in prose, fence it as markdown, trail commas, or quote keys
// with single quotes. Each of these is cheap to fix locally — every repair done
// here is one fewer LLM round trip.

export interface ExtractionResult {
  /** The raw JSON text that was located, before repairs */
  raw: string | null;
  /** Parsed value, or null when nothing parseable was found */
  value: unknown | null;
  /** Which strategy produced the value, for observability */
  strategy: 'direct' | 'fenced' | 'balanced' | 'repaired' | 'none';
  /** Local fixes applied before parsing succeeded */
  repairs: string[];
}

const EMPTY: ExtractionResult = { raw: null, value: null, strategy: 'none', repairs: [] };

/** Strip ```json ... ``` fences, returning every fenced block found. */
function fencedBlocks(text: string): string[] {
  const blocks: string[] = [];
  const re = /```(?:json|JSON)?\s*\n?([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const body = match[1].trim();
    if (body) blocks.push(body);
  }
  return blocks;
}

/**
 * Scan for the first balanced {...} or [...] span, respecting string literals
 * so that braces inside strings do not throw off the depth counter.
 */
function balancedSpan(text: string): string | null {
  const start = text.search(/[{[]/);
  if (start === -1) return null;

  const open = text[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }

  return null;
}

/** Conservative syntax fixes for the common ways models emit not-quite-JSON. */
function repairJson(text: string): { text: string; repairs: string[] } {
  const repairs: string[] = [];
  let out = text;

  // Strip // and /* */ comments, skipping anything inside a string literal
  const stripped = stripComments(out);
  if (stripped !== out) {
    repairs.push('removed comments');
    out = stripped;
  }

  // Trailing commas before } or ]
  const noTrailing = out.replace(/,(\s*[}\]])/g, '$1');
  if (noTrailing !== out) {
    repairs.push('removed trailing commas');
    out = noTrailing;
  }

  // Single-quoted strings -> double-quoted (only when no double quotes present,
  // so we never corrupt a correctly quoted payload that merely contains ')
  if (!out.includes('"') && out.includes("'")) {
    out = out.replace(/'([^']*)'/g, '"$1"');
    repairs.push('converted single quotes to double quotes');
  }

  // Unquoted object keys: {name: "x"} -> {"name": "x"}
  const quotedKeys = out.replace(/([{,]\s*)([A-Za-z_$][A-Za-z0-9_$]*)(\s*:)/g, '$1"$2"$3');
  if (quotedKeys !== out) {
    repairs.push('quoted bare object keys');
    out = quotedKeys;
  }

  // Python/JS literals that are not valid JSON
  const literals = out
    .replace(/\bNone\b/g, 'null')
    .replace(/\bTrue\b/g, 'true')
    .replace(/\bFalse\b/g, 'false')
    .replace(/\bundefined\b/g, 'null')
    .replace(/\bNaN\b/g, 'null');
  if (literals !== out) {
    repairs.push('normalized non-JSON literals');
    out = literals;
  }

  return { text: out, repairs };
}

function stripComments(text: string): string {
  let out = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }

    if (ch === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
      continue;
    }

    if (ch === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++; // land on '/', loop increments past it
      continue;
    }

    out += ch;
  }

  return out;
}

function tryParse(candidate: string): unknown | null {
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

/**
 * Extract a JSON value from arbitrary model output.
 * Strategies run cheapest-first; the first one that parses wins.
 */
export function extractJson(text: string): ExtractionResult {
  if (!text || text.trim().length === 0) return EMPTY;

  const trimmed = text.trim();

  // 1. The whole response is already JSON
  const direct = tryParse(trimmed);
  if (direct !== null) {
    return { raw: trimmed, value: direct, strategy: 'direct', repairs: [] };
  }

  // 2. A fenced code block — last block wins, models often explain then emit
  const blocks = fencedBlocks(trimmed);
  for (const block of blocks.reverse()) {
    const parsed = tryParse(block);
    if (parsed !== null) {
      return { raw: block, value: parsed, strategy: 'fenced', repairs: [] };
    }
  }

  // 3. A balanced object/array embedded in prose
  const span = balancedSpan(trimmed);
  if (span) {
    const parsed = tryParse(span);
    if (parsed !== null) {
      return { raw: span, value: parsed, strategy: 'balanced', repairs: [] };
    }
  }

  // 4. Local syntax repair, applied to the best candidate we located
  const candidates = [...blocks, span, trimmed].filter((c): c is string => Boolean(c));
  for (const candidate of candidates) {
    const { text: repaired, repairs } = repairJson(candidate);
    const parsed = tryParse(repaired);
    if (parsed !== null) {
      return { raw: candidate, value: parsed, strategy: 'repaired', repairs };
    }
  }

  return { ...EMPTY, raw: span ?? blocks[0] ?? null };
}
