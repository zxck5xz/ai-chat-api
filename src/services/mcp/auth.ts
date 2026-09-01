/**
 * MCP auth helpers
 * - Hashes tokens before persisting (server-side tokens, per-server auth tokens)
 * - Generates opaque random tokens for the dashboard to display once
 */

const enc = new TextEncoder();

/**
 * SHA-256 hex of a token. Used both for storing per-server auth tokens
 * and for hashing MCP_API_KEY-equivalents before comparison.
 */
export async function sha256Hex(input: string): Promise<string> {
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const buf = await crypto.subtle.digest('SHA-256', enc.encode(input));
    return toHex(new Uint8Array(buf));
  }
  if (typeof globalThis.crypto?.subtle === 'object') {
    const buf = await globalThis.crypto.subtle.digest('SHA-256', enc.encode(input));
    return toHex(new Uint8Array(buf));
  }
  throw new Error('No Web Crypto subtle available');
}

/** Generate a random opaque token (hex). */
export function generateToken(bytes = 24): string {
  const arr = new Uint8Array(bytes);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(arr);
    return toHex(arr);
  }
  throw new Error('No secure random available');
}

/** Constant-time hex compare to avoid timing leaks. */
export function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

function toHex(arr: Uint8Array): string {
  let out = '';
  for (let i = 0; i < arr.length; i++) out += arr[i].toString(16).padStart(2, '0');
  return out;
}