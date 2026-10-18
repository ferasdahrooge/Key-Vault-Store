/** Random tokens, SHA-256 and constant-time string comparison. */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

// Hex-encoded SHA-256 digest (used to store token hashes).
export function sha256hex(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}

/** URL-safe random token, e.g. randomToken('kv_st_') → "kv_st_<43 chars>". */
export function randomToken(prefix = '', bytes = 32): string {
  return prefix + randomBytes(bytes).toString('base64url');
}

// Compares two strings without leaking where they differ.
export function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  // The length check leaks only the length, which is fixed for the hashes this compares.
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
